const mongoose = require("mongoose");
const { MongoMemoryServer } = require("mongodb-memory-server");
const Staff = require("../../models/Staff");
const Tenant = require("../../models/Tenant");
const Role = require("../../models/Role");
const Ticket = require("../../models/Ticket");
const Department = require("../../models/Department");
const PredefinedReply = require("../../models/PredefinedReply");
const Priority = require("../../models/Priority");
const TicketStatus = require("../../models/TicketStatus");
const Service = require("../../models/Service");
const SpamFilter = require("../../models/SpamFilter");

const {
  getDepartments,
  createDepartment,
  updateDepartment,
  deleteDepartment,
  bulkCreateDepartment,
} = require("../department_controller");

const {
  getReplies,
  createReply,
  updateReply,
  deleteReply,
  bulkCreateReply,
} = require("../predefined_reply_controller");

const {
  getPriorities,
  createPriority,
  updatePriority,
  deletePriority,
  bulkCreatePriority,
} = require("../priority_controller");

const {
  getStatuses,
  createStatus,
  updateStatus,
  deleteStatus,
  bulkCreateStatus,
} = require("../ticket_status_controller");

const {
  getServices,
  createService,
  updateService,
  deleteService,
  bulkCreateService,
} = require("../service_controller");

const {
  getSpamFilters,
  createSpamFilter,
  updateSpamFilter,
  deleteSpamFilter,
} = require("../spam_filter_controller");

const { checkPermission } = require("../../middleware/auth");

