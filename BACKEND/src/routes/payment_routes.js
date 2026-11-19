const express = require("express");
const router = express.Router();
const { createPayment, updatePayment, deletePayment, getPaymentsByInvoice, getPaymentsByCustomer, getPayments, importPayments, bulkDeletePayments } = require("../controllers/payment_controller");
const { protect, checkPermission } = require("../middleware/auth");

router.use(protect);

router.post("/import", checkPermission("Payments", "create"), importPayments);
router.post("/bulk-delete", checkPermission("Payments", "delete"), bulkDeletePayments);

router.route("/")
  .get(checkPermission("Payments", "view"), getPayments)
  .post(checkPermission("Payments", "create"), createPayment);

router.route("/invoice/:invoiceId")
  .get(checkPermission("Payments", "view"), getPaymentsByInvoice);

router.route("/customer/:clientId")
  .get(checkPermission("Payments", "view"), getPaymentsByCustomer);

router.route("/:id")
  .put(checkPermission("Payments", "edit"), updatePayment)
  .delete(checkPermission("Payments", "delete"), deletePayment);

module.exports = router;
