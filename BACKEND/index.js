const express = require("express");
const dotenv = require("dotenv");
dotenv.config();
const dns = require("node:dns");
dns.setServers(["8.8.8.8", "1.1.1.1"]);

const path = require("path");
const connectDB = require("./src/config/db");
const mongoose = require("mongoose");
const cors = require("cors");
const cookieParser = require("cookie-parser");

// Give the network/DNS stack a moment to settle right after process boot —
// connecting immediately on restart routinely misses the first attempt
// (Atlas SRV lookup fails) and has to fall back to the retry-with-backoff
// logic in connectDB, which shows up as a scary error on every restart.
setTimeout(connectDB, 3000);
// Invoice numbers: unique per company instead of across all companies (one-time index change, safe to repeat).
require("mongoose").connection.once("open", () => {
  // Single-company server: stop at once if TENANT_ID is missing or this DB
  // holds anything other than that one company (e.g. the shared main DB).
  require("./src/utils/singleTenant")
    .assertSingleTenantDatabase()
    .then((t) => console.log(`Single-company server: ${t.company_name} (${t._id})`))
    .catch((err) => {
      console.error(`FATAL: ${err.message}`);
      process.exit(1);
    });
  require("./src/services/invoiceSettings").ensureInvoiceNumberIndex();
  require("./src/services/docSettings").ensureNumberIndexes();
});
const app = express();

// City Smile only (single-company server). Local dev ports kept for testing.
const allowedOrigins = [
  "https://crm.citysmile.in",
  "https://api.citysmile.in",
  "http://localhost:8080",
  "http://localhost:5173",
  "http://localhost:5183",
];

const corsOptions = {
  origin: function (origin, callback) {
    if (!origin) return callback(null, true);
    if (allowedOrigins.includes(origin) || origin.startsWith("chrome-extension://")) return callback(null, true);
    return callback(new Error("Not allowed by CORS: " + origin));
  },
  credentials: true,
};

// /api/public/website-leads is embedded on external client landing pages
// (arbitrary, unpredictable domains), unlike the rest of the API which is
// only ever called from our own dashboard origins — so it gets its own
// wide-open, credential-less CORS instead of the allowedOrigins check.
const { mountClaudeConnector, isConnectorPath } = require("./src/mcp");

const corsOptionsDelegate = (req, callback) => {
  if (req.path.startsWith("/api/public/website-leads")) {
    return callback(null, { origin: true, credentials: false });
  }
  // Claude connector (src/mcp): reached from Claude, not a CRM origin, and
  // authenticated by bearer token rather than cookies.
  if (isConnectorPath(req.path)) {
    return callback(null, { origin: true, credentials: false });
  }
  callback(null, corsOptions);
};

app.use(cors(corsOptionsDelegate));
// Explicit preflight handler so every OPTIONS request is answered with CORS
// headers even if a downstream middleware would otherwise handle it.
app.options("*", cors(corsOptionsDelegate));


// Middleware
// app.use(
//   cors({
//     origin: [
//       "https://crm.beontimeofficial.com",
//       "http://localhost:8080",
//       "http://localhost:5173",
//       "https://crm-fuerte.netlify.app",
//       "https://crm-frontend-wtw2.onrender.com",
//       "https://newcrm.fuertedevelopers.com",
//       "https://rosybrown-bat-931514.hostingersite.com",
//     ],
//     credentials: true,
//   }),
// );

// If MongoDB isn't connected yet (e.g. still reconnecting right after a
// restart), fail fast with a normal Express response instead of letting
// DB-dependent requests hang until an upstream proxy kills the connection
// with a header-less error — that's what previously showed up in the
// browser as a false "blocked by CORS policy" failure.
app.use("/api", (req, res, next) => {
  // Never block a CORS preflight on the DB check.
  if (req.method === "OPTIONS") return next();
  if (mongoose.connection.readyState !== 1) {
    return res.status(503).json({ message: "Database is not connected yet, please retry shortly" });
  }
  next();
});

