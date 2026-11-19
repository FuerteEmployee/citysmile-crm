const mongoose = require("mongoose");
const Lead = require("../models/Lead");
const Client = require("../models/Client");
const Note = require("../models/Note");
const Task = require("../models/Task");
const Invoice = require("../models/Invoice");
const Project = require("../models/Project");
const Ticket = require("../models/Ticket");
const Payment = require("../models/Payment");
const Expense = require("../models/Expense");
const Tenant = require("../models/Tenant");
const Call = require("../models/Call");
const CallTranscript = require("../models/CallTranscript");
const Staff = require("../models/Staff");
const { registry } = require("../config/assistantModules");

// Escapes special characters for regex search
const escapeRegex = (str) => String(str || "").replace(/[.*+?^${}()|[\]\\]/g, "\\$&");

// Normalize phone to last 10 digits
const extractLast10Digits = (phone) => {
  const digits = String(phone || "").replace(/\D/g, "");
  return digits.length >= 10 ? digits.slice(-10) : digits; i
};

// Format currency for voice
const formatCurrency = (val) => {
  const num = Number(val || 0);
  return num.toLocaleString("en-IN") + " rupaye";
};

// Format date for voice
const formatDateForVoice = (date) => {
  if (!date) return "date set nahi hai";
  try {
    const d = new Date(date);
    if (isNaN(d.getTime())) return "invalid date";
    return d.toLocaleDateString("hi-IN", {
      day: "numeric",
      month: "short",
      year: "numeric",
    });
  } catch (_) {
    return "date set nahi hai";
  }
};

// Single-company server: every Vapi call belongs to this server's only
// company (TENANT_ID). Ids/names sent in the request are never trusted.
async function resolveTenantId() {
  return process.env.TENANT_ID || null;
}

// Convert string/ObjectId to safe ObjectId filter
function toObjectIdFilter(id) {
  if (!id) return null;
  return mongoose.Types.ObjectId.isValid(id) ? new mongoose.Types.ObjectId(id) : id;
}

// ─────────────────────────────────────────────────────────────────
// TOOL HANDLERS
// ─────────────────────────────────────────────────────────────────

// 1. Check Lead Status
async function handleCheckLead(args, tenantId) {
  const phoneRaw = args?.phone || "";
  const nameRaw = args?.name || "";
  const phone10 = extractLast10Digits(phoneRaw);

  const query = {};
  if (tenantId) query.tenant_id = toObjectIdFilter(tenantId);

  if (phone10.length >= 7) {
    query.$or = [
      { phone_last10: phone10 },
      { phonenumber: { $regex: phone10 } },
    ];
  } else if (nameRaw) {
    const q = escapeRegex(nameRaw.trim());
    query.$or = [
      { name: { $regex: q, $options: "i" } },
      { company: { $regex: q, $options: "i" } },
    ];
  } else {
    return "Lead search karne ke liye phone number ya naam batayein.";
  }

  const lead = await Lead.findOne(query)
    .populate("status", "name")
    .populate("source", "name")
    .populate("assigned", "firstname lastname")
    .lean();

  if (!lead) {
    return "Mujhe is number ya naam se koi lead nahi mila CRM mein. Kya aap dusra naam ya number bata sakte hain?";
  }

  const assignedTo = lead.assigned
    ? `${lead.assigned.firstname || ""} ${lead.assigned.lastname || ""}`.trim()
    : "Kisi ko assign nahi kiya gaya";

  const followup = formatDateForVoice(lead.followup_date);
  const lastContact = formatDateForVoice(lead.lastcontact);
  const statusName = lead.status?.name || "Status set nahi hai";

  let reply = `Lead mil gaya! Naam: ${lead.name}. Status: ${statusName}. Source: ${lead.source?.name || "Unknown"}. Assigned to: ${assignedTo}. Next Followup: ${followup}. Last Contact: ${lastContact}.`;
  if (lead.lost) reply += " Note: Ye lead lost mark ki gayi hai.";
  if (lead.converted) reply += " Note: Ye lead ek client mein convert ho chuki hai.";

  return reply;
}

