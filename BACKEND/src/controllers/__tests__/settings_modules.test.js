const mongoose = require("mongoose");
const { MongoMemoryServer } = require("mongodb-memory-server");
const Setting = require("../../models/Setting");
const Tenant = require("../../models/Tenant");
const Staff = require("../../models/Staff");
const Role = require("../../models/Role");
const { getSettings, updateSettings, testEmail, testSms } = require("../setting_controller");
const emailService = require("../../services/EmailService");
const smsService = require("../../services/SmsService");
const nodemailer = require("nodemailer");
const axios = require("axios");

// Mock nodemailer and axios to safely test email and sms without making real external connections
jest.mock("nodemailer");
jest.mock("axios");

describe("Setup -> Settings Modules (Payment Gateways, Email/SMTP, SMS)", () => {
  let mongoServer;
  let tenantAId;
  let tenantBId;
  let mockSendMail;

  beforeAll(async () => {
    mongoServer = await MongoMemoryServer.create();
    const uri = mongoServer.getUri();
    
    // SAFETY GUARD: Must be 127.0.0.1 in-memory DB
    if (!uri.includes("127.0.0.1") && !uri.includes("localhost")) {
      throw new Error("GUARD CHECK FAILED: Host is not 127.0.0.1! Stopping for safety.");
    }
    console.log(`[SAFETY GUARD CHECK PASSED] Connected to in-memory DB: ${uri}`);

    await mongoose.connect(uri);

    // Create 2 tenants
    const tenantA = await Tenant.create({
      company_name: "Tenant A Tech",
      login_code: "tenant-a",
      status: "active"
    });
    tenantAId = tenantA._id;

    const tenantB = await Tenant.create({
      company_name: "Tenant B Retail",
      login_code: "tenant-b",
      status: "active"
    });
    tenantBId = tenantB._id;

    mockSendMail = jest.fn().mockResolvedValue({ messageId: "test-msg-123" });
    nodemailer.createTransport.mockReturnValue({
      sendMail: mockSendMail,
    });
  });

  afterAll(async () => {
    await mongoose.disconnect();
    if (mongoServer) {
      await mongoServer.stop();
    }
  });

  beforeEach(async () => {
    await Setting.deleteMany({});
    jest.clearAllMocks();
  });

  // =========================================================================
  // 1. UNIT TESTING
  // =========================================================================
  describe("1. UNIT TESTING", () => {
    test("Setting model: requires name and value, defaults tenant_id to null", async () => {
      const setting = new Setting({ name: "smtpHost", value: "smtp.example.com" });
      const saved = await setting.save();
      expect(saved._id).toBeDefined();
      expect(saved.tenant_id).toBeNull();
      expect(saved.name).toBe("smtpHost");
      expect(saved.value).toBe("smtp.example.com");
    });

    test("Setting model: enforces unique compound index on { name, tenant_id }", async () => {
      await Setting.create({ name: "smsTwilioSid", value: "SID1", tenant_id: tenantAId });
      
      let duplicateError = null;
      try {
        await Setting.create({ name: "smsTwilioSid", value: "SID2", tenant_id: tenantAId });
      } catch (err) {
        duplicateError = err;
      }
      expect(duplicateError).not.toBeNull();
      expect(duplicateError.code).toBe(11000);
    });

    test("EmailService: getTransporter parses port to number and checks SSL encryption flag", async () => {
      await Setting.create([
        { name: "smtpHost", value: "smtp.gmail.com", tenant_id: tenantAId },
        { name: "smtpPort", value: "465", tenant_id: tenantAId },
        { name: "smtpEncryption", value: "ssl", tenant_id: tenantAId },
        { name: "smtpUser", value: "user@gmail.com", tenant_id: tenantAId },
        { name: "smtpPass", value: "pass123", tenant_id: tenantAId },
      ]);

      await emailService.getTransporter(tenantAId);

      expect(nodemailer.createTransport).toHaveBeenCalledWith(
        expect.objectContaining({
          host: "smtp.gmail.com",
          port: 465,
          secure: true, // ssl is true
          auth: { user: "user@gmail.com", pass: "pass123" },
        })
      );
    });

    test("EmailService: falls back to 587 and secure: false when encryption is TLS", async () => {
      await Setting.create([
        { name: "smtpHost", value: "smtp.office365.com", tenant_id: tenantAId },
        { name: "smtpPort", value: "587", tenant_id: tenantAId },
        { name: "smtpEncryption", value: "tls", tenant_id: tenantAId },
      ]);

      await emailService.getTransporter(tenantAId);

      expect(nodemailer.createTransport).toHaveBeenCalledWith(
        expect.objectContaining({
          host: "smtp.office365.com",
          port: 587,
          secure: false, // tls is not ssl, so false
        })
      );
    });
  });

  // =========================================================================
  // 2. POSITIVE TESTING
  // =========================================================================
  describe("2. POSITIVE TESTING", () => {
    test("Positive: Superadmin saves global Payment Gateway settings", async () => {
      const req = {
        user: { is_superadmin: true, tenant_id: null },
        body: {
          settings: [
            { name: "stripeActive", value: true },
            { name: "stripePubKey", value: "pk_test_123456" },
            { name: "stripeSecretKey", value: "sk_test_654321" },
            { name: "stripeFixedFee", value: 10 },
            { name: "gateNotifyOnPayment", value: true },
            { name: "gateAllowModifyAmount", value: false }
          ]
        }
      };
      const res = {
        status: jest.fn().mockReturnThis(),
        json: jest.fn()
      };

      await updateSettings(req, res);
      expect(res.json).toHaveBeenCalledWith(expect.objectContaining({ message: "Settings updated successfully" }));

      const saved = await Setting.find({ tenant_id: null });
      expect(saved.length).toBe(6);
      const stripeKey = saved.find(s => s.name === "stripePubKey");
      expect(stripeKey.value).toBe("pk_test_123456");
    });

    test("Positive: Tenant A admin saves Email/SMTP settings", async () => {
      const req = {
        user: { is_superadmin: false, tenant_id: tenantAId },
        body: {
          settings: [
            { name: "smtpHost", value: "smtp.mailgun.org" },
            { name: "smtpPort", value: "587" },
            { name: "smtpUser", value: "postmaster@tenanta.com" },
            { name: "smtpPass", value: "secretkey" },
            { name: "smtpEmail", value: "info@tenanta.com" },
            { name: "smtpEncryption", value: "tls" }
          ]
        }
      };
      const res = { status: jest.fn().mockReturnThis(), json: jest.fn() };

      await updateSettings(req, res);
      expect(res.json).toHaveBeenCalledWith(expect.objectContaining({ message: "Settings updated successfully" }));

      const saved = await Setting.find({ tenant_id: tenantAId });
      expect(saved.length).toBe(6);
    });

    test("Positive: Tenant A sends test email when SMTP is configured", async () => {
      await Setting.create([
        { name: "smtpHost", value: "smtp.mailgun.org", tenant_id: tenantAId },
        { name: "smtpEmail", value: "info@tenanta.com", tenant_id: tenantAId },
      ]);

      const req = {
        user: { is_superadmin: false, tenant_id: tenantAId },
        headers: {},
        body: { email: "recipient@example.com" }
      };
      const res = { status: jest.fn().mockReturnThis(), json: jest.fn() };

      await testEmail(req, res);

      expect(res.json).toHaveBeenCalledWith({ message: "Test email sent successfully" });
      expect(mockSendMail).toHaveBeenCalledWith(
        expect.objectContaining({
          to: "recipient@example.com",
          from: expect.stringContaining("Tenant A Tech"),
          subject: expect.stringContaining("Test Email"),
        })
      );
    });

    test("Positive: Saving valid SMS Settings (Twilio configuration)", async () => {
      const req = {
        user: { is_superadmin: false, tenant_id: tenantAId },
        body: {
          settings: [
            { name: "smsTwilioSid", value: "AC_TEST_ACCOUNT_SID" },
            { name: "smsTwilioToken", value: "AUTH_TOKEN_SECRET" },
            { name: "smsTwilioPhone", value: "+1234567890" },
            { name: "smsTwilioActive", value: true },
            { name: "smsTriggerInvoiceOverdue", value: true }
          ]
        }
      };
      const res = { status: jest.fn().mockReturnThis(), json: jest.fn() };

      await updateSettings(req, res);
      expect(res.json).toHaveBeenCalledWith(expect.objectContaining({ message: "Settings updated successfully" }));

      const saved = await Setting.find({ tenant_id: tenantAId });
      expect(saved.find(s => s.name === "smsTwilioActive").value).toBe(true);
    });
  });

  // =========================================================================
  // 3. NEGATIVE TESTING
  // =========================================================================
  describe("3. NEGATIVE TESTING", () => {
    test("Negative: updateSettings returns 400 when body.settings is not an array", async () => {
      const req = {
        user: { is_superadmin: true, tenant_id: null },
        body: { settings: "invalid-string" }
      };
      const res = { status: jest.fn().mockReturnThis(), json: jest.fn() };

      await updateSettings(req, res);
      expect(res.status).toHaveBeenCalledWith(400);
      expect(res.json).toHaveBeenCalledWith({ message: "Invalid settings format" });
    });

    test("Negative: testEmail returns 400 when recipient email is missing", async () => {
      const req = {
        user: { is_superadmin: false, tenant_id: tenantAId },
        headers: {},
        body: {} // no email
      };
      const res = { status: jest.fn().mockReturnThis(), json: jest.fn() };

      await testEmail(req, res);
      expect(res.status).toHaveBeenCalledWith(400);
      expect(res.json).toHaveBeenCalledWith({ message: "Email is required" });
    });

    test("Negative: testEmail returns 400 when SMTP host is not configured", async () => {
      const req = {
        user: { is_superadmin: false, tenant_id: tenantAId },
        headers: {},
        body: { email: "test@example.com" }
      };
      const res = { status: jest.fn().mockReturnThis(), json: jest.fn() };

      await testEmail(req, res);
      expect(res.status).toHaveBeenCalledWith(400);
      expect(res.json).toHaveBeenCalledWith(
        expect.objectContaining({
          message: expect.stringContaining("SMTP not configured"),
        })
      );
    });

    test("Negative: SMS Multiple Active Gateways returns 400 error enforcing single active rule", async () => {
      const req = {
        user: { is_superadmin: false, tenant_id: tenantAId },
        body: {
          settings: [
            { name: "smsClickatellActive", value: true },
            { name: "smsMsg91Active", value: true },
            { name: "smsTwilioActive", value: true }
          ]
        }
      };
      const res = { status: jest.fn().mockReturnThis(), json: jest.fn() };

      await updateSettings(req, res);
      expect(res.status).toHaveBeenCalledWith(400);
      expect(res.json).toHaveBeenCalledWith({ message: "Only 1 active SMS gateway is allowed at a time" });
    });

    test("Negative: Payment Gateway fee fields reject negative numbers with 400 error", async () => {
      const req = {
        user: { is_superadmin: false, tenant_id: tenantAId },
        body: {
          settings: [
            { name: "stripeFixedFee", value: -50 }
          ]
        }
      };
      const res = { status: jest.fn().mockReturnThis(), json: jest.fn() };

      await updateSettings(req, res);
      expect(res.status).toHaveBeenCalledWith(400);
      expect(res.json).toHaveBeenCalledWith({ message: 'Field "stripeFixedFee" cannot be a negative number' });
    });

    test("Negative & Security: Script injection strings in gateway and SMTP fields are sanitized", async () => {
      const maliciousPayload = "<script>alert('xss')</script>CleanText";
      const req = {
        user: { is_superadmin: false, tenant_id: tenantAId },
        body: {
          settings: [
            { name: "stripeLabel", value: maliciousPayload }
          ]
        }
      };
      const res = { status: jest.fn().mockReturnThis(), json: jest.fn() };

      await updateSettings(req, res);

      const saved = await Setting.findOne({ tenant_id: tenantAId, name: "stripeLabel" });
      expect(saved.value).toBe("CleanText");
      expect(saved.value).not.toContain("<script>");
    });

    test("Negative: testSms returns 400 when phone number is missing", async () => {
      const req = {
        user: { is_superadmin: false, tenant_id: tenantAId },
        headers: {},
        body: {}
      };
      const res = { status: jest.fn().mockReturnThis(), json: jest.fn() };

      await testSms(req, res);
      expect(res.status).toHaveBeenCalledWith(400);
      expect(res.json).toHaveBeenCalledWith({ message: "Phone number is required" });
    });

    test("Negative: testSms returns 400 when no SMS gateway is active", async () => {
      const req = {
        user: { is_superadmin: false, tenant_id: tenantAId },
        headers: {},
        body: { phone: "+919876543210" }
      };
      const res = { status: jest.fn().mockReturnThis(), json: jest.fn() };

      await testSms(req, res);
      expect(res.status).toHaveBeenCalledWith(400);
      expect(res.json).toHaveBeenCalledWith(
        expect.objectContaining({
          message: expect.stringContaining("No active SMS gateway configured"),
        })
      );
    });

    test("Positive: testSms sends SMS when Twilio gateway is active", async () => {
      await Setting.create([
        { name: "smsTwilioSid", value: "AC_TEST_123", tenant_id: tenantAId },
        { name: "smsTwilioToken", value: "AUTH_TOKEN_123", tenant_id: tenantAId },
        { name: "smsTwilioPhone", value: "+1234567890", tenant_id: tenantAId },
        { name: "smsTwilioActive", value: true, tenant_id: tenantAId },
      ]);

      axios.post.mockResolvedValueOnce({ data: { sid: "SM_TEST_MSG_SID" } });

      const req = {
        user: { is_superadmin: false, tenant_id: tenantAId },
        headers: {},
        body: { phone: "+919876543210" }
      };
      const res = { status: jest.fn().mockReturnThis(), json: jest.fn() };

      await testSms(req, res);
      expect(res.json).toHaveBeenCalledWith({ message: "Test SMS sent successfully" });
      expect(axios.post).toHaveBeenCalled();
    });
  });

  // =========================================================================
  // 4. INTEGRATION TESTING
  // =========================================================================
  describe("4. INTEGRATION TESTING", () => {
    test("Tenant Isolation: Tenant A settings never leak into Tenant B", async () => {
      // Tenant A configures its private Stripe keys and SMTP
      await Setting.create([
        { name: "stripeSecretKey", value: "sk_live_TENANT_A_SECRET", tenant_id: tenantAId },
        { name: "smtpUser", value: "admin@tenanta.com", tenant_id: tenantAId },
        { name: "smsTwilioToken", value: "TOKEN_A", tenant_id: tenantAId }
      ]);

      // Tenant B requests settings
      const reqB = {
        user: { is_superadmin: false, tenant_id: tenantBId },
        headers: {},
        query: {}
      };
      const resB = { status: jest.fn().mockReturnThis(), json: jest.fn() };

      await getSettings(reqB, resB);

      const returnedSettings = resB.json.mock.calls[0][0];
      const foundStripe = returnedSettings.find(s => s.name === "stripeSecretKey");
      const foundSmtp = returnedSettings.find(s => s.name === "smtpUser");
      const foundTwilio = returnedSettings.find(s => s.name === "smsTwilioToken");

      // Tenant B should NOT see Tenant A's private keys!
      expect(foundStripe).toBeUndefined();
      expect(foundSmtp).toBeUndefined();
      expect(foundTwilio).toBeUndefined();
    });

    test("Global Fallback: Tenant inherits global settings if not overridden", async () => {
      // Super admin sets global gateway notifications and default email charset
      await Setting.create([
        { name: "gateNotifyOnPayment", value: true, tenant_id: null },
        { name: "emailCharset", value: "utf-8", tenant_id: null }
      ]);

      // Tenant A fetches settings without defining its own
      const reqA = {
        user: { is_superadmin: false, tenant_id: tenantAId },
        headers: {},
        query: {}
      };
      const resA = { status: jest.fn().mockReturnThis(), json: jest.fn() };

      await getSettings(reqA, resA);

      const returnedSettings = resA.json.mock.calls[0][0];
      const gateNotify = returnedSettings.find(s => s.name === "gateNotifyOnPayment");
      const charset = returnedSettings.find(s => s.name === "emailCharset");

      expect(gateNotify.value).toBe(true);
      expect(charset.value).toBe("utf-8");
    });

    test("Unauthenticated user security: Private SMTP, SMS, and Gateway credentials are stripped from public GET /api/settings", async () => {
      // Global settings hold sensitive credentials
      await Setting.create([
        { name: "smtpPass", value: "super_secret_smtp_password", tenant_id: null },
        { name: "stripeSecretKey", value: "sk_live_stripe_secret", tenant_id: null },
        { name: "smsTwilioToken", value: "twilio_secret_token", tenant_id: null },
        { name: "companyName", value: "Platform Inc.", tenant_id: null }
      ]);

      // Unauthenticated request
      const req = {
        user: null, // unauthenticated
        headers: {},
        query: {}
      };
      const res = { status: jest.fn().mockReturnThis(), json: jest.fn() };

      await getSettings(req, res);

      const returnedList = res.json.mock.calls[0][0];
      
      // Crucial security verification:
      expect(returnedList.some(s => s.name === "smtpPass")).toBe(false);
      expect(returnedList.some(s => s.name === "stripeSecretKey")).toBe(false);
      expect(returnedList.some(s => s.name === "smsTwilioToken")).toBe(false);
    });

    test("EmailService: Priority override prefers Tenant.company_name over stale Setting.companyName row", async () => {
      // Stale companyName in Setting collection says "Old Fuerte CRM"
      await Setting.create([
        { name: "companyName", value: "Old Fuerte CRM", tenant_id: tenantAId },
        { name: "smtpHost", value: "smtp.mailgun.org", tenant_id: tenantAId },
        { name: "smtpEmail", value: "noreply@tenanta.com", tenant_id: tenantAId },
      ]);

      // Call sendOtpCode
      await emailService.sendOtpCode("user@example.com", "998877", tenantAId);

      // Verify sender used Tenant A Tech (from Tenant model) instead of Old Fuerte CRM
      expect(mockSendMail).toHaveBeenCalledWith(
        expect.objectContaining({
          from: expect.stringContaining("Tenant A Tech"),
          to: "user@example.com"
        })
      );
    });
  });

  // =========================================================================
  // 5. FEATURE & ARCHITECTURAL CHECKS
  // =========================================================================
  describe("5. FEATURE & ARCHITECTURAL CHECKS", () => {
    test("Architectural Finding: Payment Gateways have no webhook routes or transaction models in Backend", () => {
      // Verify that backend routes does not mount gateway webhooks
      const fs = require("fs");
      const path = require("path");
      const routesDir = path.join(__dirname, "../..");
      const settingControllerPath = path.join(routesDir, "controllers/setting_controller.js");
      const content = fs.readFileSync(settingControllerPath, "utf-8");

      // settings controller only does generic key-value upsert
      expect(content).toContain("Setting.findOneAndUpdate");
      expect(content).not.toContain("stripe.webhooks.constructEvent");
      expect(content).not.toContain("paypal.payment.execute");
    });

    test("Architectural Finding: SMS Triggers in Database have no backend consumer/job", () => {
      // In Backend, search for SMS dispatcher: it does not exist
      const fs = require("fs");
      const path = require("path");
      const servicesDir = path.join(__dirname, "../../services");
      const files = fs.readdirSync(servicesDir);

      const hasSmsService = files.some(f => f.toLowerCase().includes("sms"));
      expect(hasSmsService).toBe(true); // SmsService.js now exists and is available!
    });
  });
});
