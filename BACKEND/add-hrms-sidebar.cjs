const connectDB = require('./src/config/db');
const MainSidebar = require('./src/models/MainSidebar');
const dotenv = require('dotenv');

dotenv.config();

async function addHRMS() {
  await connectDB();
  const items = [
    { title: "HR Dashboard", url: "/hrms", icon: "LayoutDashboard", group: "Management", order: 50 },
    { title: "Attendance", url: "/hrms/staff/attendance", icon: "Clock", group: "Management", order: 51 },
    { title: "Live Tracking", url: "/hrms/staff/live-tracking", icon: "MapPin", group: "Management", order: 52 },
    { title: "Leave Management", url: "/hrms/staff/leave-management", icon: "Calendar", group: "Management", order: 53 },
    { title: "Payroll", url: "/hrms/staff/payroll", icon: "Banknote", group: "Management", order: 54 },
    { title: "Staff Directory", url: "/hrms/staff/users", icon: "Users", group: "Management", order: 55 },
    
    // Additional HRMS Modules
    { title: "Departments", url: "/hrms/staff/departments", icon: "Building", group: "Management", order: 56 },
    { title: "Designations", url: "/hrms/staff/designations", icon: "Briefcase", group: "Management", order: 57 },
    { title: "Shifts", url: "/hrms/staff/shifts", icon: "CalendarRange", group: "Management", order: 58 },
    { title: "Branches", url: "/hrms/staff/branches", icon: "GitBranch", group: "Management", order: 59 },
    { title: "Device Approvals", url: "/hrms/staff/device-approvals", icon: "Smartphone", group: "Management", order: 60 },
    { title: "Expenses", url: "/hrms/staff/expense-management", icon: "Wallet", group: "Management", order: 61 },
    { title: "Targets", url: "/hrms/staff/targets", icon: "Target", group: "Management", order: 62 },
    { title: "Salary Settlements", url: "/hrms/staff/salary-settlements", icon: "Receipt", group: "Management", order: 63 },
    { title: "Advance Salary", url: "/hrms/staff/advance-salary", icon: "Coins", group: "Management", order: 64 },
    { title: "Session Logs", url: "/hrms/staff/session-logs", icon: "History", group: "Management", order: 65 },
    { title: "Roles & Permissions", url: "/hrms/staff/roles", icon: "Shield", group: "Management", order: 66 }
  ];

  // Optionally clear old items to avoid duplicates or wrong URLs if they were added manually
  // await MainSidebar.deleteMany({ group: "Management", url: { $regex: "/hrms" } });

  for (const item of items) {
    const exists = await MainSidebar.findOne({ title: item.title, group: "Management" });
    if (!exists) {
      await MainSidebar.create(item);
      console.log(`Added: ${item.title}`);
    } else {
      // Update URL if it was wrong (like /admin/hrms/...)
      await MainSidebar.updateOne({ _id: exists._id }, { $set: { url: item.url, icon: item.icon, order: item.order } });
      console.log(`Updated: ${item.title}`);
    }
  }
  console.log("HRMS sidebar items injected successfully! Please refresh your frontend browser.");
  process.exit(0);
}

addHRMS().catch(err => {
  console.error("Error adding HRMS sidebar items:", err);
  process.exit(1);
});
