const express = require("express");
const router = express.Router();
const ctrl = require("../controllers/incentive_rule_controller");
const { protect, requireAdmin } = require("../middleware/auth_middleware");

router.use(protect);

// Incentive rules decide what a salesperson is PAID, so writes are admin-only
// (matching the reference project's requirePermission("view_targets") gate,
// adapted to this codebase's simpler admin-only pattern — see Holiday Calendar).
router.get("/", ctrl.getAll);
router.get("/:id", ctrl.getById);
// Calculate is a read-only projection used by the slabs UI preview.
router.post("/calculate", ctrl.calculate);

router.post("/", requireAdmin, ctrl.create);
router.put("/:id", requireAdmin, ctrl.update);
router.delete("/:id", requireAdmin, ctrl.delete);

module.exports = router;
