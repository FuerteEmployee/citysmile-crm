const TodoTask = require("../models/todo_task_model");
const Inventory = require("../models/inventory_model");
const InstallationTicket = require("../models/installation_ticket_model");
const ServiceTicket = require("../models/service_ticket_model");
const SalesInvoice = require("../models/sales_invoice_model");
const PurchaseOrder = require("../models/purchase_order_model");
const LeaveRequest = require("../models/leave_request_model");
const SalespersonTarget = require("../models/salesperson_target_model");
const Salesperson = require("../models/salesperson_model");
const AccountVoucher = require("../models/account_voucher_model");
const PurchaseBill = require("../models/purchase_bill_model");
const Store = require("../models/store_model");
const Alert = require("../models/alert_model");

const DAY_MS = 864e5;
const toYMD = (d) => d.toISOString().split("T")[0];
const inr = (n) => `₹${Math.round(Number(n) || 0).toLocaleString("en-IN")}`;

// Upserts one TodoTask per generated item, keyed by `identifier` so re-runs
// (this fires hourly via the scheduler) never create duplicates. Entity-based
// identifiers (tied to a specific record) stay stable until resolved; daily
// summary identifiers embed the date so a fresh task appears each day.
async function upsertTasks(items) {
  await Promise.all(
    items.map(({ identifier, ...fields }) =>
      TodoTask.updateOne(
        { identifier },
        { $setOnInsert: { ...fields, identifier, status: "Pending", isSystemGenerated: true } },
        { upsert: true }
      )
    )
  );
}

// ── 1. Inventory: negative stock (data-integrity issue, not a normal alert) ──
async function negativeStockTasks() {
  const items = await Inventory.find({ quantity: { $lt: 0 } }).populate("productId", "name").lean();
  return items
    .filter((inv) => inv.productId)
    .map((inv) => ({
      identifier: `inv_neg_${inv._id}`,
      title: `Negative Stock Alert: ${inv.productId.name}`,
      description: `Stock is currently negative (${inv.quantity}) at this branch. Please review inventory logs.`,
      category: "Inventory",
      priority: "High",
      branchId: inv.branchId,
      relatedModule: "Inventory",
      relatedEntityId: inv._id,
      actionUrl: "/inventory/stock-dashboard",
    }));
}

// ── 2. Stock Alerts: out-of-stock / low-stock / dead-stock, one summary per
// branch per day — reuses the Alert records the existing daily stock-alert
// job (stock_alert_jobs.js) already maintains, rather than re-detecting them.
async function stockAlertSummaryTasks(dateStr) {
  const openAlerts = await Alert.find({ status: "open" }).lean();
  if (!openAlerts.length) return [];

  // Dead-stock value isn't stored as a clean number on the Alert doc (only
  // embedded in its free-text message), so we report a count, not a total.
  const byBranch = new Map();
  for (const a of openAlerts) {
    const key = String(a.branchId);
    if (!byBranch.has(key)) byBranch.set(key, { outOfStock: 0, lowStock: 0, deadStock: 0 });
    const bucket = byBranch.get(key);
    if (a.type === "OUT_OF_STOCK") bucket.outOfStock++;
    else if (a.type === "LOW_STOCK") bucket.lowStock++;
    else if (a.type === "DEAD_STOCK") bucket.deadStock++;
  }

  const stores = await Store.find({ _id: { $in: [...byBranch.keys()] } }).select("name").lean();
  const storeMap = new Map(stores.map((s) => [String(s._id), s.name]));

  return [...byBranch.entries()].map(([branchId, bucket]) => {
    const total = bucket.outOfStock + bucket.lowStock + bucket.deadStock;
    return {
      identifier: `stock_alerts_${branchId}_${dateStr}`,
      title: `Stock Alerts — ${storeMap.get(branchId) || "Branch"}`,
      description: `${bucket.outOfStock} out of stock, ${bucket.lowStock} low stock, ${bucket.deadStock} dead-stock item(s) flagged.`,
      category: "Inventory",
      priority: bucket.outOfStock > 0 ? "High" : total > 0 ? "Medium" : "Low",
      branchId,
      relatedModule: "Alert",
      actionUrl: "/inventory/alerts",
    };
  });
}

