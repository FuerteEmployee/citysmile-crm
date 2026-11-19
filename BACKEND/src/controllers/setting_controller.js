const Setting = require("../models/Setting");
const Tenant = require("../models/Tenant");
const emailService = require("../services/EmailService");
const smsService = require("../services/SmsService");
const os = require("os");
const mongoose = require("mongoose");
const fs = require("fs");
const path = require("path");
const { getRequestHost, resolveTenantByHost } = require("../utils/resolveTenantByHost");

// Settings whose value is a bare filename saved to disk by updateSettings'
// base64-decode step (see logosDir below) rather than a URL/plain string.
const FILE_BACKED_SETTING_KEYS = ["compLogoLight", "compLogoDark", "favicon", "ogImage"];
const logosDir = path.join(__dirname, "..", "uploads", "logos");

// The physical file can go missing (disk cleanup, a dev machine that never
// synced the uploads folder, …) while the DB still holds its old filename —
// that used to reach the frontend as a value it would render an <img> for,
// producing a 404 on every page load. Drop values that no longer resolve to
// a real file so the frontend falls back to its default branding instead.
const dropStaleFileSettings = (settingsList) =>
  settingsList.map((s) => {
    if (
      FILE_BACKED_SETTING_KEYS.includes(s.name) &&
      typeof s.value === "string" &&
      s.value &&
      !s.value.startsWith("http://") &&
      !s.value.startsWith("https://") &&
      !s.value.startsWith("data:") &&
      !fs.existsSync(path.join(logosDir, s.value))
    ) {
      return { ...s, value: "" };
    }
    return s;
  });

// Settings are per-tenant with global fallback:
// tenant_id null  = global defaults (managed by the super admin, also serve
//                   the public/unauthenticated pages like the login screen)
// tenant_id set   = that admin's own overrides (logos, favicon, formats, …)
const getSettings = async (req, res) => {
  try {
    const globalSettings = await Setting.find({ tenant_id: null });
    const isAuthenticated = req.user != null;

    let tenantId = req.user?.tenant_id;

    if (!tenantId) {
      const tenantHeader = req.headers["x-tenant-id"];
      if (tenantHeader && mongoose.Types.ObjectId.isValid(tenantHeader)) {
        tenantId = tenantHeader;
      }
    }

    // A company's own login link on the shared domain (?company=<login_code>)
    // picks that company's branding for the login page. Branding only — the
    // response below is still limited to the public keys when not logged in.
    if (!tenantId && typeof req.query.company === "string" && req.query.company.trim()) {
      const byCode = await Tenant.findOne({ login_code: req.query.company.trim().toLowerCase() }).select("_id");
      if (byCode) tenantId = byCode._id;
    }

    if (!tenantId) {
      const host = getRequestHost(req);
      let tenantMatch = host ? await resolveTenantByHost(host) : null;
      if (!tenantMatch) {
        // Cosmetic-only fallback for single-tenant dev/staging installs —
        // does not affect access control, only which branding is merged in.
        const tenantCount = await Tenant.countDocuments();
        if (tenantCount === 1) {
          tenantMatch = await Tenant.findOne();
        }
      }
      if (tenantMatch) {
        tenantId = tenantMatch._id;
      }
    }

    let merged = new Map(globalSettings.map(s => [s.name, s.toObject()]));

    if (tenantId) {
      const tenantSettings = await Setting.find({ tenant_id: tenantId });
      tenantSettings.forEach(s => merged.set(s.name, s.toObject()));
      // The favicon is the company's own or nothing — never another company's
      // icon inherited from the global row. With none set, the frontend draws
      // the company's first letter instead.
      if (!tenantSettings.some(s => s.name === "favicon" && s.value)) merged.delete("favicon");
      // Same for the company's own domain: the global row is the platform
      // owner's domain, not something another company should inherit/save.
      if (!tenantSettings.some(s => s.name === "companyDomain")) merged.delete("companyDomain");

      // A company's name is always its own record's name — including names
      // that happen to equal a platform default (e.g. a real company called
      // "Fuerte Developers"); hiding those blanked the name everywhere.
      const tenant = await Tenant.findById(tenantId).select("company_name");
      if (tenant) {
        merged.set("companyName", {
          name: "companyName",
          value: tenant.company_name || "",
          tenant_id: tenantId,
        });
      }
    } else {
      const globalCompName = merged.get("companyName")?.value;
      if (globalCompName === "Fuerte CRM" || globalCompName === "Fuerte Developers" || globalCompName === "CRMPro" || globalCompName === "CRM Pro Inc.") {
        merged.set("companyName", {
          name: "companyName",
          value: "",
          tenant_id: null,
        });
      }
    }

    const settingsList = dropStaleFileSettings([...merged.values()]);

    if (!isAuthenticated) {
      const publicKeys = [
        'theme_style',
        'companyName',
        'favicon',
        'compLogoLight',
        'compLogoDark',
        'ogImage',
        'rtlAdmin',
        'rtlCustomers',
        'aiAgentName',
        // Localization for the customer login / public pages
        'locLanguage',
        'locDisableLanguages',
        'locDateFormat',
        'locTimeFormat',
        'locTimezone'
      ];
      return res.json(settingsList.filter(s => publicKeys.includes(s.name)));
    }

    res.json(settingsList);
  } catch (error) {
    res.status(500).json({ message: error.message });
  }
};

