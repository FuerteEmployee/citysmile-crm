const express = require("express");
const router = express.Router();
const {
  getBankDetails,
  createBankDetail,
  updateBankDetail,
  deleteBankDetail,
} = require("../controllers/bank_detail_controller");
const { protect, adminOnly, bankDetailsOnly } = require("../middleware/auth");

router.use(protect);
router.use(bankDetailsOnly);

router.get("/", getBankDetails);
router.post("/", adminOnly, createBankDetail);
router.patch("/:id", adminOnly, updateBankDetail);
router.delete("/:id", adminOnly, deleteBankDetail);

module.exports = router;
