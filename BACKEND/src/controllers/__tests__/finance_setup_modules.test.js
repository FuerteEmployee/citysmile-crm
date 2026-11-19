const mongoose = require("mongoose");
const { MongoMemoryServer } = require("mongodb-memory-server");
const Staff = require("../../models/Staff");
const Tenant = require("../../models/Tenant");
const Role = require("../../models/Role");
const Tax = require("../../models/Tax");
const Currency = require("../../models/Currency");
const PaymentMode = require("../../models/PaymentMode");
const ExpenseCategory = require("../../models/ExpenseCategory");

const {
  getTaxes,
  createTax,
  updateTax,
  deleteTax,
  bulkCreateTax,
} = require("../tax_controller");

const {
  getCurrencies,
  createCurrency,
  updateCurrency,
  deleteCurrency,
  bulkCreateCurrency,
} = require("../currency_controller");

const {
  getPaymentModes,
  createPaymentMode,
  updatePaymentMode,
  deletePaymentMode,
  bulkCreatePaymentMode,
} = require("../payment_mode_controller");

const {
  getExpenseCategories,
  createExpenseCategory,
  updateExpenseCategory,
  deleteExpenseCategory,
  bulkCreateExpenseCategory,
} = require("../expense_category_controller");

const { checkPermission } = require("../../middleware/auth");

