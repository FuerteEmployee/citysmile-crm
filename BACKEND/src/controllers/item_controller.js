const Item = require("../models/Item");
const Tax = require("../models/Tax");
const CustomField = require("../models/CustomField");
const PurchaseCategory = require("../models/PurchaseCategory");
const CustomFieldService = require("../services/CustomFieldService");
const { withoutProtected, isObjectId, statusForError } = require("../utils/requestSafety");
const { checkNumber, checkHsn, checkLength, firstError, isBlank } = require("../hrms/utils/fieldRules");

const escapeRegExp = (string) => String(string).replace(/[.*+?^${}()|[\]\\]/g, "\\$&");

// Company scope for every query. Super admins (no company) see everything.
const tenantFilterOf = (req) => (!req.user?.is_superadmin && req.user?.tenant_id ? { tenant_id: req.user.tenant_id } : {});

// Fields a client may set on an item. Anything else in the body is ignored.
const ITEM_FIELDS = ["name", "long_description", "quantity", "rate", "amount", "tax", "tax2", "hsn_sac_code", "cess_rate", "tax_inclusive", "unit", "group", "branch", "procurementType", "categoryId", "subcategoryId", "uom", "hsn", "gstRate", "spec", "reorderLevel", "isAssembly"];

const LIMITS = { name: 300, long_description: 5000, unit: 50, group: 100 };

class InputError extends Error {
  constructor(message, status = 400) { super(message); this.status = status; }
}

const toBoolean = (v) => {
  if (v === null || v === undefined || v === "") return false;
  if (typeof v === "boolean") return v;
  const s = String(v).trim().toLowerCase();
  if (["true", "yes", "1", "y"].includes(s)) return true;
  if (["false", "no", "0", "n"].includes(s)) return false;
  return undefined;
};

// Branch must be one of the company's HRMS branches, when the company has any.
const checkBranch = async (req, branch) => {
  if (!branch) return null;
  const tf = tenantFilterOf(req);
  if (!tf.tenant_id) return null;
  const HRMSBranch = require("../hrms/models/hrms_branch_model");
  const branches = await HRMSBranch.find({ tenant_id: tf.tenant_id }).select("name").lean();
  if (branches.length === 0) return null;
  return branches.some((b) => b.name === branch) ? null : `Branch "${branch}" does not exist for this company`;
};

// Tax must exist and belong to the requester's company. "none"/"" → no tax.
const resolveTax = async (req, value, label) => {
  if (value === null || value === undefined || value === "" || String(value).toLowerCase() === "none") return null;
  const id = typeof value === "object" && value?._id ? String(value._id) : String(value);
  if (!isObjectId(id)) throw new InputError(`${label} is not a valid tax`);
  const tax = await Tax.findOne({ _id: id, ...tenantFilterOf(req) }).select("_id").lean();
  if (!tax) throw new InputError(`${label} does not exist for this company`);
  return tax._id;
};

/**
 * Validates and normalises an item body for create (existing = null) or update.
 * Returns the fields to save. Throws InputError (400) for bad input.
 */
