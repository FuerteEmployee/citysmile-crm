const express = require("express");
const router = express.Router();
const { protect, staffOnly, checkPermission } = require("../middleware/auth");
const { requireTenantFeature } = require("../utils/tenantFeatures");
const multer = require("multer");
const {
  listPurchaseOrders,
  getStats,
  getPurchaseOrder,
  createPurchaseOrder,
  updatePurchaseOrder,
  submitPurchaseOrder,
  approvePurchaseOrder,
  rejectPurchaseOrder,
  getPendingApprovals,
  changeStatus,
  deletePurchaseOrder,
  sendOnWhatsApp,
  uploadCustomerPoFile,
  getPrintData,
  getPoSettings,
  updatePoSettings,
  setCustomerPriceLevel,
  listPoItems,
  listPoItemCategories,
  listPoItemSeries,
  createPoItem,
  updatePoItem,
  deletePoItem,
  previewPoItems,
  importPoItems,
  exportPoItems,
} = require("../controllers/purchase_order_controller");
const { scanPriceList, previewPriceList, importPriceList } = require("../controllers/purchase_order_pricelist_controller");
const {
  createProforma,
  listProformas,
  getProforma,
  updateProforma,
  cancelProforma,
  getProformaPrint,
  sendProformaWhatsApp,
} = require("../controllers/purchase_order_proforma_controller");
const { readCustomerPo } = require("../controllers/purchase_order_autofill_controller");
const { saveReference, referenceStatus, findCatalogs, addCatalogs } = require("../controllers/purchase_order_reference_controller");

// The browser-made PO PDF for WhatsApp: one file, at most 10 MB, kept in memory
// (the controller checks it really is a PDF).
const pdfUpload = multer({ storage: multer.memoryStorage(), limits: { fileSize: 10 * 1024 * 1024 + 1, files: 1 } }).single("file");
const poPdfUpload = (req, res, next) =>
  pdfUpload(req, res, (err) => {
    if (!err) return next();
    res.status(400).json({ message: err.code === "LIMIT_FILE_SIZE" ? "The PDF is larger than 10 MB" : "Upload one PDF file" });
  });

// The customer's own PO on a Purchase PO: one file ("file"), at most 10 MB, kept in
// memory — never written to disk here. The controller checks its first bytes
// (PDF / JPG / PNG only) before storing it like other CRM uploads.
// (+1: busboy flags a file that reaches the limit, so exactly 10 MB still passes.)
const MAX_CUSTOMER_PO_BYTES = 10 * 1024 * 1024;
const customerPoSingle = multer({ storage: multer.memoryStorage(), limits: { fileSize: MAX_CUSTOMER_PO_BYTES + 1, files: 1 } }).single("file");
const customerPoUpload = (req, res, next) =>
  customerPoSingle(req, res, (err) => {
    if (!err) return next();
    res.status(400).json({ message: err.code === "LIMIT_FILE_SIZE" ? "The file is larger than 10 MB" : "Attach one file (PDF, JPG or PNG)" });
  });

// Round 29 (S3): "Read items from the customer PO" — one file (PDF or .xlsx),
// at most 10 MB, in memory only (read, never stored).
const customerPoReadSingle = multer({ storage: multer.memoryStorage(), limits: { fileSize: MAX_CUSTOMER_PO_BYTES + 1, files: 1 } }).single("file");
const customerPoReadUpload = (req, res, next) =>
  customerPoReadSingle(req, res, (err) => {
    if (!err) return next();
    res.status(400).json({ message: err.code === "LIMIT_FILE_SIZE" ? "The file is larger than 10 MB" : "Attach one file (PDF or Excel)" });
  });

// Only companies the super admin gave the "purchase_orders" add-on (Trinetra)
// get past this line; everyone else gets 403. Create/Edit/Delete/Approve/
// Manage Prices are checked inside each handler.
router.use(protect, staffOnly, requireTenantFeature("purchase_orders"), checkPermission("Purchase Orders"));

router.get("/settings", getPoSettings);
router.put("/settings", updatePoSettings);
// Q2: a customer's price level (End user / Distributor) — the selling-price floor.
router.put("/settings/price-level", setCustomerPriceLevel);

// PO Items: the module's own item list + price master (not the CRM Items module).
// Writes need "Manage Prices" (checked in the handlers).
router.get("/items", listPoItems);
router.get("/items/export", exportPoItems);
router.get("/items/categories", listPoItemCategories);
// S1: series (price-list sheets) with item counts + the default series.
router.get("/items/series", listPoItemSeries);
// R3: the Brady price list (all sheets) — scan, preview, import in batches.
router.post("/items/pricelist/scan", scanPriceList);
router.post("/items/pricelist/preview", previewPriceList);
router.post("/items/pricelist/import", importPriceList);
// Round 30 (S6): the whole price list as a reference + "+ Add Catalog No."
router.post("/items/pricelist/reference", saveReference);
router.get("/items/pricelist/reference", referenceStatus);
router.post("/items/catalog/find", findCatalogs);
router.post("/items/catalog/add", addCatalogs);
router.post("/items", createPoItem);
router.post("/items/import/preview", previewPoItems);
router.post("/items/import", importPoItems);
router.put("/items/:itemId", updatePoItem);
router.delete("/items/:itemId", deletePoItem);

router.get("/stats", getStats);
// S3: read the customer's PO file → matched lines for the editor (nothing saved).
router.post("/customer-po/read", customerPoReadUpload, readCustomerPo);
router.get("/approvals/pending", getPendingApprovals);

// R5: Proforma invoices (made from an approved Purchase PO, for its customer).
router.get("/proformas", listProformas);
router.get("/proformas/:pid", getProforma);
router.get("/proformas/:pid/print", getProformaPrint);
router.put("/proformas/:pid", updateProforma);
router.post("/proformas/:pid/cancel", cancelProforma);
router.post("/proformas/:pid/whatsapp", poPdfUpload, sendProformaWhatsApp);

router.get("/", listPurchaseOrders);
router.post("/", createPurchaseOrder);
router.get("/:id", getPurchaseOrder);
// R4: data for the PO PDF — only after the approver's Yes (else 400).
router.get("/:id/print", getPrintData);
router.put("/:id", updatePurchaseOrder);
router.delete("/:id", deletePurchaseOrder);
router.post("/:id/submit", submitPurchaseOrder);
router.post("/:id/approve", approvePurchaseOrder);
router.post("/:id/reject", rejectPurchaseOrder);
router.post("/:id/status", changeStatus);
router.post("/:id/whatsapp", poPdfUpload, sendOnWhatsApp);
router.post("/:id/customer-po-file", customerPoUpload, uploadCustomerPoFile);
// R5: "Create Proforma Invoice" from an approved Purchase PO.
router.post("/:id/proforma", createProforma);

module.exports = router;
