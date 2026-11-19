const express = require("express");
const router = express.Router();
const { getProposals, getProposalById, createProposal, updateProposal, deleteProposal, importProposals, bulkDeleteProposals } = require("../controllers/proposal_controller");
const { protect, checkPermission } = require("../middleware/auth");
const { viewOrAssigned, nextNumberHandler } = require("../services/docSettings");

router.use(protect);
// Proposals "View", or (GET only) the proposals assigned to the staff member
// when Setup > Settings > Proposals > "Allow staff members to view proposals
// where they are assigned to" is on.
router.use(viewOrAssigned(checkPermission, "Proposals", "proposal"));

router.route("/")
  .get(getProposals)
  .post(createProposal);

router.get("/next-number", nextNumberHandler("proposal"));
router.post("/import", importProposals);
router.post("/bulk-delete", checkPermission("Proposals", "Delete"), bulkDeleteProposals);

router.route("/:id")
  .get(getProposalById)
  .put(updateProposal)
  .delete(deleteProposal);

module.exports = router;
