const Client = require("../models/Client");
const Contact = require("../models/Contact");
const Invoice = require("../models/Invoice");
const Payment = require("../models/Payment");
const Staff = require("../models/Staff");
const ClientGroup = require("../models/ClientGroup");
const HRMSBranch = require("../hrms/models/hrms_branch_model");
const CustomFieldService = require("../services/CustomFieldService");
const { logActivity } = require("../services/ActivityLogService");
const fs = require("fs");
const path = require("path");
const mongoose = require("mongoose");
const FileModel = require("../models/File");
const VaultEntry = require("../models/VaultEntry");
const Reminder = require("../models/Reminder");
const Note = require("../models/Note");
const { toE164 } = require("../utils/phoneNormalize");
const { withoutProtected, isObjectId, statusForError } = require("../utils/requestSafety");
const { checkEmail, checkContactPhone, checkLength, firstError, isBlank } = require("../hrms/utils/fieldRules");
const {
  tenantScope, findOwnClient, validateClientData, checkClientRefs, findDuplicateCompany, findDuplicateReference,
  pendingCreates, createLockKey, escapeRegExp, HTML_TAG,
} = require("../utils/customerRules");

const enrichClients = async (clients) => {
  const primaryContacts = clients.length
    ? await Contact.find({ is_primary: true, userid: { $in: clients.map((c) => c._id) } })
    : [];

  const cfByClient = await CustomFieldService.getValuesForMany(clients.map((c) => c._id), "customers");
  return clients.map((client) => {
    const primaryContact = primaryContacts.find((c) => c.userid.toString() === client._id.toString());
    const clientObj = client.toObject();
    clientObj.custom_fields = cfByClient.get(String(client._id)) || {};
    clientObj.primaryContact = primaryContact;
    return clientObj;
  });
};

// Staff with only "View (Own)" on Customers (set by checkPermission as req.permissionLevel)
// may only see customers where they are assigned as Customer Admin, Sales Person, or Creator.
const applyOwnScope = (req, query) => {
  if (req.permissionLevel === "own" && req.user?._id) {
    query.$or = [
      { "admins.staff": req.user._id },
      { sales_person: req.user._id },
      { created_by: req.user._id },
    ];
  }
  return query;
};

const getClients = async (req, res) => {
  try {
    const filter = {};
    if (!req.user?.is_superadmin && req.user?.tenant_id) filter.tenant_id = req.user.tenant_id;
    applyOwnScope(req, filter);

    const { page, limit, search, status, branch } = req.query;
    const isPaginated = page !== undefined || limit !== undefined || search !== undefined;

    // Legacy behavior, unchanged: callers that don't ask for pagination
    // (dropdowns/selects across the app, exports, other pages) keep getting
    // the full bare array exactly as before.
    if (!isPaginated) {
      const clients = await Client.find(filter)
        .populate("groups")
        .populate("created_by", "firstname lastname")
        .populate("admins.staff", "firstname lastname")
        .populate("branch", "name city")
        .populate("sales_person", "firstname lastname")
        .sort({ createdAt: -1 });

      return res.json(await enrichClients(clients));
    }

    // Preserve any existing $or conditions (e.g. from applyOwnScope)
    const andConditions = [];
    if (filter.$or) {
      andConditions.push({ $or: filter.$or });
      delete filter.$or;
    }

    if (search && String(search).trim()) {
      const re = new RegExp(escapeRegExp(String(search).trim()), "i");

      // Groups and Branch are shown in the table by name, but stored as refs
      // — resolve which ones match the search text (scoped to the same
      // tenant) so those columns are searchable too, not just plain-string fields.
      const refScope = req.user?.is_superadmin ? {} : { tenant_id: req.user?.tenant_id };
      const [matchedGroupIds, matchedBranchIds] = await Promise.all([
        ClientGroup.find({ ...refScope, name: re }).distinct("_id"),
        HRMSBranch.find({ ...refScope, name: re }).distinct("_id"),
      ]);

      andConditions.push({
        $or: [
          { company: re },
          { contact_person: re },
          { email: re },
          { phonenumber: re },
          { customer_reference: re },
          { pan_number: re },
          { gst_number: re },
          { groups: { $in: matchedGroupIds } },
          { branch: { $in: matchedBranchIds } },
        ],
      });
    }

    if (andConditions.length > 0) {
      filter.$and = andConditions;
    }

    // Customers are only Active or Inactive (anything not active, incl. legacy null, is Inactive).
    // Any other status value (e.g. the old "Lead" option) matches nothing.
    if (status === "Active") filter.active = true;
    else if (status === "Inactive") filter.active = { $ne: true };
    else if (status && status !== "all") filter._id = { $in: [] };
    if (branch) {
      if (!isObjectId(String(branch))) return res.status(400).json({ message: "Invalid branch filter" });
      filter.branch = branch;
    }

    const pageNum = Math.max(parseInt(page, 10) || 1, 1);
    const limitNum = Math.min(Math.max(parseInt(limit, 10) || 25, 1), 500);

    const [total, activeCount, clients] = await Promise.all([
      Client.countDocuments(filter),
      Client.countDocuments({ ...filter, active: true }),
      Client.find(filter)
        .populate("groups")
        .populate("created_by", "firstname lastname")
        .populate("admins.staff", "firstname lastname")
        .populate("branch", "name city")
        .populate("sales_person", "firstname lastname")
        .sort({ createdAt: -1 })
        .skip((pageNum - 1) * limitNum)
        .limit(limitNum),
    ]);

    const clientsWithData = await enrichClients(clients);

    res.json({
      data: clientsWithData,
      total,
      activeCount,
      inactiveCount: total - activeCount,
      page: pageNum,
      pages: Math.max(Math.ceil(total / limitNum), 1),
      limit: limitNum,
    });
  } catch (error) {
    res.status(500).json({ message: error.message });
  }
};