const updateSettings = async (req, res) => {
  try {
    const { settings } = req.body; // Array of { name, value }
    if (!Array.isArray(settings)) {
      return res.status(400).json({ message: "Invalid settings format" });
    }

    // Validation: Only 1 active SMS gateway allowed at a time
    const activeSmsGateways = settings.filter(
      (s) =>
        ["smsClickatellActive", "smsMsg91Active", "smsTwilioActive"].includes(s.name) &&
        (s.value === true || s.value === "true")
    );
    if (activeSmsGateways.length > 1) {
      return res.status(400).json({ message: "Only 1 active SMS gateway is allowed at a time" });
    }

    // Process base64 images into physical files, sanitize text inputs, and validate fee numbers
    if (!fs.existsSync(logosDir)) {
      fs.mkdirSync(logosDir, { recursive: true });
    }

    for (let i = 0; i < settings.length; i++) {
      let s = settings[i];

      // Validate payment gateway fees to prevent negative values
      if (
        typeof s.name === "string" &&
        (s.name.endsWith("FixedFee") || s.name.endsWith("PercFee") || s.name.endsWith("Fee"))
      ) {
        const num = Number(s.value);
        if (!isNaN(num) && num < 0) {
          return res.status(400).json({ message: `Field "${s.name}" cannot be a negative number` });
        }
      }

      // XSS sanitization: strip script tags from string values
      if (typeof s.value === "string") {
        s.value = s.value.replace(/<script\b[^<]*(?:(?!<\/script>)<[^<]*)*<\/script>/gi, "");
      }
      if (typeof s.value === 'string' && s.value.startsWith('data:image/')) {
        const matches = s.value.match(/^data:([A-Za-z-+\/]+);base64,(.+)$/);
        if (!matches || matches.length !== 3) {
          return res.status(400).json({ message: `Invalid image data for setting "${s.name}"` });
        }
        try {
          // "image/svg+xml" / "image/x-icon" would otherwise give ".svg+xml" /
          // ".x-icon" files that static serving can't type, so browsers won't show them.
          const rawExt = matches[1].split('/')[1] || 'png';
          const ext = { "svg+xml": "svg", "x-icon": "ico", "vnd.microsoft.icon": "ico", jpeg: "jpg" }[rawExt] || rawExt;
          const buffer = Buffer.from(matches[2], 'base64');
          const filename = `logo_${Date.now()}_${Math.floor(Math.random() * 1000)}.${ext}`;
          const filepath = path.join(logosDir, filename);
          // Async write — the sync version blocked Node's single event loop
          // thread for the entire disk write, stalling every other
          // in-flight request (incl. unrelated GETs) until it finished. On
          // a small single-core VPS that's long enough to trip a proxy
          // timeout, which then surfaces in the browser as a CORS failure
          // (the timed-out proxy response never carries CORS headers).
          await fs.promises.writeFile(filepath, buffer);
          s.value = filename; // Save only the filename in the database
        } catch (err) {
          // Fail loudly instead of falling through with s.value still holding
          // the raw base64 — silently saving that to Mongo balloons the
          // settings document and breaks every future GET /api/settings.
          console.error("Failed to save logo file:", err);
          return res.status(500).json({ message: `Failed to save image for setting "${s.name}": ${err.message}` });
        }
      }
    }

    // Tenant admins: save into their own tenant scope only
    if (req.user && req.user.tenant_id && !req.user.is_superadmin) {
      const tenantId = req.user.tenant_id;

      const companyNameEntry = settings.find(s => s.name === "companyName");
      // Never blank the company's name — an empty field (e.g. a page that
      // didn't load the name) would otherwise wipe Tenant.company_name.
      if (companyNameEntry && String(companyNameEntry.value || "").trim()) {
        const newName = (companyNameEntry.value || "").trim();
        await Tenant.findByIdAndUpdate(tenantId, {
          company_name: newName
        });
        await Setting.findOneAndUpdate(
          { name: "companyName", tenant_id: tenantId },
          { value: newName },
          { upsert: true, new: true }
        );
      }

      const otherSettings = settings.filter(s => s.name !== "companyName");
      const updates = otherSettings.map(s =>
        Setting.findOneAndUpdate(
          { name: s.name, tenant_id: tenantId },
          { value: s.value },
          { upsert: true, new: true }
        )
      );
      await Promise.all(updates);
      // Branding stays inside this tenant. It used to be mirrored into the
      // global (tenant_id: null) rows so the shared login page showed it, which
      // let whichever tenant saved last change every tenant's login page. The
      // login page now finds a tenant's branding itself — by its own domain,
      // its ?company=<login_code> link, or the company remembered in that
      // browser — so the global rows are left to the super admin only.
    } else {
      // Super admin: save the global defaults
      const updates = settings.map(s =>
        Setting.findOneAndUpdate(
          { name: s.name, tenant_id: null },
          { value: s.value },
          { upsert: true, new: true }
        )
      );
      await Promise.all(updates);
    }

    if (settings.some(s => s.name === "miscMaxFileSize" || s.name === "miscMaxFilesPost")) {
      require("../utils/uploadLimits").invalidateUploadLimits(req.user?.tenant_id && !req.user.is_superadmin ? req.user.tenant_id : null);
    }

    if (settings.some(s => s.name === "allowedFileTypes")) {
      const { invalidateAllowedFileTypes } = require("../utils/allowedFileTypes");
      invalidateAllowedFileTypes(req.user?.tenant_id && !req.user.is_superadmin ? req.user.tenant_id : null);
    }

    res.json({ message: "Settings updated successfully" });
  } catch (error) {
    res.status(500).json({ message: error.message });
  }
};

