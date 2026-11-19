const Invoice = require("../models/Invoice");
const Payment = require("../models/Payment");
const Client = require("../models/Client");
const Project = require("../models/Project");
const Task = require("../models/Task");
const Ticket = require("../models/Ticket");

// Numeric enums decoded here (not by the model) so the snapshot is
// self-explanatory — the LLM never has to guess what "2" means.
const PROJECT_STATUS = { 1: "Not Started", 2: "In Progress", 3: "On Hold", 4: "Finished", 5: "Cancelled" };
const TASK_STATUS = { 1: "Not Started", 2: "Awaiting Feedback", 3: "Testing", 4: "In Progress", 5: "Complete" };

const fmtDate = (d) => (d ? new Date(d).toISOString().slice(0, 10) : "");

// Builds a compact, token-cheap CRM snapshot for one customer — Invoice,
// Payment, Project, Task, Ticket only. Outstanding is summed in JS; the
// model is never asked to add numbers.
async function buildSnapshot(customerId) {
  const client = await Client.findById(customerId).select("company").lean();
  const customerName = client?.company || "Unknown";

  const invoices = await Invoice.find({ client: customerId })
    .select("number total status duedate")
    .sort({ date: -1 })
    .limit(10)
    .lean();

  const invoiceIds = invoices.map((inv) => inv._id);
  const payments = await Payment.find({ invoice: { $in: invoiceIds } })
    .select("amount date paymentmode invoice")
    .sort({ date: -1 })
    .limit(10)
    .lean();

  // paid-per-invoice, computed here — never delegated to the model
  const paidByInvoice = new Map();
  for (const p of payments) {
    const key = String(p.invoice);
    paidByInvoice.set(key, (paidByInvoice.get(key) || 0) + p.amount);
  }

  let outstanding = 0;
  let unpaidCount = 0;
  const invoiceLines = invoices.map((inv) => {
    const paid = paidByInvoice.get(String(inv._id)) || 0;
    const balance = inv.total - paid;
    if (inv.status !== "paid" && inv.status !== "cancelled" && balance > 0) {
      outstanding += balance;
      unpaidCount += 1;
    }
    return `${inv.number}|${inv.total}|${paid}|${inv.status}|${fmtDate(inv.duedate)}`;
  });

  const paymentLines = payments.map((p) => `${p.amount}|${fmtDate(p.date)}|${p.paymentmode || ""}`);

  const projects = await Project.find({ clientid: customerId })
    .select("name status deadline progress")
    .sort({ project_created: -1 })
    .limit(10)
    .lean();
  const projectLines = projects.map(
    (p) => `${p.name}|${PROJECT_STATUS[p.status] || p.status}|${p.progress ?? 0}|${fmtDate(p.deadline)}`
  );

  // Tasks link to a customer via rel_type/rel_id (polymorphic), not a direct
  // "client" field — only "rel_type: customer" tasks are picked up here.
  // Tasks attached only to this customer's projects are not included yet.
  const tasks = await Task.find({ rel_type: "customer", rel_id: customerId })
    .select("name status duedate")
    .sort({ duedate: -1 })
    .limit(10)
    .lean();
  const taskLines = tasks.map((t) => `${t.name}|${TASK_STATUS[t.status] || t.status}|${fmtDate(t.duedate)}`);

  const tickets = await Ticket.find({ client: customerId })
    .select("subject status date")
    .sort({ date: -1 })
    .limit(10)
    .lean();
  const ticketLines = tickets.map((t) => `${t.subject}|${t.status}|${fmtDate(t.date)}`);

  return [
    `CUSTOMER: ${customerName} (${customerId})`,
    "INVOICES: number|total|paid|status|due",
    ...invoiceLines,
    "PAYMENTS: amount|date|mode",
    ...paymentLines,
    `PRECOMPUTED: outstanding=${outstanding} unpaid_count=${unpaidCount}`,
    "PROJECTS: name|status|progress|deadline",
    ...projectLines,
    "TASKS: name|status|duedate",
    ...taskLines,
    "TICKETS: subject|status|date",
    ...ticketLines,
  ].join("\n");
}

module.exports = { buildSnapshot };