const getClientById = async (req, res) => {
  try {
    const client = await Client.findById(req.params.id)
      .populate("groups")
      .populate("created_by", "firstname lastname")
      .populate("admins.staff", "firstname lastname")
      .populate("branch", "name city")
      .populate("sales_person", "firstname lastname");

    if (!client) {
      return res.status(404).json({ message: "Client not found" });
    }

    // Check tenant isolation
    if (!req.user?.is_superadmin && req.user?.tenant_id) {
      if (client.tenant_id && client.tenant_id.toString() !== req.user.tenant_id.toString()) {
        return res.status(404).json({ message: "Client not found" });
      }
    }

    // Check own scope
    if (req.permissionLevel === "own" && req.user?._id) {
      const uid = req.user._id.toString();
      const isAdmin = Array.isArray(client.admins) && client.admins.some((a) => {
        const sid = a.staff?._id || a.staff;
        return sid && sid.toString() === uid;
      });
      const isSales = (client.sales_person?._id || client.sales_person)?.toString() === uid;
      const isCreator = (client.created_by?._id || client.created_by)?.toString() === uid;

      if (!isAdmin && !isSales && !isCreator) {
        return res.status(403).json({ message: "Forbidden: You do not have permission to view this customer" });
      }
    }

    // Fetch custom fields for this client
    const customFields = await CustomFieldService.getValues(client._id, "customers");
    const clientWithCustomFields = { ...client._doc, custom_fields: customFields };

    res.json(clientWithCustomFields);
  } catch (error) {
    res.status(500).json({ message: error.message });
  }
};

const createClient = async (req, res) => {
  const { error, data, custom_fields } = validateClientData(req.body, { isCreate: true });
  if (error) return res.status(400).json({ message: error });

  const lockKey = createLockKey(req, data.company);
  if (pendingCreates.has(lockKey)) {
    return res.status(409).json({ message: `A customer named "${data.company}" is already being created` });
  }
  pendingCreates.add(lockKey);
  try {
    const refError = await checkClientRefs(req, data);
    if (refError) return res.status(400).json({ message: refError });
    if (await findDuplicateCompany(req, data.company)) {
      return res.status(409).json({ message: `A customer named "${data.company}" already exists` });
    }
    if (await findDuplicateReference(req, data.customer_reference)) {
      return res.status(409).json({ message: `Customer Reference "${data.customer_reference}" is already used` });
    }

    const client = await Client.create({
      ...data,
      branch: data.branch || null,
      sales_person: data.sales_person || null,
      created_by: req.user._id,
      tenant_id: req.user?.tenant_id,
    });

    if (custom_fields) {
      await CustomFieldService.handlePost(client._id, "customers", custom_fields, client.tenant_id);
    }
    logActivity(req, `Created customer: ${client.company}`, { rel_id: client._id, rel_type: "customer" });
    res.status(201).json(client);
  } catch (error) {
    res.status(statusForError(error)).json({ message: error.message });
  } finally {
    pendingCreates.delete(lockKey);
  }
};

// Drops body keys whose value is the same as what is already stored, so an edit
// form that re-sends the whole record only validates (and writes) what changed.
const sameValue = (a, b) => {
  const norm = (v) => {
    if (v === undefined || v === null || v === "") return "";
    if (Array.isArray(v)) return JSON.stringify(v.map((x) => norm(x)));
    if (v instanceof Date) return v.toISOString();
    if (typeof v === "object") return String(v._id || JSON.stringify(v));
    return String(v);
  };
  return norm(a) === norm(b);
};

const updateClient = async (req, res) => {
  try {
    const client = await findOwnClient(req, req.params.id);
    if (!client) return res.status(404).json({ message: "Client not found" });

    const body = { ...(req.body || {}) };
    for (const k of Object.keys(body)) {
      if (k === "custom_fields" || k === "admins") continue;
      if (sameValue(body[k], client[k])) delete body[k];
    }
    const { error, data, custom_fields } = validateClientData(body, { isCreate: false, existing: client.toObject() });
    if (error) return res.status(400).json({ message: error });

    const refError = await checkClientRefs(req, data, client);
    if (refError) return res.status(400).json({ message: refError });
    if ("company" in data && (await findDuplicateCompany(req, data.company, client._id))) {
      return res.status(409).json({ message: `A customer named "${data.company}" already exists` });
    }
    if ("customer_reference" in data && (await findDuplicateReference(req, data.customer_reference, client._id))) {
      return res.status(409).json({ message: `Customer Reference "${data.customer_reference}" is already used` });
    }

    // Only the fields actually sent are written — a partial PUT ({ active }) keeps everything else.
    client.set(data);
    const updatedClient = await client.save();

    if (custom_fields) {
      await CustomFieldService.handlePost(client._id, "customers", custom_fields, client.tenant_id);
    }
    logActivity(req, `Updated customer: ${updatedClient.company}`, { rel_id: updatedClient._id, rel_type: "customer" });
    res.json(updatedClient);
  } catch (error) {
    res.status(statusForError(error)).json({ message: error.message });
  }
};

// Records that would be orphaned by deleting a customer.
const countLinkedRecords = async (clientId) => {
  const Estimate = mongoose.models.Estimate || require("../models/Estimate");
  const Proposal = mongoose.models.Proposal || require("../models/Proposal");
  const [invoices, estimates, proposals, payments] = await Promise.all([
    Invoice.countDocuments({ client: clientId }),
    Estimate.countDocuments({ client: clientId }),
    Proposal.countDocuments({ rel_type: "customer", rel_id: clientId }),
    Payment.countDocuments({ client: clientId }),
  ]);
  return { invoices, estimates, proposals, payments };
};
const linkedMessage = (company, counts) => {
  const parts = Object.entries(counts).filter(([, n]) => n > 0).map(([k, n]) => `${n} ${n === 1 ? k.replace(/s$/, "") : k}`);
  return parts.length ? `Cannot delete "${company}": it has ${parts.join(", ")}. Mark it inactive instead.` : null;
};

