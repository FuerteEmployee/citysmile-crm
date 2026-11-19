const Proposal = require("../models/Proposal");
const InvoiceService = require("../services/InvoiceService");
const Client = require("../models/Client");
const Lead = require("../models/Lead");
const { logActivity } = require("../services/ActivityLogService");
const docSettings = require("../services/docSettings");

// Staff with "View (Own)" (or only "assigned" access) see the proposals they
// created or are assigned to.
const proposalScope = (req) => docSettings.docScope(req, ["created_by", "assigned"]);

// Proposal.rel_id is a polymorphic ref (rel_type "customer" -> Client, "lead" -> Lead),
// so it can't use Mongoose .populate(). Batch-resolve a display name for any proposal
// missing proposal_to, and self-heal legacy rows so future reads skip recomputation.
const resolveProposalNames = async (proposals) => {
  const needsResolve = proposals.filter((p) => !p.proposal_to && p.rel_id);
  if (needsResolve.length === 0) return proposals;

  const customerIds = needsResolve.filter((p) => p.rel_type === "customer").map((p) => p.rel_id);
  const leadIds = needsResolve.filter((p) => p.rel_type === "lead").map((p) => p.rel_id);

  const [clients, leads] = await Promise.all([
    customerIds.length ? Client.find({ _id: { $in: customerIds } }).select("company") : [],
    leadIds.length ? Lead.find({ _id: { $in: leadIds } }).select("company name") : [],
  ]);
  const clientMap = new Map(clients.map((c) => [c._id.toString(), c.company]));
  const leadMap = new Map(leads.map((l) => [l._id.toString(), l.company || l.name]));

  await Promise.all(
    needsResolve.map(async (p) => {
      const idStr = p.rel_id.toString();
      const resolved = p.rel_type === "customer" ? clientMap.get(idStr) : leadMap.get(idStr);
      if (!resolved) return;
      p.proposal_to = resolved;
      // Fire-and-forget: don't block the response on persisting the backfill.
      Proposal.updateOne({ _id: p._id }, { proposal_to: resolved }).catch(() => {});
    })
  );
  return proposals;
};

const getProposals = async (req, res) => {
  try {
    const query = proposalScope(req);
    if (req.query.rel_id) query.rel_id = req.query.rel_id;
    if (req.query.rel_type) query.rel_type = req.query.rel_type;

    const { page, limit, search, branch } = req.query;
    const isPaginated = page !== undefined || limit !== undefined || search !== undefined;

    // Legacy behavior, unchanged: callers that don't ask for pagination
    // (dashboard/report aggregation, exports, lead-tab proposal list) keep
    // getting the full bare array exactly as before.
    if (!isPaginated) {
      const proposals = await Proposal.find(query).sort({ createdAt: -1 });
      await resolveProposalNames(proposals);
      return res.json(proposals);
    }

    if (search && String(search).trim()) {
      const escapeRegExp = (string) => string.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
      const searchTerm = String(search).trim();
      const re = new RegExp(escapeRegExp(searchTerm), "i");
      // Status is shown in the table via STATUS_MAP's numeric-code -> label
      // (e.g. "Sent"), not the raw stored number — resolve which code(s)'
      // label text matches, mirroring the frontend's STATUS_MAP in Proposals.tsx.
      const STATUS_LABELS = {
        1: "Draft",
        2: "Sent",
        3: "Open",
        4: "Revised",
        5: "Declined",
        6: "Accepted",
      };
      const searchLower = searchTerm.toLowerCase();
      const matchingStatusCodes = Object.entries(STATUS_LABELS)
        .filter(([, label]) => label.toLowerCase().includes(searchLower))
        .map(([code]) => Number(code));
      // Note: `tags` isn't a field on the Proposal schema, so it's intentionally
      // not searched here.
      // $and: the scope may already use $or (own/assigned staff).
      query.$and = [{ $or: [
        { subject: re },
        { proposal_to: re },
        { number: re },
        { branch: re },
        { status: { $in: matchingStatusCodes } },
      ] }];
    }
    if (branch) query.branch = branch;

    const pageNum = Math.max(parseInt(page, 10) || 1, 1);
    const limitNum = Math.min(Math.max(parseInt(limit, 10) || 25, 1), 500);

    const [total, proposals] = await Promise.all([
      Proposal.countDocuments(query),
      Proposal.find(query)
        .sort({ createdAt: -1 })
        .skip((pageNum - 1) * limitNum)
        .limit(limitNum),
    ]);
    await resolveProposalNames(proposals);

    res.json({
      data: proposals,
      total,
      page: pageNum,
      pages: Math.max(Math.ceil(total / limitNum), 1),
      limit: limitNum,
    });
  } catch (error) {
    res.status(500).json({ message: error.message });
  }
};