describe("Support Module Comprehensive Audit & Tests (All 6 Submodules)", () => {
  let mongoServer;
  let tenantA;
  let tenantB;
  let adminA;
  let adminB;
  let staffA;
  let roleViewOnly;

  beforeAll(async () => {
    process.env.JWT_SECRET = "test-jwt-secret-support-999";
    mongoServer = await MongoMemoryServer.create();
    const uri = mongoServer.getUri();

    // Safety Guard Check
    if (!uri.includes("127.0.0.1") && !uri.includes("localhost")) {
      throw new Error("GUARD CHECK FAILED: Host is not 127.0.0.1! Stopping for safety.");
    }
    console.log(`[SAFETY GUARD CHECK PASSED] Connected to in-memory DB: ${uri}`);

    await mongoose.connect(uri);

    tenantA = await Tenant.create({
      company_name: "Tenant A Enterprises",
      login_code: "tenant-a",
      status: "active",
    });

    tenantB = await Tenant.create({
      company_name: "Tenant B Global",
      login_code: "tenant-b",
      status: "active",
    });

    roleViewOnly = await Role.create({
      name: "Support Viewer",
      permissions: {
        Support: { "View(Global)": true, Create: false, Edit: false, Delete: false },
      },
    });

    adminA = await Staff.create({
      firstname: "AdminA",
      lastname: "Support",
      email: "admin@tenanta.com",
      password: "adminpassword123",
      phonenumber: "9876543201",
      admin: true,
      tenant_id: tenantA._id,
    });

    staffA = await Staff.create({
      firstname: "StaffA",
      lastname: "Agent",
      email: "staff@tenanta.com",
      password: "staffpassword123",
      phonenumber: "9876543202",
      admin: false,
      role: roleViewOnly._id,
      tenant_id: tenantA._id,
    });

    adminB = await Staff.create({
      firstname: "AdminB",
      lastname: "Support",
      email: "admin@tenantb.com",
      password: "adminpassword123",
      phonenumber: "9876543203",
      admin: true,
      tenant_id: tenantB._id,
    });
  });

  afterAll(async () => {
    await mongoose.disconnect();
    if (mongoServer) await mongoServer.stop();
  });

  // ───────────────────────────────────────────────────────────────────────────
  // 1. Departments Submodule
  // ───────────────────────────────────────────────────────────────────────────
  describe("1. Departments Submodule", () => {
    let deptA;

    test("Creates department and initializes dynamic totalTickets to 0", async () => {
      const req = {
        user: adminA,
        body: { name: "Technical Support", email: "tech@tenanta.com" },
      };
      const res = { status: jest.fn().mockReturnThis(), json: jest.fn() };

      await createDepartment(req, res);

      expect(res.status).toHaveBeenCalledWith(201);
      deptA = res.json.mock.calls[0][0];
      expect(deptA.name).toBe("Technical Support");
      expect(deptA.totalTickets).toBe(0);
      expect(deptA.tenant_id.toString()).toBe(tenantA._id.toString());
    });

    test("Dynamically calculates totalTickets when tickets belong to department", async () => {
      await Ticket.create({
        subject: "Cannot login to server",
        department: deptA._id,
        tenant_id: tenantA._id,
      });

      const req = { user: adminA };
      const res = { status: jest.fn().mockReturnThis(), json: jest.fn() };

      await getDepartments(req, res);

      const depts = res.json.mock.calls[0][0];
      const found = depts.find((d) => d._id.toString() === deptA._id.toString());
      expect(found).toBeDefined();
      expect(found.totalTickets).toBe(1);
    });

    test("Prevents deletion of department that has active tickets", async () => {
      const req = { user: adminA, params: { id: deptA._id.toString() } };
      const res = { status: jest.fn().mockReturnThis(), json: jest.fn() };

      await deleteDepartment(req, res);

      expect(res.status).toHaveBeenCalledWith(400);
      expect(res.json).toHaveBeenCalledWith({
        message: "Cannot delete department with active tickets",
      });
    });

    test("Multi-tenant: Tenant B can create same department name without duplicate key error", async () => {
      const reqB = {
        user: adminB,
        body: { name: "Technical Support", email: "tech@tenantb.com" },
      };
      const resB = { status: jest.fn().mockReturnThis(), json: jest.fn() };

      await createDepartment(reqB, resB);

      expect(resB.status).toHaveBeenCalledWith(201);
      const deptB = resB.json.mock.calls[0][0];
      expect(deptB.name).toBe("Technical Support");
      expect(deptB.tenant_id.toString()).toBe(tenantB._id.toString());
    });
  });

  // ───────────────────────────────────────────────────────────────────────────
  // 2. Predefined Replies Submodule
  // ───────────────────────────────────────────────────────────────────────────
  describe("2. Predefined Replies Submodule", () => {
    let replyA;

    test("Creates predefined reply successfully", async () => {
      const req = {
        user: adminA,
        body: {
          name: "Greeting Reply",
          message: "Hello, thank you for reaching out to support. How can we help?",
        },
      };
      const res = { status: jest.fn().mockReturnThis(), json: jest.fn() };

      await createReply(req, res);

      expect(res.status).toHaveBeenCalledWith(201);
      replyA = res.json.mock.calls[0][0];
      expect(replyA.name).toBe("Greeting Reply");
      expect(replyA.message).toContain("Hello, thank you");
      expect(replyA.tenant_id.toString()).toBe(tenantA._id.toString());
    });

    test("Tenant isolation: Tenant A cannot update or delete Tenant B's reply", async () => {
      // Create reply in Tenant B
      const replyB = await PredefinedReply.create({
        name: "Tenant B Reply",
        message: "Tenant B message",
        tenant_id: tenantB._id,
      });

      // Tenant A tries to update
      const reqUpdate = {
        user: adminA,
        params: { id: replyB._id.toString() },
        body: { name: "Hacked" },
      };
      const resUpdate = { status: jest.fn().mockReturnThis(), json: jest.fn() };
      await updateReply(reqUpdate, resUpdate);

      expect(resUpdate.status).toHaveBeenCalledWith(404);

      // Tenant A tries to delete
      const reqDelete = {
        user: adminA,
        params: { id: replyB._id.toString() },
      };
      const resDelete = { status: jest.fn().mockReturnThis(), json: jest.fn() };
      await deleteReply(reqDelete, resDelete);

      expect(resDelete.status).toHaveBeenCalledWith(404);
    });
  });

  // ───────────────────────────────────────────────────────────────────────────
  // 3. Ticket Priority Submodule
  // ───────────────────────────────────────────────────────────────────────────
  describe("3. Ticket Priority Submodule", () => {
    let prioA;

    test("Creates priority and dynamically calculates totalTickets", async () => {
      const req = {
        user: adminA,
        body: { name: "Critical Urgency" },
      };
      const res = { status: jest.fn().mockReturnThis(), json: jest.fn() };

      await createPriority(req, res);

      expect(res.status).toHaveBeenCalledWith(201);
      prioA = res.json.mock.calls[0][0];
      expect(prioA.name).toBe("Critical Urgency");
      expect(prioA.totalTickets).toBe(0);

      // Add ticket with this priority
      const dept = await Department.findOne({ tenant_id: tenantA._id });
      await Ticket.create({
        subject: "Database outage",
        priority: prioA._id,
        department: dept._id,
        tenant_id: tenantA._id,
      });

      // Fetch priorities
      const reqGet = { user: adminA };
      const resGet = { status: jest.fn().mockReturnThis(), json: jest.fn() };
      await getPriorities(reqGet, resGet);

      const list = resGet.json.mock.calls[0][0];
      const target = list.find((p) => p._id.toString() === prioA._id.toString());
      expect(target.totalTickets).toBe(1);
    });

    test("Multi-tenant isolation: Tenant B can create same priority name", async () => {
      const reqB = {
        user: adminB,
        body: { name: "Critical Urgency" },
      };
      const resB = { status: jest.fn().mockReturnThis(), json: jest.fn() };

      await createPriority(reqB, resB);

      expect(resB.status).toHaveBeenCalledWith(201);
      const prioB = resB.json.mock.calls[0][0];
      expect(prioB.name).toBe("Critical Urgency");
      expect(prioB.tenant_id.toString()).toBe(tenantB._id.toString());
    });
  });

  // ───────────────────────────────────────────────────────────────────────────
  // 4. Ticket Statuses Submodule
  // ───────────────────────────────────────────────────────────────────────────
  describe("4. Ticket Statuses Submodule", () => {
    let statusA;

    test("Creates ticket status with color and dynamic totalTickets instead of hardcoded 0", async () => {
      const req = {
        user: adminA,
        body: { name: "Awaiting Client Reply", color: "#f59e0b", statusorder: 2 },
      };
      const res = { status: jest.fn().mockReturnThis(), json: jest.fn() };

      await createStatus(req, res);

      expect(res.status).toHaveBeenCalledWith(201);
      statusA = res.json.mock.calls[0][0];
      expect(statusA.name).toBe("Awaiting Client Reply");
      expect(statusA.color).toBe("#f59e0b");
      expect(statusA.totalTickets).toBe(0);

      // Create a ticket with this status
      const dept = await Department.findOne({ tenant_id: tenantA._id });
      await Ticket.create({
        subject: "Billing clarification",
        status: statusA.name,
        department: dept._id,
        tenant_id: tenantA._id,
      });

      // Fetch statuses
      const reqGet = { user: adminA };
      const resGet = { status: jest.fn().mockReturnThis(), json: jest.fn() };
      await getStatuses(reqGet, resGet);

      const statuses = resGet.json.mock.calls[0][0];
      const found = statuses.find((s) => s._id.toString() === statusA._id.toString());
      expect(found).toBeDefined();
      expect(found.totalTickets).toBe(1); // Dynamic count verified!
    });
  });

  // ───────────────────────────────────────────────────────────────────────────
  // 5. Services Submodule
  // ───────────────────────────────────────────────────────────────────────────
  describe("5. Services Submodule", () => {
    let serviceA;

    test("Creates and updates support service with multi-tenant isolation", async () => {
      const req = {
        user: adminA,
        body: { name: "Cloud Migration", description: "AWS to GCP Migration service" },
      };
      const res = { status: jest.fn().mockReturnThis(), json: jest.fn() };

      await createService(req, res);

      expect(res.status).toHaveBeenCalledWith(201);
      serviceA = res.json.mock.calls[0][0];
      expect(serviceA.name).toBe("Cloud Migration");
      expect(serviceA.tenant_id.toString()).toBe(tenantA._id.toString());

      // Tenant B can also create same service name
      const reqB = {
        user: adminB,
        body: { name: "Cloud Migration", description: "Azure Migration" },
      };
      const resB = { status: jest.fn().mockReturnThis(), json: jest.fn() };
      await createService(reqB, resB);
      expect(resB.status).toHaveBeenCalledWith(201);
      const serviceB = resB.json.mock.calls[0][0];
      expect(serviceB.tenant_id.toString()).toBe(tenantB._id.toString());

      // Tenant A cannot update Tenant B's service
      const reqUpdate = {
        user: adminA,
        params: { id: serviceB._id.toString() },
        body: { name: "Hacked Service" },
      };
      const resUpdate = { status: jest.fn().mockReturnThis(), json: jest.fn() };
      await updateService(reqUpdate, resUpdate);
      expect(resUpdate.status).toHaveBeenCalledWith(404);
    });
  });

  // ───────────────────────────────────────────────────────────────────────────
  // 6. Spam Filters Submodule
  // ───────────────────────────────────────────────────────────────────────────
  describe("6. Spam Filters Submodule", () => {
    let spamFilterA;

    test("Creates spam filter scoped to tenant", async () => {
      const req = {
        user: adminA,
        body: { type: "sender", value: "spammer@badguys.com" },
      };
      const res = { status: jest.fn().mockReturnThis(), json: jest.fn() };

      await createSpamFilter(req, res);

      expect(res.status).toHaveBeenCalledWith(201);
      spamFilterA = res.json.mock.calls[0][0];
      expect(spamFilterA.value).toBe("spammer@badguys.com");
      expect(spamFilterA.tenant_id.toString()).toBe(tenantA._id.toString());
    });

    test("Tenant B does not see Tenant A's spam filters", async () => {
      const reqB = { user: adminB };
      const resB = { status: jest.fn().mockReturnThis(), json: jest.fn() };

      await getSpamFilters(reqB, resB);

      const filtersB = resB.json.mock.calls[0][0];
      const hasA = filtersB.some((f) => f._id.toString() === spamFilterA._id.toString());
      expect(hasA).toBe(false);
    });

    test("Tenant A cannot delete Tenant B's spam filter", async () => {
      // Create filter in Tenant B
      const filterB = await SpamFilter.create({
        type: "phrase",
        value: "free money lottery",
        tenant_id: tenantB._id,
      });

      const reqDelete = {
        user: adminA,
        params: { id: filterB._id.toString() },
      };
      const resDelete = { status: jest.fn().mockReturnThis(), json: jest.fn() };
      await deleteSpamFilter(reqDelete, resDelete);

      expect(resDelete.status).toHaveBeenCalledWith(404);
    });
  });

  // ───────────────────────────────────────────────────────────────────────────
  // 7. Permissions & Safety
  // ───────────────────────────────────────────────────────────────────────────
  describe("7. Permissions & Security", () => {
    test("Staff with View-only permission cannot Create, Edit, or Delete support items", async () => {
      const next = jest.fn();
      const res = { status: jest.fn().mockReturnThis(), json: jest.fn() };

      const createMiddleware = checkPermission("Support", "Create");
      await createMiddleware({ user: staffA, userRole: "staff" }, res, next);
      expect(res.status).toHaveBeenCalledWith(403);

      const editMiddleware = checkPermission("Support", "Edit");
      await editMiddleware({ user: staffA, userRole: "staff" }, res, next);
      expect(res.status).toHaveBeenCalledWith(403);

      const deleteMiddleware = checkPermission("Support", "Delete");
      await deleteMiddleware({ user: staffA, userRole: "staff" }, res, next);
      expect(res.status).toHaveBeenCalledWith(403);
    });

    test("Admin automatically bypasses all permission checks", async () => {
      const next = jest.fn();
      const res = { status: jest.fn().mockReturnThis(), json: jest.fn() };

      const deleteMiddleware = checkPermission("Support", "Delete");
      await deleteMiddleware({ user: adminA, userRole: "staff" }, res, next);
      expect(next).toHaveBeenCalled();
    });
  });
});