// Removes everything that only belongs to these customers (contacts, files on disk, vault, reminders, notes).
const deleteClientChildren = async (clientIds) => {
  if (!clientIds.length) return;
  const files = await FileModel.find({ rel_type: "customer", rel_id: { $in: clientIds } }).select("attachment_key");
  for (const f of files) {
    if (!f.attachment_key) continue;
    const p = path.join(__dirname, "../uploads", path.basename(f.attachment_key));
    try { if (fs.existsSync(p)) fs.unlinkSync(p); } catch (e) { console.error("[customers] file cleanup failed:", e.message); }
  }
  await Promise.all([
    Contact.deleteMany({ userid: { $in: clientIds } }),
    FileModel.deleteMany({ rel_type: "customer", rel_id: { $in: clientIds } }),
    VaultEntry.deleteMany({ client: { $in: clientIds } }),
    Reminder.deleteMany({ rel_type: "customer", rel_id: { $in: clientIds } }),
    Note.deleteMany({ rel_type: "customer", rel_id: { $in: clientIds } }),
  ]);
};

const deleteClient = async (req, res) => {
  try {
    const client = await findOwnClient(req, req.params.id);
    if (!client) return res.status(404).json({ message: "Client not found" });

    const blocked = linkedMessage(client.company, await countLinkedRecords(client._id));
    if (blocked) return res.status(409).json({ message: blocked });

    const clientCompany = client.company;
    await deleteClientChildren([client._id]);
    await client.deleteOne();
    logActivity(req, `Deleted customer: ${clientCompany}`, { rel_type: "customer" });
    res.json({ message: "Client and associated records removed" });
  } catch (error) {
    res.status(statusForError(error)).json({ message: error.message });
  }
};

// One request, one deleteMany — replaces firing one DELETE per selected
// customer from the browser. Customers that still have invoices / estimates /
// proposals / payments are skipped (reported back), never orphaned.
const bulkDeleteClients = async (req, res) => {
  try {
    const ids = Array.isArray(req.body?.ids) ? req.body.ids.map(String).filter((id) => isObjectId(id)) : [];
    if (ids.length === 0) return res.status(400).json({ message: "No customer ids provided" });

    const matched = await Client.find({ _id: { $in: ids }, ...tenantScope(req) }).select("_id company").lean();

    const deletable = [];
    const skipped = [];
    for (const m of matched) {
      const reason = linkedMessage(m.company, await countLinkedRecords(m._id));
      if (reason) skipped.push({ id: m._id, company: m.company, reason });
      else deletable.push(m._id);
    }

    await deleteClientChildren(deletable);
    const result = deletable.length ? await Client.deleteMany({ _id: { $in: deletable } }) : { deletedCount: 0 };

    logActivity(req, `Bulk-deleted ${result.deletedCount} customer(s)`, { rel_type: "customer" });
    res.json({
      message: `Deleted ${result.deletedCount} customer(s)${skipped.length ? `, skipped ${skipped.length} with linked records` : ""}`,
      deletedCount: result.deletedCount,
      skipped,
    });
  } catch (error) {
    res.status(statusForError(error)).json({ message: error.message });
  }
};

// Bulk "Assign to Group": ADDS the group to each selected customer (keeps their other groups).
const bulkAssignGroup = async (req, res) => {
  try {
    const ids = Array.isArray(req.body?.ids) ? req.body.ids.map(String).filter((id) => isObjectId(id)) : [];
    const groupId = String(req.body?.groupId || "");
    if (ids.length === 0) return res.status(400).json({ message: "No customer ids provided" });
    if (!isObjectId(groupId) || !(await ClientGroup.exists({ _id: groupId, ...tenantScope(req) }))) {
      return res.status(400).json({ message: "Group was not found in your company" });
    }
    const result = await Client.updateMany({ _id: { $in: ids }, ...tenantScope(req) }, { $addToSet: { groups: groupId } });
    res.json({ message: `Added group to ${result.matchedCount} customer(s)`, count: result.matchedCount });
  } catch (error) {
    res.status(statusForError(error)).json({ message: error.message });
  }
};

// CONTACT CONTROLLERS
// A contact belongs to a customer; the customer must be in the caller's company.
const contactPublic = (c) => {
  if (!c) return c;
  const o = typeof c.toJSON === "function" ? c.toJSON() : { ...c };
  delete o.password;
  return o;
};

const CONTACT_FIELDS = [
  "firstname", "lastname", "email", "phonenumber", "title", "is_primary", "active", "password",
  "invoice_emails", "estimate_emails", "credit_note_emails", "contract_emails", "task_emails", "project_emails", "ticket_emails",
];
function validateContactData(body, { isCreate }) {
  const src = withoutProtected(body || {});
  const data = {};
  for (const k of CONTACT_FIELDS) if (k in src) data[k] = typeof src[k] === "string" ? src[k].trim() : src[k];
  if (isCreate || "firstname" in data) if (isBlank(data.firstname)) return { error: "First name is required" };
  if (isCreate || "lastname" in data) if (isBlank(data.lastname)) return { error: "Last name is required" };
  if (isCreate || "email" in data) if (isBlank(data.email)) return { error: "Email is required" };
  const error = firstError(
    checkEmail("Email", data.email),
    checkContactPhone("Phone", data.phonenumber),
    checkLength("First name", data.firstname, 100),
    checkLength("Last name", data.lastname, 100),
    checkLength("Position", data.title, 150),
    ["firstname", "lastname", "title"].some((k) => typeof data[k] === "string" && HTML_TAG.test(data[k])) ? "Contact names must not contain HTML tags" : null,
  );
  if (error) return { error };
  if ("password" in data && isBlank(data.password)) delete data.password;
  return { data };
}

