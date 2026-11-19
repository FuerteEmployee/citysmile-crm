const ManagingCompany = require("../models/managing_company_model");
const User = require("../models/user_model");
const SalarySettlementRecord = require("../models/salary_settlement_record_model");

/**
 * List all managing companies
 */
exports.getCompanies = async (req, res) => {
  try {
    const { active } = req.query;
    const query = { tenant_id: req.user?.is_superadmin ? null : (req.user?.tenant_id || null) };
    if (active !== undefined) {
      query.active = active === "true" || active === true;
    }

    const companies = await ManagingCompany.find(query).sort({ name: 1 });

    res.json({
      success: true,
      count: companies.length,
      data: companies,
    });
  } catch (error) {
    res.status(500).json({
      success: false,
      message: error.message || "Failed to fetch managing companies",
    });
  }
};

/**
 * Get a single managing company by ID
 */
exports.getCompanyById = async (req, res) => {
  try {
    const tenantFilter = { tenant_id: req.user?.is_superadmin ? null : (req.user?.tenant_id || null) };
    const company = await ManagingCompany.findOne({ _id: req.params.id, ...tenantFilter });
    if (!company) {
      return res.status(404).json({
        success: false,
        message: "Managing company not found",
      });
    }

    res.json({
      success: true,
      data: company,
    });
  } catch (error) {
    res.status(500).json({
      success: false,
      message: error.message || "Failed to fetch managing company",
    });
  }
};

/**
 * Create a new managing company
 */
exports.createCompany = async (req, res) => {
  try {
    const { name, active } = req.body;

    if (!name || !name.trim()) {
      return res.status(400).json({
        success: false,
        message: "Company name is required",
      });
    }

    const tenantFilter = { tenant_id: req.user?.is_superadmin ? null : (req.user?.tenant_id || null) };

    // Check if already exists (unique constraint)
    const existing = await ManagingCompany.findOne({
      name: { $regex: `^${name}$`, $options: "i" },
      ...tenantFilter,
    });
    if (existing) {
      return res.status(409).json({
        success: false,
        message: "A managing company with this name already exists",
      });
    }

    const company = new ManagingCompany({
      name: name.trim(),
      active: active !== false,
      tenant_id: req.user?.is_superadmin ? (req.body.tenant_id || null) : (req.user?.tenant_id || null),
    });

    await company.save();

    res.status(201).json({
      success: true,
      message: "Managing company created",
      data: company,
    });
  } catch (error) {
    res.status(400).json({
      success: false,
      message: error.message || "Failed to create managing company",
    });
  }
};

/**
 * Update a managing company
 */
exports.updateCompany = async (req, res) => {
  try {
    const { id } = req.params;
    const { name, active } = req.body;
    const tenantFilter = { tenant_id: req.user?.is_superadmin ? null : (req.user?.tenant_id || null) };

    const company = await ManagingCompany.findOne({ _id: id, ...tenantFilter });
    if (!company) {
      return res.status(404).json({
        success: false,
        message: "Managing company not found",
      });
    }

    // If name is being changed, check for uniqueness
    if (name && name.trim() && name !== company.name) {
      const existing = await ManagingCompany.findOne({
        _id: { $ne: id },
        name: { $regex: `^${name}$`, $options: "i" },
        ...tenantFilter,
      });
      if (existing) {
        return res.status(409).json({
          success: false,
          message: "A managing company with this name already exists",
        });
      }
      company.name = name.trim();
    }

    if (active !== undefined) {
      company.active = active;
    }

    await company.save();

    res.json({
      success: true,
      message: "Managing company updated",
      data: company,
    });
  } catch (error) {
    res.status(400).json({
      success: false,
      message: error.message || "Failed to update managing company",
    });
  }
};

/**
 * Hard-delete a managing company — only when nothing references it.
 * Referenced companies must be deactivated instead, so employee
 * assignments and settlement history never point at a missing record.
 */
exports.deleteCompany = async (req, res) => {
  try {
    const { id } = req.params;
    const tenantFilter = { tenant_id: req.user?.is_superadmin ? null : (req.user?.tenant_id || null) };
    const company = await ManagingCompany.findOne({ _id: id, ...tenantFilter });
    if (!company) {
      return res.status(404).json({
        success: false,
        message: "Managing company not found",
      });
    }

    const [userCount, settlementCount] = await Promise.all([
      User.countDocuments({ managingCompanyId: id }),
      SalarySettlementRecord.countDocuments({ managingCompanyId: id }),
    ]);

    if (userCount > 0 || settlementCount > 0) {
      return res.status(409).json({
        success: false,
        message: `Cannot delete "${company.name}" — assigned to ${userCount} employee(s) and referenced by ${settlementCount} settlement record(s).`,
      });
    }

    await company.deleteOne();

    res.json({
      success: true,
      message: "Managing company deleted",
    });
  } catch (error) {
    res.status(400).json({
      success: false,
      message: error.message || "Failed to delete managing company",
    });
  }
};

/**
 * Deactivate a managing company
 */
exports.deactivateCompany = async (req, res) => {
  try {
    const tenantFilter = { tenant_id: req.user?.is_superadmin ? null : (req.user?.tenant_id || null) };
    const company = await ManagingCompany.findOneAndUpdate(
      { _id: req.params.id, ...tenantFilter },
      { active: false },
      { new: true }
    );

    if (!company) {
      return res.status(404).json({
        success: false,
        message: "Managing company not found",
      });
    }

    res.json({
      success: true,
      message: "Managing company deactivated",
      data: company,
    });
  } catch (error) {
    res.status(400).json({
      success: false,
      message: error.message || "Failed to deactivate managing company",
    });
  }
};