const createProposal = async (req, res) => {
  try {
    const payload = { ...req.body };
    // Clean empty strings for optional fields (like dates, numbers, ObjectIds)
    Object.keys(payload).forEach(key => {
      if (payload[key] === "") {
        delete payload[key];
      }
    });

    delete payload.number;
    const tenantId = req.user?.tenant_id;
    const cfg = await docSettings.getDocSettings("proposal", tenantId);
    if (!payload.open_till) payload.open_till = docSettings.addDays(payload.date, cfg.dueAfter);
    const totals = InvoiceService.calculateTotals(payload);
    // Setup > Settings > Proposals: Prefix + Next Proposal Number.
    const proposal = await docSettings.createWithNextNumber("proposal", tenantId, payload.date, (number) =>
      Proposal.create({ ...payload, ...totals, number, tenant_id: tenantId, created_by: req.user?._id })
    );
    logActivity(req, `Created proposal: ${proposal.subject || proposal._id}`, { rel_id: proposal._id, rel_type: "proposal" });
    res.status(201).json(proposal);
  } catch (error) {
    res.status(500).json({ message: error.message });
  }
};

const updateProposal = async (req, res) => {
  try {
    const proposal = await Proposal.findOne({ _id: req.params.id, ...proposalScope(req) });
    if (proposal) {
      const payload = { ...req.body };
      ["number", "tenant_id", "created_by"].forEach((k) => delete payload[k]);
      // Clean empty strings for optional fields (like dates, numbers, ObjectIds)
      Object.keys(payload).forEach(key => {
        if (payload[key] === "") {
          delete payload[key];
        }
      });

      const hasFinancialUpdates = payload.items !== undefined || payload.discount_percent !== undefined || payload.discount_fixed !== undefined || payload.adjustment !== undefined;
      if (hasFinancialUpdates) {
        const itemsToCalc = payload.items !== undefined ? payload.items : proposal.items;
        const totals = InvoiceService.calculateTotals({ ...proposal.toObject(), ...payload, items: itemsToCalc });
        Object.assign(proposal, { ...payload, ...totals });
      } else {
        Object.assign(proposal, payload);
      }
      const updatedProposal = await proposal.save();
      logActivity(req, `Updated proposal: ${updatedProposal.subject || updatedProposal._id}`, { rel_id: updatedProposal._id, rel_type: "proposal" });
      res.json(updatedProposal);
    } else {
      res.status(404).json({ message: "Proposal not found" });
    }
  } catch (error) {
    res.status(500).json({ message: error.message });
  }
};

const deleteProposal = async (req, res) => {
  try {
    const proposal = await Proposal.findOne({ _id: req.params.id, ...proposalScope(req) });
    if (proposal) {
      const proposalSubject = proposal.subject || proposal._id;
      await proposal.deleteOne();
      logActivity(req, `Deleted proposal: ${proposalSubject}`, { rel_type: "proposal" });
      res.json({ message: "Proposal removed" });
    } else {
      res.status(404).json({ message: "Proposal not found" });
    }
  } catch (error) {
    res.status(500).json({ message: error.message });
  }
};

const getProposalById = async (req, res) => {
  try {
    const proposal = await Proposal.findOne({ _id: req.params.id, ...proposalScope(req) });
    if (!proposal) return res.status(404).json({ message: "Proposal not found" });
    await resolveProposalNames([proposal]);
    res.json(await docSettings.addDisplayNames(proposal.toObject(), "assigned"));
  } catch (error) {
    res.status(500).json({ message: error.message });
  }
};