const findOwnContact = async (req, id) => {
  if (!isObjectId(String(id || ""))) return null;
  const contact = await Contact.findById(id);
  if (!contact) return null;
  const owner = await findOwnClient(req, contact.userid);
  return owner ? contact : null;
};

const getContacts = async (req, res) => {
  try {
    const client = await findOwnClient(req, req.params.clientId);
    if (!client) return res.status(404).json({ message: "Client not found" });
    const contacts = await Contact.find({ userid: client._id }).select("-password");
    res.json(contacts);
  } catch (error) {
    res.status(statusForError(error)).json({ message: error.message });
  }
};

const getAllContacts = async (req, res) => {
  try {
    // Contact has no tenant_id of its own — it's scoped via its parent
    // Client (`userid`), so resolve this tenant's client ids first.
    const filter = {};
    if (!req.user?.is_superadmin && req.user?.tenant_id) {
      const tenantClients = await Client.find({ tenant_id: req.user.tenant_id }).select("_id");
      filter.userid = { $in: tenantClients.map((c) => c._id) };
    }

    const { page, limit, search, status, filter: queryFilter } = req.query;
    const isPaginated = page !== undefined || limit !== undefined || search !== undefined || status !== undefined || queryFilter !== undefined;

    // Legacy behavior, unchanged: callers that don't ask for pagination
    // (TicketCreate/TicketView contact pickers) keep getting the full bare
    // array exactly as before.
    if (!isPaginated) {
      const contacts = await Contact.find(filter).select("-password").populate("userid", "company");
      return res.json(contacts);
    }

    if (status === "active") {
      filter.active = { $ne: false };
    } else if (status === "inactive") {
      filter.active = false;
    }

    if (queryFilter === "logged_in") {
      filter.last_login = { $ne: null, $exists: true };
    }

    if (search && String(search).trim()) {
      const re = new RegExp(escapeRegExp(String(search).trim()), "i");
      const matchingClients = await Client.find({ ...tenantScope(req), company: re }).select("_id");
      filter.$or = [
        { firstname: re },
        { lastname: re },
        { email: re },
        { phonenumber: re },
        { title: re },
        { userid: { $in: matchingClients.map((c) => c._id) } },
      ];
    }

    const pageNum = Math.max(parseInt(page, 10) || 1, 1);
    const limitNum = Math.min(Math.max(parseInt(limit, 10) || 25, 1), 500);

    const [total, contacts] = await Promise.all([
      Contact.countDocuments(filter),
      Contact.find(filter)
        .select("-password")
        .populate("userid", "company")
        .sort({ createdAt: -1 })
        .skip((pageNum - 1) * limitNum)
        .limit(limitNum),
    ]);

    res.json({
      data: contacts,
      total,
      page: pageNum,
      pages: Math.max(Math.ceil(total / limitNum), 1),
      limit: limitNum,
    });
  } catch (error) {
    res.status(statusForError(error)).json({ message: error.message });
  }
};

const createContact = async (req, res) => {
  try {
    const client = await findOwnClient(req, req.params.clientId);
    if (!client) return res.status(404).json({ message: "Client not found" });
    const { error, data } = validateContactData(req.body, { isCreate: true });
    if (error) return res.status(400).json({ message: error });
    const contact = await Contact.create({ ...data, userid: client._id });
    res.status(201).json(contactPublic(contact));
  } catch (error) {
    res.status(statusForError(error)).json({ message: error.message });
  }
};

// Uses save() (not findByIdAndUpdate) so the model hooks run: the password is
// hashed and phoneE164 follows the phone number.
const updateContact = async (req, res) => {
  try {
    const contact = await findOwnContact(req, req.params.id);
    if (!contact) return res.status(404).json({ message: "Contact not found" });
    const { error, data } = validateContactData(req.body, { isCreate: false });
    if (error) return res.status(400).json({ message: error });
    contact.set(data);
    await contact.save();
    res.json(contactPublic(contact));
  } catch (error) {
    res.status(statusForError(error)).json({ message: error.message });
  }
};

const deleteContact = async (req, res) => {
  try {
    const contact = await findOwnContact(req, req.params.id);
    if (!contact) return res.status(404).json({ message: "Contact not found" });
    await contact.deleteOne();
    res.json({ message: "Contact removed" });
  } catch (error) {
    res.status(statusForError(error)).json({ message: error.message });
  }
};

// Cancelled and draft invoices are not money owed, so they stay off the statement.
const STATEMENT_EXCLUDED = ["cancelled", "draft"];
// "YYYY-MM-DD" as an end date means the whole of that day.
const parseStatementDate = (value, endOfDay) => {
  if (!value) return null;
  const d = new Date(value);
  if (isNaN(d.getTime())) return undefined;
  if (endOfDay && /^\d{4}-\d{2}-\d{2}$/.test(String(value))) d.setUTCHours(23, 59, 59, 999);
  return d;
};