app.use(cookieParser());
// Blocks API calls to modules switched off in the company's SaaS plan
// (route -> module table in src/middleware/planModules.js).
app.use("/api", require("./src/middleware/planModules").planModuleGate);
app.use(
  express.json({
    limit: "10mb",
    // Captures the exact bytes Meta signed, needed to verify the WhatsApp
    // webhook's X-Hub-Signature-256 header per-tenant (see
    // whatsapp_webhook_controller.js). Storing the buffer alongside the
    // parsed body doesn't change parsing behavior for any other route.
    verify: (req, res, buf) => {
      req.rawBody = buf;
    },
  })
);
app.use(
  "/uploads",
  express.static(path.join(__dirname, "src", "uploads"), {
    setHeaders: (res) => {
      res.set("Access-Control-Allow-Origin", "*");
      res.set("Cross-Origin-Resource-Policy", "cross-origin");
    },
  })
);

// Super Admin panel -> this server (signed server-to-server calls, no login).
// Off (404) unless CONTROL_SECRET is set. Must stay after express.json so the
// raw body is available for signature checks. See src/routes/control_routes.js.
app.use("/api/control", require("./src/routes/control_routes"));

// Claude connector: MCP endpoint (/mcp) + OAuth sign-in, see src/mcp/index.js.
// Off unless MCP_PUBLIC_URL is set.
mountClaudeConnector(app);
const claudeConnectorRoutes = require("./src/routes/claude_connector_routes");
app.use("/api/claude-connector", claudeConnectorRoutes);

// Auth Routes
const authRoutes = require("./src/routes/auth_routes");
app.use("/api/auth", authRoutes);

// Media Routes
const mediaRoutes = require("./src/routes/media_routes");
app.use("/api/media", mediaRoutes);

// Bookmark Routes
const bookmarkRoutes = require("./src/routes/bookmark_routes");
app.use("/api/bookmarks", bookmarkRoutes);

// Knowledge Base Logic (Directly embedded to solve 404/500 issues)
const KBGroup = require("./src/models/KBGroup");
const KBArticle = require("./src/models/KBArticle");
const { protect: kbProtect } = require("./src/middleware/auth");

const kbTenantFilter = (req) => (!req.user?.is_superadmin && req.user?.tenant_id) ? { tenant_id: req.user.tenant_id } : {};

app.get("/api/kb/groups", kbProtect, async (req, res) => {
  try {
    const groups = await KBGroup.find({ active: true, ...kbTenantFilter(req) }).sort({ group_order: 1 });
    res.json(groups);
  } catch (err) {
    res.status(500).json({ message: err.message });
  }
});

app.post("/api/kb/groups", kbProtect, async (req, res) => {
  try {
    const { name, color, description, order, disabled } = req.body;
    const group = await KBGroup.create({ name, color, description, group_order: order, active: !disabled, tenant_id: req.user?.tenant_id });
    res.status(201).json(group);
  } catch (err) {
    res.status(500).json({ message: err.message });
  }
});

app.get("/api/kb/articles", kbProtect, async (req, res) => {
  try {
    const query = { ...kbTenantFilter(req) };
    if (req.query.all !== "true") query.active = true;
    if (req.query.group) query.group = req.query.group;
    const articles = await KBArticle.find(query).populate("group", "name color").sort({ article_order: 1 });
    res.json(articles);
  } catch (err) {
    res.status(500).json({ message: err.message });
  }
});

app.post("/api/kb/articles", kbProtect, async (req, res) => {
  try {
    const { subject, group, internal, disabled, description } = req.body;
    const article = await KBArticle.create({ subject, group, staff_article: internal, active: !disabled, description, tenant_id: req.user?.tenant_id });
    res.status(201).json(article);
  } catch (err) {
    res.status(500).json({ message: err.message });
  }
});

app.put("/api/kb/articles/:id", kbProtect, async (req, res) => {
  try {
    const { subject, group, internal, disabled, description } = req.body;
    const article = await KBArticle.findByIdAndUpdate(
      req.params.id,
      { subject, group, staff_article: internal, active: !disabled, description },
      { new: true }
    );
    if (!article) return res.status(404).json({ message: "Article not found" });
    res.json(article);
  } catch (err) {
    res.status(500).json({ message: err.message });
  }
});

app.delete("/api/kb/articles/:id", kbProtect, async (req, res) => {
  try {
    const article = await KBArticle.findByIdAndDelete(req.params.id);
    if (!article) return res.status(404).json({ message: "Article not found" });
    res.json({ message: "Article deleted successfully" });
  } catch (err) {
    res.status(500).json({ message: err.message });
  }
});

