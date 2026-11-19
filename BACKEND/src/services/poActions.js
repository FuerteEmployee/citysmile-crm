// Purchase Orders round 29 (S2): when the row icons (View / Edit / Delete)
// are enabled, and why not. Pure — the controllers use the same reasons in
// their 400 / 403 answers and the frontend mirrors this file in
// pages/purchase-orders/poActions.ts, so the disabled icon's tooltip and the
// API say the same thing.

const LOCKED = {
  pending_approval: "Pending POs are locked",
  approved: "Approved POs are locked",
  sent: "Approved POs are locked",
  partially_received: "Approved POs are locked",
  received: "Approved POs are locked",
  cancelled: "Cancelled POs are locked",
};
const NO_PERMISSION = "No permission";
const HAS_PROFORMA = "Has a proforma invoice";
const OLD_SALES = "Old Sales POs are read-only";

// Why this PO can't be edited (null = it can). canEdit = the Edit permission.
const editBlock = (po, { canEdit }) => {
  if (po?.type === "sales") return OLD_SALES;
  if (!canEdit) return NO_PERMISSION;
  if (po?.status !== "draft") return LOCKED[po?.status] || "This PO is locked";
  return null;
};

// Why this PO can't be deleted (null = it can): drafts and cancelled POs
// without a proforma invoice, by staff with the Delete permission.
const deleteBlock = (po, { canDelete, hasProforma }) => {
  if (!canDelete) return NO_PERMISSION;
  // Round 30: a locked PO that also has a proforma says both (status first).
  if (!["draft", "cancelled"].includes(po?.status)) {
    const locked = LOCKED[po?.status] || "This PO is locked";
    return hasProforma ? `${locked} · has a proforma invoice` : locked;
  }
  if (hasProforma) return HAS_PROFORMA;
  return null;
};

// All three icons of one row: { view, edit, delete } → { enabled, reason }.
const rowActions = (po, perms) => {
  const e = editBlock(po, perms);
  const d = deleteBlock(po, perms);
  return {
    view: { enabled: true, reason: null },
    edit: { enabled: !e, reason: e },
    delete: { enabled: !d, reason: d },
  };
};

module.exports = { LOCKED, NO_PERMISSION, HAS_PROFORMA, OLD_SALES, editBlock, deleteBlock, rowActions };