const getStatement = async (req, res) => {
  try {
    const client = await findOwnClient(req, req.params.id);
    if (!client) return res.status(404).json({ message: "Client not found" });
    const id = client._id;

    const startDate = parseStatementDate(req.query.from, false) ?? new Date(0);
    const endDate = parseStatementDate(req.query.to, true) ?? new Date();
    if (startDate === undefined || endDate === undefined || isNaN(startDate) || isNaN(endDate)) {
      return res.status(400).json({ message: "Invalid from / to date" });
    }

    const allClientInvoices = await Invoice.find({ client: id, status: { $nin: STATEMENT_EXCLUDED } });
    const allClientInvoiceIds = allClientInvoices.map((inv) => inv._id);

    const prevInvoicesSum = allClientInvoices
      .filter((inv) => new Date(inv.date) < startDate)
      .reduce((sum, inv) => sum + (inv.total || 0), 0);

    const prevPaymentsSum = await Payment.find({
      invoice: { $in: allClientInvoiceIds },
      date: { $lt: startDate },
    }).then((payments) => payments.reduce((sum, p) => sum + (p.amount || 0), 0));

    const beginningBalance = prevInvoicesSum - prevPaymentsSum;

    const invoicesInRange = allClientInvoices.filter((inv) => {
      const d = new Date(inv.date);
      return d >= startDate && d <= endDate;
    });

    const paymentsInRange = await Payment.find({
      invoice: { $in: allClientInvoiceIds },
      date: { $gte: startDate, $lte: endDate },
    }).populate("invoice");

    const entries = [
      ...invoicesInRange.map((inv) => ({
        date: inv.date,
        details: `Invoice ${inv.number} - due on ${inv.duedate ? new Date(inv.duedate).toLocaleDateString() : "N/A"}`,
        amount: inv.total,
        payments: 0,
        type: "invoice",
      })),
      ...paymentsInRange.map((p) => ({
        date: p.date,
        details: `Payment (#${p.transactionid || p._id}) to invoice ${p.invoice?.number || "N/A"}`,
        amount: 0,
        payments: p.amount,
        type: "payment",
      })),
    ];

    entries.sort((a, b) => new Date(a.date).getTime() - new Date(b.date).getTime());

    let currentBalance = beginningBalance;
    const entriesWithBalance = entries.map((entry) => {
      currentBalance += entry.amount - entry.payments;
      return { ...entry, balance: currentBalance };
    });

    res.json({
      beginningBalance,
      totalInvoiced: invoicesInRange.reduce((sum, inv) => sum + (inv.total || 0), 0),
      totalPaid: paymentsInRange.reduce((sum, p) => sum + (p.amount || 0), 0),
      balanceDue: currentBalance,
      entries: entriesWithBalance,
      from: startDate,
      to: endDate,
    });
  } catch (error) {
    res.status(statusForError(error)).json({ message: error.message });
  }
};


const sendStatementEmail = async (req, res) => {
  try {
    const client = await findOwnClient(req, req.params.id);
    if (!client) return res.status(404).json({ message: "Client not found" });

    const rawTo = req.body?.to || req.body?.email;
    const to = Array.isArray(rawTo) ? rawTo : [rawTo].filter(Boolean);
    const rawCc = req.body?.cc;
    const cc = Array.isArray(rawCc) ? rawCc : (rawCc ? String(rawCc).split(",").map(s => s.trim()).filter(Boolean) : []);
    const subject = String(req.body?.subject || `Account Statement - ${client.company}`).trim();
    const bodyText = String(req.body?.body || req.body?.message || "Please find your account statement attached.").trim();
    const html = req.body?.html;

    if (!to.length) return res.status(400).json({ message: "Please enter at least one recipient email address in To." });

    const attachments = [];
    if (req.body?.pdf_base64) {
      const pdf = Buffer.from(String(req.body.pdf_base64), "base64");
      attachments.push({
        filename: `Statement_${String(client.company || "Client").replace(/[^\w.-]+/g, "_")}.pdf`,
        content: pdf,
        contentType: "application/pdf",
      });
    }

    const EmailService = require("../services/EmailService");
    await EmailService.sendMail({
      tenantId: client.tenant_id,
      to,
      cc,
      subject,
      text: bodyText,
      html,
      attachments,
    });

    logActivity(req, `Emailed account statement for ${client.company} to ${to.join(", ")}`, { rel_id: client._id, rel_type: "customer" });
    res.json({ message: `Statement successfully sent to ${to.join(", ")}` });
  } catch (error) {
    const notSetUp = /SMTP not configured/.test(error.message);
    res.status(notSetUp ? 400 : 500).json({ message: error.message });
  }
};

const importContacts = async (req, res) => {
  try {
    const rows = Array.isArray(req.body) ? req.body : req.body.contacts;
    if (!rows || !Array.isArray(rows) || rows.length === 0)
      return res.status(400).json({ message: "No valid contact data provided" });

    const scope = tenantScope(req);

    // Collect unique company names to batch-fetch clients
    const companyNames = [...new Set(
      rows.map((r) => String(r.company || r.Company || r["Company Name"] || "").trim()).filter(Boolean)
    )];

    const clients = companyNames.length
      ? await Client.find({ ...scope, company: { $in: companyNames.map((n) => new RegExp(`^${escapeRegExp(n)}$`, "i")) } }).select("_id company")
      : [];

    const clientMap = new Map(clients.map((c) => [c.company.toLowerCase().trim(), c._id]));

    const sanitized = rows.map((r) => {
      const company = String(r.company || r.Company || r["Company Name"] || "").trim();
      const userid = clientMap.get(company.toLowerCase());
      return {
        userid,
        firstname: String(r.firstname || r["First Name"] || r.first_name || "").trim(),
        lastname: String(r.lastname || r["Last Name"] || r.last_name || "-").trim() || "-",
        email: String(r.email || r.Email || "").trim().toLowerCase(),
        phonenumber: String(r.phonenumber || r.phone || r.Phone || "").trim(),
        title: String(r.title || r.Title || r.position || r.Position || "").trim(),
      };
    }).filter((r) => r.firstname && r.email && r.userid && !checkEmail("Email", r.email) && !HTML_TAG.test(`${r.firstname} ${r.lastname} ${r.title}`));

    if (sanitized.length === 0) {
      return res.status(400).json({
        message: "No importable rows. Each row needs firstname, a valid email, and a 'company' that matches an existing customer.",
      });
    }

    // Deduplicate by email within this company's contacts only (and within the file).
    const tenantClientIds = scope.tenant_id ? (await Client.find(scope).select("_id")).map((c) => c._id) : null;
    const existing = await Contact.find({
      email: { $in: sanitized.map((r) => r.email) },
      ...(tenantClientIds ? { userid: { $in: tenantClientIds } } : {}),
    }).select("email");
    const seen = new Set(existing.map((e) => e.email));
    const newContacts = [];
    for (const r of sanitized) {
      if (seen.has(r.email)) continue;
      seen.add(r.email);
      newContacts.push(r);
    }
    const skipped = rows.length - newContacts.length;

    if (newContacts.length === 0)
      return res.status(200).json({ message: "All contacts already exist — nothing imported.", count: 0, skipped });

    // create() (not insertMany) so phoneE164 is filled by the model hook.
    const result = await Contact.create(newContacts);
    res.status(201).json({
      message: `Imported ${result.length} new contact(s)${skipped ? `, skipped ${skipped}` : ""}.`,
      count: result.length,
      skipped,
    });
  } catch (error) {
    console.error("IMPORT CONTACTS ERROR:", error);
    res.status(statusForError(error)).json({ message: error.message });
  }
};