app.put("/api/kb/groups/:id", kbProtect, async (req, res) => {
  try {
    const { name, color, description, order, disabled } = req.body;
    const group = await KBGroup.findByIdAndUpdate(
      req.params.id,
      { name, color, description, group_order: order, active: !disabled },
      { new: true }
    );
    if (!group) return res.status(404).json({ message: "Group not found" });
    res.json(group);
  } catch (err) {
    res.status(500).json({ message: err.message });
  }
});

app.delete("/api/kb/groups/:id", kbProtect, async (req, res) => {
  try {
    const group = await KBGroup.findByIdAndDelete(req.params.id);
    if (!group) return res.status(404).json({ message: "Group not found" });
    res.json({ message: "Group deleted successfully" });
  } catch (err) {
    res.status(500).json({ message: err.message });
  }
});

app.get("/api/test-kb", (req, res) => res.json({ status: "ok", message: "KB direct routes active" }));

// Note Routes
console.log("Loading Note Routes...");
const noteRoutes = require("./src/routes/note_routes");
app.use("/api/notes", noteRoutes);

// Test Route
app.get("/api/ping", (req, res) => res.json({ message: "pong" }));

// Staff Routes
const staffRoutes = require("./src/routes/staff_routes");
app.use("/api/staff", staffRoutes);

// Client Routes
const clientRoutes = require("./src/routes/client_routes");
app.use("/api/clients", clientRoutes);

// Lead Routes
const leadRoutes = require("./src/routes/lead_routes");
app.use("/api/leads", leadRoutes);

// Daily marketing spend ("burning amount") for the Leads page
const marketingSpendRoutes = require("./src/routes/marketing_spend_routes");
app.use("/api/marketing-spend", marketingSpendRoutes);

// Per-tenant Meta Ads ad-account connections + spend sync
const metaAdsRoutes = require("./src/routes/meta_ads_routes");
app.use("/api/meta-ads", metaAdsRoutes);

// Webhook Routes
const webhookRoutes = require("./src/routes/webhook_routes");
app.use("/api/webhooks", webhookRoutes);

// Vapi.ai Webhooks
const vapiWebhookRoutes = require("./src/routes/vapi_webhook_routes");
app.use("/api/webhooks/vapi", vapiWebhookRoutes);

// WhatsApp Business Cloud API — webhook verification + incoming messages/status
const whatsappWebhookRoutes = require("./src/routes/whatsapp_webhook_routes");
app.use("/api/webhooks/whatsapp", whatsappWebhookRoutes);

// WhatsApp — campaigns, inbox, integration settings (auth-protected)
const whatsappCampaignRoutes = require("./src/routes/whatsapp_campaign_routes");
app.use("/api/whatsapp/campaigns", whatsappCampaignRoutes);

const whatsappInboxRoutes = require("./src/routes/whatsapp_inbox_routes");
app.use("/api/whatsapp/inbox", whatsappInboxRoutes);

const whatsappIntegrationRoutes = require("./src/routes/whatsapp_integration_routes");
app.use("/api/whatsapp/integration", whatsappIntegrationRoutes);

const whatsappTemplateConditionRoutes = require("./src/routes/whatsapp_template_condition_routes");
app.use("/api/whatsapp/template-conditions", whatsappTemplateConditionRoutes);

// Calling Agent — Exotel call webhooks (public, token-in-path auth; see
// src/models/CallingAgentIntegration.js for why there's no HMAC check)
const callingAgentWebhookRoutes = require("./src/routes/calling_agent_webhook_routes");
app.use("/api/calling-agent/webhook", callingAgentWebhookRoutes);

// Calling Agent — authenticated CRM-side actions (retry transcription, etc)
const callingAgentRoutes = require("./src/routes/calling_agent_routes");
app.use("/api/calling-agent", callingAgentRoutes);

// Serves live OG/Twitter meta tags to social-media crawlers only — nginx on
// the frontend's EC2 instance proxies known bot User-Agents here instead of
// the static SPA (which can't reflect live Setup > Settings data since
// crawlers never run its JS). See src/controllers/bot_preview_controller.js.
const botPreviewRoutes = require("./src/routes/bot_preview_routes");
app.use("/api/bot-preview", botPreviewRoutes);

// Serves a dynamic PWA manifest so the "Install app" dialog shows the live
// company logo/favicon from Settings instead of the static icon baked into
// the build. Nginx proxies /manifest.webmanifest on the frontend domain here.
// See src/controllers/pwa_manifest_controller.js.
const pwaManifestRoutes = require("./src/routes/pwa_manifest_routes");
app.use("/api/pwa-manifest", pwaManifestRoutes);