// 2. Get Client / Customer Info
async function handleGetClient(args, tenantId) {
  const phoneRaw = args?.phone || "";
  const nameRaw = args?.company || args?.name || "";
  const phone10 = extractLast10Digits(phoneRaw);

  const query = {};
  if (tenantId) query.tenant_id = toObjectIdFilter(tenantId);

  if (phone10.length >= 7) {
    query.$or = [
      { phonenumber: { $regex: phone10 } },
      { phoneE164: { $regex: phone10 } },
    ];
  } else if (nameRaw) {
    const q = escapeRegex(nameRaw.trim());
    query.$or = [
      { company: { $regex: q, $options: "i" } },
      { contact_person: { $regex: q, $options: "i" } },
    ];
  } else {
    return "Client find karne ke liye company ka naam ya phone number batayein.";
  }

  const client = await Client.findOne(query).lean();
  if (!client) {
    return "Is jaankari se koi existing client CRM mein nahi mila. Kya aap naya account check karna chahte hain?";
  }

  // Also check if they have open invoices
  let invoiceSummary = "";
  try {
    const openInvoicesCount = await Invoice.countDocuments({
      client: client._id,
      status: { $in: ["unpaid", "partially_paid", "overdue"] },
    });
    if (openInvoicesCount > 0) {
      invoiceSummary = ` Is client ke ${openInvoicesCount} unpaid invoices pending hain.`;
    }
  } catch (_) { }

  return `Client details mil gayi. Company: ${client.company}. Contact person: ${client.contact_person || "Not specified"}. Phone: ${client.phonenumber || "Not available"}. Email: ${client.email || "Not available"}. Status: ${client.active ? "Active" : "Inactive"}.${invoiceSummary}`;
}

// 2b. Dedicated Company Search (searches Clients, Leads, and Tenants)
async function handleSearchCompany(args, tenantId) {
  const companyRaw = (args?.company_name || args?.company || args?.name || args?.query || "").trim();

  if (!companyRaw) {
    return "Company search karne ke liye company ka naam batayein.";
  }

  const safeTenant = toObjectIdFilter(tenantId);
  const baseFilter = safeTenant ? { tenant_id: safeTenant } : {};
  const q = escapeRegex(companyRaw);

  // 1. Search in Clients (Customers)
  const matchingClients = await Client.find({
    ...baseFilter,
    $or: [
      { company: { $regex: q, $options: "i" } },
      { contact_person: { $regex: q, $options: "i" } },
    ],
  }).limit(5).lean();

  if (matchingClients && matchingClients.length > 0) {
    if (matchingClients.length === 1) {
      const client = matchingClients[0];
      let details = `Company mil gayi: ${client.company}. Contact person: ${client.contact_person || "Not specified"}. Phone: ${client.phonenumber || "Not available"}. Email: ${client.email || "Not available"}. Status: ${client.active ? "Active" : "Inactive"}.`;

      // Check open invoices and projects for this company
      try {
        const [openInvoices, activeProjects] = await Promise.all([
          Invoice.aggregate([
            { $match: { client: client._id, status: { $in: ["unpaid", "partially_paid", "overdue"] } } },
            { $group: { _id: null, count: { $sum: 1 }, totalDue: { $sum: "$total" } } },
          ]),
          Project.countDocuments({ clientid: client._id, status: { $in: [1, 2, 3] } }),
        ]);

        if (openInvoices[0] && openInvoices[0].count > 0) {
          details += ` Is company ke ${openInvoices[0].count} unpaid invoices pending hain jinki kul rakam ${formatCurrency(openInvoices[0].totalDue)} hai.`;
        }
        if (activeProjects > 0) {
          details += ` Sath hi ${activeProjects} active projects chal rahe hain.`;
        }
      } catch (_) { }

      return details;
    }

    // Multiple companies matched
    const companyNames = matchingClients.map((c) => c.company).join(", ");
    return `"${companyRaw}" naam se ${matchingClients.length} companies mili: ${companyNames}. Aap kis company ke baare mein janna chahte hain?`;
  }

  // 2. Search in Leads
  const matchingLeads = await Lead.find({
    ...baseFilter,
    company: { $regex: q, $options: "i" },
  })
    .populate("status", "name")
    .populate("assigned", "firstname lastname")
    .limit(3)
    .lean();

  if (matchingLeads && matchingLeads.length > 0) {
    const lead = matchingLeads[0];
    const assigned = lead.assigned
      ? `${lead.assigned.firstname || ""} ${lead.assigned.lastname || ""}`.trim()
      : "Kisi ko assign nahi";
    return `Ye company hamare CRM mein ek Lead ke roop mein darj hai: ${lead.company} (Contact: ${lead.name}). Status: ${lead.status?.name || "Pending"}. Assigned to: ${assigned}. Phone: ${lead.phonenumber || "Not specified"}.`;
  }

  // 3. Search in Tenants
  try {
    const tenantDoc = await Tenant.findOne({
      company_name: { $regex: q, $options: "i" },
    }).lean();
    if (tenantDoc) {
      return `"${tenantDoc.company_name}" CRM mein ek registered tenant organization hai. Status: ${tenantDoc.status || "Active"}.`;
    }
  } catch (_) { }

  return `CRM mein "${companyRaw}" naam se koi company nahi mili. Kya aap koi dusra naam check karna chahte hain?`;
}

