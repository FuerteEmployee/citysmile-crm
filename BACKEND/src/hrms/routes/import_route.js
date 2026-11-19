const express = require("express");
const router = express.Router();
const multer = require("multer");

// Controllers
const employeeImportController = require("../controllers/import_employees_controller");
const centralImportController = require("../controllers/import_controller");
const { protect } = require("../middleware/auth_middleware");

router.use(protect);

const storage = multer.memoryStorage();
const upload = multer({ storage, limits: { fileSize: 100 * 1024 * 1024 } }); // 100 MB cap for large Excel files

// Employee Import
router.post("/bulk", upload.single("file"), employeeImportController.bulkImportEmployees);

// Masters Bulk Imports
router.post("/items", upload.single("file"), centralImportController.importItems);
router.post("/customers", upload.single("file"), centralImportController.importCustomers);
router.post("/financiers", upload.single("file"), centralImportController.importFinanciers);
router.post("/suppliers", upload.single("file"), centralImportController.importSuppliers);
router.post("/account-masters", upload.single("file"), centralImportController.importAccountMasters);
router.post("/branches", upload.single("file"), centralImportController.importBranches);
router.post("/purchase-bills", upload.single("file"), centralImportController.importPurchaseBills);
router.post("/sales-bills", upload.single("file"), centralImportController.importSalesBills);
router.post("/update-sales-dates", upload.single("file"), centralImportController.updateSalesDates);
router.post("/leads", upload.single("file"), centralImportController.importLeads);

module.exports = router;