// Meta (Facebook) Lead Ads Integration Routes
const metaIntegrationRoutes = require("./src/routes/meta_integration_routes");
app.use("/api/meta-integration", metaIntegrationRoutes);

// WhatsApp Business Cloud API — inbound delivery/message webhook (public;
// tenant resolved from metadata.phone_number_id, see whatsapp_webhook_controller.js)
const whatsAppWebhookRoutes = require("./src/routes/whatsapp_webhook_routes");
app.use("/api/webhooks/whatsapp", whatsAppWebhookRoutes);

// WhatsApp Business Cloud API — authenticated CRM-side actions
const whatsAppIntegrationRoutes = require("./src/routes/whatsapp_integration_routes");
app.use("/api/whatsapp-integration", whatsAppIntegrationRoutes);
const whatsAppCampaignRoutes = require("./src/routes/whatsapp_campaign_routes");
app.use("/api/whatsapp/campaigns", whatsAppCampaignRoutes);
const whatsAppInboxRoutes = require("./src/routes/whatsapp_inbox_routes");
app.use("/api/whatsapp/inbox", whatsAppInboxRoutes);
const whatsAppTemplateConditionRoutes = require("./src/routes/whatsapp_template_condition_routes");
app.use("/api/whatsapp/conditions", whatsAppTemplateConditionRoutes);

const websiteLeadFormRoutes = require("./src/routes/website_lead_form_routes");
app.use("/api/website-lead-forms", websiteLeadFormRoutes);

const websiteLeadPublicRoutes = require("./src/routes/website_lead_public_routes");
app.use("/api/public/website-leads", websiteLeadPublicRoutes);

// Admin-configured external API data sources shown as Dashboard table widgets
const externalDataSourceRoutes = require("./src/routes/external_data_source_routes");
app.use("/api/external-data-sources", externalDataSourceRoutes);

// Project Routes
const projectRoutes = require("./src/routes/project_routes");
app.use("/api/projects", projectRoutes);

// Task Routes
const taskRoutes = require("./src/routes/task_routes");
app.use("/api/tasks", taskRoutes);

// Role Routes
const roleRoutes = require("./src/routes/role_routes");
app.use("/api/roles", roleRoutes);

// Custom Field Routes
const customFieldRoutes = require("./src/routes/custom_field_routes");
app.use("/api/custom-fields", customFieldRoutes);

// Client Group Routes
const clientGroupRoutes = require("./src/routes/client_group_routes");
app.use("/api/client-groups", clientGroupRoutes);

// Lead Pipeline Routes
const leadPipelineRoutes = require("./src/routes/lead_pipeline_routes");
app.use("/api/lead-pipeline", leadPipelineRoutes);

// Invoice Routes
const invoiceRoutes = require("./src/routes/invoice_routes");
app.use("/api/invoices", invoiceRoutes);

// Payment Routes
const paymentRoutes = require("./src/routes/payment_routes");
app.use("/api/payments", paymentRoutes);

// Estimate Routes
const estimateRoutes = require("./src/routes/estimate_routes");
app.use("/api/estimates", estimateRoutes);

// Proposal Routes
const proposalRoutes = require("./src/routes/proposal_routes");
app.use("/api/proposals", proposalRoutes);

// Item Routes
const itemRoutes = require("./src/routes/item_routes");
app.use("/api/items", itemRoutes);

// Tax Routes
const taxRoutes = require("./src/routes/tax_routes");
app.use("/api/taxes", taxRoutes);

// Ticket Routes
const ticketRoutes = require("./src/routes/ticket_routes");
app.use("/api/tickets", ticketRoutes);

// Milestone Routes
const milestoneRoutes = require("./src/routes/milestone_routes");
app.use("/api/milestones", milestoneRoutes);

// Announcement Logic (Directly embedded to solve 404 issues)
const Announcement = require("./src/models/Announcement");

// Announcements are per company: login required, and each company only sees
// its own (plus any old company-less ones created before this was scoped).
const { protect: announcementProtect } = require("./src/middleware/auth");
const announcementScope = (req) => ({ $or: [{ tenant_id: req.user.tenant_id || null }, { tenant_id: null }] });