// 3. Get CRM Stats & Analytics
async function handleGetCRMStats(args, tenantId) {
  const matchFilter = {};
  if (tenantId) {
    matchFilter.tenant_id = toObjectIdFilter(tenantId);
  }

  const [leadStats, clientStats, invoiceStats, taskStats, paymentStats, expenseStats] = await Promise.all([
    Lead.aggregate([
      { $match: matchFilter },
      {
        $group: {
          _id: null,
          total: { $sum: 1 },
          converted: { $sum: { $cond: [{ $eq: ["$converted", true] }, 1, 0] } },
          lost: { $sum: { $cond: [{ $eq: ["$lost", true] }, 1, 0] } },
          junk: { $sum: { $cond: [{ $eq: ["$junk", true] }, 1, 0] } },
        },
      },
    ]),
    Client.aggregate([
      { $match: matchFilter },
      {
        $group: {
          _id: null,
          total: { $sum: 1 },
          active: { $sum: { $cond: [{ $eq: ["$active", 1] }, 1, 0] } },
        },
      },
    ]),
    Invoice.aggregate([
      { $match: matchFilter },
      {
        $group: {
          _id: null,
          totalCount: { $sum: 1 },
          totalAmount: { $sum: "$total" },
          unpaidCount: {
            $sum: { $cond: [{ $in: ["$status", ["unpaid", "partially_paid", "overdue"]] }, 1, 0] },
          },
          unpaidAmount: {
            $sum: {
              $cond: [
                { $in: ["$status", ["unpaid", "partially_paid", "overdue"]] },
                "$total",
                0,
              ],
            },
          },
        },
      },
    ]),
    Task.countDocuments({ ...matchFilter, status: { $in: [1, 2, 3, 4] } }),
    Payment.aggregate([
      { $match: matchFilter },
      { $group: { _id: null, totalReceived: { $sum: "$amount" } } },
    ]),
    Expense.aggregate([
      { $match: matchFilter },
      { $group: { _id: null, totalSpent: { $sum: "$amount" } } },
    ]),
  ]);

  const lData = leadStats[0] || { total: 0, converted: 0, lost: 0, junk: 0 };
  const cData = clientStats[0] || { total: 0, active: 0 };
  const iData = invoiceStats[0] || { totalCount: 0, totalAmount: 0, unpaidCount: 0, unpaidAmount: 0 };
  const revData = paymentStats[0] || { totalReceived: 0 };
  const expData = expenseStats[0] || { totalSpent: 0 };

  const activeLeads = Math.max(0, lData.total - lData.converted - lData.lost - lData.junk);

  const metric = (args?.metric || "all").toLowerCase();

  if (metric === "leads") {
    return `Total leads ${lData.total} hain, jisme se ${activeLeads} active leads hain, ${lData.converted} converted hain, aur ${lData.lost} lost leads hain.`;
  }
  if (metric === "clients" || metric === "customers") {
    return `Total clients ${cData.total} hain, jisme se ${cData.active} active clients hain.`;
  }
  if (metric === "invoices" || metric === "billing") {
    return `Total invoices ${iData.totalCount} hain jinki value ${formatCurrency(iData.totalAmount)} hai. ${iData.unpaidCount} unpaid invoices pending hain jinki value ${formatCurrency(iData.unpaidAmount)} hai.`;
  }
  if (metric === "revenue" || metric === "payments") {
    return `Total received payment ${formatCurrency(revData.totalReceived)} hai.`;
  }
  if (metric === "expenses") {
    return `Total expenses ${formatCurrency(expData.totalSpent)} hain.`;
  }
  if (metric === "tasks") {
    return `Abhi CRM mein ${taskStats} pending tasks open hain.`;
  }

  // Default: Full concise summary
  return `CRM Summary: Total Leads: ${lData.total} (${activeLeads} active). Total Clients: ${cData.total} (${cData.active} active). Pending Tasks: ${taskStats}. Invoices: ${iData.unpaidCount} unpaid invoices pending (${formatCurrency(iData.unpaidAmount)}). Total Revenue received: ${formatCurrency(revData.totalReceived)}.`;
}

