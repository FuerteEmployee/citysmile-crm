const MainSidebar = require("../models/MainSidebar");
const Tenant = require("../models/Tenant");
const { allowedFeatures } = require("../config/tenantFeatures");

// Maps a Tenant.hidden_hrms_features key to the sidebar row(s) it should
// suppress for that tenant only — see Tenant.js's hidden_hrms_features field.
const HIDDEN_HRMS_FEATURE_URLS = {
  targets: ["/admin/hrms/staff/targets"],
  incentive_slabs: ["/admin/hrms/staff/incentive-slabs"],
};

// The opposite: rows that only appear for tenants with an opt-in add-on
// (Tenant.enabled_features, see src/config/tenantFeatures.js).
const ADDON_FEATURE_URLS = {
  face_attendance: ["/admin/hrms/staff/face-attendance"],
};

const filterHiddenHrmsFeatures = (list, hiddenFeatures, enabledFeatures = []) => {
  const hiddenUrls = new Set((hiddenFeatures || []).flatMap((f) => HIDDEN_HRMS_FEATURE_URLS[f] || []));
  for (const [feature, urls] of Object.entries(ADDON_FEATURE_URLS)) {
    if (!enabledFeatures.includes(feature)) urls.forEach((u) => hiddenUrls.add(u));
  }
  if (hiddenUrls.size === 0) return list;
  return list.filter((i) => !hiddenUrls.has(i.url));
};