// Subject, a non-empty message (rich text "<br>" alone counts as empty) and at
// least one audience are required, otherwise the announcement is invisible to
// everyone and can no longer be managed.
const announcementError = (data, isNew) => {
  if ((isNew || data.name !== undefined) && !String(data.name ?? "").trim()) return "Subject is required";
  if ((isNew || data.message !== undefined) && !String(data.message ?? "").replace(/<[^>]*>/g, "").replace(/&nbsp;/g, " ").trim()) return "Message is required";
  if ((isNew || data.showtostaff !== undefined || data.showtousers !== undefined) && data.showtostaff === false && data.showtousers === false) {
    return "Select at least one: Show to Staff or Show to Clients";
  }
  return null;
};

app.get("/api/announcements", announcementProtect, async (req, res) => {
  try {
    // Admins see every announcement of their company (so client-only ones can
    // still be managed); other staff only see the ones meant for staff.
    const audience = req.user.admin || req.user.is_superadmin ? {} : { showtostaff: true };
    const announcements = await Announcement.find({ $and: [announcementScope(req), audience] })
      .populate("created_by", "firstname lastname")
      .sort({ dateadded: -1 });
    res.json(announcements);
  } catch (error) {
    res.status(500).json({ message: error.message });
  }
});

app.get("/api/announcements/:id", announcementProtect, async (req, res) => {
  try {
    const announcement = await Announcement.findOne({ _id: req.params.id, ...announcementScope(req) }).populate("created_by", "firstname lastname");
    if (!announcement) return res.status(404).json({ message: "Announcement not found" });
    res.json(announcement);
  } catch (error) {
    res.status(500).json({ message: error.message });
  }
});

app.post("/api/announcements", announcementProtect, async (req, res) => {
  try {
    const { tenant_id, created_by, _id, ...data } = req.body;
    const invalid = announcementError(data, true);
    if (invalid) return res.status(400).json({ message: invalid });
    const announcement = await Announcement.create({ ...data, tenant_id: req.user.tenant_id || null, created_by: req.user._id });
    res.status(201).json(announcement);
  } catch (error) {
    res.status(500).json({ message: error.message });
  }
});

app.put("/api/announcements/:id", announcementProtect, async (req, res) => {
  try {
    const { tenant_id, created_by, _id, ...update } = req.body;
    const invalid = announcementError(update, false);
    if (invalid) return res.status(400).json({ message: invalid });
    const announcement = await Announcement.findOneAndUpdate({ _id: req.params.id, tenant_id: req.user.tenant_id || null }, update, { new: true });
    if (!announcement) return res.status(404).json({ message: "Announcement not found" });
    res.json(announcement);
  } catch (error) {
    res.status(500).json({ message: error.message });
  }
});

app.delete("/api/announcements/:id", announcementProtect, async (req, res) => {
  try {
    const announcement = await Announcement.findOneAndDelete({ _id: req.params.id, tenant_id: req.user.tenant_id || null });
    if (!announcement) return res.status(404).json({ message: "Announcement not found" });
    res.json({ message: "Announcement deleted" });
  } catch (error) {
    res.status(500).json({ message: error.message });
  }
});

// Todo Routes
const todoRoutes = require("./src/routes/todo_routes");
app.use("/api/todos", todoRoutes);

// Expense Routes
const expenseRoutes = require("./src/routes/expense_routes");
app.use("/api/expenses", expenseRoutes);

// Purchase Routes
const purchaseRoutes = require("./src/routes/purchase_routes");
app.use("/api/purchases", purchaseRoutes);
const vendorRoutes = require("./src/routes/vendor_routes");
app.use("/api/vendors", vendorRoutes);

// Subscription Routes
const subscriptionRoutes = require("./src/routes/subscription_routes");
app.use("/api/subscriptions", subscriptionRoutes);

// Activity Log Routes
const activityLogRoutes = require("./src/routes/activity_log_routes");
app.use("/api/activity-logs", activityLogRoutes);

// Ticket Pipe Log Routes
const ticketPipeLogRoutes = require("./src/routes/ticket_pipe_log_routes");
app.use("/api/ticket-pipe-logs", ticketPipeLogRoutes);

// Setting Routes
const settingRoutes = require("./src/routes/setting_routes");
app.use("/api/settings", settingRoutes);

// Main Sidebar Routes
const mainSidebarRoutes = require("./src/routes/mainsidebar_routes");
app.use("/api/mainsidebar", mainSidebarRoutes);

// Report Routes
const reportRoutes = require("./src/routes/report_routes");
app.use("/api/reports", reportRoutes);