// 4. Get Invoice Details
async function handleGetInvoice(args, tenantId) {
  const invoiceNumber = args?.invoice_number || args?.number || "";
  const clientName = args?.client_name || args?.client || "";

  const query = {};
  if (tenantId) query.tenant_id = toObjectIdFilter(tenantId);

  if (invoiceNumber) {
    const q = escapeRegex(invoiceNumber.trim());
    query.number = { $regex: q, $options: "i" };
  } else if (clientName) {
    const matchingClients = await Client.find({
      company: { $regex: escapeRegex(clientName.trim()), $options: "i" },
    }).select("_id").limit(5).lean();

    if (matchingClients.length > 0) {
      query.client = { $in: matchingClients.map((c) => c._id) };
    }
  }

  const invoices = await Invoice.find(query)
    .populate("client", "company")
    .sort({ date: -1 })
    .limit(3)
    .lean();

  if (!invoices || invoices.length === 0) {
    return "Mujhe koi invoice nahi mila is search se. Kya aap invoice number jaise INV-1001 batana chahenge?";
  }

  if (invoices.length === 1) {
    const inv = invoices[0];
    const clientCompany = inv.client?.company || "Unknown Client";
    const dueStr = formatDateForVoice(inv.duedate);
    return `Invoice number ${inv.number}: Client ${clientCompany}. Total amount ${formatCurrency(inv.total)}. Status: ${inv.status}. Due date: ${dueStr}.`;
  }

  const list = invoices
    .map(
      (inv) =>
        `Invoice ${inv.number} (${inv.client?.company || "Client"}): ${formatCurrency(inv.total)}, Status: ${inv.status}`
    )
    .join(". ");

  return `Mujhe ${invoices.length} invoices mile: ${list}.`;
}

// 5. Get Tasks
async function handleGetTasks(args, tenantId) {
  const statusParam = (args?.status || "pending").toLowerCase();
  const nameParam = args?.name || args?.query || "";

  const query = {};
  if (tenantId) query.tenant_id = toObjectIdFilter(tenantId);

  if (statusParam === "completed" || statusParam === "done") {
    query.status = 5;
  } else if (statusParam === "pending" || statusParam === "open") {
    query.status = { $in: [1, 2, 3, 4] };
  }

  if (nameParam) {
    query.name = { $regex: escapeRegex(nameParam.trim()), $options: "i" };
  }

  const tasks = await Task.find(query).sort({ duedate: 1, priority: -1 }).limit(4).lean();

  if (!tasks || tasks.length === 0) {
    return "Is criteria ke koi tasks nahi mile CRM mein.";
  }

  const PRIORITY_MAP = { 1: "Low", 2: "Medium", 3: "High", 4: "Urgent" };
  const STATUS_MAP = { 1: "Not Started", 2: "Feedback", 3: "Testing", 4: "In Progress", 5: "Complete" };

  const taskList = tasks
    .map((t, idx) => {
      const p = PRIORITY_MAP[t.priority] || "Medium";
      const s = STATUS_MAP[t.status] || "Pending";
      const due = formatDateForVoice(t.duedate);
      return `${idx + 1}. ${t.name} (Priority: ${p}, Status: ${s}, Due: ${due})`;
    })
    .join(". ");

  return `Aapke ${tasks.length} tasks mile: ${taskList}.`;
}

// 6. Get Project Details
async function handleGetProjects(args, tenantId) {
  const name = args?.name || args?.project || "";
  const query = {};
  if (tenantId) query.tenant_id = toObjectIdFilter(tenantId);

  if (name) {
    query.name = { $regex: escapeRegex(name.trim()), $options: "i" };
  }

  const projects = await Project.find(query)
    .populate("clientid", "company")
    .sort({ project_created: -1 })
    .limit(3)
    .lean();

  if (!projects || projects.length === 0) {
    return "Is naam se koi project nahi mila CRM mein.";
  }

  const STATUS_MAP = { 1: "Not Started", 2: "In Progress", 3: "On Hold", 4: "Finished", 5: "Cancelled" };

  const projectList = projects
    .map((p) => {
      const client = p.clientid?.company || "Unknown";
      const s = STATUS_MAP[p.status] || "Active";
      return `Project "${p.name}" (Client: ${client}, Status: ${s}, Progress: ${p.progress || 0}%)`;
    })
    .join(". ");

  return `Projects mil gaye: ${projectList}.`;
}

