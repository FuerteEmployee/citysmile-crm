const express = require("express");
const router = express.Router();

router.use("/stores", require("./store_route"));
// router.use("/leads", require("./lead_route")); (missing module)
// router.use("/customers-master", require("./customer_master_route")); (missing module)
// router.use("/followups", require("./followup_route")); (missing module)
// router.use("/inventory", require("./inventory_route")); (missing module)
// router.use("/stock", require("./stock_audit_routes")); (missing module)
router.use("/notifications", require("./notification_route"));
// router.use("/jobs", require("./job_route")); (missing module)
// router.use("/maintenance", require("./fix_inventory_route")); (missing module)
// router.use("/brands", require("./brand_route")); (missing module)
// router.use("/categories", require("./category_route")); (missing module)
router.use("/users", require("./user_route"));
router.use("/roles", require("./role_route"));
// router.use("/campaigns", require("./campaign_route")); (missing module)
router.use("/expenses", require("./expense_route"));
router.use("/expense-categories", require("./expense_category_routes"));
// router.use("/franchises", require("./franchise_route")); (missing module)
router.use("/attendance", require("./attendance_route"));
router.use("/face", require("./face_route")); // Face Attendance (BOTLens): enrolment + kiosk
// router.use("/marketing", require("./marketing_route")); (missing module)
// router.use("/schemes", require("./scheme_route")); (missing module)
// router.use("/scheme-status", require("./scheme_status_route")); (missing module)
router.use("/training", require("./training_route"));
router.use("/departments", require("./department_route"));
router.use("/designations", require("./designation_route"));
router.use("/shifts", require("./shift_route"));
router.use("/import", require("./import_route"));
// router.use("/installation", require("./installation_route")); (missing module)
// router.use("/service",      require("./service_route")); (missing module)
// router.use("/warranty",     require("./warranty_route")); (missing module)
// router.use("/account-groups", require("./account_group_route")); (missing module)
// router.use("/customer-categories", require("./customer_category_route")); (missing module)
// router.use("/account-masters", require("./account_master_route")); (missing module)
// router.use("/suppliers", require("./supplier_route")); (missing module)
// router.use("/dealers", require("./dealer_route")); (missing module)
// router.use("/supplier-categories", require("./supplier_category_route")); (missing module)
// router.use("/item-masters", require("./item_master_route")); (missing module)
// router.use("/financiers", require("./financier_route")); (missing module)
// router.use("/bank-summary",   require("./bank_summary_route")); (missing module)
// router.use("/collections",    require("./collections_route")); (missing module)
router.use("/leaves", require("./leave_route"));
router.use("/holidays", require("./holiday_route"));
router.use("/payroll", require("./payroll_route"));
router.use("/managing-companies", require("./managing_company_route"));
router.use("/salary-settlements", require("./salary_settlement_route"));
router.use("/locations", require("./location_route"));
// router.use("/model-classes", require("./model_class_route")); (missing module)
// router.use("/warranty-components", require("./warranty_component_master_route")); (missing module)
// router.use("/warranty-conditions", require("./warranty_condition_master_route")); (missing module)
// router.use("/service-tasks", require("./service_task_master_route")); (missing module)
// router.use("/service-plans", require("./service_plan_master_route")); (missing module)
// router.use("/hsn-sac", require("./hsn_sac_route")); (missing module)
// router.use("/products-master", require("./product_master_route")); (missing module)
// router.use("/settings", require("./system_settings_route")); (removed — HRMS-only settings dropped, main CRM's Setup > Settings covers this now)
// router.use("/initial-stock", require("./initial_stock_route")); (missing module)
// router.use("/internal-stock", require("./internal_stock_route")); (missing module)
// router.use("/sales-invoices", require("./sales_invoice_route")); (missing module)
// router.use("/sales-dcs", require("./sales_dc_route")); (missing module)
// router.use("/orders", require("./sales_order_route")); (missing module)
// router.use("/quotations", require("./quotation_route")); (missing module)
// router.use("/sales-returns", require("./sales_return_route")); (missing module)
router.use("/checklist", require("./checklist_routes"));
router.use("/todos", require("./todo_routes"));
router.use("/tasks", require("./task_route"));
// router.use("/auto-reminders", require("./auto_reminder_route")); (missing module)
router.use("/targets", require("./target_route"));
router.use("/incentive-rules", require("./incentive_rule_route"));
// router.use("/salespersons", require("./salesperson_route")); (missing module)
// router.use("/salesperson-targets", require("./salesperson_target_route")); (missing module)
// router.use("/general-ledger", require("./general_ledger_route")); (missing module)
// router.use("/purchase-orders", require("./purchase_order_route")); (missing module)
// router.use("/purchase-dcs", require("./purchase_dc_route")); (missing module)
// router.use("/purchase-bills", require("./purchase_bill_route")); (missing module)
// router.use("/purchase-returns", require("./purchase_return_route")); (missing module)
// router.use("/accounts-vouchers", require("./account_voucher_route")); (missing module)
// router.use("/reports",    require("./report_route")); (missing module)
router.use("/analytics", require("./analytics_route"));
// router.use("/api-docs", require("./swagger_route")); (missing module)
router.use("/branch-types", require("./branch_type_route"));
router.use("/hrms-branches", require("./hrms_branch_route"));
router.use("/advance-salary", require("./advance_salary_route"));
router.use("/salary-templates", require("./salary_template_route"));
// router.use("/imei", require("./imei_route")); (missing module)
// router.use("/delivery-address", require("./delivery_address_routes")); (missing module)

