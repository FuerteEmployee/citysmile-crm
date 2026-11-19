const express = require("express");
const router = express.Router();
const { getInvoices, getInvoiceById, createInvoice, updateInvoice, deleteInvoice, importInvoices, getInvoiceBranches, bulkDeleteInvoices, getNextInvoiceNumber, getInvoiceEmailDraft, sendInvoiceEmail } = require("../controllers/invoice_controller");
const { protect, checkPermission } = require("../middleware/auth");
const { getInvoiceSettings } = require("../services/invoiceSettings");

router.use(protect);

// Invoices "View" permission. Staff without it can still OPEN (read only) the
// invoices they are the sale agent of when Setup > Settings > Invoices >
// "Allow staff members to view invoices where they are assigned to" is on.
router.use((req, res, next) => {
  const fallback = async () => {
    try {
      if (req.method === "GET" && req.userRole === "staff" && (await getInvoiceSettings(req.user?.tenant_id)).allowStaffView) {
        req.permissionLevel = "assigned";
        return next();
      }
    } catch { /* fall through to the normal refusal */ }
    res.status(403).json({ message: "Forbidden: no View permission for Invoices" });
  };
  const fakeRes = {
    status: (code) => ({ json: (body) => (code === 403 ? fallback() : res.status(code).json(body)) }),
  };
  checkPermission("Invoices", "View")(req, fakeRes, next);
});

router.route("/")
  .get(getInvoices)
  .post(checkPermission("Invoices", "Create"), createInvoice);

router.get("/next-number", getNextInvoiceNumber);
router.post("/import", checkPermission("Invoices", "Create"), importInvoices);
router.get("/branches", getInvoiceBranches);
router.post("/bulk-delete", checkPermission("Invoices", "Delete"), bulkDeleteInvoices);

router.get("/:id/email-draft", getInvoiceEmailDraft);
router.post("/:id/send-email", checkPermission("Invoices", "Edit"), sendInvoiceEmail);

router.route("/:id")
  .get(getInvoiceById)
  .put(checkPermission("Invoices", "Edit"), updateInvoice)
  .delete(checkPermission("Invoices", "Delete"), deleteInvoice);

module.exports = router;