const buildItemData = async (req, rawBody, existing = null) => {
  const body = withoutProtected(rawBody || {});
  const data = {};
  for (const k of ITEM_FIELDS) if (Object.prototype.hasOwnProperty.call(body, k)) data[k] = body[k];

  // Name (falls back to "description" like before).
  if (isBlank(data.name) && !isBlank(body.description) && (existing === null || "name" in data)) data.name = body.description;
  if (existing === null || "name" in data) {
    data.name = typeof data.name === "string" || typeof data.name === "number" ? String(data.name).trim() : "";
    if (!data.name) throw new InputError("Item Name is required");
  }

  for (const f of ["long_description", "unit", "group", "hsn_sac_code", "branch"]) {
    if (f in data) data[f] = isBlank(data[f]) ? "" : String(data[f]).trim();
  }

  const err = firstError(
    "name" in data ? checkLength("Item Name", data.name, LIMITS.name) : null,
    checkLength("Description", data.long_description, LIMITS.long_description),
    checkLength("Unit", data.unit, LIMITS.unit),
    checkLength("Group", data.group, LIMITS.group),
    checkHsn("HSN/SAC Code", data.hsn_sac_code),
    checkNumber("Quantity", data.quantity, { min: 0 }),
    checkNumber("Rate", data.rate, { min: 0 }),
    checkNumber("Amount", data.amount, { min: 0 }),
    checkNumber("Cess Rate", data.cess_rate, { min: 0, max: 100 }),
  );
  if (err) throw new InputError(err);

  // Number defaults: "" / null → quantity 1, rate 0, cess 0 (never null).
  if ("quantity" in data || existing === null) data.quantity = isBlank(data.quantity) ? 1 : Number(data.quantity);
  if ("rate" in data || existing === null) data.rate = isBlank(data.rate) ? 0 : Number(data.rate);
  if ("cess_rate" in data || existing === null) data.cess_rate = isBlank(data.cess_rate) ? 0 : Number(data.cess_rate);

  // Amount is always quantity × rate (a client-sent amount is ignored).
  const qty = "quantity" in data ? data.quantity : existing?.quantity ?? 1;
  const rate = "rate" in data ? data.rate : existing?.rate ?? 0;
  data.amount = qty * rate;

  if ("tax_inclusive" in data || existing === null) {
    const b = toBoolean(data.tax_inclusive);
    if (b === undefined) throw new InputError("Tax inclusive must be true or false");
    data.tax_inclusive = b;
  }

  if ("tax" in data) data.tax = await resolveTax(req, data.tax, "Tax");
  if ("tax2" in data) data.tax2 = await resolveTax(req, data.tax2, "Tax 2");

  if ("branch" in data) {
    const bErr = await checkBranch(req, data.branch);
    if (bErr) throw new InputError(bErr);
  }
  return data;
};

// Custom fields: required ones must have a value, number ones must be numbers.
const checkCustomFields = async (customFields, existingItemId = null, tenantId = null) => {
  const defs = await CustomField.find({ fieldto: "items", active: true, ...CustomFieldService.tenantScope(tenantId) }).lean();
  const cf = customFields && typeof customFields === "object" ? customFields : {};
  const existing = existingItemId ? await CustomFieldService.getValues(existingItemId, "items") : {};
  for (const def of defs) {
    const id = String(def._id);
    const sent = Object.prototype.hasOwnProperty.call(cf, id) ? cf[id] : Object.prototype.hasOwnProperty.call(cf, def.slug) ? cf[def.slug] : undefined;
    const value = sent !== undefined ? sent : existing[def.slug];
    const blank = value === undefined || value === null || String(value).trim() === "" || (Array.isArray(value) && value.length === 0);
    if (def.required && blank) throw new InputError(`${def.name} is required`);
    if (def.type === "number" && sent !== undefined && !blank && !Number.isFinite(Number(sent))) {
      throw new InputError(`${def.name} must be a number`);
    }
  }
};

// Duplicate rule: same company + branch + name (case-insensitive).
const findDuplicate = (req, name, branch, excludeId) => Item.findOne({
  ...tenantFilterOf(req),
  name: new RegExp(`^${escapeRegExp(name)}$`, "i"),
  branch: branch || "",
  ...(excludeId ? { _id: { $ne: excludeId } } : {}),
}).select("_id").lean();

// Serialises create/rename of the same name in one company so a double-click
// can't slip two identical items past the duplicate check.
const pending = new Map();
const withNameLock = async (key, fn) => {
  const prev = pending.get(key) || Promise.resolve();
  let release;
  const mine = new Promise((r) => { release = r; });
  const chain = prev.then(() => mine);
  pending.set(key, chain);
  await prev;
  try { return await fn(); } finally {
    release();
    if (pending.get(key) === chain) pending.delete(key);
  }
};
const lockKey = (req, name, branch) => `${req.user?.tenant_id || ""}|${String(branch || "").toLowerCase()}|${String(name).toLowerCase()}`;