// ── 3. Service & Installation: installations >48h, service tickets >7 days ──
async function servicePendingTasks() {
  const twoDaysAgo = new Date(Date.now() - 48 * 36e5);
  const sevenDaysAgo = new Date(Date.now() - 7 * DAY_MS);

  const [pendingInstalls, pendingServices] = await Promise.all([
    InstallationTicket.find({
      status: { $nin: ["Completed", "Cancelled", "Closed By Customer"] },
      createdAt: { $lte: twoDaysAgo },
    }).populate("customerId", "name").lean(),
    ServiceTicket.find({
      status: { $nin: ["Completed", "Cancelled", "Closed By Customer", "Upcoming"] },
      createdAt: { $lte: sevenDaysAgo },
    }).populate("customerId", "name").lean(),
  ]);

  const installTasks = pendingInstalls.map((ticket) => ({
    identifier: `install_delay_${ticket._id}`,
    title: `Delayed Installation: ${ticket.ticketNo}`,
    description: `Installation pending for more than 48 hours for customer ${ticket.customerId?.name || "Unknown"}.`,
    category: "Service & Installation",
    priority: "High",
    branchId: ticket.storeId,
    relatedModule: "InstallationTicket",
    relatedEntityId: ticket._id,
    actionUrl: "/service/installation",
  }));

  const serviceTasks = pendingServices.map((ticket) => ({
    identifier: `service_delay_${ticket._id}`,
    title: `Aging Service Ticket: ${ticket.ticketNo}`,
    description: `${ticket.type} ticket open for more than 7 days for customer ${ticket.customerId?.name || "Unknown"}.`,
    category: "Service & Installation",
    priority: "High",
    branchId: ticket.storeId,
    relatedModule: "ServiceTicket",
    relatedEntityId: ticket._id,
    actionUrl: "/service/service",
  }));

  return [...installTasks, ...serviceTasks];
}

// ── 4. Purchase: orders awaiting approval ────────────────────────────────────
async function pendingPurchaseOrderTasks() {
  const pendingPOs = await PurchaseOrder.find({ status: "Pending" }).populate("supplierId", "name").lean();
  return pendingPOs.map((po) => ({
    identifier: `po_pending_${po._id}`,
    title: `Approve Purchase Order: ${po.docNo}`,
    description: `Purchase order requires approval. Supplier: ${po.supplierId?.name || "Unknown"}`,
    category: "Purchase",
    priority: "Medium",
    branchId: po.branchId,
    relatedModule: "PurchaseOrder",
    relatedEntityId: po._id,
    actionUrl: "/purchase/purchase-order",
  }));
}

// ── 5. Sales: invoices cancelled yesterday ───────────────────────────────────
async function cancelledInvoiceTasks(yesterdayStart, yesterdayEnd) {
  const cancelledInvoices = await SalesInvoice.find({
    status: "Cancelled",
    updatedAt: { $gte: yesterdayStart, $lte: yesterdayEnd },
  }).lean();

  return cancelledInvoices.map((inv) => ({
    identifier: `invoice_cancel_${inv._id}`,
    title: `Review Cancelled Invoice: ${inv.docNo}`,
    description: `Invoice was cancelled yesterday. Amount: ${inr(inv.summary?.netInvoiceValue)}`,
    category: "Sales",
    priority: "Medium",
    branchId: inv.branchId,
    relatedModule: "SalesInvoice",
    relatedEntityId: inv._id,
    actionUrl: `/sales/sales-invoice/${inv._id}`,
  }));
}

// ── 6. Sales Summary: yesterday's revenue by store vs daily-prorated target ─
async function salesSummaryTasks(yesterdayStart, yesterdayEnd, dateStr) {
  const [stores, revenueRows, targetRows] = await Promise.all([
    Store.find({ isActive: true }).select("name").lean(),
    SalesInvoice.aggregate([
      { $match: { status: { $ne: "Cancelled" }, docDate: { $gte: yesterdayStart, $lte: yesterdayEnd } } },
      { $group: { _id: "$branchId", revenue: { $sum: "$summary.netInvoiceValue" } } },
    ]),
    SalespersonTarget.aggregate([
      { $match: { month: yesterdayStart.getMonth() + 1, year: yesterdayStart.getFullYear() } },
      { $group: { _id: "$branchId", targetAmount: { $sum: "$targetAmount" } } },
    ]),
  ]);

  const revenueMap = new Map(revenueRows.map((r) => [String(r._id), r.revenue]));
  const targetMap = new Map(targetRows.map((t) => [String(t._id), t.targetAmount]));
  const daysInMonth = new Date(yesterdayStart.getFullYear(), yesterdayStart.getMonth() + 1, 0).getDate();

  return stores.map((store) => {
    const sid = String(store._id);
    const revenue = revenueMap.get(sid) || 0;
    const monthlyTarget = targetMap.get(sid) || 0;
    const dailyTarget = monthlyTarget / daysInMonth;
    const pct = dailyTarget > 0 ? Math.round((revenue / dailyTarget) * 100) : null;

    return {
      identifier: `sales_summary_${sid}_${dateStr}`,
      title: `Sales Summary — ${store.name}`,
      description: pct !== null
        ? `Yesterday's revenue: ${inr(revenue)} vs daily target ${inr(dailyTarget)} (${pct}%).`
        : `Yesterday's revenue: ${inr(revenue)}. No monthly target set for this branch.`,
      category: "Sales",
      priority: pct !== null && pct < 70 ? "High" : "Low",
      branchId: store._id,
      relatedModule: "SalesInvoice",
      actionUrl: "/reports/scoreboard",
    };
  });
}

