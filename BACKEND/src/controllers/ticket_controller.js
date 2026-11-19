const fs = require("fs");
const path = require("path");
const Ticket = require("../models/Ticket");
const File = require("../models/File");
const CustomFieldService = require("../services/CustomFieldService");
const { logActivity } = require("../services/ActivityLogService");
const { readSettings, isOn, isAdminUser } = require("../utils/tenantSettings");

// Setup > Settings > Support as the backend uses it.
const getSupportSettings = async (tenantId) => {
  const v = await readSettings(tenantId, [
    "supStaffDeptOnly", "supAutoAssignOnReply", "supNonAdminDelTickets", "supMaxAttachments", "supAllowedExtensions",
  ]);
  const max = parseInt(v.supMaxAttachments, 10);
  return {
    staffDeptOnly: isOn(v.supStaffDeptOnly),
    autoAssignOnReply: isOn(v.supAutoAssignOnReply),
    nonAdminDelete: isOn(v.supNonAdminDelTickets),
    maxAttachments: Number.isFinite(max) && max > 0 ? max : 0,
    allowedExtensions: String(v.supAllowedExtensions || "")
      .split(",")
      .map((e) => e.trim().toLowerCase().replace(/^\./, ""))
      .filter(Boolean),
  };
};

// The company's tickets; non-admin staff only see their departments' tickets
// (plus the ones assigned to / opened by them) when "Allow staff to access
// only ticket that belongs to staff departments" is on. Staff without any
// department are not restricted (nothing to match them against).
const ticketScope = async (req) => {
  const scope = {};
  if (!req.user?.is_superadmin && req.user?.tenant_id) scope.tenant_id = req.user.tenant_id;
  const depts = (req.user?.departments || []).filter(Boolean);
  if (depts.length && !isAdminUser(req.user) && (await getSupportSettings(req.user?.tenant_id)).staffDeptOnly) {
    scope.$or = [
      { department: { $in: depts } },
      { assigned: req.user._id },
      { created_by: req.user._id },
    ];
  }
  return scope;
};

const populateTicket = (q) =>
  q
    .populate("client", "company")
    .populate("department", "name")
    .populate("priority", "name")
    .populate("assigned", "firstname lastname");

const enrichTickets = async (tickets) => {
  const cfByTicket = await CustomFieldService.getValuesForMany(tickets.map((t) => t._id), "tickets");
  return tickets.map((ticket) => {
    const ticketObj = ticket.toObject();
    ticketObj.custom_fields = cfByTicket.get(String(ticket._id)) || {};
    return ticketObj;
  });
};

const getTickets = async (req, res) => {
  try {
    const filter = await ticketScope(req);
    if (req.query.clientid) {
        filter.client = req.query.clientid;
    }

    const { page, limit, search, status } = req.query;
    const isPaginated = page !== undefined || limit !== undefined || search !== undefined;

    // Legacy behavior, unchanged: callers that don't ask for pagination
    // (client-tab ticket list, exports) keep getting the full bare array.
    if (!isPaginated) {
      const tickets = await populateTicket(Ticket.find(filter));
      return res.json(await enrichTickets(tickets));
    }

    if (search && String(search).trim()) {
      const escapeRegExp = (string) => string.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
      const re = new RegExp(escapeRegExp(String(search).trim()), "i");
      // $and: the scope may already use $or (department-only staff).
      filter.$and = [{ $or: [{ subject: re }, { message: re }] }];
    }
    if (status && status !== "all") filter.status = status;

    const pageNum = Math.max(parseInt(page, 10) || 1, 1);
    const limitNum = Math.min(Math.max(parseInt(limit, 10) || 25, 1), 500);

    const [total, tickets] = await Promise.all([
      Ticket.countDocuments(filter),
      populateTicket(Ticket.find(filter))
        .sort({ createdAt: -1 })
        .skip((pageNum - 1) * limitNum)
        .limit(limitNum),
    ]);

    res.json({
      data: await enrichTickets(tickets),
      total,
      page: pageNum,
      pages: Math.max(Math.ceil(total / limitNum), 1),
      limit: limitNum,
    });
  } catch (error) {
    res.status(500).json({ message: error.message });
  }
};

