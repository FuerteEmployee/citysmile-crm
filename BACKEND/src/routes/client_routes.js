const express = require("express");
const router = express.Router();
const {
  getClients,
  getClientById,
  createClient,
  updateClient,
  deleteClient,
  getContacts,
  getAllContacts,
  createContact,
  updateContact,
  deleteContact,
  getStatement,
  sendStatementEmail,
  importClients,
  importContacts,
  bulkDeleteClients,
  transferOrAssignCustomers,
  bulkAssignGroup,
} = require("../controllers/client_controller");
const { getVaultEntries, createVaultEntry, deleteVaultEntry } = require("../controllers/vault_controller");
const {
  requireOwnClient, uploadCustomerFiles, saveCustomerFiles, getCustomerFiles, deleteCustomerFile,
} = require("../controllers/client_file_controller");
const { getReminders, createReminder, deleteReminder } = require("../controllers/reminder_controller");
const { protect, checkPermission, requireCapability } = require("../middleware/auth");
const { validIdParam } = require("../utils/requestSafety");

// Reads need View; every write also needs the matching Create / Edit / Delete
// capability on "Customers" (admins pass automatically).
const canCreate = requireCapability("Customers", "Create");
const canEdit = requireCapability("Customers", "Edit");
const canDelete = requireCapability("Customers", "Delete");
const id = validIdParam("id");

router.use(protect);
router.use(checkPermission("Customers", "View"));

// --- Sub-resource routes (Specific first) ---

// Files (customer must be in the caller's company; checked before anything is written to disk)
router.get("/:id/files", id, requireOwnClient, getCustomerFiles);
router.post("/:id/files", id, canCreate, requireOwnClient, uploadCustomerFiles, saveCustomerFiles);
router.delete("/:id/files/:fileId", id, canDelete, requireOwnClient, deleteCustomerFile);

// Reminders
router.get("/:id/reminders", id, requireOwnClient, (req, res, next) => {
    req.query.rel_id = req.params.id;
    req.query.rel_type = "customer";
    next();
}, getReminders);
router.post("/:id/reminders", id, canCreate, requireOwnClient, (req, res, next) => {
    req.body = { ...(req.body || {}), rel_id: req.params.id, rel_type: "customer" };
    next();
}, createReminder);
router.delete("/reminders/:id", id, canDelete, deleteReminder);

// Vault
router.get("/:id/vault", id, (req, res, next) => {
    req.params.clientId = req.params.id; // Controller expects clientId
    next();
}, getVaultEntries);
router.post("/:id/vault", id, canCreate, (req, res, next) => {
    req.params.clientId = req.params.id; // Controller expects clientId
    next();
}, createVaultEntry);
router.delete("/vault/:id", id, canDelete, deleteVaultEntry);

// Contacts
router.get("/contacts/all", getAllContacts);
router.post("/contacts/import", canCreate, importContacts);
router.put("/contacts/:id", id, canEdit, updateContact);
router.delete("/contacts/:id", id, canDelete, deleteContact);
router.get("/:id/contacts", id, (req, res, next) => {
    req.params.clientId = req.params.id; // Controller expects clientId
    next();
}, getContacts);
router.post("/:id/contacts", id, canCreate, (req, res, next) => {
    req.params.clientId = req.params.id; // Controller expects clientId
    next();
}, createContact);

// Statement
router.get("/:id/statement", id, getStatement);
router.post("/:id/statement/send", id, sendStatementEmail);

// --- Generic Client routes (General last) ---

router.post("/import", canCreate, importClients);
router.post("/bulk-delete", canDelete, bulkDeleteClients);
router.post("/bulk-assign-group", canEdit, bulkAssignGroup);
router.post("/transfer-or-assign", canEdit, transferOrAssignCustomers);
router.get("/", getClients);
router.post("/", canCreate, createClient);

router.get("/:id", id, getClientById);
router.put("/:id", id, canEdit, updateClient);
router.delete("/:id", id, canDelete, deleteClient);

module.exports = router;