// ── 7. Collection Pending: outstanding credit sales by store ────────────────
async function collectionPendingTasks(dateStr) {
  const [stores, overdueRows] = await Promise.all([
    Store.find({ isActive: true }).select("name").lean(),
    SalesInvoice.aggregate([
      { $match: { status: { $ne: "Cancelled" }, salesType: "Credit", pendingAmount: { $gt: 0 } } },
      { $group: { _id: "$branchId", count: { $sum: 1 }, total: { $sum: "$pendingAmount" } } },
    ]),
  ]);

  const overdueMap = new Map(overdueRows.map((r) => [String(r._id), r]));

  return stores.map((store) => {
    const sid = String(store._id);
    const row = overdueMap.get(sid);
    return {
      identifier: `collection_pending_${sid}_${dateStr}`,
      title: `Collection Pending — ${store.name}`,
      description: row
        ? `${row.count} credit invoice(s) outstanding, totalling ${inr(row.total)}.`
        : "No outstanding credit sales at this branch.",
      category: "Collections",
      priority: row && row.total > 0 ? "Medium" : "Low",
      branchId: store._id,
      relatedModule: "SalesInvoice",
      actionUrl: "/collections",
    };
  });
}

// ── 8. Staff Performance: top/bottom 3 by monthly target achievement, plus
// salespersons with no target set this month ──────────────────────────────
async function staffPerformanceTasks(now, dateStr) {
  const month = now.getMonth() + 1;
  const year = now.getFullYear();
  const monthStart = new Date(year, now.getMonth(), 1);

  const [achievedRows, targets, salespersons] = await Promise.all([
    SalesInvoice.aggregate([
      { $match: { status: { $ne: "Cancelled" }, docDate: { $gte: monthStart, $lte: now }, salespersonId: { $exists: true, $ne: null } } },
      { $group: { _id: "$salespersonId", achieved: { $sum: "$summary.netInvoiceValue" } } },
    ]),
    SalespersonTarget.find({ month, year }).lean(),
    Salesperson.find({ isActive: true }).populate("userId", "name").lean(),
  ]);

  const achievedMap = new Map(achievedRows.map((r) => [String(r._id), r.achieved]));
  const targetMap = new Map(targets.map((t) => [String(t.salespersonId), t.targetAmount]));

  const withTarget = [];
  const withoutTarget = [];
  for (const sp of salespersons) {
    const spId = String(sp._id);
    const name = sp.userId?.name || "Unknown";
    if (!targetMap.has(spId)) { withoutTarget.push(name); continue; }
    const target = targetMap.get(spId);
    const achieved = achievedMap.get(spId) || 0;
    withTarget.push({ name, achieved, target, pct: target > 0 ? Math.round((achieved / target) * 100) : 0 });
  }

  if (!withTarget.length && !withoutTarget.length) return [];

  withTarget.sort((a, b) => b.pct - a.pct);
  const top3 = withTarget.slice(0, 3);
  const bottom3 = withTarget.slice(-3).reverse();
  const fmtList = (rows) => rows.map((r) => `${r.name} (${r.pct}%)`).join(", ") || "—";

  const descriptionParts = [
    `Top: ${fmtList(top3)}.`,
    `Bottom: ${fmtList(bottom3)}.`,
  ];
  if (withoutTarget.length) descriptionParts.push(`${withoutTarget.length} salesperson(s) missing a target this month: ${withoutTarget.join(", ")}.`);

  return [{
    identifier: `staff_performance_${dateStr}`,
    title: "Staff Performance — Monthly Review",
    description: descriptionParts.join(" "),
    category: "HR & Sales Team",
    priority: withoutTarget.length ? "Medium" : "Low",
    relatedModule: "SalespersonTarget",
    actionUrl: "/reports/scoreboard",
  }];
}

