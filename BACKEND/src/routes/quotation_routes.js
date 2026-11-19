const express = require("express");
const router = express.Router();
const {
  getQuotationStats, getQuotations, createQuotation, getQuotationById, updateQuotation, deleteQuotation,
  requestApproval, approveQuotation, rejectQuotation, getPendingApprovals, getApprovalHistory,
} = require("../controllers/quotation_controller");
const { protect, checkPermission, hasCapability } = require("../middleware/auth");

const checkQuotationCreate = async (req, res, next) => {
  if (req.user?.admin || req.user?.is_superadmin) return next();
  if ((await hasCapability(req, "Quotations", "Create")) || (await hasCapability(req, "Quotations", "Approve"))) return next();
  return res.status(403).json({ message: "Forbidden: no Create permission for Quotations" });
};

const checkQuotationEdit = async (req, res, next) => {
  if (req.user?.admin || req.user?.is_superadmin) return next();
  if ((await hasCapability(req, "Quotations", "Edit")) || (await hasCapability(req, "Quotations", "Approve"))) return next();
  return res.status(403).json({ message: "Forbidden: no Edit permission for Quotations" });
};

router.get("/stats", protect, checkPermission("Quotations", "View"), getQuotationStats);
router.get("/approvals/pending", protect, getPendingApprovals);
router.get("/", protect, checkPermission("Quotations", "View"), getQuotations);
router.post("/", protect, checkQuotationCreate, createQuotation);
router.get("/:id", protect, checkPermission("Quotations", "View"), getQuotationById);
router.put("/:id", protect, checkQuotationEdit, updateQuotation);
router.delete("/:id", protect, checkPermission("Quotations", "Delete"), deleteQuotation);
router.post("/:id/request-approval", protect, requestApproval);
router.post("/:id/approve", protect, approveQuotation);
router.post("/:id/reject", protect, rejectQuotation);
router.get("/:id/approval-history", protect, checkPermission("Quotations", "View"), getApprovalHistory);

module.exports = router;