function levenshteinDistance(s1, s2) {
  s1 = s1 || "";
  s2 = s2 || "";
  const m = s1.length;
  const n = s2.length;
  const dp = Array.from({ length: m + 1 }, () => new Array(n + 1).fill(0));
  for (let i = 0; i <= m; i++) dp[i][0] = i;
  for (let j = 0; j <= n; j++) dp[0][j] = j;
  for (let i = 1; i <= m; i++) {
    for (let j = 1; j <= n; j++) {
      if (s1[i - 1] === s2[j - 1]) {
        dp[i][j] = dp[i - 1][j - 1];
      } else {
        dp[i][j] = 1 + Math.min(dp[i - 1][j], dp[i][j - 1], dp[i - 1][j - 1]);
      }
    }
  }
  return dp[m][n];
}

function stringSimilarity(s1, s2) {
  const clean1 = (s1 || "").toLowerCase().trim();
  const clean2 = (s2 || "").toLowerCase().trim();
  if (clean1 === clean2) return 1.0;
  if (!clean1 || !clean2) return 0.0;
  const maxLen = Math.max(clean1.length, clean2.length);
  if (maxLen === 0) return 1.0;
  const dist = levenshteinDistance(clean1, clean2);
  return (maxLen - dist) / maxLen;
}

function resolveBranchId(rawBranchName, branches, defaultBranchId) {
  if (!rawBranchName || String(rawBranchName).trim() === "" || String(rawBranchName).trim() === "-") {
    return defaultBranchId || null;
  }
  const input = String(rawBranchName).trim();
  const inputLower = input.toLowerCase();
  const inputNormalized = inputLower.replace(/[^a-z0-9]/g, "");

  // 1. Exact match
  let found = branches.find(b => b.name && b.name.trim().toLowerCase() === inputLower);
  if (found) return found._id;

  // 2. Normalized match (ignoring spaces, hyphens, dots, casing)
  found = branches.find(b => b.name && b.name.toLowerCase().replace(/[^a-z0-9]/g, "") === inputNormalized);
  if (found) return found._id;

  // 3. Substring / Token inclusion match
  found = branches.find(b => {
    if (!b.name) return false;
    const bNorm = b.name.toLowerCase().replace(/[^a-z0-9]/g, "");
    return inputNormalized.includes(bNorm) || bNorm.includes(inputNormalized);
  });
  if (found) return found._id;

  // 4. Fuzzy Levenshtein match (>= 75% similarity, e.g. "Sparkling Techo Tools" matches "Sparkling Techno Tools")
  let bestMatch = null;
  let highestSim = 0;
  for (const b of branches) {
    if (!b.name) continue;
    const sim = stringSimilarity(inputLower, b.name.toLowerCase().trim());
    if (sim > highestSim && sim >= 0.75) {
      highestSim = sim;
      bestMatch = b;
    }
  }
  if (bestMatch) return bestMatch._id;

  // 5. Unknown branch name: leave it empty (the default branch if one was chosen).
  // Never auto-create HRMS branches from a spreadsheet.
  return defaultBranchId || null;
}

function resolveStaffId(rawStaffName, staffList) {
  if (!rawStaffName || String(rawStaffName).trim() === "" || String(rawStaffName).trim() === "-") return null;
  const input = String(rawStaffName).trim();
  const inputLower = input.toLowerCase();
  const inputNorm = inputLower.replace(/[^a-z0-9]/g, "");

  // 1. Exact match
  let found = staffList.find(s => `${s.firstname} ${s.lastname}`.trim().toLowerCase() === inputLower);
  if (found) return found._id;

  // 2. Normalized match
  found = staffList.find(s => `${s.firstname}${s.lastname}`.toLowerCase().replace(/[^a-z0-9]/g, "") === inputNorm);
  if (found) return found._id;

  // 3. Firstname or Lastname match
  found = staffList.find(s => {
    const fn = (s.firstname || "").toLowerCase().trim();
    const ln = (s.lastname || "").toLowerCase().trim();
    return fn === inputLower || ln === inputLower;
  });
  if (found) return found._id;

  // 4. Fuzzy Levenshtein match
  let bestMatch = null;
  let highestSim = 0;
  for (const s of staffList) {
    const fullName = `${s.firstname} ${s.lastname}`.trim().toLowerCase();
    const sim = stringSimilarity(inputLower, fullName);
    if (sim > highestSim && sim >= 0.75) {
      highestSim = sim;
      bestMatch = s;
    }
  }
  if (bestMatch) return bestMatch._id;

  return null;
}

