const express = require("express");
const { hrmsManager } = require("../middleware/authorize");
const router = express.Router();
const branchTypeController = require("../controllers/branch_type_controller");
const { protect } = require("../middleware/auth_middleware");

router.post("/", protect, hrmsManager(["create_branches"]), branchTypeController.createBranchType);
router.get("/", protect, branchTypeController.getAllBranchTypes);
router.get("/:id", protect, branchTypeController.getBranchTypeById);
router.patch("/:id", protect, hrmsManager(["edit_branches"]), branchTypeController.updateBranchType);
router.delete("/:id", protect, hrmsManager(["delete_branches"]), branchTypeController.deleteBranchType);

module.exports = router;