// 7. Get Support Tickets
async function handleGetTickets(args, tenantId) {
  const subject = args?.subject || args?.query || "";
  const query = {};
  if (tenantId) query.tenant_id = toObjectIdFilter(tenantId);

  if (subject) {
    query.subject = { $regex: escapeRegex(subject.trim()), $options: "i" };
  } else {
    query.status = { $ne: "closed" };
  }

  const tickets = await Ticket.find(query)
    .populate("client", "company")
    .sort({ date: -1 })
    .limit(3)
    .lean();

  if (!tickets || tickets.length === 0) {
    return "Koi open support ticket nahi mila.";
  }

  const ticketList = tickets
    .map((t) => `Ticket "${t.subject}" for ${t.client?.company || "Client"} (Status: ${t.status})`)
    .join(". ");

  return `Tickets mil gaye: ${ticketList}.`;
}

// 8. Create Lead Directly from Voice Call
async function handleCreateLead(args, tenantId) {
  const name = args?.name?.trim();
  const phone = args?.phone || args?.phonenumber || "";
  const company = args?.company || "";
  const email = args?.email || "";
  const description = args?.description || args?.notes || "Lead created by Vapi Voice AI Agent";

  if (!name) {
    return "Lead create karne ke liye customer ka naam zaroori hai. Kripya naam batayein.";
  }

  const leadData = {
    name,
    company,
    phonenumber: phone,
    email,
    description,
    dateadded: new Date(),
    origin: "vapi_voice_agent",
  };

  if (tenantId) leadData.tenant_id = toObjectIdFilter(tenantId);

  const newLead = await Lead.create(leadData);
  return `Lead successfully create ho gaya hai! Naam: ${newLead.name}, Phone: ${phone || "Not provided"}. CRM ID: ${newLead._id}.`;
}

// 9. Create Task from Voice Call
async function handleCreateTask(args, tenantId) {
  const name = args?.name?.trim();
  const description = args?.description || "Created by Voice AI Agent";
  const priorityRaw = (args?.priority || "medium").toLowerCase();

  if (!name) {
    return "Task create karne ke liye task ka title ya naam batayein.";
  }

  const PRIORITY_LOOKUP = { low: 1, medium: 2, high: 3, urgent: 4 };
  const priority = PRIORITY_LOOKUP[priorityRaw] || 2;

  let duedate = null;
  if (args?.duedate) {
    duedate = new Date(args.duedate);
  } else {
    // Default: tomorrow
    duedate = new Date(Date.now() + 24 * 60 * 60 * 1000);
  }

  const taskData = {
    name,
    description,
    priority,
    status: 1, // Not started
    duedate,
    dateadded: new Date(),
  };

  if (tenantId) taskData.tenant_id = toObjectIdFilter(tenantId);

  const newTask = await Task.create(taskData);
  return `Task successfully create kar diya gaya hai: "${newTask.name}". Due date: ${formatDateForVoice(newTask.duedate)}.`;
}

// 10. Add Note to Lead or Client
async function handleAddNote(args, tenantId) {
  const noteText = args?.note || args?.description || "";
  const phoneRaw = args?.phone || "";
  const phone10 = extractLast10Digits(phoneRaw);

  if (!noteText) {
    return "Note add karne ke liye note ka content batayein.";
  }

  const query = {};
  if (tenantId) query.tenant_id = toObjectIdFilter(tenantId);

  let target = null;
  let relType = "lead";

  if (phone10.length >= 7) {
    target = await Lead.findOne({ ...query, phone_last10: phone10 }).lean();
    if (!target) {
      target = await Client.findOne({
        ...query,
        $or: [{ phonenumber: { $regex: phone10 } }, { phoneE164: { $regex: phone10 } }],
      }).lean();
      if (target) relType = "customer";
    }
  }

  if (!target && args?.lead_id) {
    target = await Lead.findById(args.lead_id).lean();
    relType = "lead";
  }

  if (!target) {
    return "Note attach karne ke liye koi valid lead ya client nahi mila phone number se.";
  }

  await Note.create({
    rel_id: target._id,
    rel_type: relType,
    description: `🎙️ Voice Note: ${noteText}`,
    tenant_id: tenantId || target.tenant_id,
    dateadded: new Date(),
  });

  return `Note successfully save ho gaya hai ${relType} "${target.name || target.company}" ke record mein.`;
}

