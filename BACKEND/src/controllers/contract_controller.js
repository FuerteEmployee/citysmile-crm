const Contract = require("../models/Contract");
const Client = require("../models/Client");
const CustomFieldService = require("../services/CustomFieldService");
const { logActivity } = require("../services/ActivityLogService");

const enrichContracts = async (contracts) => {
  const cfByContract = await CustomFieldService.getValuesForMany(contracts.map((c) => c._id), "contracts");
  return contracts.map((c) => {
    const cObj = c.toObject();
    cObj.custom_fields = cfByContract.get(String(c._id)) || {};
    return cObj;
  });
};

const getContracts = async (req, res) => {
  try {
    const { client } = req.query;
    const filter = {};
    if (client) filter.client = client;
    if (!req.user?.is_superadmin && req.user?.tenant_id) filter.tenant_id = req.user.tenant_id;

    const { page, limit, search } = req.query;
    const isPaginated = page !== undefined || limit !== undefined || search !== undefined;

    // Legacy behavior, unchanged: callers that don't ask for pagination
    // (client-tab contract list, exports) keep getting the full bare array.
    if (!isPaginated) {
      const contracts = await Contract.find(filter).populate("client", "company").populate("project", "name");
      return res.json(await enrichContracts(contracts));
    }

    if (search && String(search).trim()) {
      const escapeRegExp = (string) => string.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
      const searchTerm = String(search).trim();
      const re = new RegExp(escapeRegExp(searchTerm), "i");
      const matchingClients = await Client.find({ company: re }).select("_id");
      filter.$or = [
        { subject: re },
        { client: { $in: matchingClients.map((c) => c._id) } },
        // contract_value is stored as a Number — $expr/$regexMatch is valid
        // inside a plain find() filter (not only inside aggregation
        // pipelines) on MongoDB 4.2+, so it can search the stringified value.
        {
          $expr: {
            $regexMatch: {
              input: { $toString: "$contract_value" },
              regex: escapeRegExp(searchTerm),
              options: "i",
            },
          },
        },
      ];
    }

    const pageNum = Math.max(parseInt(page, 10) || 1, 1);
    const limitNum = Math.min(Math.max(parseInt(limit, 10) || 25, 1), 500);

    const [total, contracts] = await Promise.all([
      Contract.countDocuments(filter),
      Contract.find(filter)
        .populate("client", "company")
        .populate("project", "name")
        .sort({ createdAt: -1 })
        .skip((pageNum - 1) * limitNum)
        .limit(limitNum),
    ]);

    res.json({
      data: await enrichContracts(contracts),
      total,
      page: pageNum,
      pages: Math.max(Math.ceil(total / limitNum), 1),
      limit: limitNum,
    });
  } catch (error) {
    res.status(500).json({ message: error.message });
  }
};

const getContractById = async (req, res) => {
  try {
    const filter = { _id: req.params.id };
    if (!req.user?.is_superadmin && req.user?.tenant_id) filter.tenant_id = req.user.tenant_id;

    const contract = await Contract.findOne(filter).populate("client", "company firstname lastname email").populate("project", "name");
    if (!contract) return res.status(404).json({ message: "Contract not found" });

    const cf = await CustomFieldService.getValues(contract._id, "contracts");
    const cObj = contract.toObject();
    cObj.custom_fields = cf;
    res.json(cObj);
  } catch (error) {
    res.status(500).json({ message: error.message });
  }
};

const signContract = async (req, res) => {
  try {
    const { firstname, lastname, email, signature_data } = req.body;
    if (!firstname || !lastname || !email || !signature_data) {
      return res.status(400).json({ message: "First name, last name, email, and a signature are required." });
    }

    const filter = { _id: req.params.id };
    if (!req.user?.is_superadmin && req.user?.tenant_id) filter.tenant_id = req.user.tenant_id;

    const contract = await Contract.findOneAndUpdate(
      filter,
      {
        is_signed: true,
        signer_firstname: firstname,
        signer_lastname: lastname,
        signer_email: email,
        signature_data,
        signed_at: new Date(),
      },
      { new: true }
    );
    if (!contract) return res.status(404).json({ message: "Contract not found" });

    logActivity(req, `Signed contract: ${contract.subject}`, { rel_id: contract._id, rel_type: "contract" });
    res.json(contract);
  } catch (error) {
    res.status(500).json({ message: error.message });
  }
};

const createContract = async (req, res) => {
  try {
    const payload = { ...req.body };
    Object.keys(payload).forEach(key => {
      if (payload[key] === "") {
        delete payload[key];
      }
    });
    const contract = await Contract.create({ ...payload, staff_id: req.user._id, tenant_id: req.user?.tenant_id });
    if (payload.custom_fields) {
      await CustomFieldService.handlePost(contract._id, "contracts", payload.custom_fields, contract.tenant_id);
    }
    logActivity(req, `Created contract: ${contract.subject}`, { rel_id: contract._id, rel_type: "contract" });
    res.status(201).json(contract);
  } catch (error) {
    res.status(500).json({ message: error.message });
  }
};