const testEmail = async (req, res) => {
  try {
    const { email } = req.body;
    if (!email) {
      return res.status(400).json({ message: "Email is required" });
    }

    // Resolve tenantId the same way getSettings does — req.user.tenant_id is
    // null for superadmins, so fall back to x-tenant-id header and then
    // host-based resolution so the correct tenant's company name is used.
    let tenantId = req.user?.tenant_id;

    if (!tenantId) {
      const tenantHeader = req.headers["x-tenant-id"];
      if (tenantHeader && mongoose.Types.ObjectId.isValid(tenantHeader)) {
        tenantId = tenantHeader;
      }
    }

    if (!tenantId) {
      const host = getRequestHost(req);
      let tenantMatch = host ? await resolveTenantByHost(host) : null;
      if (!tenantMatch) {
        const tenantCount = await Tenant.countDocuments();
        if (tenantCount === 1) tenantMatch = await Tenant.findOne();
      }
      if (tenantMatch) tenantId = tenantMatch._id;
    }

    await emailService.sendTestEmail(email, tenantId);
    res.json({ message: "Test email sent successfully" });
  } catch (error) {
    // SMTP not configured — return 400 so the frontend shows a clear message
    // instead of a generic "Server Error".
    if (error.message && error.message.startsWith("SMTP not configured")) {
      return res.status(400).json({ message: error.message });
    }
    res.status(500).json({ message: `Failed to send email: ${error.message}` });
  }
};

const testSms = async (req, res) => {
  try {
    const { phone } = req.body;
    if (!phone || !phone.trim()) {
      return res.status(400).json({ message: "Phone number is required" });
    }

    let tenantId = req.user?.tenant_id;
    if (!tenantId) {
      const tenantHeader = req.headers["x-tenant-id"];
      if (tenantHeader && mongoose.Types.ObjectId.isValid(tenantHeader)) {
        tenantId = tenantHeader;
      }
    }
    if (!tenantId) {
      const host = getRequestHost(req);
      let tenantMatch = host ? await resolveTenantByHost(host) : null;
      if (!tenantMatch) {
        const tenantCount = await Tenant.countDocuments();
        if (tenantCount === 1) tenantMatch = await Tenant.findOne();
      }
      if (tenantMatch) tenantId = tenantMatch._id;
    }

    await smsService.sendTestSms(phone, tenantId);
    res.json({ message: "Test SMS sent successfully" });
  } catch (error) {
    res.status(400).json({ message: error.message || "Failed to send SMS" });
  }
};