// ── 9. Cash Flow: cash in hand + vendor dues + outstanding by store ─────────
async function cashFlowTasks(dateStr) {
  const thirtyDaysAgo = new Date(Date.now() - 30 * DAY_MS);
  const [stores, cashReceipts, cashPayments, vendorDue, outstanding] = await Promise.all([
    Store.find({ isActive: true }).select("name").lean(),
    AccountVoucher.aggregate([
      { $match: { voucherType: "receipt", paymentMode: "Cash", docDate: { $gte: thirtyDaysAgo } } },
      { $group: { _id: "$branchId", total: { $sum: "$amount" } } },
    ]),
    AccountVoucher.aggregate([
      { $match: { voucherType: "payment", paymentMode: "Cash", docDate: { $gte: thirtyDaysAgo } } },
      { $group: { _id: "$branchId", total: { $sum: "$amount" } } },
    ]),
    PurchaseBill.aggregate([
      { $match: { status: "Active" } },
      { $group: { _id: "$branchId", total: { $sum: "$balance" } } },
    ]),
    SalesInvoice.aggregate([
      { $match: { status: { $ne: "Cancelled" }, pendingAmount: { $gt: 0 } } },
      { $group: { _id: "$branchId", total: { $sum: "$pendingAmount" } } },
    ]),
  ]);

  const toMap = (rows) => new Map(rows.map((r) => [String(r._id), r.total]));
  const inMap = toMap(cashReceipts);
  const outMap = toMap(cashPayments);
  const vendorMap = toMap(vendorDue);
  const outstandingMap = toMap(outstanding);

  return stores.map((store) => {
    const sid = String(store._id);
    const cashInHand = Math.max(0, (inMap.get(sid) || 0) - (outMap.get(sid) || 0));
    const vendorPaymentsDue = vendorMap.get(sid) || 0;
    const forecast = outstandingMap.get(sid) || 0;

    return {
      identifier: `cash_flow_${sid}_${dateStr}`,
      title: `Cash Flow — ${store.name}`,
      description: `Cash in hand: ${inr(cashInHand)}. Vendor payments due: ${inr(vendorPaymentsDue)}. Collection forecast (outstanding): ${inr(forecast)}.`,
      category: "Finance",
      priority: vendorPaymentsDue > cashInHand ? "High" : "Low",
      branchId: store._id,
      relatedModule: "AccountVoucher",
      actionUrl: "/reports/bank",
    };
  });
}

// ── 10. HR: leave requests awaiting approval ─────────────────────────────────
async function pendingLeaveTasks() {
  const pendingLeaves = await LeaveRequest.find({ status: "pending" }).populate("employeeId", "name storeId").lean();
  return pendingLeaves.map((leave) => ({
    identifier: `leave_pending_${leave._id}`,
    title: `Leave Approval: ${leave.employeeId?.name || "Employee"}`,
    description: `Pending leave request from ${new Date(leave.fromDate).toLocaleDateString()} to ${new Date(leave.toDate).toLocaleDateString()}`,
    category: "HR & Sales Team",
    priority: "Medium",
    branchId: leave.employeeId?.storeId,
    relatedModule: "LeaveRequest",
    relatedEntityId: leave._id,
    actionUrl: "/staff/leave-management",
  }));
}

exports.generateTodos = async () => {
  const now = new Date();
  const todayStr = toYMD(now);

  const yesterdayStart = new Date(now);
  yesterdayStart.setDate(yesterdayStart.getDate() - 1);
  yesterdayStart.setHours(0, 0, 0, 0);
  const yesterdayEnd = new Date(now);
  yesterdayEnd.setDate(yesterdayEnd.getDate() - 1);
  yesterdayEnd.setHours(23, 59, 59, 999);

  const taskBatches = await Promise.all([
    negativeStockTasks(),
    stockAlertSummaryTasks(todayStr),
    servicePendingTasks(),
    pendingPurchaseOrderTasks(),
    cancelledInvoiceTasks(yesterdayStart, yesterdayEnd),
    salesSummaryTasks(yesterdayStart, yesterdayEnd, todayStr),
    collectionPendingTasks(todayStr),
    staffPerformanceTasks(now, todayStr),
    cashFlowTasks(todayStr),
    pendingLeaveTasks(),
  ]);

  await upsertTasks(taskBatches.flat());
};