const sendError = (res, error) => {
  const status = error instanceof InputError ? error.status : statusForError(error);
  res.status(status).json({ message: error.message });
};

// Price-master fields belong to the Purchase Orders price list, which has its
// own permission ("Purchase Orders" > "Manage Prices") and change log.
const PO_PRICE_FIELDS = ["item_code", "master_price", "cost_price", "distributor_price", "end_customer_price"];
const stripPoPriceFields = (data) => PO_PRICE_FIELDS.forEach((f) => delete data[f]);

const enrichItems = async (items) => {
  const cfByItem = await CustomFieldService.getValuesForMany(items.map((i) => i._id), "items");
  return items.map((item) => {
    const itemObj = item.toObject();
    itemObj.custom_fields = cfByItem.get(String(item._id)) || {};
    return itemObj;
  });
};

const getItems = async (req, res) => {
  try {
    const filter = tenantFilterOf(req);

    const { page, limit, search, branch } = req.query;
    const isPaginated = page !== undefined || limit !== undefined || search !== undefined;
    if (branch) filter.branch = String(branch);

    // Legacy behavior: callers that don't ask for pagination (item pickers on
    // invoices/estimates/etc., exports) keep getting the full bare array.
    if (!isPaginated) {
      const items = await Item.find(filter).populate("tax tax2 categoryId subcategoryId").sort({ createdAt: -1 });
      return res.json(await enrichItems(items));
    }

    if (search && String(search).trim()) {
      const re = new RegExp(escapeRegExp(String(search).trim()), "i");
      const matchedTaxIds = await Tax.find({ name: re, ...tenantFilterOf(req) }).distinct("_id");
      filter.$or = [
        { name: re },
        { long_description: re },
        { group: re },
        { hsn_sac_code: re },
        { branch: re },
        { tax: { $in: matchedTaxIds } },
      ];
    }

    const pageNum = Math.max(parseInt(page, 10) || 1, 1);
    const limitNum = Math.min(Math.max(parseInt(limit, 10) || 25, 1), 500);

    const [total, items] = await Promise.all([
      Item.countDocuments(filter),
      Item.find(filter)
        .populate("tax tax2 categoryId subcategoryId")
        .sort({ createdAt: -1 })
        .skip((pageNum - 1) * limitNum)
        .limit(limitNum),
    ]);

    res.json({
      data: await enrichItems(items),
      total,
      page: pageNum,
      pages: Math.max(Math.ceil(total / limitNum), 1),
      limit: limitNum,
    });
  } catch (error) {
    sendError(res, error);
  }
};

const getItemById = async (req, res) => {
  try {
    const item = await Item.findOne({ _id: req.params.id, ...tenantFilterOf(req) }).populate("tax tax2");
    if (!item) return res.status(404).json({ message: "Item not found" });
    const cf = await CustomFieldService.getValues(item._id, "items");
    const itemObj = item.toObject();
    itemObj.custom_fields = cf;
    res.json(itemObj);
  } catch (error) {
    sendError(res, error);
  }
};

// Some forms send only a description; use it as the item name.
// PO prices are changed only through the price master, never the item form.
const withNameFallback = (raw) => {
  const body = { ...(raw || {}) };
  stripPoPriceFields(body);
  if (!body.name && body.description) body.name = body.description;
  return body;
};

