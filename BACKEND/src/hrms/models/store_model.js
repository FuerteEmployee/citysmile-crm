const mongoose = require("mongoose");

const storeSchema = new mongoose.Schema(
  {
    name: { type: String, required: true }, // Branch Name
    shortName: { type: String, unique: true },
    allowTransactionSince: { type: String },
    accountGroup: { type: mongoose.Schema.Types.ObjectId, ref: "AccountGroup" },
    branchCategory: { type: String, default: "General" },
    openedOn: { type: String },
    status: { type: String, enum: ["Active", "Inactive"], default: "Active" },

    // Address Info Tab
    addressLine1: { type: String },
    addressLine2: { type: String },
    addressLine3: { type: String },
    pincode: { type: String },
    city: { type: String },
    state: { type: String },
    mobile: { type: String },
    phone1: { type: String },
    email: { type: String },
    fax: { type: String },
    otherInfo: { type: String },
    areaSqFt: { type: String }, // Area(Sq.ft)

    // Others1 Tab (Statutory & Limits)
    lstNo: { type: String },
    cstNo: { type: String },
    gstin: { type: String },
    taxClassInward: { type: String },
    branchType: { type: String }, // Type
    stockTransferCreditLimit: { type: String },
    cashLimit: { type: String },
    pan: { type: String },
    taxClassOutward: { type: String },

    // Others2 Tab (Templates & Validation)
    purchasePriceTemplate: { type: String },
    salesPriceTemplate: { type: String },
    validate2ndMinSellingPrice: { type: String },
    validateMaxExchangePurcDCPrice: { type: String },
    validateMinSellingPrice: { type: String },
    validateMaxSellingPrice: { type: String },
    validateMaxPurchasesPrice: { type: String },
    internalStockTransferPriceTemplate: { type: String },

    // Others3 Tab (Company & Accounts)
    branchCompanyName: { type: String },
    sisTemplate: { type: String },
    outwardAccount: { type: String },
    companyGroup: { type: String },
    sisDealer: { type: String },
    inwardAccount: { type: String },

    // Others4 Tab (Payments)
    merchantId: { type: String },
    terminalId: { type: String },

    // Legacy fields for compatibility
    location: { type: String },
    description: { type: String },
    image: { type: String },
    isWarehouse: { type: Boolean, default: false },
    isActive: { type: Boolean, default: true },

    // Scopes this store/branch to one tenant deployment (see hrms_branch_model.js's
    // identical field) — every controller reading/writing stores must filter by
    // this so different tenants sharing this backend never see each other's stores.
    tenant_id: { type: mongoose.Schema.Types.ObjectId, ref: "Tenant", default: null, index: true },
  },
  { timestamps: true },
);

// Performance Indexes
storeSchema.index({ name: 1 });
storeSchema.index({ phone1: 1 });
storeSchema.index({ gstin: 1 });
storeSchema.index({ pan: 1 });

const Store = (mongoose.models["Store"] || mongoose.model("Store", storeSchema));

module.exports = Store;