const getSidebarItems = async (req, res) => {
  try {
    // A tenant with a custom sidebar_config fully replaces the global list
    // for that tenant's users only — everyone else keeps seeing the shared
    // MainSidebar collection below, untouched.
    let tenant = null;
    if (req.user?.tenant_id) {
      tenant = await Tenant.findById(req.user.tenant_id).select("sidebar_config hidden_hrms_features enabled_features");
    }
    const hiddenFeatures = tenant?.hidden_hrms_features || [];
    // Platform super admins (no tenant) see every add-on.
    const enabledFeatures = req.user?.is_superadmin
      ? Object.keys(ADDON_FEATURE_URLS)
      : allowedFeatures(req.user?.tenant_id, tenant?.enabled_features);

    if (tenant?.sidebar_config?.length > 0) {
      const overrideItems = [...tenant.sidebar_config]
        .sort((a, b) => a.order - b.order)
        .map((item) => ({ ...item.toObject(), active: true }));

      // HRMS/Reports/Utilities are each a whole sub-app with many pages of
      // their own (Staff Directory, Attendance, Payroll, …) that a tenant's
      // flat top-level override was never meant to enumerate — a tenant
      // override only repositions the plain top-level items. These three
      // groups' real, live items are always appended so their collapsible
      // sections keep working with full sub-navigation, unaffected by
      // (and not reorderable within) the tenant's custom flat order.
      const NESTED_GROUPS = ["HRMS", "Reports", "Utilities"];
      const allNestedItems = await MainSidebar.find({ group: { $in: NESTED_GROUPS } }).sort({ order: 1 });
      // If the tenant's own flat order already places a page at the top level
      // (e.g. Rudraverse puts Goals in its main menu), that top-level spot is
      // the one the tenant chose — drop the copy inside HRMS/Reports/Utilities
      // so the page shows only once. Tenants without a custom sidebar_config
      // never reach this branch, so their Utilities > Goals is untouched.
      const topLevelUrls = new Set(overrideItems.filter((i) => !i.childGroup).map((i) => i.url));
      const nestedItems = allNestedItems.filter((i) => !topLevelUrls.has(i.url));
      return res.json(filterHiddenHrmsFeatures([...overrideItems, ...nestedItems], hiddenFeatures, enabledFeatures));
    }

    const items = await MainSidebar.find().sort({ order: 1 });

    // Seed default items if empty
    if (items.length === 0) {
      const defaultItems = [
        { title: "Dashboard", url: "/admin/dashboard", icon: "LayoutDashboard", group: "Main", order: 1 },
        { title: "Chat", url: "/admin/chat", icon: "MessageSquare", permission: "Chat", group: "Main", order: 2 },
        { title: "Meetings", url: "/admin/meetings", icon: "Users", permission: "Meetings", group: "Main", order: 3 },
        { title: "Bookmarks", url: "/admin/bookmarks", icon: "Bookmark", permission: "Bookmarks", group: "Main", order: 4 },
        
        { title: "Customers", url: "/admin/customers", icon: "Users", permission: "Customers", group: "Customers", order: 5 },
        
        { title: "Proposals", url: "/admin/proposals", icon: "FileBarChart", permission: "Proposals", group: "Sales", order: 6 },
        { title: "Estimates", url: "/admin/estimates", icon: "ClipboardList", permission: "Estimates", group: "Sales", order: 7 },
        { title: "Invoices", url: "/admin/invoices", icon: "FileText", permission: "Invoices", group: "Sales", order: 8 },
        { title: "Payments", url: "/admin/payments", icon: "Wallet", permission: "Payments", group: "Sales", order: 9 },
        { title: "Credit Notes", url: "/admin/credit-notes", icon: "Receipt", permission: "Credit Notes", group: "Sales", order: 10 },
        { title: "Purchases", url: "/admin/purchases", icon: "ShoppingCart", permission: "Purchases", group: "Sales", order: 11 },
        { title: "Vendors", url: "/admin/vendors", icon: "Truck", permission: "Vendors", group: "Sales", order: 12 },
        { title: "Items", url: "/admin/items", icon: "Package", permission: "Items", group: "Sales", order: 13 },
        
        { title: "Subscriptions", url: "/admin/subscriptions", icon: "CreditCard", permission: "Subscriptions", group: "Management", order: 12 },
        { title: "Expenses", url: "/admin/expenses", icon: "Receipt", permission: "Expenses", group: "Management", order: 13 },
        { title: "Contracts", url: "/admin/contracts", icon: "FileSignature", permission: "Contracts", group: "Management", order: 14 },
        { title: "Projects", url: "/admin/projects", icon: "FolderKanban", permission: "Projects", group: "Management", order: 15 },
        { title: "Tasks", url: "/admin/tasks", icon: "CheckSquare", permission: "Tasks", group: "Management", order: 16 },
        { title: "Support", url: "/admin/support", icon: "HeadphonesIcon", permission: "Support", group: "Management", order: 17 },
        { title: "Leads", url: "/admin/leads", icon: "Target", permission: "Leads", group: "Management", order: 18 },
        { title: "Estimate Request", url: "/admin/estimate-request", icon: "ClipboardList", permission: "Estimate Request", group: "Management", order: 19 },
        { title: "Knowledge Base", url: "/admin/knowledge-base", icon: "BookOpen", permission: "Knowledge Base", group: "Management", order: 20 },
        { title: "FAQ", url: "/admin/faq", icon: "HelpCircle", permission: "FAQ", group: "Management", order: 21 },

        { title: "Media", url: "/admin/media", icon: "Image", permission: "Media", group: "Utilities", order: 22 },
        { title: "Bulk PDF Export", url: "/admin/bulk-export", icon: "FileDown", permission: "Bulk PDF Export", group: "Utilities", order: 23 },
        { title: "Calendar", url: "/admin/calendar", icon: "CalendarDays", permission: "Calendar", group: "Utilities", order: 24 },
        { title: "Announcements", url: "/admin/announcements", icon: "Megaphone", permission: "Announcements", group: "Utilities", order: 25 },
        { title: "Goals", url: "/admin/goals", icon: "Crosshair", permission: "Goals", group: "Utilities", order: 26 },
        { title: "Activity Log", url: "/admin/activity", icon: "Activity", permission: "Activity Log", group: "Utilities", order: 27 },
        { title: "Ticket Pipe Log", url: "/admin/ticket-pipe-log", icon: "MessageSquare", permission: "Ticket Pipe Log", group: "Utilities", order: 28 },
        
        { title: "Master Dashboard", url: "/admin/reports/master", icon: "LayoutDashboard", permission: "Reports", group: "Reports", order: 29 },
        { title: "Sales", url: "/admin/reports/sales", icon: "TrendingUp", permission: "Reports", group: "Reports", order: 30 },
        { title: "Expenses", url: "/admin/reports/expenses", icon: "DollarSign", permission: "Reports", group: "Reports", order: 31 },
        { title: "Expenses vs Income", url: "/admin/reports/expenses-vs-income", icon: "BarChart3", permission: "Reports", group: "Reports", order: 32 },
        { title: "Leads", url: "/admin/reports/leads", icon: "Target", permission: "Reports", group: "Reports", order: 33 },
        { title: "Timesheets Overview", url: "/admin/reports/timesheets", icon: "Clock", permission: "Reports", group: "Reports", order: 34 },
        { title: "Knowledge Base Articles", url: "/admin/reports/kb", icon: "BookOpen", permission: "Reports", group: "Reports", order: 35 },
        { title: "Purchase Report", url: "/admin/reports/purchase", icon: "ShoppingCart", permission: "Reports", group: "Reports", order: 36 },
        
        { title: "Setup", url: "/admin/setup", icon: "Settings", permission: "Settings", group: "Setup", order: 37 },

        { title: "Staff Directory", url: "/admin/hrms/staff/users", icon: "Users", permission: "HRMS Staff Directory", group: "HRMS", order: 38 },
        { title: "Attendance Dashboard", url: "/admin/hrms/employees", icon: "LayoutDashboard", permission: "HRMS Attendance", group: "HRMS", order: 39 },
        { title: "Departments", url: "/admin/hrms/staff/departments", icon: "Building2", permission: "HRMS Departments", group: "HRMS", order: 40 },
        { title: "Shift Management", url: "/admin/hrms/staff/shifts", icon: "AlarmClock", permission: "HRMS Shift Management", group: "HRMS", order: 41 },
        { title: "Device Approvals", url: "/admin/hrms/staff/device-approvals", icon: "ShieldCheck", permission: "HRMS Attendance", group: "HRMS", order: 42 },
        { title: "Session Logs", url: "/admin/hrms/staff/session-logs", icon: "Clock", permission: "HRMS Attendance", group: "HRMS", order: 43 },
        { title: "Live Tracking", url: "/admin/hrms/staff/live-tracking", icon: "RadioTower", permission: "HRMS Attendance", group: "HRMS", order: 44 },
        { title: "Leave Management", url: "/admin/hrms/staff/leave-management", icon: "CalendarDays", permission: "HRMS Leave Management", group: "HRMS", order: 45 },
        { title: "Expense Management", url: "/admin/hrms/staff/expense-management", icon: "Wallet", permission: "HRMS Expense Management", group: "HRMS", order: 46 },
        { title: "Salary Management", url: "/admin/hrms/staff/payroll", icon: "Landmark", permission: "HRMS Salary Management", group: "HRMS", order: 47 },
        { title: "Advance Salary", url: "/admin/hrms/staff/advance-salary", icon: "CreditCard", permission: "HRMS Salary Management", group: "HRMS", order: 47.5 },
        { title: "Branch Management", url: "/admin/hrms/staff/branches", icon: "MapPin", permission: "HRMS Branch Management", group: "HRMS", order: 48 },
        { title: "My Attendance", url: "/admin/hrms/staff/attendance", icon: "Clock", group: "HRMS", order: 49 },
        { title: "My Leaves", url: "/admin/hrms/staff/leaves", icon: "Briefcase", group: "HRMS", order: 50 },
        { title: "My Expenses", url: "/admin/hrms/staff/expenses", icon: "Wallet", group: "HRMS", order: 51 },
        { title: "My Salary", url: "/admin/hrms/staff/salary", icon: "Landmark", group: "HRMS", order: 52 },
        { title: "My Advance Salary", url: "/admin/hrms/staff/advance-salary", icon: "CreditCard", group: "HRMS", order: 52.5 },
      ];
      await MainSidebar.insertMany(defaultItems);
      const newItems = await MainSidebar.find().sort({ order: 1 });
      return res.json(newItems);
    }

    // NOTE: this used to also auto re-insert Dashboard/Purchases/Vendors/Purchase
    // Report/the whole HRMS group whenever they were missing from the DB, to
    // migrate old installs forward. That ran on every single request, so it
    // couldn't tell "never seeded" apart from "an admin deleted this on
    // purpose" — any admin who removed one of those rows via Setup > Main
    // Sidebar would see it silently reappear on the next fetch. That logic now
    // lives in backfill-mainsidebar-defaults.js as a one-time script instead —
    // run it manually if an old install is genuinely missing these rows.

    // Backfill the `permission` key onto items whose matching feature already
    // exists in the Setup > Roles permission grid but was never tagged on the
    // sidebar row, so role-based View permission actually gates these items
    // instead of showing them to every staff member regardless of role.
    const permissionBackfillTargets = {
      "/admin/projects": "Projects",
      "/admin/tasks": "Tasks",
      "/admin/support": "Support",
      "/admin/chat": "Chat",
      "/admin/meetings": "Meetings",
      "/admin/bookmarks": "Bookmarks",
      "/admin/media": "Media",
      "/admin/calendar": "Calendar",
      "/admin/faq": "FAQ",
    };
    const untagged = items.filter(
      (i) => permissionBackfillTargets[i.url] && !i.permission
    );
    if (untagged.length > 0) {
      await Promise.all(
        untagged.map((i) =>
          MainSidebar.updateOne(
            { _id: i._id },
            { $set: { permission: permissionBackfillTargets[i.url] } }
          )
        )
      );
      const refreshed = await MainSidebar.find().sort({ order: 1 });
      return res.json(filterHiddenHrmsFeatures(refreshed, hiddenFeatures, enabledFeatures));
    }

    res.json(filterHiddenHrmsFeatures(items, hiddenFeatures, enabledFeatures));
  } catch (error) {
    res.status(500).json({ message: error.message });
  }
};

