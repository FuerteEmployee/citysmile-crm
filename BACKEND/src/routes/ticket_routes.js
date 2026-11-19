const express = require("express");
const router = express.Router();
const { getTickets, getTicketById, addTicketReply, createTicket, updateTicket, deleteTicket, bulkDeleteTickets } = require("../controllers/ticket_controller");
const { protect, checkPermission } = require("../middleware/auth");
const { upload } = require("../controllers/file_controller");

router.use(protect);
router.use(checkPermission("Support", "View"));

router.route("/")
  .get(getTickets)
  .post(upload.array("attachments"), createTicket);

router.post("/bulk-delete", checkPermission("Support", "Delete"), bulkDeleteTickets);

router.route("/:id")
  .get(getTicketById)
  .put(updateTicket)
  .delete(deleteTicket);

router.post("/:id/replies", addTicketReply);

module.exports = router;
