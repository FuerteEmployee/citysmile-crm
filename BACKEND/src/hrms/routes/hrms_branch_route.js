const express = require("express");
const { hrmsManager } = require("../middleware/authorize");
const router = express.Router();
const hrmsBranchController = require("../controllers/hrms_branch_controller");
const { protect } = require("../middleware/auth_middleware");

router.post("/", protect, hrmsManager(["create_branches"]), hrmsBranchController.createHRMSBranch);
router.get("/", protect, hrmsBranchController.getAllHRMSBranches);
// Before /:id so "my-scope" isn't treated as a branch id.
router.get("/my-scope", protect, hrmsBranchController.getMyBranchScope);
router.get("/:id", protect, hrmsBranchController.getHRMSBranchById);
router.patch("/:id", protect, hrmsManager(["edit_branches"]), hrmsBranchController.updateHRMSBranch);
router.delete("/:id", protect, hrmsManager(["delete_branches"]), hrmsBranchController.deleteHRMSBranch);

module.exports = router;