// A tenant with a custom sidebar_config manages its own array of items
// instead of the shared MainSidebar collection — these three helpers find
// that tenant's override doc (if any) so create/update/delete/reorder can
// write to the right place. Returns null when this user's tenant has no
// override, meaning the caller should fall through to the global collection.
const getTenantOverride = async (req) => {
  if (!req.user?.tenant_id) return null;
  const tenant = await Tenant.findById(req.user.tenant_id).select("sidebar_config");
  return tenant?.sidebar_config?.length > 0 ? tenant : null;
};

const createSidebarItem = async (req, res) => {
  try {
    const tenant = await getTenantOverride(req);
    if (tenant) {
      const lastOrder = tenant.sidebar_config.reduce((max, i) => Math.max(max, i.order || 0), 0);
      tenant.sidebar_config.push({ ...req.body, order: lastOrder + 1 });
      await tenant.save();
      return res.status(201).json(tenant.sidebar_config[tenant.sidebar_config.length - 1]);
    }

    const lastItem = await MainSidebar.findOne({ group: req.body.group }).sort("-order");
    const newOrder = lastItem ? lastItem.order + 1 : 1;
    const item = await MainSidebar.create({ ...req.body, order: newOrder });
    res.status(201).json(item);
  } catch (error) {
    res.status(400).json({ message: error.message });
  }
};