const createItem = async (req, res) => {
  try {
    if (!req.user?.is_superadmin && !req.user?.tenant_id) {
      return res.status(403).json({ message: "Your account is not linked to a company" });
    }
    const body = withNameFallback(req.body);
    const { custom_fields } = body;
    const itemData = await buildItemData(req, body);
    await checkCustomFields(custom_fields, null, req.user?.tenant_id);

    const result = await withNameLock(lockKey(req, itemData.name, itemData.branch), async () => {
      if (await findDuplicate(req, itemData.name, itemData.branch)) {
        throw new InputError(`An item named "${itemData.name}" already exists${itemData.branch ? ` in ${itemData.branch}` : ""}`, 409);
      }
      return Item.create({ ...itemData, tenant_id: req.user?.tenant_id });
    });

    if (custom_fields) await CustomFieldService.handlePost(result._id, "items", custom_fields, result.tenant_id);
    const itemObj = result.toObject();
    itemObj.custom_fields = custom_fields ? await CustomFieldService.getValues(result._id, "items") : {};
    res.status(201).json(itemObj);
  } catch (error) {
    sendError(res, error);
  }
};

const updateItem = async (req, res) => {
  try {
    const item = await Item.findOne({ _id: req.params.id, ...tenantFilterOf(req) });
    if (!item) return res.status(404).json({ message: "Item not found" });

    const body = withNameFallback(req.body);
    const { custom_fields } = body;
    const itemData = await buildItemData(req, body, item);
    if (custom_fields) await checkCustomFields(custom_fields, item._id, item.tenant_id);

    const name = itemData.name ?? item.name;
    const branch = "branch" in itemData ? itemData.branch : item.branch;
    const updatedItem = await withNameLock(lockKey(req, name, branch), async () => {
      if (await findDuplicate(req, name, branch, item._id)) {
        throw new InputError(`An item named "${name}" already exists${branch ? ` in ${branch}` : ""}`, 409);
      }
      Object.assign(item, itemData);
      return item.save();
    });

    if (custom_fields) await CustomFieldService.handlePost(item._id, "items", custom_fields, item.tenant_id);
    const itemObj = updatedItem.toObject();
    itemObj.custom_fields = await CustomFieldService.getValues(item._id, "items");
    res.json(itemObj);
  } catch (error) {
    sendError(res, error);
  }
};

const deleteItem = async (req, res) => {
  try {
    const item = await Item.findOneAndDelete({ _id: req.params.id, ...tenantFilterOf(req) });
    if (!item) return res.status(404).json({ message: "Item not found" });
    await CustomFieldService.deleteValues(item._id, "items");
    res.json({ message: "Item deleted successfully" });
  } catch (error) {
    sendError(res, error);
  }
};

const bulkDeleteItems = async (req, res) => {
  try {
    const { ids } = req.body || {};
    if (!ids || !Array.isArray(ids) || ids.length === 0) {
      return res.status(400).json({ message: "No item IDs provided for deletion" });
    }
    if (!ids.every((id) => isObjectId(String(id)))) {
      return res.status(400).json({ message: "One or more item IDs are invalid" });
    }
    const filter = { _id: { $in: ids }, ...tenantFilterOf(req) };
    const found = await Item.find(filter).select("_id").lean();
    const foundIds = found.map((i) => i._id);
    const result = await Item.deleteMany({ _id: { $in: foundIds } });
    await CustomFieldService.deleteValuesForMany(foundIds, "items");
    res.json({ message: `Successfully deleted ${result.deletedCount} item(s)`, count: result.deletedCount });
  } catch (error) {
    sendError(res, error);
  }
};

const getRowVal = (row, aliases) => {
  if (!row || typeof row !== "object") return "";
  const keys = Object.keys(row);
  for (const alias of aliases) {
    const cleanAlias = alias.trim().toLowerCase().replace(/[\s_]+/g, "");
    for (const k of keys) {
      const cleanK = k.trim().toLowerCase().replace(/[\s_]+/g, "");
      if (cleanK === cleanAlias) {
        const val = row[k];
        if (val !== undefined && val !== null && String(val).trim() !== "") {
          return String(val).trim();
        }
      }
    }
  }
  return "";
};

// "₹ 1,500.50" → "1500.50"; "abc" stays "abc" so it is reported, not saved as 0.
const cleanNumber = (raw) => String(raw).replace(/^(rs\.?|inr)\s*/i, "").replace(/[₹$€£,\s]/g, "");