const importProposals = async (req, res) => {
  try {
    const rowsRaw = Array.isArray(req.body) ? req.body : req.body.proposals;
    if (!rowsRaw || !Array.isArray(rowsRaw) || rowsRaw.length === 0) {
      return res.status(400).json({ message: "No valid proposal data provided" });
    }

    const tenantId = req.user?.tenant_id;
    const tenantFilter = tenantId ? { tenant_id: tenantId } : {};
    console.log("[importProposals] user tenant_id:", tenantId, "| rows to import:", rowsRaw.length);

    // Batch-fetch all clients referenced by company name
    const companyNames = [...new Set(
      rowsRaw.map(r => r.company || r.Company).filter(Boolean)
    )];
    const clientDocs = companyNames.length
      ? await Client.find({ company: { $in: companyNames.map(c => new RegExp(`^${c}$`, 'i')) }, ...tenantFilter }).select("_id company")
      : [];
    const clientMap = new Map(clientDocs.map(c => [c.company.toLowerCase().trim(), c._id]));

    // Map CSV columns to model fields
    const rows = rowsRaw.map(r => {
      const companyName = String(r.company || r.Company || "").toLowerCase().trim();
      const clientId = clientMap.get(companyName);
      if (!clientId) return null; // no client available — skip row

      const rawAmount = String(r.total || r.Total || "0");
      const total = Number(rawAmount.replace(/[^0-9.-]+/g,"")) || 0;

      return {
        subject:     r.subject || r.Subject || "",
        rel_id:      clientId,
        rel_type:    "customer",
        date:        r.date ? new Date(r.date) : undefined,
        total:       total,
        status:      r.status !== undefined ? Number(r.status) : 1,
        branch:      r.branch || r.Branch || "",
        tenant_id:   tenantId,
        created_by:  req.user?._id,
        items:       [{ description: "Imported Proposal", rate: total, qty: 1 }],
      };
    }).filter(Boolean);

    // Deduplicate by subject within tenant
    const incomingSubjects = rows.map(r => r.subject).filter(Boolean);
    const existing = await Proposal.find({
      ...tenantFilter,
      subject: { $in: incomingSubjects },
    }).select("subject");
    const existingSet = new Set(existing.map(p => p.subject?.trim().toLowerCase()));

    const newProposals = rows.filter(r => !existingSet.has(r.subject?.trim().toLowerCase()));
    const skipped = rows.length - newProposals.length;
    console.log("[importProposals] new:", newProposals.length, "| skipped (duplicates):", skipped);

    if (newProposals.length === 0) {
      return res.status(200).json({
        message: `All ${rows.length} proposal(s) already exist — nothing imported.`,
        count: 0,
        skipped,
      });
    }

    const result = await Proposal.insertMany(newProposals, { ordered: false });
    console.log("[importProposals] inserted:", result.length);
    res.status(201).json({
      message: `Imported ${result.length} new proposal(s)${skipped ? `, skipped ${skipped} duplicate(s)` : ""}.`,
      count: result.length,
      skipped,
    });
  } catch (error) {
    console.error("IMPORT PROPOSALS ERROR:", error);
    if (error.code === 11000) {
      return res.status(207).json({ message: "Partial import completed, some duplicates skipped." });
    }
    res.status(500).json({ message: error.message });
  }
};

// One request, one deleteMany — replaces firing one DELETE per selected
// proposal from the browser (Promise.all over hundreds of ids), which
// overwhelmed the browser's per-host connection limit and felt like a hang
// under Bulk Actions on large proposal lists.
const bulkDeleteProposals = async (req, res) => {
  try {
    const ids = Array.isArray(req.body?.ids) ? req.body.ids : [];
    if (ids.length === 0) return res.status(400).json({ message: "No proposal ids provided" });

    const query = { _id: { $in: ids }, ...proposalScope(req) };

    const result = await Proposal.deleteMany(query);
    logActivity(req, `Bulk-deleted ${result.deletedCount} proposal(s)`, { rel_type: "proposal" });
    res.json({ message: `Deleted ${result.deletedCount} proposal(s)`, deletedCount: result.deletedCount });
  } catch (error) {
    res.status(500).json({ message: error.message });
  }
};

module.exports = { getProposals, getProposalById, createProposal, updateProposal, deleteProposal, importProposals, resolveProposalNames, bulkDeleteProposals };
