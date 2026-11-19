const express = require("express");
const { hrmsManager } = require("../middleware/authorize");
const router = express.Router();
const designationController = require("../controllers/designation_controller");
const { protect } = require("../middleware/auth_middleware");

router.use(protect);

router.post("/", hrmsManager(["manage_designations"]), designationController.createDesignation);
router.get("/", designationController.getAllDesignations);
router.get("/:id", designationController.getDesignationById);
router.patch("/:id", hrmsManager(["manage_designations"]), designationController.updateDesignation);
router.delete("/:id", hrmsManager(["manage_designations"]), designationController.deleteDesignation);

module.exports = router;
