const FactoryLocation = require("../models/FactoryLocation");

// Seed 3 default placeholder locations for a tenant if none exist
const ensureDefaultLocations = async (tenantId) => {
  const count = await FactoryLocation.countDocuments({ tenant_id: tenantId });
  if (count === 0) {
    await FactoryLocation.insertMany([
      {
        name: "Factory Location 1",
        code: "LOC-1",
        address: "Unit 1",
        isDefault: true,
        isActive: true,
        tenant_id: tenantId,
      },
      {
        name: "Factory Location 2",
        code: "LOC-2",
        address: "Unit 2",
        isDefault: false,
        isActive: true,
        tenant_id: tenantId,
      },
      {
        name: "Factory Location 3",
        code: "LOC-3",
        address: "Unit 3",
        isDefault: false,
        isActive: true,
        tenant_id: tenantId,
      },
    ]);
  }
};

// GET /api/locations
const listLocations = async (req, res) => {
  try {
    // No automatic static dummy seeding — tenant creates actual locations or links from HRMS

    const filter = { tenant_id: req.user.tenant_id };
    if (!req.query.includeInactive) {
      filter.isActive = true;
    }

    const locations = await FactoryLocation.find(filter).populate("hrmsBranchId", "name code addressLine1 city state").sort({ code: 1 }).lean();
    return res.json({ success: true, count: locations.length, locations });
  } catch (error) {
    return res.status(500).json({ message: error.message });
  }
};

// POST /api/locations
const createLocation = async (req, res) => {
  try {
    const { name, code, address, isDefault } = req.body;

    if (!name || !code) {
      return res.status(400).json({ message: "Name and code are required" });
    }

    const cleanCode = String(code).trim().toUpperCase();
    const existing = await FactoryLocation.findOne({
      tenant_id: req.user.tenant_id,
      code: cleanCode,
    });
    if (existing) {
      return res.status(409).json({ message: "Location code already exists" });
    }

    if (isDefault) {
      await FactoryLocation.updateMany(
        { tenant_id: req.user.tenant_id },
        { $set: { isDefault: false } }
      );
    }

    let hrmsBranchId = req.body.hrmsBranchId || null;
    if (!hrmsBranchId && req.body.createHrmsBranch) {
      try {
        const HRMSBranch = require("../hrms/models/hrms_branch_model");
        const existingBranch = await HRMSBranch.findOne({ tenant_id: req.user.tenant_id, name: String(name).trim() });
        if (existingBranch) {
          hrmsBranchId = existingBranch._id;
        } else {
          const newBranch = await HRMSBranch.create({
            name: String(name).trim(),
            code: cleanCode,
            addressLine1: address ? String(address).trim() : "",
            status: "Active",
            tenant_id: req.user.tenant_id,
          });
          hrmsBranchId = newBranch._id;
        }
      } catch (bErr) {
        console.warn("Could not create HRMS branch:", bErr.message);
      }
    }

    const location = await FactoryLocation.create({
      name: String(name).trim(),
      code: cleanCode,
      address: address ? String(address).trim() : "",
      isDefault: !!isDefault,
      hrmsBranchId,
      tenant_id: req.user.tenant_id,
    });

    return res.status(201).json({ success: true, location });
  } catch (error) {
    return res.status(500).json({ message: error.message });
  }
};

// PUT /api/locations/:id
const updateLocation = async (req, res) => {
  try {
    const { name, address, isActive, isDefault } = req.body;
    const location = await FactoryLocation.findOne({
      _id: req.params.id,
      tenant_id: req.user.tenant_id,
    });

    if (!location) {
      return res.status(404).json({ message: "Location not found" });
    }

    if (name) location.name = String(name).trim();
    if (req.body.hrmsBranchId !== undefined) location.hrmsBranchId = req.body.hrmsBranchId || null;
    if (address !== undefined) location.address = String(address).trim();
    if (isActive !== undefined) location.isActive = Boolean(isActive);

    if (isDefault) {
      await FactoryLocation.updateMany(
        { tenant_id: req.user.tenant_id },
        { $set: { isDefault: false } }
      );
      location.isDefault = true;
    }

    await location.save();
    return res.json({ success: true, location });
  } catch (error) {
    return res.status(500).json({ message: error.message });
  }
};

// DELETE /api/locations/:id
const deleteLocation = async (req, res) => {
  try {
    const loc = await FactoryLocation.findOneAndDelete({
      _id: req.params.id,
      tenant_id: req.user.tenant_id,
    });
    if (!loc) {
      return res.status(404).json({ message: "Location not found" });
    }
    return res.json({ success: true, message: "Location deleted successfully" });
  } catch (error) {
    return res.status(500).json({ message: error.message });
  }
};

module.exports = {
  ensureDefaultLocations,
  listLocations,
  createLocation,
  updateLocation,
  deleteLocation,
};

