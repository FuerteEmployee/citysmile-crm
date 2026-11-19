// Round 29 (S3): POST /purchase-orders/customer-po/read — "Read items from
// the customer PO". The editor posts the customer's PO file (text PDF or
// .xlsx, ≤ 10 MB, kept in memory — never stored here) and gets back the
// review list: matched lines (green), catalogs not in PO Items (red, with the
// text read), qty unreadable (amber) — plus the customer PO no. / date when
// found. Nothing is saved; the user checks the lines and saves the PO.
//
// Each matched line carries the PO Items prices: cost (MDP, else DP), the
// floor (End User Price, or Distributor Price for a "distributor" customer —
// optional `customer` field) and the selling price = the customer's rate, or
// the floor when the rate is below it (flag below_floor).
const mongoose = require("mongoose");
const PoItem = require("../models/PoItem");
const Client = require("../models/Client");
const { costOf, round2 } = require("../services/purchaseOrderRules");
const { readCustomerPoFile, matchLines } = require("../services/customerPoReader");
const { _internal: H } = require("./purchase_order_controller");

const { httpError, fail, can, tenantOf, getSettingsDoc } = H;

const levelOf = (settings, customerId) => {
  const levels = settings.customer_price_levels;
  const v = levels?.get ? levels.get(String(customerId)) : levels?.[String(customerId)];
  return v === "distributor" ? "distributor" : "end_user";
};

const readCustomerPo = async (req, res) => {
  try {
    if (!(await can(req, "Create")) && !(await can(req, "Edit"))) throw httpError(403, "You don't have permission to make purchase orders");
    const tenantId = tenantOf(req);
    if (!req.file) throw httpError(400, "Attach the customer's PO (PDF or Excel)");

    let level = "end_user";
    const customer = req.body?.customer;
    if (customer) {
      if (!mongoose.isValidObjectId(customer)) throw httpError(400, "Unknown customer");
      const c = await Client.findOne({ _id: customer, tenant_id: tenantId }).select("_id").lean();
      if (!c) throw httpError(400, "Unknown customer");
      level = levelOf(await getSettingsDoc(tenantId), c._id);
    }

    const { kind, rows } = await readCustomerPoFile(req.file.buffer, req.file.originalname || "");
    const items = await PoItem.find({ tenant_id: tenantId })
      .select("item_code y_code name description hsn unit tax_rate master_price distributor_price end_customer_price cost_price replaces replaced_by active category")
      .lean();
    const { lines, customer_po_number, customer_po_date } = matchLines(rows, items);
    const byId = new Map(items.map((i) => [String(i._id), i]));

    const out = lines.map((l) => {
      const it = l.item_id && byId.get(l.item_id);
      if (!it) return l;
      const floor = round2(level === "distributor" ? it.distributor_price || 0 : it.end_customer_price || 0);
      const rate = l.rate === null || l.rate === undefined ? null : round2(l.rate);
      const belowFloor = rate !== null && floor > 0 && rate < floor;
      return {
        ...l,
        rate,
        item: {
          _id: String(it._id),
          item_code: it.item_code,
          y_code: it.y_code,
          name: it.name,
          hsn: it.hsn,
          unit: it.unit,
          tax_rate: it.tax_rate,
          master_price: it.master_price,
          distributor_price: it.distributor_price,
          end_customer_price: it.end_customer_price,
          cost_price: it.cost_price,
          replaced_by: it.replaced_by,
          category: it.category,
        },
        ...costOf(it),
        list_price: floor,
        selling_price: rate === null ? floor : belowFloor ? floor : rate,
        below_floor: belowFloor,
      };
    });
    const count = (s) => out.filter((l) => l.status === s).length;
    res.json({
      source: kind,
      price_level: level,
      customer_po_number,
      customer_po_date,
      lines: out,
      summary: { matched: count("matched"), not_found: count("not_found"), qty_unreadable: count("qty_unreadable") },
      message: out.length ? "" : "No order lines with catalog numbers from PO Items were found — add items by hand",
    });
  } catch (error) {
    fail(res, error);
  }
};

module.exports = { readCustomerPo };
