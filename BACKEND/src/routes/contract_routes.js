const express = require("express");
const router = express.Router();
const { getContracts, getContractById, createContract, updateContract, deleteContract, importContracts, signContract, bulkDeleteContracts } = require("../controllers/contract_controller");
const { protect, checkPermission } = require("../middleware/auth");

router.use(protect);
router.use(checkPermission("Contracts", "View"));

router.post("/import", importContracts);
router.post("/bulk-delete", checkPermission("Contracts", "Delete"), bulkDeleteContracts);

router.route("/")
  .get(getContracts)
  .post(createContract);

router.post("/:id/sign", signContract);

router.route("/:id")
  .get(getContractById)
  .put(updateContract)
  .patch(updateContract)
  .delete(deleteContract);

module.exports = router;