const findOneTicket = (scope, id) =>
  populateTicket(Ticket.findOne({ _id: id, ...scope }))
    .populate("contact", "firstname lastname email")
    .populate("replies.staff", "firstname lastname");

const getTicketById = async (req, res) => {
  try {
    const ticket = await findOneTicket(await ticketScope(req), req.params.id);
    if (!ticket) return res.status(404).json({ message: "Ticket not found" });
    const cf_values = await CustomFieldService.getValues(ticket._id, "tickets");
    const ticketObj = ticket.toObject();
    ticketObj.custom_fields = cf_values;
    res.json(ticketObj);
  } catch (error) {
    res.status(500).json({ message: error.message });
  }
};

const addTicketReply = async (req, res) => {
  try {
    const scope = await ticketScope(req);
    const ticket = await Ticket.findOne({ _id: req.params.id, ...scope });
    if (!ticket) return res.status(404).json({ message: "Ticket not found" });

    const { message, is_note, status, cc } = req.body;
    if (!message || !message.trim()) {
      return res.status(400).json({ message: "Reply message is required" });
    }

    ticket.replies.push({ message, is_note: !!is_note, staff: req.user?._id });
    if (!is_note) ticket.lastreply = new Date();
    if (status !== undefined) ticket.status = status;
    if (cc !== undefined) ticket.cc = cc;
    // "Automatically assign the ticket to the first staff that post a reply".
    if (!is_note && !ticket.assigned && req.user?._id && (await getSupportSettings(ticket.tenant_id)).autoAssignOnReply) {
      ticket.assigned = req.user._id;
    }
    await ticket.save();

    logActivity(req, `${is_note ? "Added a note to" : "Replied to"} ticket: ${ticket.subject}`, { rel_id: ticket._id, rel_type: "ticket" });

    res.status(201).json(await findOneTicket({}, ticket._id));
  } catch (error) {
    res.status(500).json({ message: error.message });
  }
};

// Removes uploaded files that were rejected after multer saved them.
const discardUploads = (files) => {
  for (const f of files || []) {
    try { fs.unlinkSync(f.path || path.join(__dirname, "../uploads", f.filename)); } catch { /* already gone */ }
  }
};

const createTicket = async (req, res) => {
  try {
    if (req.user) {
        req.body.created_by = req.user._id;
    }

    // "Maximum ticket attachments" / "Allowed attachments file extensions".
    const cfg = await getSupportSettings(req.user?.tenant_id);
    const files = req.files || [];
    if (cfg.maxAttachments && files.length > cfg.maxAttachments) {
      discardUploads(files);
      return res.status(400).json({ message: `A ticket can have at most ${cfg.maxAttachments} attachment(s) (Setup > Settings > Support).` });
    }
    if (cfg.allowedExtensions.length) {
      const bad = files.find((f) => !cfg.allowedExtensions.includes(path.extname(f.originalname || "").toLowerCase().replace(/^\./, "")));
      if (bad) {
        discardUploads(files);
        return res.status(400).json({ message: `"${bad.originalname}" is not allowed as a ticket attachment. Allowed: ${cfg.allowedExtensions.map((e) => "." + e).join(", ")}` });
      }
    }

    const ticket = await Ticket.create({ ...req.body, tenant_id: req.user?.tenant_id });
    if (ticket) {
      if (files.length > 0) {
        const filesData = files.map((file) => ({
          rel_id: ticket._id,
          rel_type: "ticket",
          file_name: file.originalname,
          filetype: file.mimetype,
          attachment_key: file.filename,
          addedfrom: req.user?._id,
          // Without the company the attachment never showed in the ticket's file list.
          tenant_id: req.user?.tenant_id,
        }));
        await File.insertMany(filesData);
      }
      if (req.body.custom_fields) {
        await CustomFieldService.handlePost(ticket._id, "tickets", req.body.custom_fields, ticket.tenant_id);
      }
      logActivity(req, `Opened ticket: ${ticket.subject}`, { rel_id: ticket._id, rel_type: "ticket" });
      res.status(201).json(ticket);
    } else {
      res.status(400).json({ message: "Invalid ticket data" });
    }
  } catch (error) {
    console.error("Create Ticket Error:", error);
    res.status(500).json({ message: error.message });
  }
};

