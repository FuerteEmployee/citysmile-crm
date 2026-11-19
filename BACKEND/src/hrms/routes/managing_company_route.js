const express = require("express");
const router = express.Router();
const managingCompanyController = require("../controllers/managing_company_controller");
const { protect } = require("../middleware/auth_middleware");

router.use(protect);

// List all managing companies
router.get("/", managingCompanyController.getCompanies);

// Get a single managing company
router.get("/:id", managingCompanyController.getCompanyById);

// Create a managing company
router.post("/", managingCompanyController.createCompany);

// Update a managing company
router.put("/:id", managingCompanyController.updateCompany);

// Deactivate a managing company
router.patch("/:id/deactivate", managingCompanyController.deactivateCompany);

// Hard-delete a managing company (blocked while referenced)
router.delete("/:id", managingCompanyController.deleteCompany);

module.exports = router;