// 11. Search Across Any CRM Module (Universal Search)
async function handleSearchCRM(args, tenantId) {
  const modKey = (args?.module || "").toLowerCase().trim();
  const queryText = (args?.query || "").trim();

  if (!queryText) {
    return "Search karne ke liye koi keyword ya naam batayein.";
  }

  const safeTenant = toObjectIdFilter(tenantId);

  // If a specific module from registry is requested
  if (modKey && registry[modKey]) {
    const mod = registry[modKey];
    const q = escapeRegex(queryText);
    const filter = {
      ...(mod.tenantScoped && safeTenant ? { tenant_id: safeTenant } : {}),
      $or: mod.nameFields.map((f) => ({ [f]: { $regex: q, $options: "i" } })),
    };
    const records = await mod.Model.find(filter).limit(3).lean();

    if (!records || records.length === 0) {
      return `${mod.label} module mein "${queryText}" se koi match nahi mila.`;
    }

    const items = records
      .map((r) => {
        const title = mod.nameFields.map((f) => r[f]).filter(Boolean).join(" ") || String(r._id);
        return title;
      })
      .join(", ");

    return `${mod.label} mein ye matches mile: ${items}.`;
  }

  // Cross-module search: Leads, Clients, Invoices, Tasks
  const q = escapeRegex(queryText);
  const baseFilter = safeTenant ? { tenant_id: safeTenant } : {};

  const [leads, clients, invoices, tasks] = await Promise.all([
    Lead.find({ ...baseFilter, name: { $regex: q, $options: "i" } }).select("name phonenumber").limit(2).lean(),
    Client.find({ ...baseFilter, company: { $regex: q, $options: "i" } }).select("company phonenumber").limit(2).lean(),
    Invoice.find({ ...baseFilter, number: { $regex: q, $options: "i" } }).select("number total status").limit(2).lean(),
    Task.find({ ...baseFilter, name: { $regex: q, $options: "i" } }).select("name status").limit(2).lean(),
  ]);

  const results = [];
  if (leads.length) results.push(`Leads: ${leads.map((l) => l.name).join(", ")}`);
  if (clients.length) results.push(`Clients: ${clients.map((c) => c.company).join(", ")}`);
  if (invoices.length) results.push(`Invoices: ${invoices.map((i) => `${i.number} (${formatCurrency(i.total)})`).join(", ")}`);
  if (tasks.length) results.push(`Tasks: ${tasks.map((t) => t.name).join(", ")}`);

  if (results.length === 0) {
    return `CRM mein "${queryText}" se koi record match nahi hua.`;
  }

  return `Search results: ${results.join(". ")}.`;
}

// 12. Universal Ask CRM fallback
async function handleUniversalAskCRM(args, tenantId) {
  const query = args?.query || args?.question || "";
  if (!query) {
    return await handleGetCRMStats(args, tenantId);
  }
  return await handleSearchCRM({ query }, tenantId);
}

