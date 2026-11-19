const express = require("express");
const router = express.Router();
const { 
  getContractTypes, 
  createContractType, 
  updateContractType, 
  deleteContractType 
} = require("../controllers/contract_type_controller");
const { protect, adminOnly } = require("../middleware/auth");

router.use(protect);

router.get("/", getContractTypes);
router.post("/", adminOnly, createContractType);
router.patch("/:id", adminOnly, updateContractType);
router.delete("/:id", adminOnly, deleteContractType);

module.exports = router;