// Import customers. Each row is validated with the same rules as the form;
// bad rows are skipped with a reason. Rows repeating a company already in the
// file are skipped. Existing customers are only updated when the request asks
// for it ({ clients: [...], updateExisting: true }); by default they are skipped.
const importClients = async (req, res) => {
  try {
    const rows = Array.isArray(req.body) ? req.body : req.body.clients;
    if (!rows || !Array.isArray(rows) || rows.length === 0)
      return res.status(400).json({ message: "No valid client data provided" });

    const updateExisting = !Array.isArray(req.body) && req.body.updateExisting === true;
    let defaultBranchId = Array.isArray(req.body) ? null : req.body.branchId || null;
    const tenantId = req.user?.tenant_id;
    const scope = tenantScope(req);

    // Fetch branches and staff for mapping
    const [branches, staff] = await Promise.all([
      HRMSBranch.find(scope),
      Staff.find(scope).select("firstname lastname"),
    ]);
    if (defaultBranchId && !branches.some((b) => String(b._id) === String(defaultBranchId))) defaultBranchId = null;

    const normalizeKey = (key) => key.toLowerCase().replace(/[\s_]+/g, " ").trim();
    // Exact header match only (after normalising case / spaces / underscores) —
    // a substring match made "Company Name" fill the PAN field ("com-PAN-y").
    const getField = (row, ...aliases) => {
      const normalizedAliases = aliases.map(normalizeKey);
      for (const key of Object.keys(row)) {
        if (normalizedAliases.includes(normalizeKey(key))) {
          const val = row[key];
          if (val !== undefined && val !== null && String(val).trim() !== "" && String(val).trim() !== "-") return String(val).trim();
        }
      }
      return "";
    };

    const results = { insertedCount: 0, updatedCount: 0, skippedCount: 0, errors: [] };
    const skip = (rowNo, company, reason) => {
      results.skippedCount++;
      if (results.errors.length < 200) results.errors.push({ row: rowNo, company, reason });
    };

    const seenInFile = new Set();
    const candidates = [];
    rows.forEach((r, idx) => {
      const rowNo = idx + 2; // spreadsheet row (row 1 = headers)
      if (!r || typeof r !== "object") return skip(rowNo, "", "Empty row");
      const company = getField(r, "company", "Company", "Company Name", "name", "Name", "company_name");
      if (!company) return skip(rowNo, "", "Company name is missing");
      const key = company.toLowerCase();
      if (seenInFile.has(key)) return skip(rowNo, company, "Duplicate of an earlier row in this file");
      seenInFile.add(key);

      const rawBranch = getField(r, "branch", "Branch Name", "branch_name", "Branch (State)", "Branch Location", "Office");
      const rawSalesPerson = getField(r, "sales_person", "Sales Person", "Salesperson");

      const raw = {
        company,
        customer_reference: getField(r, "customer_reference", "Customer Reference"),
        contact_person: getField(r, "contact_person", "Connect Person", "Contact Person"),
        phonenumber: getField(r, "phonenumber", "phone", "Phone Number"),
        email: getField(r, "email"),
        website: getField(r, "website"),
        address: getField(r, "address", "Address with State"),
        city: getField(r, "city"),
        state: getField(r, "state"),
        zip: getField(r, "zip", "Zip Code"),
        country: getField(r, "country"),
        vat: getField(r, "vat", "Tax Number"),
        pan_number: getField(r, "pan_number", "Pan Number", "PAN", "Pan No"),
        gst_number: getField(r, "gst_number", "GST Number", "GSTIN", "GST No"),
        account_details: getField(r, "account_details", "Account details"),
        default_language: getField(r, "default_language", "Default Language"),
      };
      // Blank cells are "not provided", not "clear this field".
      for (const k of Object.keys(raw)) if (raw[k] === "") delete raw[k];

      const { error, data } = validateClientData(raw, { isCreate: true });
      if (error) return skip(rowNo, company, error);

      // Unknown branch names are left empty (never auto-create HRMS branches from a spreadsheet).
      data.branch = resolveBranchId(rawBranch, branches, defaultBranchId);
      data.sales_person = resolveStaffId(rawSalesPerson, staff);
      candidates.push({ rowNo, data });
    });

    if (candidates.length === 0) {
      return res.status(400).json({ message: "No valid rows found. Ensure a 'Company Name' column exists and rows pass validation.", ...results });
    }

    // Existing customers in this company, matched case-insensitively.
    const existingClients = candidates.length
      ? await Client.find({
        ...scope,
        company: { $in: candidates.map((c) => new RegExp(`^\\s*${escapeRegExp(c.data.company)}\\s*$`, "i")) },
      })
      : [];
    const existingMap = new Map(existingClients.map((c) => [c.company.toLowerCase().trim(), c]));

    const toInsert = [];
    for (const { rowNo, data } of candidates) {
      const existingDoc = existingMap.get(data.company.toLowerCase());
      if (!existingDoc) {
        toInsert.push({ ...data, active: true, tenant_id: tenantId, created_by: req.user?._id });
        continue;
      }
      if (!updateExisting) { skip(rowNo, data.company, "Customer already exists"); continue; }
      const changes = {};
      for (const [k, v] of Object.entries(data)) {
        if (k === "company" || v === null || v === undefined || v === "") continue;
        if (String(existingDoc[k] ?? "") !== String(v)) changes[k] = v;
      }
      if (Object.keys(changes).length) {
        existingDoc.set(changes);
        await existingDoc.save();
      }
      results.updatedCount++;
    }

    if (toInsert.length > 0) {
      // insertMany skips the save hook, so fill the phone shadow field here.
      for (const d of toInsert) if (d.phonenumber) d.phoneE164 = toE164(d.phonenumber) || undefined;
      const inserted = await Client.insertMany(toInsert, { ordered: false });
      results.insertedCount = inserted.length;
    }

    const parts = [`${results.insertedCount} new created`];
    if (updateExisting) parts.push(`${results.updatedCount} existing updated`);
    if (results.skippedCount) parts.push(`${results.skippedCount} skipped`);
    res.status(200).json({
      message: `Processed ${rows.length} row(s): ${parts.join(", ")}.`,
      count: results.insertedCount,
      ...results,
    });
  } catch (error) {
    console.error("IMPORT CLIENTS ERROR:", error);
    res.status(statusForError(error)).json({ message: error.message });
  }
};

