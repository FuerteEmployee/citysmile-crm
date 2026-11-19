const express = require("express");
const router = express.Router();
const {
  getCreditNotes,
  getCreditNoteById,
  getCreditNotesByInvoice,
  createCreditNote,
  updateCreditNote,
  deleteCreditNote,
  importCreditNotes,
  applyCreditNote,
} = require("../controllers/credit_note_controller");
const { protect, checkPermission } = require("../middleware/auth");
const { nextNumberHandler } = require("../services/docSettings");

router.use(protect);
router.use(checkPermission("Invoices", "View"));

router.route("/")
  .get(getCreditNotes)
  .post(checkPermission("Invoices", "Create"), createCreditNote);

router.get("/next-number", nextNumberHandler("credit_note"));

router.post("/import", checkPermission("Invoices", "Create"), importCreditNotes);

router.get("/invoice/:invoiceId", getCreditNotesByInvoice);

router.post("/:id/apply", checkPermission("Invoices", "Edit"), applyCreditNote);

router.route("/:id")
  .get(getCreditNoteById)
  .put(checkPermission("Invoices", "Edit"), updateCreditNote)
  .delete(checkPermission("Invoices", "Delete"), deleteCreditNote);

module.exports = router;