const importItems = async (req, res) => {
  try {
    const rowsRaw = Array.isArray(req.body) ? req.body : req.body?.items;
    if (!rowsRaw || !Array.isArray(rowsRaw) || rowsRaw.length === 0) {
      return res.status(400).json({ message: "No valid item data provided" });
    }

    const tenantId = req.user?.tenant_id;
    const tenantFilter = tenantFilterOf(req);

    const taxNames = [...new Set(rowsRaw.map((r) => getRowVal(r, ["tax", "tax_class", "tax_rate"])).filter(Boolean))];
    const taxDocs = taxNames.length
      ? await Tax.find({ name: { $in: taxNames.map((n) => new RegExp(`^${escapeRegExp(n)}$`, "i")) }, ...tenantFilter })
      : [];
    const taxMap = new Map(taxDocs.map((t) => [t.name.toLowerCase().trim(), t._id]));

    let companyBranches = null;
    if (tenantFilter.tenant_id) {
      const HRMSBranch = require("../hrms/models/hrms_branch_model");
      const list = await HRMSBranch.find({ tenant_id: tenantFilter.tenant_id }).select("name").lean();
      if (list.length) companyBranches = new Set(list.map((b) => b.name));
    }


    let catByName = new Map();
    let catByCode = new Map();
    try {
      const PurchaseCategory = require("../models/PurchaseCategory");
      const cats = await PurchaseCategory.find({ tenant_id: tenantFilter.tenant_id, isActive: true }).lean();
      cats.forEach((c) => {
        catByName.set(String(c.name || "").toLowerCase().trim(), c);
        catByCode.set(String(c.code || "").toUpperCase().trim(), c);
      });
    } catch (_) {}

    const customFieldDefs = await CustomField.find({ fieldto: "items", active: true, ...CustomFieldService.tenantScope(tenantFilter.tenant_id) });

    const errors = [];
    let noName = 0;
    const parsedRows = [];
    rowsRaw.forEach((rowIn, idx) => {
      const r = withoutProtected(rowIn && typeof rowIn === "object" ? rowIn : {});
      const rowNo = idx + 1;
      let name = getRowVal(r, ["item_name", "item name", "name", "item", "title", "product", "product_name", "product name", "item_title"]);
      const description = getRowVal(r, ["description", "item_description", "item description", "details", "desc"]);
      if (!name && description && description !== "-") name = description;
      if (!name || name === "-") { noName += 1; return; }

      const reasons = [];
      const num = (label, aliases, def, opts) => {
        const raw = getRowVal(r, aliases);
        if (raw === "" || raw === "-") return def;
        const cleaned = cleanNumber(raw);
        const e = checkNumber(label, cleaned === "" ? "x" : cleaned, opts);
        if (e) { reasons.push(e); return def; }
        return Number(cleaned);
      };
      const quantity = num("Quantity", ["quantity", "qty", "count"], 1, { min: 0 });
      const rate = num("Rate", ["rate", "price", "unit_price", "unit price", "cost"], 0, { min: 0 });
      const cess_rate = num("Cess Rate", ["cess_rate", "cess rate", "cess"], 0, { min: 0, max: 100 });
      if (name.length > LIMITS.name) reasons.push(`Item Name must be ${LIMITS.name} characters or less`);

      const rawLongDesc = getRowVal(r, ["long_description", "long description", "long_desc", "details", "notes"]);
      const longDesc = (rawLongDesc && rawLongDesc !== "-") ? rawLongDesc : ((description && description !== "-") ? description : "");
      const rawGroup = getRowVal(r, ["group", "category", "item_group", "item group", "item_category"]);
      const group = (rawGroup && rawGroup !== "-") ? rawGroup : "";
      const rawUnit = getRowVal(r, ["unit", "uom", "unit_of_measure"]);
      const unit = (rawUnit && rawUnit !== "-") ? rawUnit : "Nos";
      const rawBranch = getRowVal(r, ["branch", "branch_name", "branch name"]);
      const branch = (rawBranch && rawBranch !== "-") ? rawBranch : "";
      if (branch && companyBranches && !companyBranches.has(branch)) reasons.push(`Branch "${branch}" does not exist`);
      const lenErr = firstError(
        checkLength("Description", longDesc, LIMITS.long_description),
        checkLength("Unit", unit, LIMITS.unit),
        checkLength("Group", group, LIMITS.group),
      );
      if (lenErr) reasons.push(lenErr);

      if (reasons.length) { errors.push({ row: rowNo, name, reasons }); return; }

      const rawInclusive = getRowVal(r, ["tax_inclusive", "tax inclusive"]);
      const obj = {
        name,
        long_description: longDesc !== name ? longDesc : "",
        quantity,
        rate,
        amount: quantity * rate,
        unit,
        group,
        branch,
        hsn_sac_code: String(r.hsn_sac_code || r["HSN/SAC"] || r["HSN Code"] || r["HSN/SAC Code"] || "").trim(),
        cess_rate,
        tax_inclusive: toBoolean(rawInclusive) === true,
        tenant_id: tenantId,
        _rawRow: r,
      };
      const taxName = getRowVal(r, ["tax", "tax_class", "tax_rate"]).toLowerCase();
      if (taxName && taxName !== "-" && taxMap.has(taxName)) obj.tax = taxMap.get(taxName);
      parsedRows.push(obj);
    });

    if (parsedRows.length === 0 && errors.length === 0) {
      return res.status(400).json({ message: "No valid item data with 'Name' or 'Item Name' found in sheet" });
    }

    // Duplicates: same company + branch + name, case-insensitive — against
    // existing items and inside the file itself.
    const keyOf = (name, branch) => `${String(branch || "").toLowerCase()}|${String(name).trim().toLowerCase()}`;
    const existing = parsedRows.length ? await Item.find(tenantFilter).select("name branch").lean() : [];
    const seen = new Set(existing.map((i) => keyOf(i.name, i.branch)));
    const newItems = [];
    for (const r of parsedRows) {
      const k = keyOf(r.name, r.branch);
      if (seen.has(k)) continue;
      seen.add(k);
      newItems.push(r);
    }
    const skipped = parsedRows.length - newItems.length;
    const invalid = errors.length;

    if (newItems.length === 0) {
      return res.status(invalid ? 400 : 200).json({
        message: invalid
          ? `Nothing imported: ${invalid} row(s) have errors${skipped ? `, ${skipped} duplicate(s) skipped` : ""}.`
          : `All ${parsedRows.length} item(s) already exist — nothing imported.`,
        count: 0, created: 0, skipped, invalid, noName, errors,
      });
    }

    const itemsToInsert = newItems.map(({ _rawRow, ...itemData }) => itemData);
    const result = await Item.insertMany(itemsToInsert, { ordered: false });

    if (customFieldDefs.length > 0) {
      for (let i = 0; i < result.length; i++) {
        const rawRow = newItems[i]?._rawRow || {};
        const cfData = {};
        customFieldDefs.forEach((cf) => {
          const val = rawRow[cf.name] ?? rawRow[cf.slug] ?? rawRow[cf.name.toLowerCase()];
          if (val !== undefined) cfData[cf._id.toString()] = val;
        });
        if (Object.keys(cfData).length > 0) {
          await CustomFieldService.handlePost(result[i]._id, "items", cfData, result[i].tenant_id);
        }
      }
    }

    res.status(201).json({
      message: `Imported ${result.length} new item(s)${skipped ? `, skipped ${skipped} duplicate(s)` : ""}${invalid ? `, ${invalid} row(s) with errors not imported` : ""}.`,
      count: result.length, created: result.length, skipped, invalid, noName, errors,
    });
  } catch (error) {
    console.error("IMPORT ITEMS ERROR:", error);
    sendError(res, error);
  }
};

module.exports = { getItems, getItemById, createItem, updateItem, deleteItem, bulkDeleteItems, importItems };