// Master Dispatcher for Tools
async function executeToolCall(toolName, args, tenantId) {
  const normalized = (toolName || "").toLowerCase().trim();

  // Alias mapping
  switch (normalized) {
    case "checkleadstatus":
    case "getleadinfo":
    case "getlead":
    case "checklead":
      return await handleCheckLead(args, tenantId);

    case "getclientinfo":
    case "checkcustomer":
    case "getclient":
    case "getcustomer":
    case "checkclient":
      return await handleGetClient(args, tenantId);

    case "searchcompany":
    case "search_company":
    case "getcompanydetails":
    case "get_company_details":
    case "checkcompany":
    case "getcompany":
    case "findcompany":
      return await handleSearchCompany(args, tenantId);

    case "getcrmstats":
    case "get_analytics":
    case "getanalytics":
    case "crmstats":
    case "getstats":
      return await handleGetCRMStats(args, tenantId);

    case "getinvoicedetails":
    case "checkinvoice":
    case "getinvoice":
    case "searchinvoice":
      return await handleGetInvoice(args, tenantId);

    case "gettaskdetails":
    case "gettasks":
    case "getmytasks":
    case "searchtasks":
      return await handleGetTasks(args, tenantId);

    case "getprojectdetails":
    case "getprojects":
    case "checkproject":
      return await handleGetProjects(args, tenantId);

    case "getticketdetails":
    case "gettickets":
    case "checkticket":
      return await handleGetTickets(args, tenantId);

    case "createlead":
    case "create_lead":
    case "addlead":
      return await handleCreateLead(args, tenantId);

    case "createtask":
    case "create_task":
    case "addtask":
      return await handleCreateTask(args, tenantId);

    case "addnote":
    case "add_note":
    case "createnote":
      return await handleAddNote(args, tenantId);

    case "search_crm":
    case "search_records":
    case "searchcrm":
    case "searchrecords":
      return await handleSearchCRM(args, tenantId);

    case "ask_crm":
    case "askcrm":
    case "crmquery":
      return await handleUniversalAskCRM(args, tenantId);

    default:
      // If tool is unknown, try universal search with tool parameters
      if (args && (args.query || args.name || args.phone)) {
        return await handleUniversalAskCRM(args, tenantId);
      }
      return "Ye function abhi available nahi hai. Aap Lead, Client, Invoice, Task, ya CRM Stats ke baare mein pooch sakte hain.";
  }
}

