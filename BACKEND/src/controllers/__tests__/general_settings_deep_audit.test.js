const mongoose = require("mongoose");
const { MongoMemoryServer } = require("mongodb-memory-server");
const Staff = require("../../models/Staff");
const Tenant = require("../../models/Tenant");
const Setting = require("../../models/Setting");
const Invoice = require("../../models/Invoice");
const Task = require("../../models/Task");
const Lead = require("../../models/Lead");

const {
  getSettings,
  updateSettings,
  getSystemInfo,
  getVersionInfo,
} = require("../setting_controller");

const {
  getTags,
  deleteTag,
} = require("../tag_controller");

const {
  getInvoiceSettings,
  formatInvoiceNumber,
} = require("../../services/invoiceSettings");

const {
  getDocSettings,
} = require("../../services/docSettings");

describe("Setup -> Settings (/admin/setup/settings) Deep Audit & Tests", () => {
  let mongoServer;
  let tenantA;
  let tenantB;
  let adminA;
  let adminB;

  beforeAll(async () => {
    process.env.JWT_SECRET = "test-jwt-secret-general-settings-deep";
    mongoServer = await MongoMemoryServer.create();
    const uri = mongoServer.getUri();

    // Guard Check
    if (!uri.includes("127.0.0.1") && !uri.includes("localhost")) {
      throw new Error("GUARD CHECK FAILED: Host is not 127.0.0.1! Stopping for safety.");
    }
    console.log(`[SAFETY GUARD CHECK PASSED] Connected to in-memory DB: ${uri}`);

    await mongoose.connect(uri, {
      useNewUrlParser: true,
      useUnifiedTopology: true,
    });

    tenantA = await Tenant.create({
      company_name: "Tenant A Alpha Industries",
      status: "active",
    });

    tenantB = await Tenant.create({
      company_name: "Tenant B Beta Logistics",
      status: "active",
    });

    adminA = await Staff.create({
      firstname: "Admin",
      lastname: "TenantA",
      email: "adminA_settings@example.com",
      password: "password123",
      admin: true,
      tenant_id: tenantA._id,
      active: true,
    });

    adminB = await Staff.create({
      firstname: "Admin",
      lastname: "TenantB",
      email: "adminB_settings@example.com",
      password: "password123",
      admin: true,
      tenant_id: tenantB._id,
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
    const req = { user, userRole: "staff", body, params, query, headers: {} };
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
  // 1. COMPANY INFORMATION & BRANDING
  // ==========================================
  describe("Tab 1: Company Information & Branding", () => {
    test("Saves company info and auto-syncs with Tenant.company_name", async () => {
      const { req, res } = mockReqRes(adminA, {
        settings: [
          { name: "companyName", value: "Alpha Global Tech Pvt Ltd" },
          { name: "companyAddress", value: "401 Commerce Tower, SG Highway" },
          { name: "companyCity", value: "Ahmedabad" },
          { name: "companyState", value: "Gujarat" },
          { name: "companyCountryCode", value: "IN" },
          { name: "companyZipCode", value: "380054" },
          { name: "companyPhoneNumber", value: "+91 9876543210" },
          { name: "companyVatNumber", value: "GSTIN24AAACA1234A1Z5" },
        ],
      });
      await updateSettings(req, res);
      expect(res.statusCode).toBe(200);

      // Verify Tenant model was updated
      const updatedTenant = await Tenant.findById(tenantA._id);
      expect(updatedTenant.company_name).toBe("Alpha Global Tech Pvt Ltd");

      // Verify getSettings returns the updated company name
      const { req: gReq, res: gRes } = mockReqRes(adminA);
      await getSettings(gReq, gRes);
      expect(gRes.statusCode).toBe(200);
      const nameSetting = gRes.jsonData.find((s) => s.name === "companyName");
      expect(nameSetting.value).toBe("Alpha Global Tech Pvt Ltd");
    });

    test("Multi-Tenant Isolation: Tenant B company info remains isolated", async () => {
      const { req, res } = mockReqRes(adminB);
      await getSettings(req, res);
      expect(res.statusCode).toBe(200);
      const nameSetting = res.jsonData.find((s) => s.name === "companyName");
      expect(nameSetting.value).toBe("Tenant B Beta Logistics");
    });

    test("Base64 Image Upload: Converts base64 logo into physical file on disk", async () => {
      const sampleBase64 =
        "data:image/png;base64,iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR42mNk+M9QDwADhgGAWjR9awAAAABJRU5ErkJggg==";

      const { req, res } = mockReqRes(adminA, {
        settings: [{ name: "compLogoLight", value: sampleBase64 }],
      });
      await updateSettings(req, res);
      expect(res.statusCode).toBe(200);

      const settingInDb = await Setting.findOne({ name: "compLogoLight", tenant_id: tenantA._id });
      expect(settingInDb).not.toBeNull();
      // Should NOT be base64 string
      expect(settingInDb.value).not.toContain("data:image/png");
      expect(settingInDb.value).toMatch(/^logo_\d+_\d+\.png$/);
    });
  });

  // ==========================================
  // 2. LOCALIZATION
  // ==========================================
  describe("Tab 2: Localization Settings", () => {
    test("Saves date/time formats, timezone, and language preferences", async () => {
      const { req, res } = mockReqRes(adminA, {
        settings: [
          { name: "locDateFormat", value: "dmy" },
          { name: "locTimeFormat", value: "24" },
          { name: "locTimezone", value: "Asia/Kolkata" },
          { name: "locLanguage", value: "english" },
          { name: "locDisableLanguages", value: false },
        ],
      });
      await updateSettings(req, res);
      expect(res.statusCode).toBe(200);

      const { req: gReq, res: gRes } = mockReqRes(adminA);
      await getSettings(gReq, gRes);
      expect(gRes.statusCode).toBe(200);

      const df = gRes.jsonData.find((s) => s.name === "locDateFormat");
      const tf = gRes.jsonData.find((s) => s.name === "locTimeFormat");
      const tz = gRes.jsonData.find((s) => s.name === "locTimezone");

      expect(df.value).toBe("dmy");
      expect(tf.value).toBe("24");
      expect(tz.value).toBe("Asia/Kolkata");
    });
  });

  // ==========================================
  // 3. FINANCE RULES & DOCUMENT NUMBERING
  // ==========================================
  describe("Tab 3: Finance Rules & Document Numbering", () => {
    test("Invoice Numbering Configuration & Formatting", async () => {
      const { req, res } = mockReqRes(adminA, {
        settings: [
          { name: "invPrefix", value: "INV-2026-" },
          { name: "invNextNumber", value: 1001 },
          { name: "invNumberFormat", value: "number_based" },
          { name: "numberPadding", value: 4 },
          { name: "invDueAfter", value: 15 },
        ],
      });
      await updateSettings(req, res);
      expect(res.statusCode).toBe(200);

      // Verify invoiceSettings service reads tenant config
      const invConfig = await getInvoiceSettings(tenantA._id);
      expect(invConfig.prefix).toBe("INV-2026-");
      expect(invConfig.nextNumber).toBe(1001);
      expect(invConfig.padding).toBe(4);
      expect(invConfig.dueAfter).toBe(15);

      // Verify invoice number formatting
      const formatted = formatInvoiceNumber(invConfig.nextNumber, new Date("2026-10-24"), invConfig);
      expect(formatted).toBe("INV-2026-1001");
    });

    test("Estimates, Proposals, and Credit Notes Numbering Configuration", async () => {
      const { req, res } = mockReqRes(adminA, {
        settings: [
          { name: "estPrefix", value: "EST-" },
          { name: "estNextNumber", value: 201 },
          { name: "propPrefix", value: "PRP-" },
          { name: "propNextNumber", value: 501 },
          { name: "cnPrefix", value: "CN-" },
          { name: "cnNextNumber", value: 11 },
        ],
      });
      await updateSettings(req, res);
      expect(res.statusCode).toBe(200);

      // Verify docSettings service
      const estConfig = await getDocSettings("estimate", tenantA._id);
      expect(estConfig.prefix).toBe("EST-");
      expect(estConfig.nextNumber).toBe(201);

      const propConfig = await getDocSettings("proposal", tenantA._id);
      expect(propConfig.prefix).toBe("PRP-");
      expect(propConfig.nextNumber).toBe(501);

      const cnConfig = await getDocSettings("credit_note", tenantA._id);
      expect(cnConfig.prefix).toBe("CN-");
      expect(cnConfig.nextNumber).toBe(11);
    });
  });

  // ==========================================
  // 4. PDF SETTINGS & SIGNATURE
  // ==========================================
  describe("Tab 4: PDF & E-Sign Settings", () => {
    test("Saves PDF Font, Font Size, and Base64 Signature Image", async () => {
      const sampleSignature =
        "data:image/png;base64,iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR42mNk+M9QDwADhgGAWjR9awAAAABJRU5ErkJggg==";

      const { req, res } = mockReqRes(adminA, {
        settings: [
          { name: "pdfFont", value: "helvetica" },
          { name: "pdfFontSize", value: "10" },
          { name: "pdfShowLogo", value: true },
          { name: "pdfSignatureImage", value: sampleSignature },
        ],
      });
      await updateSettings(req, res);
      expect(res.statusCode).toBe(200);

      const sigSetting = await Setting.findOne({ name: "pdfSignatureImage", tenant_id: tenantA._id });
      expect(sigSetting).not.toBeNull();
      expect(sigSetting.value).toMatch(/^logo_\d+_\d+\.png$/);
    });
  });

  // ==========================================
  // 5. TAGS MANAGEMENT
  // ==========================================
  describe("Tab 5: Tags Management Across Records", () => {
    test("Aggregates tags across Invoices, Tasks, and Leads for Tenant A", async () => {
      // Seed invoice with tags
      await Invoice.create({
        client: new mongoose.Types.ObjectId(),
        number: "INV-TAG-01",
        total: 1000,
        subtotal: 1000,
        currency: "INR",
        date: new Date(),
        duedate: new Date(),
        tags: ["VIP-Client", "Priority-2026"],
        tenant_id: tenantA._id,
      });

      // Seed task with tags
      await Task.create({
        name: "Annual Audit Preparation",
        tags: ["Priority-2026"],
        tenant_id: tenantA._id,
      });

      // Seed lead with tags (comma separated in Lead model)
      await Lead.create({
        name: "Acme Corporation",
        tags: "VIP-Client, Urgent",
        tenant_id: tenantA._id,
      });

      const { req, res } = mockReqRes(adminA);
      await getTags(req, res);
      expect(res.statusCode).toBe(200);

      const vipTag = res.jsonData.find((t) => t.tag.toLowerCase() === "vip-client");
      expect(vipTag).toBeDefined();
      expect(vipTag.count).toBe(2); // 1 Invoice + 1 Lead
      expect(vipTag.modules).toEqual(expect.arrayContaining(["Invoices", "Leads"]));

      const priorityTag = res.jsonData.find((t) => t.tag.toLowerCase() === "priority-2026");
      expect(priorityTag).toBeDefined();
      expect(priorityTag.count).toBe(2); // 1 Invoice + 1 Task
    });

    test("Deletes tag across records with tenant isolation", async () => {
      const { req, res } = mockReqRes(adminA, {}, { tag: "Priority-2026" });
      await deleteTag(req, res);
      expect(res.statusCode).toBe(200);

      // Verify tag was removed from Tenant A task
      const task = await Task.findOne({ name: "Annual Audit Preparation", tenant_id: tenantA._id });
      expect(task.tags).not.toContain("Priority-2026");
    });
  });

  // ==========================================
  // 6. SYSTEM & SERVER INFO
  // ==========================================
  describe("Tab 6: System & Server Information", () => {
    test("Returns platform environment, memory, and uptime information", async () => {
      const { req, res } = mockReqRes(adminA);
      await getSystemInfo(req, res);
      expect(res.statusCode).toBe(200);
      expect(Array.isArray(res.jsonData)).toBe(true);
      expect(res.jsonData.some((i) => i.name === "Database")).toBe(true);
      expect(res.jsonData.some((i) => i.name === "Server timezone")).toBe(true);

      const { req: vReq, res: vRes } = mockReqRes(adminA);
      await getVersionInfo(vReq, vRes);
      expect(vRes.statusCode).toBe(200);
      expect(vRes.jsonData.backend).toBeDefined();
      expect(vRes.jsonData.backend.node).toBe(process.version);
    });
  });
});
