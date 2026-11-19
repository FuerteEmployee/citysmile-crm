const mongoose = require("mongoose");
const { MongoMemoryServer } = require("mongodb-memory-server");
const Staff = require("../../models/Staff");
const Tenant = require("../../models/Tenant");
const Role = require("../../models/Role");
const Lead = require("../../models/Lead");
const LeadSource = require("../../models/LeadSource");
const LeadStatus = require("../../models/LeadStatus");
const Setting = require("../../models/Setting");
const WebsiteLeadForm = require("../../models/WebsiteLeadForm");

const {
  getLeadSources,
  createLeadSource,
  updateLeadSource,
  deleteLeadSource,
  bulkCreateSource,
} = require("../lead_source_controller");

const {
  getLeadStatuses,
  createLeadStatus,
  updateLeadStatus,
  deleteLeadStatus,
  bulkCreateStatus,
} = require("../lead_status_controller");

const {
  updateSettings,
  getSettings,
} = require("../setting_controller");

const {
  listForms,
  createForm,
  receiveLead,
} = require("../website_lead_form_controller");

const { checkPermission } = require("../../middleware/auth");

describe("Setup -> Leads Module Comprehensive Audit & Tests", () => {
  let mongoServer;
  let tenantA;
  let tenantB;
  let adminA;
  let adminB;
  let staffA;
  let roleViewOnly;

  beforeAll(async () => {
    process.env.JWT_SECRET = "test-jwt-secret-leads-setup-999";
    mongoServer = await MongoMemoryServer.create();
    const uri = mongoServer.getUri();

    // Safety Guard
    if (!uri.includes("127.0.0.1") && !uri.includes("localhost")) {
      throw new Error("GUARD CHECK FAILED: Host is not 127.0.0.1! Stopping for safety.");
    }
    console.log(`[SAFETY GUARD CHECK PASSED] Connected to in-memory DB: ${uri}`);

    await mongoose.connect(uri);

    tenantA = await Tenant.create({
      company_name: "Tenant A Sales",
      login_code: "tenant-a",
      status: "active",
    });

    tenantB = await Tenant.create({
      company_name: "Tenant B Global",
      login_code: "tenant-b",
      status: "active",
    });

    roleViewOnly = await Role.create({
      name: "Leads Viewer",
      permissions: {
        Leads: { "View(Global)": true, Create: false, Edit: false, Delete: false },
      },
    });

    adminA = await Staff.create({
      firstname: "AdminA",
      lastname: "Leads",
      email: "admin@tenanta.com",
      password: "adminpassword123",
      phonenumber: "9876543101",
      admin: true,
      tenant_id: tenantA._id,
    });

    staffA = await Staff.create({
      firstname: "StaffA",
      lastname: "Viewer",
      email: "staff@tenanta.com",
      password: "staffpassword123",
      phonenumber: "9876543102",
      admin: false,
      role: roleViewOnly._id,
      tenant_id: tenantA._id,
    });

    adminB = await Staff.create({
      firstname: "AdminB",
      lastname: "Leads",
      email: "admin@tenantb.com",
      password: "adminpassword123",
      phonenumber: "9876543103",
      admin: true,
      tenant_id: tenantB._id,
    });
  });

  afterAll(async () => {
    await mongoose.disconnect();
    if (mongoServer) await mongoServer.stop();
  });

  // ───────────────────────────────────────────────────────────────────────────
  // 1. Lead Sources Submodule
  // ───────────────────────────────────────────────────────────────────────────
  describe("1. Lead Sources Submodule", () => {
    let sourceA;

    test("Creates lead source and initializes totalLeads to 0", async () => {
      const req = {
        user: adminA,
        body: { name: "Google Ads Campaign" },
      };
      const res = { status: jest.fn().mockReturnThis(), json: jest.fn() };

      await createLeadSource(req, res);

      expect(res.status).toHaveBeenCalledWith(201);
      sourceA = res.json.mock.calls[0][0];
      expect(sourceA.name).toBe("Google Ads Campaign");
      expect(sourceA.totalLeads).toBe(0);
      expect(sourceA.tenant_id.toString()).toBe(tenantA._id.toString());
    });

    test("Dynamically calculates totalLeads when leads belong to source", async () => {
      await Lead.create({
        name: "John Doe",
        email: "john@example.com",
        source: sourceA._id,
        tenant_id: tenantA._id,
      });

      const req = { user: adminA };
      const res = { status: jest.fn().mockReturnThis(), json: jest.fn() };

      await getLeadSources(req, res);

      const sources = res.json.mock.calls[0][0];
      const found = sources.find((s) => s._id.toString() === sourceA._id.toString());
      expect(found).toBeDefined();
      expect(found.totalLeads).toBe(1); // Dynamic count verified!
    });

    test("Prevents deletion of lead source that has active leads", async () => {
      const req = { user: adminA, params: { id: sourceA._id.toString() } };
      const res = { status: jest.fn().mockReturnThis(), json: jest.fn() };

      await deleteLeadSource(req, res);

      expect(res.status).toHaveBeenCalledWith(400);
      expect(res.json).toHaveBeenCalledWith({
        message: "Cannot delete source used by leads",
      });
    });

    test("Multi-tenant isolation: Tenant B can create same source name without collision", async () => {
      const reqB = {
        user: adminB,
        body: { name: "Google Ads Campaign" },
      };
      const resB = { status: jest.fn().mockReturnThis(), json: jest.fn() };

      await createLeadSource(reqB, resB);

      expect(resB.status).toHaveBeenCalledWith(201);
      const sourceB = resB.json.mock.calls[0][0];
      expect(sourceB.name).toBe("Google Ads Campaign");
      expect(sourceB.tenant_id.toString()).toBe(tenantB._id.toString());
      expect(sourceB._id.toString()).not.toBe(sourceA._id.toString());
    });

    test("Tenant A cannot update or delete Tenant B's lead source", async () => {
      const sourceB = await LeadSource.findOne({ tenant_id: tenantB._id });

      const reqUpdate = {
        user: adminA,
        params: { id: sourceB._id.toString() },
        body: { name: "Hacked Source" },
      };
      const resUpdate = { status: jest.fn().mockReturnThis(), json: jest.fn() };
      await updateLeadSource(reqUpdate, resUpdate);
      expect(resUpdate.status).toHaveBeenCalledWith(404);

      const reqDelete = {
        user: adminA,
        params: { id: sourceB._id.toString() },
      };
      const resDelete = { status: jest.fn().mockReturnThis(), json: jest.fn() };
      await deleteLeadSource(reqDelete, resDelete);
      expect(resDelete.status).toHaveBeenCalledWith(404);
    });
  });

  // ───────────────────────────────────────────────────────────────────────────
  // 2. Lead Statuses Submodule
  // ───────────────────────────────────────────────────────────────────────────
  describe("2. Lead Statuses Submodule", () => {
    let statusA;

    test("Creates lead status with color and dynamic totalLeads", async () => {
      const req = {
        user: adminA,
        body: { name: "Contacted / In Discussion", color: "#3b82f6", statusorder: 1 },
      };
      const res = { status: jest.fn().mockReturnThis(), json: jest.fn() };

      await createLeadStatus(req, res);

      expect(res.status).toHaveBeenCalledWith(201);
      statusA = res.json.mock.calls[0][0];
      expect(statusA.name).toBe("Contacted / In Discussion");
      expect(statusA.color).toBe("#3b82f6");
      expect(statusA.totalLeads).toBe(0);

      // Create lead with this status
      await Lead.create({
        name: "Jane Smith",
        email: "jane@example.com",
        status: statusA._id,
        tenant_id: tenantA._id,
      });

      const reqGet = { user: adminA };
      const resGet = { status: jest.fn().mockReturnThis(), json: jest.fn() };
      await getLeadStatuses(reqGet, resGet);

      const statuses = resGet.json.mock.calls[0][0];
      const found = statuses.find((s) => s._id.toString() === statusA._id.toString());
      expect(found).toBeDefined();
      expect(found.totalLeads).toBe(1); // Dynamic count verified!
    });

    test("Prevents deletion of lead status that has active leads", async () => {
      const req = { user: adminA, params: { id: statusA._id.toString() } };
      const res = { status: jest.fn().mockReturnThis(), json: jest.fn() };

      await deleteLeadStatus(req, res);

      expect(res.status).toHaveBeenCalledWith(400);
      expect(res.json).toHaveBeenCalledWith({
        message: "Cannot delete status used by leads",
      });
    });

    test("Multi-tenant isolation: Tenant B can create same status name", async () => {
      const reqB = {
        user: adminB,
        body: { name: "Contacted / In Discussion", color: "#3b82f6" },
      };
      const resB = { status: jest.fn().mockReturnThis(), json: jest.fn() };

      await createLeadStatus(reqB, resB);

      expect(resB.status).toHaveBeenCalledWith(201);
      const statusB = resB.json.mock.calls[0][0];
      expect(statusB.name).toBe("Contacted / In Discussion");
      expect(statusB.tenant_id.toString()).toBe(tenantB._id.toString());
    });
  });

  // ───────────────────────────────────────────────────────────────────────────
  // 3. Email Integration for Leads
  // ───────────────────────────────────────────────────────────────────────────
  describe("3. Email Integration for Leads", () => {
    test("Saves and fetches IMAP configuration dynamically per tenant", async () => {
      // Tenant A updates IMAP settings
      const reqA = {
        user: adminA,
        body: {
          settings: [
            { name: "lead_email_imap_host", value: "imap.tenanta.com" },
            { name: "lead_email_imap_port", value: "993" },
            { name: "lead_email_imap_username", value: "inbox@tenanta.com" },
            { name: "lead_email_imap_ssl", value: "true" },
          ],
        },
      };
      const resA = { status: jest.fn().mockReturnThis(), json: jest.fn() };

      await updateSettings(reqA, resA);
      expect(resA.json).toHaveBeenCalledWith({ message: "Settings updated successfully" });

      // Fetch settings for Tenant A
      const reqGetA = { user: adminA };
      const resGetA = { status: jest.fn().mockReturnThis(), json: jest.fn() };
      await getSettings(reqGetA, resGetA);

      const settingsA = resGetA.json.mock.calls[0][0];
      const hostA = settingsA.find((s) => s.name === "lead_email_imap_host")?.value;
      const userA = settingsA.find((s) => s.name === "lead_email_imap_username")?.value;
      expect(hostA).toBe("imap.tenanta.com");
      expect(userA).toBe("inbox@tenanta.com");

      // Tenant B does not have Tenant A's IMAP host
      const reqGetB = { user: adminB };
      const resGetB = { status: jest.fn().mockReturnThis(), json: jest.fn() };
      await getSettings(reqGetB, resGetB);

      const settingsB = resGetB.json.mock.calls[0][0];
      const hostB = settingsB.find((s) => s.name === "lead_email_imap_host")?.value;
      expect(hostB).toBeUndefined();
    });
  });

  // ───────────────────────────────────────────────────────────────────────────
  // 4. Web to Lead Submodule
  // ───────────────────────────────────────────────────────────────────────────
  describe("4. Web to Lead Submodule", () => {
    test("Saves web to lead redirect URL and success message dynamically", async () => {
      const req = {
        user: adminA,
        body: {
          settings: [
            { name: "web_to_lead_url", value: "https://tenanta.com/thank-you" },
            { name: "web_to_lead_success_message", value: "Thank you for inquiring!" },
          ],
        },
      };
      const res = { status: jest.fn().mockReturnThis(), json: jest.fn() };

      await updateSettings(req, res);
      expect(res.json).toHaveBeenCalledWith({ message: "Settings updated successfully" });

      const reqGet = { user: adminA };
      const resGet = { status: jest.fn().mockReturnThis(), json: jest.fn() };
      await getSettings(reqGet, resGet);

      const saved = resGet.json.mock.calls[0][0];
      const url = saved.find((s) => s.name === "web_to_lead_url")?.value;
      const msg = saved.find((s) => s.name === "web_to_lead_success_message")?.value;
      expect(url).toBe("https://tenanta.com/thank-you");
      expect(msg).toBe("Thank you for inquiring!");
    });

    test("Creates website lead form and receives public lead", async () => {
      // Create a form
      const reqForm = {
        user: adminA,
        body: { name: "Homepage Contact Us" },
      };
      const resForm = { status: jest.fn().mockReturnThis(), json: jest.fn() };
      await createForm(reqForm, resForm);

      expect(resForm.status).toHaveBeenCalledWith(201);
      const form = resForm.json.mock.calls[0][0];
      expect(form.name).toBe("Homepage Contact Us");
      expect(form.key).toBeDefined();

      // Submit public lead to this form's key
      const reqPublic = {
        params: { key: form.key },
        body: {
          name: "Website Visitor",
          email: "visitor@example.com",
          phone: "9988776655",
          city: "Ahmedabad",
          budget: "50000",
        },
      };
      const resPublic = { status: jest.fn().mockReturnThis(), json: jest.fn() };
      await receiveLead(reqPublic, resPublic);

      expect(resPublic.status).toHaveBeenCalledWith(201);
      expect(resPublic.json).toHaveBeenCalledWith({ success: true });

      // Verify lead was created in Tenant A
      const createdLead = await Lead.findOne({ email: "visitor@example.com" });
      expect(createdLead).not.toBeNull();
      expect(createdLead.tenant_id.toString()).toBe(tenantA._id.toString());
      expect(createdLead.city).toBe("Ahmedabad");

      // Verify form counter incremented
      const updatedForm = await WebsiteLeadForm.findById(form._id);
      expect(updatedForm.total_leads).toBe(1);
    });
  });

  // ───────────────────────────────────────────────────────────────────────────
  // 5. Permissions & Security
  // ───────────────────────────────────────────────────────────────────────────
  describe("5. Permissions & Security", () => {
    test("Staff with View-only cannot mutate Leads setup items", async () => {
      const next = jest.fn();
      const res = { status: jest.fn().mockReturnThis(), json: jest.fn() };

      const createMiddleware = checkPermission("Leads", "Create");
      await createMiddleware({ user: staffA, userRole: "staff" }, res, next);
      expect(res.status).toHaveBeenCalledWith(403);

      const editMiddleware = checkPermission("Leads", "Edit");
      await editMiddleware({ user: staffA, userRole: "staff" }, res, next);
      expect(res.status).toHaveBeenCalledWith(403);

      const deleteMiddleware = checkPermission("Leads", "Delete");
      await deleteMiddleware({ user: staffA, userRole: "staff" }, res, next);
      expect(res.status).toHaveBeenCalledWith(403);
    });

    test("Admin automatically bypasses all permission checks", async () => {
      const next = jest.fn();
      const res = { status: jest.fn().mockReturnThis(), json: jest.fn() };

      const deleteMiddleware = checkPermission("Leads", "Delete");
      await deleteMiddleware({ user: adminA, userRole: "staff" }, res, next);
      expect(next).toHaveBeenCalled();
    });
  });
});