// Diagnostics: is push (Firebase Admin) configured on this running server?
router.get("/push-status", (req, res) => {
  const fcm = require("../utils/fcm_service");
  res.json({ success: true, pushEnabled: fcm.isConfigured() });
});

// Diagnostics: send a TEST push to users who have a registered FCM token.
// Guarded by x-job-secret (so it can be fired without a user session).
// Optional body: { email, title, body } — email targets one user, else all tokened users.
router.post("/push-test", async (req, res) => {
  try {
    if (process.env.JOB_SECRET && req.headers["x-job-secret"] !== process.env.JOB_SECRET) {
      return res.status(401).json({ success: false, message: "Invalid job secret" });
    }
    const fcm = require("../utils/fcm_service");
    if (!fcm.isConfigured()) {
      return res.status(503).json({ success: false, message: "Push not configured on server" });
    }
    const User = require("../models/user_model");
    const q = { fcmToken: { $exists: true, $nin: ["", null] } };
    if (req.body && req.body.email) q.email = req.body.email;
    const users = await User.find(q).select("fcmToken name email");

    let sent = 0;
    for (const u of users) {
      const ok = await fcm.sendPushNotification({
        token: u.fcmToken,
        title: (req.body && req.body.title) || "Test Notification",
        body: (req.body && req.body.body) || "Push notifications are working 🎉",
        data: { type: "TEST" },
      });
      if (ok) sent++;
    }
    res.json({ success: true, candidates: users.length, sent });
  } catch (err) {
    res.status(500).json({ success: false, message: err.message });
  }
});

// One-time setup: creates admin role + user if DB is empty
router.post("/setup", async (req, res) => {
  try {
    const User = require("../models/user_model");
    const Role = require("../models/role_model");

    const existingUser = await User.findOne({});
    if (existingUser) {
      return res.status(403).json({ message: "Setup already done. Users exist." });
    }

    let role = await Role.findOne({ role: "admin" });
    if (!role) {
      role = await Role.create({
        role: "admin",
        label: "Admin",
        description: "Full system access",
        isSystemRole: true,
        attendanceRequired: false,
        permissions: ["*"],
      });
    }

    await User.create({
      name: "Super Admin",
      email: "admin@screentime.com",
      password: "Admin@1234",
      role: role._id,
      isActive: true,
      attendanceRequired: false,
    });

    res.json({
      message: "Admin created successfully",
      email: "admin@screentime.com",
      password: "Admin@1234",
    });
  } catch (err) {
    res.status(500).json({ message: err.message });
  }
});

module.exports = router;
