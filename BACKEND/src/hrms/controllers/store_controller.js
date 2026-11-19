const Store = require("../models/store_model");

// Create store/branch
exports.createStore = async (req, res) => {
  try {
    // Scope to the requester's own tenant — never trust a client-supplied tenant_id
    const body = { ...req.body };
    body.tenant_id = req.user?.is_superadmin ? (req.body.tenant_id || null) : (req.user?.tenant_id || null);

    const store = new Store(body);
    await store.save();
    res.status(201).json({ success: true, data: store });
  } catch (error) {
    res.status(400).json({ success: false, message: error.message });
  }
};

// Get all stores/branches with search and pagination
exports.getStores = async (req, res) => {
  try {
    if (!req.user?.is_superadmin && !req.user?.tenant_id) {
      return res.status(200).json({
        success: true,
        data: [],
        pagination: { total: 0, page: 1, limit: 10, totalPages: 0 },
        stats: { total: 0, active: 0, warehouses: 0 },
      });
    }

    const {
      page = 1,
      limit = 10,
      search = "",
      field = "name",
      state = "",
      city = "",
      category = "",
      orderBy = "name"
    } = req.query;

    // Scope to the requester's own tenant — see auth_middleware.js's `protect`, which
    // resolves req.user.tenant_id for both the CRM-staff-bridged and native HRMS login paths.
    const tenantFilter = { tenant_id: req.user.is_superadmin ? null : req.user.tenant_id };

    const query = { ...tenantFilter };

    // Text Search
    if (search) {
      query[field] = { $regex: search, $options: "i" };
    }

    // Location Filters
    if (state && state !== "all") {
      query.state = state;
    }
    if (city && city !== "all") {
      query.city = city;
    }

    // Category Filter
    if (category && category !== "all") {
      query.branchCategory = category;
    }

    const total = await Store.countDocuments(query);

    const stats = {
      total: await Store.countDocuments(tenantFilter),
      active: await Store.countDocuments({ ...tenantFilter, status: "Active" }),
      warehouses: await Store.countDocuments({
        ...tenantFilter,
        $or: [
          { isWarehouse: true },
          { branchCategory: "Warehouse" }
        ]
      }),
    };

    // Sort mapping
    const sortObj = {};
    if (orderBy === "name") sortObj.name = 1;
    else if (orderBy === "code") sortObj.shortName = 1;
    else sortObj.createdAt = -1;

    const stores = await Store.find(query)
      .sort(sortObj)
      .limit(limit * 1)
      .skip((page - 1) * limit)
      .exec();

    res.status(200).json({
      success: true,
      data: stores,
      pagination: {
        total,
        page: parseInt(page),
        limit: parseInt(limit),
        totalPages: Math.ceil(total / limit)
      },
      stats
    });
  } catch (error) {
    res.status(500).json({ success: false, message: error.message });
  }
};

// Get single store/branch
exports.getStoreById = async (req, res) => {
  try {
    const tenantFilter = { tenant_id: req.user?.is_superadmin ? null : (req.user?.tenant_id || null) };
    const store = await Store.findOne({ _id: req.params.id, ...tenantFilter });
    if (!store)
      return res.status(404).json({ success: false, message: "Branch not found" });
    res.status(200).json({ success: true, data: store });
  } catch (error) {
    res.status(500).json({ success: false, message: error.message });
  }
};

// Update store/branch
exports.updateStore = async (req, res) => {
  try {
    const body = { ...req.body };
    delete body.tenant_id; // never reassignable via this endpoint

    const tenantFilter = { tenant_id: req.user?.is_superadmin ? null : (req.user?.tenant_id || null) };
    const store = await Store.findOneAndUpdate({ _id: req.params.id, ...tenantFilter }, body, {
      returnDocument: 'after',
      runValidators: true,
    });
    if (!store)
      return res.status(404).json({ success: false, message: "Branch not found" });
    res.status(200).json({ success: true, data: store });
  } catch (error) {
    res.status(400).json({ success: false, message: error.message });
  }
};

// Delete store/branch
exports.deleteStore = async (req, res) => {
  try {
    const tenantFilter = { tenant_id: req.user?.is_superadmin ? null : (req.user?.tenant_id || null) };
    const store = await Store.findOneAndDelete({ _id: req.params.id, ...tenantFilter });
    if (!store)
      return res.status(404).json({ success: false, message: "Branch not found" });
    res.status(200).json({ success: true, message: "Branch deleted successfully" });
  } catch (error) {
    res.status(500).json({ success: false, message: error.message });
  }
};