const updateSidebarItem = async (req, res) => {
  try {
    const tenant = await getTenantOverride(req);
    const subdoc = tenant?.sidebar_config.id(req.params.id);
    if (subdoc) {
      subdoc.set(req.body);
      await tenant.save();
      return res.json(subdoc);
    }

    const item = await MainSidebar.findByIdAndUpdate(req.params.id, req.body, { new: true });
    if (!item) return res.status(404).json({ message: "Item not found" });
    res.json(item);
  } catch (error) {
    res.status(400).json({ message: error.message });
  }
};

const deleteSidebarItem = async (req, res) => {
  try {
    const tenant = await getTenantOverride(req);
    const subdoc = tenant?.sidebar_config.id(req.params.id);
    if (subdoc) {
      subdoc.deleteOne();
      await tenant.save();
      return res.json({ message: "Item removed" });
    }

    const item = await MainSidebar.findByIdAndDelete(req.params.id);
    if (!item) return res.status(404).json({ message: "Item not found" });
    res.json({ message: "Item removed" });
  } catch (error) {
    res.status(500).json({ message: error.message });
  }
};

const reorderSidebarItems = async (req, res) => {
  try {
    const { items } = req.body; // [{ id, order }, ...]
    if (!Array.isArray(items) || items.length === 0) {
      return res.status(400).json({ message: "items array is required" });
    }

    // A single drag on the Setup page can mix ids from the tenant's own
    // override (its flat items) with ids from the global collection (the
    // always-live HRMS/Reports/Utilities sub-items appended alongside it)
    // — split the batch and write each id to whichever store actually owns it.
    const tenant = await getTenantOverride(req);
    const globalUpdates = [];
    let tenantChanged = false;
    for (const { id, order } of items) {
      const subdoc = tenant?.sidebar_config.id(id);
      if (subdoc) {
        subdoc.order = order;
        tenantChanged = true;
      } else {
        globalUpdates.push({ updateOne: { filter: { _id: id }, update: { $set: { order } } } });
      }
    }

    if (tenantChanged) await tenant.save();
    if (globalUpdates.length > 0) await MainSidebar.bulkWrite(globalUpdates);

    // Reuse GET's logic so the response reflects the same merged, tenant-aware view.
    return getSidebarItems(req, res);
  } catch (error) {
    res.status(400).json({ message: error.message });
  }
};

module.exports = {
  getSidebarItems,
  createSidebarItem,
  updateSidebarItem,
  deleteSidebarItem,
  reorderSidebarItems
};
