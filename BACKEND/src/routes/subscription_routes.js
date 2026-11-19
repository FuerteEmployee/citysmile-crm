const express = require("express");
const router = express.Router();
const { getSubscriptions, getSubscriptionById, createSubscription, updateSubscription, deleteSubscription } = require("../controllers/subscription_controller");
const { protect, checkPermission } = require("../middleware/auth");

router.use(protect);

router.route("/")
  .get(checkPermission("Subscriptions","view"), getSubscriptions)
  .post(checkPermission("Subscriptions","create"), createSubscription);

router.route("/:id")
  .get(checkPermission("Subscriptions","view"), getSubscriptionById)
  .put(checkPermission("Subscriptions","edit"), updateSubscription)
  .delete(checkPermission("Subscriptions","delete"), deleteSubscription);

module.exports = router;