const transferOrAssignCustomers = async (req, res) => {
  try {
    const { fromStaffId, toStaffId, clientIds, assignAs = "both", sync = true } = req.body;

    if (!toStaffId) {
      return res.status(400).json({ message: "Target staff (toStaffId) is required." });
    }
    if (!isObjectId(String(toStaffId)) || (fromStaffId && !isObjectId(String(fromStaffId)))) {
      return res.status(400).json({ message: "Invalid staff id." });
    }
    if (clientIds !== undefined && (!Array.isArray(clientIds) || clientIds.some((id) => !isObjectId(String(id))))) {
      return res.status(400).json({ message: "clientIds must be a list of customer ids." });
    }
    if (!["admin", "sales_person", "both"].includes(assignAs)) {
      return res.status(400).json({ message: "assignAs must be admin, sales_person or both." });
    }

    const tenantFilter = req.user?.is_superadmin ? {} : { tenant_id: req.user?.tenant_id };

    const targetStaff = await Staff.findOne({ _id: toStaffId, ...tenantFilter });
    if (!targetStaff) {
      return res.status(404).json({ message: "Staff member not found in this tenant." });
    }

    let updatedCount = 0;

    // Mode A: Direct selection of clientIds (Assign / Sync)
    if (Array.isArray(clientIds)) {
      const selectedIdStrings = new Set(clientIds.map((id) => id.toString()));

      // Fetch all clients in tenant to sync assignments
      const allClients = await Client.find(tenantFilter);

      for (const client of allClients) {
        let modified = false;
        const clientIdStr = client._id.toString();
        const shouldHaveAccess = selectedIdStrings.has(clientIdStr);

        if (!Array.isArray(client.admins)) client.admins = [];

        const adminIndex = client.admins.findIndex((a) => {
          const sid = a.staff?._id || a.staff;
          return sid && sid.toString() === toStaffId.toString();
        });
        const isSales = (client.sales_person?._id || client.sales_person)?.toString() === toStaffId.toString();

        if (shouldHaveAccess) {
          // Add to admins if not already present
          if (adminIndex === -1 && (assignAs === "admin" || assignAs === "both")) {
            client.admins.push({ staff: toStaffId, date_assigned: new Date() });
            modified = true;
          }
          // Set sales_person if requested and empty
          if (!client.sales_person && (assignAs === "sales_person" || assignAs === "both")) {
            client.sales_person = toStaffId;
            modified = true;
          }
        } else if (sync) {
          // If sync is true and this customer is not selected, remove this staff
          if (adminIndex !== -1) {
            client.admins.splice(adminIndex, 1);
            modified = true;
          }
          if (isSales) {
            client.sales_person = null;
            modified = true;
          }
        }

        if (modified) {
          await client.save();
          updatedCount++;
        }
      }
    } else if (fromStaffId) {
      // Mode B: Transfer all from old staff
      const clientsToUpdate = await Client.find({
        ...tenantFilter,
        $or: [
          { "admins.staff": fromStaffId },
          { sales_person: fromStaffId },
          { created_by: fromStaffId },
        ],
      });

      for (const client of clientsToUpdate) {
        let modified = false;

        if (!Array.isArray(client.admins)) client.admins = [];
        const alreadyAdmin = client.admins.some((a) => {
          const sid = a.staff?._id || a.staff;
          return sid && sid.toString() === toStaffId.toString();
        });

        if (!alreadyAdmin && (assignAs === "admin" || assignAs === "both")) {
          client.admins.push({ staff: toStaffId, date_assigned: new Date() });
          modified = true;
        }

        // Remove old staff from admins
        const prevLen = client.admins.length;
        client.admins = client.admins.filter((a) => {
          const sid = a.staff?._id || a.staff;
          return sid && sid.toString() !== fromStaffId.toString();
        });
        if (client.admins.length !== prevLen) modified = true;

        if (client.sales_person && client.sales_person.toString() === fromStaffId.toString()) {
          client.sales_person = toStaffId;
          modified = true;
        }

        if (modified) {
          await client.save();
          updatedCount++;
        }
      }
    }

    logActivity(
      req,
      `Assigned ${clientIds ? clientIds.length : updatedCount} customer(s) to staff: ${targetStaff.firstname} ${targetStaff.lastname}`,
      { rel_type: "customer" }
    );

    res.json({
      message: `Successfully assigned customers to ${targetStaff.firstname} ${targetStaff.lastname}.`,
      count: updatedCount,
    });
  } catch (error) {
    console.error("Transfer customers error:", error);
    res.status(500).json({ message: error.message });
  }
};

module.exports = {
  getClients,
  getClientById,
  createClient,
  updateClient,
  deleteClient,
  getContacts,
  getAllContacts,
  createContact,
  updateContact,
  deleteContact,
  getStatement,
  sendStatementEmail,
  importClients,
  importContacts,
  bulkDeleteClients,
  transferOrAssignCustomers,
  bulkAssignGroup,
};