const updateContract = async (req, res) => {
  try {
    const payload = { ...req.body };
    Object.keys(payload).forEach(key => {
      if (payload[key] === "") {
        delete payload[key];
      }
    });
    const filter = { _id: req.params.id };
    if (!req.user?.is_superadmin && req.user?.tenant_id) filter.tenant_id = req.user.tenant_id;
    const contract = await Contract.findOneAndUpdate(filter, payload, { new: true });
    if (!contract) return res.status(404).json({ message: "Contract not found" });
    logActivity(req, `Updated contract: ${contract.subject}`, { rel_id: contract._id, rel_type: "contract" });
    res.json(contract);
  } catch (error) {
    res.status(500).json({ message: error.message });
  }
};

const deleteContract = async (req, res) => {
  try {
    const filter = { _id: req.params.id };
    if (!req.user?.is_superadmin && req.user?.tenant_id) filter.tenant_id = req.user.tenant_id;
    const contract = await Contract.findOneAndDelete(filter);
    if (!contract) return res.status(404).json({ message: "Contract not found" });
    logActivity(req, `Deleted contract: ${contract.subject}`, { rel_type: "contract" });
    res.json({ message: "Contract deleted successfully" });
  } catch (error) {
    res.status(500).json({ message: error.message });
  }
};

const importContracts = async (req, res) => {
  try {
    const rowsRaw = Array.isArray(req.body) ? req.body : req.body.contracts;
    if (!rowsRaw || !Array.isArray(rowsRaw) || rowsRaw.length === 0) {
      return res.status(400).json({ message: "No valid contract data provided" });
    }

    const tenantId = req.user?.tenant_id;
    const tenantFilter = tenantId ? { tenant_id: tenantId } : {};

    const companyNames = [...new Set(
      rowsRaw.map(r => r.company || r.Company || r.client || r.Client).filter(Boolean)
    )];
    const clientDocs = companyNames.length
      ? await Client.find({ company: { $in: companyNames.map(c => new RegExp(`^${c}$`, "i")) }, ...tenantFilter }).select("_id company")
      : [];
    const clientMap = new Map(clientDocs.map(c => [c.company.toLowerCase().trim(), c._id]));

    const parseBool = (v) => ["true", "yes", "1", "signed"].includes(String(v ?? "").toLowerCase().trim());
    const parseDate = (v) => {
      if (!v) return undefined;
      const d = new Date(v);
      return isNaN(d.getTime()) ? undefined : d;
    };

    const rows = rowsRaw
      .map((r) => {
        const companyName = String(r.company || r.Company || r.client || r.Client || "").toLowerCase().trim();
        const clientId = clientMap.get(companyName);
        const subject = r.subject || r.Subject || "";
        if (!clientId || !subject) return null;
        return {
          client: clientId,
          subject,
          contract_value: Number(r.contract_value || r["Contract Value"] || r.value || 0) || 0,
          contract_type: r.contract_type || r["Contract Type"] || r.type || undefined,
          datestart: parseDate(r.datestart || r["Start Date"]),
          dateend: parseDate(r.dateend || r["End Date"]),
          description: r.description || r.Description || "",
          is_signed: parseBool(r.is_signed || r["Signed"] || r.status),
          staff_id: req.user._id,
          tenant_id: tenantId,
        };
      })
      .filter(Boolean);

    const skipped = rowsRaw.length - rows.length;
    if (rows.length === 0) {
      return res.status(400).json({ message: "No rows matched an existing client and subject. Ensure 'Company' and 'Subject' columns are present." });
    }

    const created = await Contract.insertMany(rows);
    res.status(201).json({ count: created.length, skipped });
  } catch (error) {
    res.status(500).json({ message: error.message });
  }
};

// One request, one deleteMany — replaces firing one DELETE per selected
// contract from the browser (Promise.all over hundreds of ids), which
// overwhelmed the browser's per-host connection limit and felt like a hang
// under Bulk Actions on large contract lists.
const bulkDeleteContracts = async (req, res) => {
  try {
    const ids = Array.isArray(req.body?.ids) ? req.body.ids : [];
    if (ids.length === 0) return res.status(400).json({ message: "No contract ids provided" });

    const query = { _id: { $in: ids } };
    if (!req.user?.is_superadmin && req.user?.tenant_id) query.tenant_id = req.user.tenant_id;

    const matched = await Contract.find(query).select("_id").lean();
    const matchedIds = matched.map((m) => m._id);

    const result = matchedIds.length
      ? await Contract.deleteMany({ _id: { $in: matchedIds } })
      : { deletedCount: 0 };
    await CustomFieldService.deleteValuesForMany(matchedIds, "contracts");

    logActivity(req, `Bulk-deleted ${result.deletedCount} contract(s)`, { rel_type: "contract" });
    res.json({ message: `Deleted ${result.deletedCount} contract(s)`, deletedCount: result.deletedCount });
  } catch (error) {
    res.status(500).json({ message: error.message });
  }
};

module.exports = { getContracts, getContractById, createContract, updateContract, deleteContract, importContracts, signContract, bulkDeleteContracts };