const updateTicket = async (req, res) => {
  try {
    const ticket = await Ticket.findOne({ _id: req.params.id, ...(await ticketScope(req)) });
    if (ticket) {
      const payload = { ...req.body };
      ["tenant_id", "created_by", "replies"].forEach((k) => delete payload[k]);
      Object.assign(ticket, payload);
      const updatedTicket = await ticket.save();

      if (req.body.custom_fields) {
        await CustomFieldService.handlePost(ticket._id, "tickets", req.body.custom_fields, ticket.tenant_id);
      }

      logActivity(req, `Updated ticket: ${updatedTicket.subject}`, { rel_id: updatedTicket._id, rel_type: "ticket" });
      res.json(updatedTicket);
    } else {
      res.status(404).json({ message: "Ticket not found" });
    }
  } catch (error) {
    res.status(500).json({ message: error.message });
  }
};

// "Allow non-admin staff members to delete tickets and replies".
const deleteNotAllowed = async (req) =>
  !isAdminUser(req.user) && !(await getSupportSettings(req.user?.tenant_id)).nonAdminDelete;
const DELETE_DENIED = "Only administrators can delete tickets (Setup > Settings > Support).";

const deleteTicket = async (req, res) => {
  try {
    if (await deleteNotAllowed(req)) return res.status(403).json({ message: DELETE_DENIED });
    const ticket = await Ticket.findOneAndDelete({ _id: req.params.id, ...(await ticketScope(req)) });
    if (ticket) {
      // Delete associated files
      await File.deleteMany({ rel_id: ticket._id, rel_type: "ticket" });
      logActivity(req, `Deleted ticket: ${ticket.subject}`, { rel_type: "ticket" });
      res.json({ message: "Ticket removed" });
    } else {
      res.status(404).json({ message: "Ticket not found" });
    }
  } catch (error) {
    console.error("Delete Ticket Error:", error);
    res.status(500).json({ message: error.message });
  }
};

// One request, one deleteMany — replaces firing one DELETE per selected
// ticket from the browser (Promise.all over hundreds of ids), which
// overwhelmed the browser's per-host connection limit and felt like a hang
// under Bulk Actions on large ticket lists.
const bulkDeleteTickets = async (req, res) => {
  try {
    if (await deleteNotAllowed(req)) return res.status(403).json({ message: DELETE_DENIED });
    const ids = Array.isArray(req.body?.ids) ? req.body.ids : [];
    if (ids.length === 0) return res.status(400).json({ message: "No ticket ids provided" });

    const query = { _id: { $in: ids }, ...(await ticketScope(req)) };

    const matched = await Ticket.find(query).select("_id").lean();
    const matchedIds = matched.map((m) => m._id);

    const result = matchedIds.length
      ? await Ticket.deleteMany({ _id: { $in: matchedIds } })
      : { deletedCount: 0 };
    await File.deleteMany({ rel_id: { $in: matchedIds }, rel_type: "ticket" });

    logActivity(req, `Bulk-deleted ${result.deletedCount} ticket(s)`, { rel_type: "ticket" });
    res.json({ message: `Deleted ${result.deletedCount} ticket(s)`, deletedCount: result.deletedCount });
  } catch (error) {
    res.status(500).json({ message: error.message });
  }
};

module.exports = { getTickets, getTicketById, addTicketReply, createTicket, updateTicket, deleteTicket, bulkDeleteTickets };
