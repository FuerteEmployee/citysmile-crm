const express = require("express");
const router = express.Router();
const {
  getPurchases,
  getPurchaseById,
  createPurchase,
  updatePurchase,
  deletePurchase,
  bulkDeletePurchases,
  bulkUpdatePurchases,
  importPurchases,
  getPurchaseBranches,
} = require("../controllers/purchase_controller");
const { protect, checkPermission } = require("../middleware/auth");

router.use(protect);
router.use(checkPermission("Purchases", "View"));

router.route("/")
  .get(getPurchases)
  .post(createPurchase);

router.post("/import", importPurchases);
router.post("/bulk-delete", bulkDeletePurchases);
router.get("/branches", getPurchaseBranches);

router.route("/:id")
  .get(getPurchaseById)
  .put(updatePurchase)
  .delete(deletePurchase);

module.exports = router;