const getSystemInfo = async (req, res) => {
  // Setup > Settings > System/Server Information. A company admin sees what
  // matters for their CRM; the server's internals (OS, memory, …) are shared
  // by every company on this server, so only the super admin sees those.
  try {
    const tenantId = req.user?.tenant_id && !req.user?.is_superadmin ? req.user.tenant_id : null;

    // Database: real connection state + a ping round-trip.
    let dbValue = "Disconnected";
    let dbStatus = "destructive";
    if (mongoose.connection.readyState === 1) {
      try {
        const t0 = Date.now();
        await mongoose.connection.db.admin().ping();
        dbValue = `Connected (${Date.now() - t0} ms)`;
        dbStatus = "success";
      } catch {
        dbValue = "Connected, not responding";
      }
    }

    const companyRows = await Setting.find({
      name: { $in: ["locTimezone", "smtpHost", "smtpEmail"] },
      $or: [{ tenant_id: tenantId }, { tenant_id: null }],
    }).lean();
    const pick = (name) => {
      const own = companyRows.find((r) => r.name === name && tenantId && String(r.tenant_id) === String(tenantId));
      const global = companyRows.find((r) => r.name === name && r.tenant_id == null);
      return (own ?? global)?.value;
    };
    const { getAllowedExtensions } = require("../utils/allowedFileTypes");
    const allowed = await getAllowedExtensions(tenantId);
    const smtpHost = String(pick("smtpHost") || "").trim();

    const info = [
      { section: "CRM", name: "Database", value: dbValue, status: dbStatus },
      { section: "CRM", name: "Server version", value: SERVER_BUILD.commit ? `build ${SERVER_BUILD.commit}` : "unknown" },
      { section: "CRM", name: "Running since", value: SERVER_STARTED_AT, type: "datetime" },
      { section: "CRM", name: "Server time", value: new Date().toISOString(), type: "datetime" },
      { section: "CRM", name: "Server timezone", value: Intl.DateTimeFormat().resolvedOptions().timeZone || "UTC" },
      {
        section: "CRM",
        name: "Company timezone (Localization)",
        // Older rows store short codes (same aliases as the frontend's lib/dateFormat.ts).
        value: (({ ist: "Asia/Kolkata", utc: "UTC", est: "America/New_York", pst: "America/Los_Angeles" })[String(pick("locTimezone") || "").toLowerCase()]) || String(pick("locTimezone") || "not set"),
      },
      {
        section: "CRM",
        name: "Email (SMTP)",
        value: smtpHost ? `Configured — ${pick("smtpEmail") || smtpHost}` : "Not configured",
        status: smtpHost ? "success" : "secondary",
      },
      { section: "CRM", name: "Allowed file types", value: allowed.map((e) => "." + e).join(", ") },
      { section: "CRM", name: "Attachment size limit", value: "No CRM limit (the web server's limit applies)" },
    ];

    if (req.user?.is_superadmin) {
      const S = "Server (super admin only)";
      const gb = (b) => `${(b / 1024 ** 3).toFixed(2)} GB`;
      info.push(
        { section: S, name: "OS", value: `${os.type()} ${os.release()} (${os.platform()} ${os.arch()})` },
        { section: S, name: "CPU cores", value: String(os.cpus().length) },
        { section: S, name: "Memory", value: `${gb(os.freemem())} free of ${gb(os.totalmem())}` },
        { section: S, name: "Node.js", value: process.version },
        { section: S, name: "Mongoose", value: mongoose.version || "unknown" },
        { section: S, name: "Process uptime", value: `${(process.uptime() / 3600).toFixed(1)} hours` },
        { section: S, name: "Environment", value: process.env.NODE_ENV || "development" },
      );
    }

    res.json(info);
  } catch (error) {
    console.error("System info error:", error);
    res.status(500).json({ message: error.message });
  }
};

// Setup > Settings > System Update: which code the server is running. Read
// once at startup from the deployed Git checkout (empty if it isn't one).
const SERVER_STARTED_AT = new Date().toISOString();
const SERVER_BUILD = (() => {
  try {
    // execFileSync (no shell) — "|" in the format would be a pipe in cmd.exe.
    const out = require("child_process")
      .execFileSync("git", ["log", "-1", "--format=%h|%cI|%s"], { cwd: path.join(__dirname, "..", ".."), stdio: ["ignore", "pipe", "ignore"] })
      .toString()
      .trim();
    const [commit, commitDate, ...msg] = out.split("|");
    return { commit, commitDate, message: msg.join("|") };
  } catch {
    return { commit: "", commitDate: "", message: "" };
  }
})();

const getVersionInfo = async (req, res) => {
  res.json({
    backend: { ...SERVER_BUILD, startedAt: SERVER_STARTED_AT, node: process.version },
  });
};

module.exports = { getSettings, updateSettings, testEmail, testSms, getSystemInfo, getVersionInfo };