// ─────────────────────────────────────────────────────────────────
// MAIN WEBHOOK CONTROLLER
// ─────────────────────────────────────────────────────────────────
exports.handleVapiWebhook = async (req, res) => {
  try {
    const payload = req.body || {};
    const message = payload.message || payload;

    if (!message || !message.type) {
      console.warn("[Vapi Webhook] Empty or invalid payload received");
      return res.status(200).json({ status: "ok", message: "Ignored empty payload" });
    }

    console.log(`[Vapi Webhook] Event type: ${message.type}`);

    // ─────────────────────────────────────────────────────────────────
    // 1. TOOL CALLS & FUNCTION CALLS (Live Live Calls)
    // Supports modern "tool-calls" and legacy "function-call"
    // ─────────────────────────────────────────────────────────────────
    if (message.type === "tool-calls" || message.type === "function-call") {
      let toolCallsList = [];

      if (message.type === "tool-calls") {
        toolCallsList = message.toolCalls || message.toolCallList || [];
      } else if (message.type === "function-call" && message.functionCall) {
        toolCallsList = [
          {
            id: message.functionCall.id || "func_call_1",
            function: {
              name: message.functionCall.name,
              arguments: message.functionCall.parameters,
            },
          },
        ];
      }

      if (!toolCallsList || toolCallsList.length === 0) {
        console.warn("[Vapi Webhook] Tool call event received with empty tool calls list");
        return res.json({ results: [] });
      }

      const results = [];

      for (const call of toolCallsList) {
        const toolCallId = call.id || "call_default";
        const functionName = call.function?.name || call.name || "";

        // Arguments may arrive as an Object or stringified JSON depending on LLM
        let parameters = call.function?.arguments || call.parameters || {};
        if (typeof parameters === "string") {
          try {
            parameters = JSON.parse(parameters);
          } catch (e) {
            console.warn(`[Vapi Webhook] Failed to JSON parse arguments for ${functionName}:`, e.message);
            parameters = {};
          }
        }

        console.log(`[Vapi Webhook] Executing tool: ${functionName} with params:`, JSON.stringify(parameters));

        try {
          const tenantId = await resolveTenantId(req, message, parameters);
          const toolResult = await executeToolCall(functionName, parameters, tenantId);

          results.push({
            toolCallId,
            result: String(toolResult),
          });
        } catch (toolError) {
          console.error(`[Vapi Webhook] Error in tool ${functionName}:`, toolError);
          results.push({
            toolCallId,
            result: "CRM database se data fetch karne mein thodi dikkat aayi. Kripya dobara try karein.",
          });
        }
      }

      console.log("[Vapi Webhook] Returning tool results:", JSON.stringify(results));
      return res.json({ results });
    }

    // ─────────────────────────────────────────────────────────────────
    // 2. ASSISTANT REQUEST (Pre-call handshake)
    // ─────────────────────────────────────────────────────────────────
    if (message.type === "assistant-request") {
      console.log("[Vapi Webhook] Handshake assistant-request received");
      return res.status(200).json({});
    }

    // ─────────────────────────────────────────────────────────────────
    // 3. END-OF-CALL REPORT (Save note, transcript & call log)
    // ─────────────────────────────────────────────────────────────────
    if (message.type === "end-of-call-report") {
      const summary = message.summary || "No summary provided";
      const transcript = message.transcript || "";
      const callerPhone = message.customer?.number || message.call?.customer?.number || "";
      const recordingUrl = message.recordingUrl || message.call?.recordingUrl || "";
      const durationSeconds = message.durationSeconds || message.call?.durationSeconds || 0;
      const callId = message.call?.id || message.id || `vapi_${Date.now()}`;

      console.log(`[Vapi] Call ended. Caller: ${callerPhone}, Duration: ${durationSeconds}s`);
      console.log(`[Vapi] Summary: ${summary}`);

      let matchedEntity = null;
      let entityType = "lead";
      let tenantId = await resolveTenantId(req, message, {});

      if (callerPhone) {
        const phone10 = extractLast10Digits(callerPhone);
        if (phone10.length >= 7) {
          const lead = await Lead.findOne({
            $or: [{ phone_last10: phone10 }, { phonenumber: { $regex: phone10 } }],
          }).lean();

          if (lead) {
            matchedEntity = lead;
            entityType = "lead";
            if (!tenantId) tenantId = lead.tenant_id;
          } else {
            const client = await Client.findOne({
              $or: [{ phonenumber: { $regex: phone10 } }, { phoneE164: { $regex: phone10 } }],
            }).lean();
            if (client) {
              matchedEntity = client;
              entityType = "customer";
              if (!tenantId) tenantId = client.tenant_id;
            }
          }
        }
      }

      // Save call summary note
      if (matchedEntity) {
        try {
          await Note.create({
            rel_id: matchedEntity._id,
            rel_type: entityType,
            description: `📞 AI Voice Call Summary (${durationSeconds}s):\n${summary}\n\nRecording: ${recordingUrl || "Not available"}\n\n--- Transcript ---\n${transcript}`,
            tenant_id: tenantId || matchedEntity.tenant_id,
            dateadded: new Date(),
          });
          console.log(`[Vapi] Note saved for ${entityType}: ${matchedEntity.name || matchedEntity.company}`);
        } catch (noteErr) {
          console.error("[Vapi] Error saving note:", noteErr);
        }
      }

      // Save to Call & CallTranscript models if available
      try {
        const existingCall = await Call.findOne({ providerCallId: callId }).lean();
        if (!existingCall) {
          const callDoc = await Call.create({
            tenant_id: tenantId || null,
            providerCallId: callId,
            direction: "inbound",
            fromNumber: callerPhone,
            customerId: entityType === "customer" && matchedEntity ? matchedEntity._id : null,
            matchStatus: matchedEntity ? "matched" : "not_found",
          });

          if (transcript) {
            await CallTranscript.create({
              tenant_id: tenantId || null,
              callId: callDoc._id,
              fullText: transcript,
              summary: {
                text: summary,
                sentiment: message.analysis?.sentiment || "neutral",
                generatedByModel: "vapi-ai",
                generatedAt: new Date(),
              },
              utterances: [],
            });
          }
        }
      } catch (callLogErr) {
        console.warn("[Vapi] Optional Call model logging note:", callLogErr.message);
      }

      return res.status(200).send("Report received and saved");
    }

    // ─────────────────────────────────────────────────────────────────
    // 4. STATUS UPDATE / TRANSCRIPT / SPEECH UPDATE
    // ─────────────────────────────────────────────────────────────────
    if (message.type === "status-update" || message.type === "speech-update" || message.type === "transcript") {
      return res.status(200).send("Event acknowledged");
    }

    return res.status(200).send("Event received");
  } catch (error) {
    console.error("[Vapi Webhook] Top-level Error:", error);

    // If it was a tool call that failed unexpectedly, return a graceful Vapi response instead of a crash 500
    if (req.body?.message?.type === "tool-calls" || req.body?.message?.type === "function-call") {
      return res.status(200).json({
        results: [
          {
            toolCallId: "fallback_error",
            result: "Kshama karein, technical samasya ke kaaran CRM se data prapt nahi ho saka.",
          },
        ],
      });
    }

    return res.status(200).json({ status: "error", error: error.message });
  }
};