// Contract Routes
const contractRoutes = require("./src/routes/contract_routes");
app.use("/api/contracts", contractRoutes);

// Credit Note Routes
const creditNoteRoutes = require("./src/routes/credit_note_routes");
app.use("/api/credit-notes", creditNoteRoutes);

// Department Routes
const departmentRoutes = require("./src/routes/department_routes");
app.use("/api/departments", departmentRoutes);

// Priority Routes
const priorityRoutes = require("./src/routes/priority_routes");
app.use("/api/priorities", priorityRoutes);

// Ticket Status Routes
const ticketStatusRoutes = require("./src/routes/ticket_status_routes");
app.use("/api/ticket-statuses", ticketStatusRoutes);

// Chat Routes
const chatRoutes = require("./src/routes/chat_routes");
app.use("/api/chat", chatRoutes);

// Service Routes
const serviceRoutes = require("./src/routes/service_routes");
app.use("/api/services", serviceRoutes);

// Spam Filter Routes
const spamFilterRoutes = require("./src/routes/spam_filter_routes");
app.use("/api/spam-filters", spamFilterRoutes);

// Lead Source Routes
const leadSourceRoutes = require("./src/routes/lead_source_routes");
app.use("/api/lead-sources", leadSourceRoutes);

// Lead Status Routes
const leadStatusRoutes = require("./src/routes/lead_status_routes");
app.use("/api/lead-statuses", leadStatusRoutes);

// Currency Routes
const currencyRoutes = require("./src/routes/currency_routes");
app.use("/api/currencies", currencyRoutes);

// Payment Mode Routes
const paymentModeRoutes = require("./src/routes/payment_mode_routes");
app.use("/api/payment-modes", paymentModeRoutes);

// Bank Detail Routes
const bankDetailRoutes = require("./src/routes/bank_detail_routes");
app.use("/api/bank-details", bankDetailRoutes);

// Expense Category Routes
const expenseCategoryRoutes = require("./src/routes/expense_category_routes");
app.use("/api/expense-categories", expenseCategoryRoutes);

// Contract Type Routes
const contractTypeRoutes = require("./src/routes/contract_type_routes");
app.use("/api/contract-types", contractTypeRoutes);

// Estimate Status Routes
const estimateStatusRoutes = require("./src/routes/estimate_status_routes");
app.use("/api/estimate-statuses", estimateStatusRoutes);

// Module Routes
const moduleRoutes = require("./src/routes/module_routes");
app.use("/api/modules", moduleRoutes);

// Consent Purpose Routes (Setup > GDPR > Consent)
const consentPurposeRoutes = require("./src/routes/consent_purpose_routes");
app.use("/api/consent-purposes", consentPurposeRoutes);

// GDPR Settings Routes (Setup > GDPR tabs other than Consent Purposes)
const gdprSettingRoutes = require("./src/routes/gdpr_setting_routes");
app.use("/api/gdpr-settings", gdprSettingRoutes);

// Goal Routes
const goalRoutes = require("./src/routes/goal_routes");
app.use("/api/goals", goalRoutes);

// Estimate Request Form Routes
const estimateRequestFormRoutes = require("./src/routes/estimate_request_form_routes");
app.use("/api/estimate-request-forms", estimateRequestFormRoutes);

// Estimate Request Routes
const estimateRequestRoutes = require("./src/routes/estimate_request_routes");
app.use("/api/estimate-requests", estimateRequestRoutes);

// Meeting Routes
const meetingRoutes = require("./src/routes/meeting_routes");
app.use("/api/meetings", meetingRoutes);

// Time Entry Routes
const timeEntryRoutes = require("./src/routes/time_entry_routes");
app.use("/api/time-entries", timeEntryRoutes);

// Calendar Event Routes
const calendarEventRoutes = require("./src/routes/calendar_event_routes");
app.use("/api/calendar-events", calendarEventRoutes);

// Predefined Reply Routes
const predefinedReplyRoutes = require("./src/routes/predefined_reply_routes");
app.use("/api/predefined-replies", predefinedReplyRoutes);

// Email Template Routes
const emailTemplateRoutes = require("./src/routes/email_template_routes");
app.use("/api/email-templates", emailTemplateRoutes);

// FAQ Routes
const faqRoutes = require("./src/routes/faqRoutes");
app.use("/api/faqs", faqRoutes);

// Single-company server: no Super Admin routes (the separate Super Admin panel
// manages this server through /api/control), and no self-service signup (that
// would create new companies here). Only the read-only plan list stays public.
app.use("/api/public", require("./src/routes/public_routes"));