describe("Setup -> Finance Module Comprehensive Audit & Tests", () => {
  let mongoServer;
  let tenantA;
  let tenantB;
  let adminA;
  let adminB;
  let staffWithEdit;
  let staffWithViewOnly;
  let staffWithNoPerm;

  beforeAll(async () => {
    process.env.JWT_SECRET = "test-jwt-secret-finance-setup-999";
    mongoServer = await MongoMemoryServer.create();
    const uri = mongoServer.getUri();

    // Safety Guard: In-memory DB only
    if (!uri.includes("127.0.0.1") && !uri.includes("localhost")) {
      throw new Error("GUARD CHECK FAILED: Host is not 127.0.0.1! Stopping for safety.");
    }
    console.log(`[SAFETY GUARD CHECK PASSED] Connected to in-memory DB: ${uri}`);

    await mongoose.connect(uri, {
      useNewUrlParser: true,
      useUnifiedTopology: true,
    });

    tenantA = await Tenant.create({
      company_name: "Tenant A Finance Corp",
      status: "active",
    });

    tenantB = await Tenant.create({
      company_name: "Tenant B Global Ltd",
      status: "active",
    });

    adminA = await Staff.create({
      firstname: "Admin",
      lastname: "TenantA",
      email: "adminA_finance@example.com",
      password: "password123",
      admin: true,
      tenant_id: tenantA._id,
      active: true,
    });

    adminB = await Staff.create({
      firstname: "Admin",
      lastname: "TenantB",
      email: "adminB_finance@example.com",
      password: "password123",
      admin: true,
      tenant_id: tenantB._id,
      active: true,
    });

    const roleEdit = await Role.create({
      name: "Finance Manager",
      tenant_id: tenantA._id,
      permissions: {
        Settings: { "View(Global)": true, Edit: true },
      },
    });

    const roleViewOnly = await Role.create({
      name: "Finance Viewer",
      tenant_id: tenantA._id,
      permissions: {
        Settings: { "View(Global)": true, Edit: false },
      },
    });

    const roleNone = await Role.create({
      name: "No Finance Access",
      tenant_id: tenantA._id,
      permissions: {},
    });

    staffWithEdit = await Staff.create({
      firstname: "Editor",
      lastname: "Staff",
      email: "editor_staff@example.com",
      password: "password123",
      admin: false,
      role: roleEdit._id,
      tenant_id: tenantA._id,
      active: true,
    });

    staffWithViewOnly = await Staff.create({
      firstname: "Viewer",
      lastname: "Staff",
      email: "viewer_staff@example.com",
      password: "password123",
      admin: false,
      role: roleViewOnly._id,
      tenant_id: tenantA._id,
      active: true,
    });

    staffWithNoPerm = await Staff.create({
      firstname: "NoPerm",
      lastname: "Staff",
      email: "noperm_staff@example.com",
      password: "password123",
      admin: false,
      role: roleNone._id,
      tenant_id: tenantA._id,
      active: true,
    });
  });

  afterAll(async () => {
    await mongoose.disconnect();
    if (mongoServer) {
      await mongoServer.stop();
    }
  });

  const mockReqRes = (user, body = {}, params = {}, query = {}) => {
    const req = { user, userRole: "staff", body, params, query };
    const res = {
      statusCode: 200,
      jsonData: null,
      status(code) {
        this.statusCode = code;
        return this;
      },
      json(data) {
        this.jsonData = data;
        return this;
      },
    };
    return { req, res };
  };

  // ==========================================
  // 1. TAX RATES SUBMODULE TESTS
  // ==========================================
  describe("Submodule 1: Tax Rates", () => {
    let taxA1;

    test("Dynamic Creation: Valid tax rate saves properly in database", async () => {
      const { req, res } = mockReqRes(adminA, { name: "GST 18%", taxrate: 18 });
      await createTax(req, res);

      expect(res.statusCode).toBe(201);
      expect(res.jsonData.name).toBe("GST 18%");
      expect(res.jsonData.taxrate).toBe(18);
      expect(res.jsonData.tenant_id.toString()).toBe(tenantA._id.toString());
      taxA1 = res.jsonData;

      const fromDb = await Tax.findById(taxA1._id);
      expect(fromDb).not.toBeNull();
      expect(fromDb.name).toBe("GST 18%");
      expect(fromDb.taxrate).toBe(18);
    });

    test("Validation: Rejects negative tax rates or invalid numbers", async () => {
      const { req, res } = mockReqRes(adminA, { name: "Negative Tax", taxrate: -5 });
      await createTax(req, res);

      expect(res.statusCode).toBe(400);
      expect(res.jsonData.message).toMatch(/non-negative/i);
    });

    test("Validation: Rejects duplicate tax rate name in same tenant", async () => {
      const { req, res } = mockReqRes(adminA, { name: "GST 18%", taxrate: 18 });
      await createTax(req, res);

      expect(res.statusCode).toBe(400);
      expect(res.jsonData.message).toMatch(/already exists/i);
    });

    test("Multi-Tenant Isolation: Tenant B can create same tax rate name without collision", async () => {
      const { req, res } = mockReqRes(adminB, { name: "GST 18%", taxrate: 18 });
      await createTax(req, res);

      expect(res.statusCode).toBe(201);
      expect(res.jsonData.tenant_id.toString()).toBe(tenantB._id.toString());
    });

    test("Update Tax Rate: Successfully updates name and rate", async () => {
      const { req, res } = mockReqRes(
        adminA,
        { name: "GST 18% (Standard)", taxrate: 18.5 },
        { id: taxA1._id.toString() }
      );
      await updateTax(req, res);

      expect(res.statusCode).toBe(200);
      expect(res.jsonData.name).toBe("GST 18% (Standard)");
      expect(res.jsonData.taxrate).toBe(18.5);
    });

    test("Tenant Isolation on Update: Tenant B cannot update Tenant A's tax rate", async () => {
      const { req, res } = mockReqRes(
        adminB,
        { name: "Hacked Tax", taxrate: 0 },
        { id: taxA1._id.toString() }
      );
      await updateTax(req, res);

      expect(res.statusCode).toBe(404);
      const unchanged = await Tax.findById(taxA1._id);
      expect(unchanged.name).toBe("GST 18% (Standard)");
    });

    test("Bulk Create Taxes: Correctly parses and inserts multiple rates", async () => {
      const { req, res } = mockReqRes(adminA, {
        items: ["VAT 5%|5", "Luxury Tax 28%|28"],
      });
      await bulkCreateTax(req, res);

      expect(res.statusCode).toBe(201);
      expect(res.jsonData.length).toBe(2);
      expect(res.jsonData.map((t) => t.taxrate)).toEqual(expect.arrayContaining([5, 28]));
    });

    test("Tenant Isolation on Delete: Tenant B cannot delete Tenant A's tax rate", async () => {
      const { req, res } = mockReqRes(adminB, {}, { id: taxA1._id.toString() });
      await deleteTax(req, res);

      expect(res.statusCode).toBe(404);
      const existing = await Tax.findById(taxA1._id);
      expect(existing).not.toBeNull();
    });

    test("Delete Tax: Tenant A successfully deletes their tax rate", async () => {
      const { req, res } = mockReqRes(adminA, {}, { id: taxA1._id.toString() });
      await deleteTax(req, res);

      expect(res.statusCode).toBe(200);
      const fromDb = await Tax.findById(taxA1._id);
      expect(fromDb).toBeNull();
    });
  });

  // ==========================================
  // 2. CURRENCIES SUBMODULE TESTS
  // ==========================================
  describe("Submodule 2: Currencies", () => {
    let currUSD;
    let currINR;

    test("Dynamic Creation: Base currency created with default flag true", async () => {
      const { req, res } = mockReqRes(adminA, {
        name: "USD",
        symbol: "$",
        decimal_separator: ".",
        thousand_separator: ",",
        placement: "before",
        isdefault: true,
      });
      await createCurrency(req, res);

      expect(res.statusCode).toBe(201);
      expect(res.jsonData.name).toBe("USD");
      expect(res.jsonData.symbol).toBe("$");
      expect(res.jsonData.isdefault).toBe(true);
      currUSD = res.jsonData;

      const fromDb = await Currency.findById(currUSD._id);
      expect(fromDb).not.toBeNull();
      expect(fromDb.isdefault).toBe(true);
    });

    test("Default Currency Switching: Setting new default demotes previous default", async () => {
      const { req, res } = mockReqRes(adminA, {
        name: "INR",
        symbol: "₹",
        decimal_separator: ".",
        thousand_separator: ",",
        placement: "before",
        isdefault: true,
      });
      await createCurrency(req, res);

      expect(res.statusCode).toBe(201);
      expect(res.jsonData.name).toBe("INR");
      expect(res.jsonData.isdefault).toBe(true);
      currINR = res.jsonData;

      // Verify previous default USD was switched to false
      const usdInDb = await Currency.findById(currUSD._id);
      expect(usdInDb.isdefault).toBe(false);
    });

    test("Guard: Cannot delete base currency", async () => {
      const { req, res } = mockReqRes(adminA, {}, { id: currINR._id.toString() });
      await deleteCurrency(req, res);

      expect(res.statusCode).toBe(400);
      expect(res.jsonData.message).toMatch(/cannot delete base currency/i);
    });

    test("Tenant Isolation on Update: Tenant B cannot modify Tenant A's currency", async () => {
      const { req, res } = mockReqRes(
        adminB,
        { symbol: "HACK", isdefault: true },
        { id: currUSD._id.toString() }
      );
      await updateCurrency(req, res);

      expect(res.statusCode).toBe(404);
    });

    test("Multi-Tenant Currency Codes: Tenant B can create INR independently", async () => {
      const { req, res } = mockReqRes(adminB, {
        name: "INR",
        symbol: "₹",
        isdefault: true,
      });
      await createCurrency(req, res);

      expect(res.statusCode).toBe(201);
      expect(res.jsonData.tenant_id.toString()).toBe(tenantB._id.toString());
    });

    test("Delete Currency: Non-default currency can be deleted", async () => {
      const { req, res } = mockReqRes(adminA, {}, { id: currUSD._id.toString() });
      await deleteCurrency(req, res);

      expect(res.statusCode).toBe(200);
      const fromDb = await Currency.findById(currUSD._id);
      expect(fromDb).toBeNull();
    });
  });

  // ==========================================
  // 3. PAYMENT MODES SUBMODULE TESTS
  // ==========================================
  describe("Submodule 3: Payment Modes", () => {
    let modeStripe;

    test("Dynamic Creation: Valid payment mode with flags saves in DB", async () => {
      const { req, res } = mockReqRes(adminA, {
        name: "Stripe Online",
        description: "Credit card processing",
        active: true,
        show_on_pdf: true,
        selected_by_default: false,
        invoices_only: true,
        expenses_only: false,
      });
      await createPaymentMode(req, res);

      expect(res.statusCode).toBe(201);
      expect(res.jsonData.name).toBe("Stripe Online");
      expect(res.jsonData.active).toBe(true);
      expect(res.jsonData.show_on_pdf).toBe(true);
      expect(res.jsonData.invoices_only).toBe(true);
      modeStripe = res.jsonData;

      const fromDb = await PaymentMode.findById(modeStripe._id);
      expect(fromDb).not.toBeNull();
      expect(fromDb.name).toBe("Stripe Online");
    });

    test("Validation: Rejects empty payment mode name", async () => {
      const { req, res } = mockReqRes(adminA, { name: "   " });
      await createPaymentMode(req, res);

      expect(res.statusCode).toBe(400);
      expect(res.jsonData.message).toMatch(/name is required/i);
    });

    test("Validation: Duplicate check prevents duplicate payment mode in same tenant", async () => {
      const { req, res } = mockReqRes(adminA, { name: "Stripe Online" });
      await createPaymentMode(req, res);

      expect(res.statusCode).toBe(400);
      expect(res.jsonData.message).toMatch(/already exists/i);
    });

    test("Update Payment Mode: Active toggle and options update properly", async () => {
      const { req, res } = mockReqRes(
        adminA,
        { active: false, show_on_pdf: false },
        { id: modeStripe._id.toString() }
      );
      await updatePaymentMode(req, res);

      expect(res.statusCode).toBe(200);
      expect(res.jsonData.active).toBe(false);
      expect(res.jsonData.show_on_pdf).toBe(false);
    });

    test("Tenant Isolation on Update: Tenant B cannot edit Tenant A's payment mode", async () => {
      const { req, res } = mockReqRes(
        adminB,
        { name: "Hacked Mode" },
        { id: modeStripe._id.toString() }
      );
      await updatePaymentMode(req, res);

      expect(res.statusCode).toBe(404);
    });

    test("Bulk Create Payment Modes: Inserts multiple payment modes", async () => {
      const { req, res } = mockReqRes(adminA, {
        items: ["Bank Transfer", "PayPal Gateway"],
      });
      await bulkCreatePaymentMode(req, res);

      expect(res.statusCode).toBe(201);
      expect(res.jsonData.length).toBe(2);
    });

    test("Delete Payment Mode: Successfully deletes payment mode", async () => {
      const { req, res } = mockReqRes(adminA, {}, { id: modeStripe._id.toString() });
      await deletePaymentMode(req, res);

      expect(res.statusCode).toBe(200);
      const fromDb = await PaymentMode.findById(modeStripe._id);
      expect(fromDb).toBeNull();
    });
  });

  // ==========================================
  // 4. EXPENSE CATEGORIES SUBMODULE TESTS
  // ==========================================
  describe("Submodule 4: Expense Categories", () => {
    let catTravelA;

    test("Dynamic Creation: Valid expense category saves in DB", async () => {
      const { req, res } = mockReqRes(adminA, {
        name: "Travel & Fuel",
        description: "Flights, fuel, and lodging",
      });
      await createExpenseCategory(req, res);

      expect(res.statusCode).toBe(201);
      expect(res.jsonData.name).toBe("Travel & Fuel");
      expect(res.jsonData.description).toBe("Flights, fuel, and lodging");
      catTravelA = res.jsonData;

      const fromDb = await ExpenseCategory.findById(catTravelA._id);
      expect(fromDb).not.toBeNull();
      expect(fromDb.name).toBe("Travel & Fuel");
    });

    test("Validation: Rejects empty name", async () => {
      const { req, res } = mockReqRes(adminA, { name: "" });
      await createExpenseCategory(req, res);

      expect(res.statusCode).toBe(400);
      expect(res.jsonData.message).toMatch(/name is required/i);
    });

    test("Validation: Rejects duplicate expense category in same tenant", async () => {
      const { req, res } = mockReqRes(adminA, { name: "Travel & Fuel" });
      await createExpenseCategory(req, res);

      expect(res.statusCode).toBe(400);
      expect(res.jsonData.message).toMatch(/already exists/i);
    });

    test("Multi-Tenant Unique Isolation: Tenant B can create category with same name without collision", async () => {
      const { req, res } = mockReqRes(adminB, { name: "Travel & Fuel" });
      await createExpenseCategory(req, res);

      expect(res.statusCode).toBe(201);
      expect(res.jsonData.tenant_id.toString()).toBe(tenantB._id.toString());
    });

    test("Update Expense Category: Successfully updates description and name", async () => {
      const { req, res } = mockReqRes(
        adminA,
        { description: "Updated travel policy description" },
        { id: catTravelA._id.toString() }
      );
      await updateExpenseCategory(req, res);

      expect(res.statusCode).toBe(200);
      expect(res.jsonData.description).toBe("Updated travel policy description");
    });

    test("Tenant Isolation on Update & Delete: Tenant B cannot modify or delete Tenant A's category", async () => {
      const { req: updateReq, res: updateRes } = mockReqRes(
        adminB,
        { name: "Hacked" },
        { id: catTravelA._id.toString() }
      );
      await updateExpenseCategory(updateReq, updateRes);
      expect(updateRes.statusCode).toBe(404);

      const { req: delReq, res: delRes } = mockReqRes(adminB, {}, { id: catTravelA._id.toString() });
      await deleteExpenseCategory(delReq, delRes);
      expect(delRes.statusCode).toBe(404);

      const stillThere = await ExpenseCategory.findById(catTravelA._id);
      expect(stillThere).not.toBeNull();
    });

    test("Delete Expense Category: Tenant A deletes their category", async () => {
      const { req, res } = mockReqRes(adminA, {}, { id: catTravelA._id.toString() });
      await deleteExpenseCategory(req, res);

      expect(res.statusCode).toBe(200);
      const fromDb = await ExpenseCategory.findById(catTravelA._id);
      expect(fromDb).toBeNull();
    });
  });

  // ==========================================
  // 5. ROLE-BASED PERMISSIONS ON SETTINGS MODULE
  // ==========================================
  describe("Submodule 5: Settings / Finance Role Permissions", () => {
    test("Staff with Settings Edit permission can view and edit Finance setup", async () => {
      const viewMiddleware = checkPermission("Settings", "View");
      const editMiddleware = checkPermission("Settings", "Edit");

      let nextCalled = false;
      const { req: reqView, res: resView } = mockReqRes(staffWithEdit);
      await viewMiddleware(reqView, resView, () => {
        nextCalled = true;
      });
      expect(nextCalled).toBe(true);

      let editCalled = false;
      const { req: reqEdit, res: resEdit } = mockReqRes(staffWithEdit);
      await editMiddleware(reqEdit, resEdit, () => {
        editCalled = true;
      });
      expect(editCalled).toBe(true);
    });

    test("Staff with View-Only permission can view but is 403 Forbidden from editing", async () => {
      const viewMiddleware = checkPermission("Settings", "View");
      const editMiddleware = checkPermission("Settings", "Edit");

      let viewCalled = false;
      const { req: reqView, res: resView } = mockReqRes(staffWithViewOnly);
      await viewMiddleware(reqView, resView, () => {
        viewCalled = true;
      });
      expect(viewCalled).toBe(true);

      let editCalled = false;
      const { req: reqEdit, res: resEdit } = mockReqRes(staffWithEdit);
      const { req: reqEditForbidden, res: resEditForbidden } = mockReqRes(staffWithViewOnly);
      await editMiddleware(reqEditForbidden, resEditForbidden, () => {
        editCalled = true;
      });
      expect(editCalled).toBe(false);
      expect(resEditForbidden.statusCode).toBe(403);
    });

    test("Staff with No Settings permission is 403 Forbidden from viewing and editing", async () => {
      const viewMiddleware = checkPermission("Settings", "View");
      let viewCalled = false;
      const { req, res } = mockReqRes(staffWithNoPerm);
      await viewMiddleware(req, res, () => {
        viewCalled = true;
      });
      expect(viewCalled).toBe(false);
      expect(res.statusCode).toBe(403);
    });
  });
});
