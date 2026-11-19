// One-time backfill for the (global, not per-tenant) MainSidebar collection.
//
// mainsidebar_controller.js used to auto re-insert these rows on every single
// GET /api/mainsidebar request whenever they were missing, to migrate old
// installs forward as new default menu items were added over time. That made
// it impossible to actually delete Dashboard/Purchases/Vendors/Purchase
// Report or any HRMS row via Setup > Main Sidebar — an admin's deletion would
// silently be undone on the very next page load, since the check couldn't
// tell "never seeded" apart from "removed on purpose". That auto-backfill has
// been removed from the request path; run this script manually instead, only
// if an install is genuinely missing these rows (e.g. an old DB that predates
// them and was never opened since).
//
// Pass --dry-run to only print what would happen, without writing anything.
require("dotenv").config();
const mongoose = require("mongoose");
const MainSidebar = require("./src/models/MainSidebar");

const DRY_RUN = process.argv.includes("--dry-run");

const CORE_DEFAULTS = [
  { title: "Dashboard", url: "/admin/dashboard", icon: "LayoutDashboard", group: "Main", order: 1 },
  {
    title: "Purchases",
    url: "/admin/purchases",
    icon: "ShoppingCart",
    permission: "Purchases",
    group: "Sales",
    fallbackOrder: 11,
  },
  {
    title: "Vendors",
    url: "/admin/vendors",
    icon: "Truck",
    permission: "Vendors",
    group: "Sales",
    fallbackOrder: 12,
  },
  {
    title: "Purchase Report",
    url: "/admin/reports/purchase",
    icon: "ShoppingCart",
    permission: "Reports",
    group: "Reports",
    fallbackOrder: 36,
  },
];

const HRMS_DEFAULTS = [
  { title: "Staff Directory", url: "/admin/hrms/staff/users", icon: "Users", permission: "HRMS Staff Directory" },
  { title: "Attendance Dashboard", url: "/admin/hrms/employees", icon: "LayoutDashboard", permission: "HRMS Attendance" },
  { title: "Departments", url: "/admin/hrms/staff/departments", icon: "Building2", permission: "HRMS Departments" },
  { title: "Shift Management", url: "/admin/hrms/staff/shifts", icon: "AlarmClock", permission: "HRMS Shift Management" },
  { title: "Device Approvals", url: "/admin/hrms/staff/device-approvals", icon: "ShieldCheck", permission: "HRMS Attendance" },
  { title: "Session Logs", url: "/admin/hrms/staff/session-logs", icon: "Clock", permission: "HRMS Attendance" },
  { title: "Live Tracking", url: "/admin/hrms/staff/live-tracking", icon: "RadioTower", permission: "HRMS Attendance" },
  { title: "Leave Management", url: "/admin/hrms/staff/leave-management", icon: "CalendarDays", permission: "HRMS Leave Management" },
  { title: "Expense Management", url: "/admin/hrms/staff/expense-management", icon: "Wallet", permission: "HRMS Expense Management" },
  { title: "Salary Management", url: "/admin/hrms/staff/payroll", icon: "Landmark", permission: "HRMS Salary Management" },
  { title: "Branch Management", url: "/admin/hrms/staff/branches", icon: "MapPin", permission: "HRMS Branch Management" },
  { title: "My Attendance", url: "/admin/hrms/staff/attendance", icon: "Clock" },
  { title: "My Leaves", url: "/admin/hrms/staff/leaves", icon: "Briefcase" },
  { title: "My Expenses", url: "/admin/hrms/staff/expenses", icon: "Wallet" },
  { title: "My Salary", url: "/admin/hrms/staff/salary", icon: "Landmark" },
];

async function main() {
  await mongoose.connect(process.env.MONGO_URI);
  console.log(DRY_RUN ? "Running in --dry-run mode (no writes).\n" : "Running for real — writes will be committed.\n");

  const items = await MainSidebar.find({});
  const existingUrls = new Set(items.map((i) => i.url));
  const toInsert = [];

  for (const d of CORE_DEFAULTS) {
    if (existingUrls.has(d.url)) continue;
    const last = await MainSidebar.findOne({ group: d.group }).sort("-order");
    const { fallbackOrder, ...rest } = d;
    toInsert.push({ ...rest, order: last ? last.order + 1 : fallbackOrder });
  }

  const missingHrms = HRMS_DEFAULTS.filter((d) => !existingUrls.has(d.url));
  if (missingHrms.length > 0) {
    const lastHrms = await MainSidebar.findOne({ group: "HRMS" }).sort("-order");
    let nextOrder = lastHrms ? lastHrms.order + 1 : 37;
    for (const d of missingHrms) {
      toInsert.push({ ...d, group: "HRMS", order: nextOrder++ });
    }
  }

  if (toInsert.length === 0) {
    console.log("Nothing missing — all default rows already present.");
  } else {
    console.log(`Would insert ${toInsert.length} row(s):`);
    toInsert.forEach((i) => console.log(`  - [${i.group}] ${i.title} (${i.url})`));
    if (!DRY_RUN) {
      await MainSidebar.insertMany(toInsert);
      console.log("\nInserted.");
    }
  }

  await mongoose.disconnect();
}

main().catch((err) => {
  console.error(err);
  process.exit(1);
});