// Generic Reminder Routes (rel_id/rel_type — used by tasks, and any future module)
const reminderRoutes = require("./src/routes/reminder_routes");
app.use("/api/reminders", reminderRoutes);

// Generic File Routes (rel_id/rel_type — used by tasks, and any future module)
const fileRoutes = require("./src/routes/file_routes");
app.use("/api/files", fileRoutes);


// CRM Agent Assistant Routes (Claude API gateway)
const assistantRoutes = require("./src/routes/assistant_routes");
app.use("/api/assistant", assistantRoutes);

// Quotation Routes
const quotationRoutes = require("./src/routes/quotation_routes");
app.use("/api/quotations", quotationRoutes);

// Quotation Types (dynamic "Quotation Maker" sidebar entries)
const quotationTypeRoutes = require("./src/routes/quotation_type_routes");
app.use("/api/quotation-types", quotationTypeRoutes);

// Purchase Orders (tenant add-on "purchase_orders")
const purchaseOrderRoutes = require("./src/routes/purchase_order_routes");
app.use("/api/purchase-orders", purchaseOrderRoutes);

// Purchase Procurement Types (tenant add-on "procurement_types")
const purchaseCategoryRoutes = require("./src/routes/purchase_category_routes");
app.use("/api/purchase-categories", purchaseCategoryRoutes);

const factoryLocationRoutes = require("./src/routes/factory_location_routes");
app.use("/api/locations", factoryLocationRoutes);

// HRMS Routes
const hrmsRoutes = require("./src/hrms/routes/index");
app.use("/api/hrms", hrmsRoutes);

// Base route
app.get("/", (req, res) => {
  res.send("CRM API is running...");
});

// Start server
const PORT = process.env.PORT || 5000;
const http = require("http");
const { Server } = require("socket.io");

const server = http.createServer(app);
const io = new Server(server, {
  cors: {
    origin: allowedOrigins,
    credentials: true,
  },
});

app.set('io', io);


io.on("connection", (socket) => {
  socket.on("join", (userId) => {
    socket.join(userId);
  });
});

// Calling Agent — async transcription/summary worker (Mongo-backed queue,
// see src/jobs/callingAgentTranscriptionWorker.js for why not BullMQ+Redis)
require("./src/jobs/callingAgentTranscriptionWorker").start(io);
// Reminder delivery (Leads + Customers) — checks every minute for reminders
// whose time has arrived and pushes a live notification to the assigned
// staff member's socket room; also nudges a Lead to "Pending" when its
// reminder fires (see src/cron/reminderDelivery.js).
require("./src/cron/reminderDelivery").start(io);
// Task deadline reminders + ticket auto-close (Setup > Settings > Cron Job).
require("./src/cron/taskTicketAutomation").start(io);
// Meta Ads daily spend sync for tenants with connected ad accounts
require("./src/cron/metaAdsSpendSync").start();
// WhatsApp monthly recurring-campaign cron (see src/cron/whatsappMonthlyCampaign.js)
require("./src/cron/whatsappMonthlyCampaign").start();
// Marks companies expired when their plan/trial end date passes (dry run
// until TENANT_EXPIRY_DRY_RUN=false — see src/cron/tenantExpiry.js)
require("./src/cron/tenantExpiry").start();
// Nightly cleanup of old activity logs (Setup > Settings > Misc).
require("./src/cron/activityLogCleanup").start();
// Global Error Handler
app.use((err, req, res, next) => {
  console.error("Unhandled Global Error:", err);
  // Guarantee CORS headers on error responses for allowed origins, so a 500
  // is reported to the browser as a real error instead of a misleading
  // "blocked by CORS policy" (header-less) failure.
  const origin = req.headers.origin;
  if (origin && allowedOrigins.includes(origin)) {
    res.header("Access-Control-Allow-Origin", origin);
    res.header("Access-Control-Allow-Credentials", "true");
  }
  // Errors marked as client errors (e.g. a file type rejected by Setup >
  // Settings > Allowed file types) keep their status and plain message.
  if (err.status >= 400 && err.status < 500) {
    return res.status(err.status).json({ message: err.message });
  }
  res.status(500).json({ message: "Global Server Error: " + err.message });
});

server.listen(PORT, "0.0.0.0", () => console.log(`Server running on port ${PORT}`));
