const mongoose = require("mongoose");
const { MongoMemoryServer } = require("mongodb-memory-server");
const Staff = require("../../models/Staff");
const Tenant = require("../../models/Tenant");
const Role = require("../../models/Role");
const Client = require("../../models/Client");
const ClientGroup = require("../../models/ClientGroup");
const {
  getGroups,
  createGroup,
  updateGroup,
  deleteGroup,
  bulkCreateGroup,
} = require("../client_group_controller");
const { checkPermission } = require("../../middleware/auth");

describe("Setup -> Customers -> Groups Tab Comprehensive Audit & Tests", () => {
  let mongoServer;
  let tenantA;
  let tenantB;
  let adminA;
  let staffA;
  let adminB;
  let roleViewOnly;
  let roleFullCustomer;

  beforeAll(async () => {
    process.env.JWT_SECRET = "test-jwt-secret-groups-12345";
    mongoServer = await MongoMemoryServer.create();
    const uri = mongoServer.getUri();

    // Safety Guard
    if (!uri.includes("127.0.0.1") && !uri.includes("localhost")) {
      throw new Error("GUARD CHECK FAILED: Host is not 127.0.0.1! Stopping for safety.");
    }
    console.log(`[SAFETY GUARD CHECK PASSED] Connected to in-memory DB: ${uri}`);

    await mongoose.connect(uri);

    tenantA = await Tenant.create({
      company_name: "Tenant A Tech",
      login_code: "tenant-a",
      status: "active",
    });

    tenantB = await Tenant.create({
      company_name: "Tenant B Retail",
      login_code: "tenant-b",
      status: "active",
    });

    // Roles
    roleViewOnly = await Role.create({
      name: "Customer Viewer",
      permissions: {
        Customers: { "View(Global)": true, Create: false, Edit: false, Delete: false },
      },
    });

    roleFullCustomer = await Role.create({
      name: "Customer Manager",
      permissions: {
        Customers: { "View(Global)": true, Create: true, Edit: true, Delete: true },
      },
    });

    // Staff for Tenant A
    adminA = await Staff.create({
      firstname: "AdminA",
      lastname: "User",
      email: "admin@tenanta.com",
      password: "adminpassword123",
      phonenumber: "9876543210",
      admin: true,
      tenant_id: tenantA._id,
    });

    staffA = await Staff.create({
      firstname: "StaffA",
      lastname: "Viewer",
      email: "staff@tenanta.com",
      password: "staffpassword123",
      phonenumber: "9876543211",
      admin: false,
      role: roleViewOnly._id,
      tenant_id: tenantA._id,
    });

    // Admin for Tenant B
    adminB = await Staff.create({
      firstname: "AdminB",
      lastname: "User",
      email: "admin@tenantb.com",
      password: "adminpassword123",
      phonenumber: "9876543212",
      admin: true,
      tenant_id: tenantB._id,
    });
  });

  afterAll(async () => {
    await mongoose.disconnect();
    if (mongoServer) await mongoServer.stop();
  });

  describe("1. CRUD & Dynamic Customer Count", () => {
    let createdGroup;

    test("Creates customer group with dynamic totalCustomers initialized to 0", async () => {
      const req = {
        user: adminA,
        body: { name: "VIP Wholesale" },
      };
      const res = {
        status: jest.fn().mockReturnThis(),
        json: jest.fn(),
      };

      await createGroup(req, res);

      expect(res.status).toHaveBeenCalledWith(201);
      const jsonResponse = res.json.mock.calls[0][0];
      expect(jsonResponse.name).toBe("VIP Wholesale");
      expect(jsonResponse.totalCustomers).toBe(0);
      expect(jsonResponse.tenant_id.toString()).toBe(tenantA._id.toString());

      createdGroup = jsonResponse;
    });

    test("Dynamically calculates totalCustomers when clients are assigned to the group", async () => {
      // Create 2 clients belonging to Tenant A assigned to this group
      await Client.create({
        company: "Alpha Corp",
        email: "alpha@example.com",
        tenant_id: tenantA._id,
        groups: [createdGroup._id],
      });

      await Client.create({
        company: "Beta LLC",
        email: "beta@example.com",
        tenant_id: tenantA._id,
        groups: [createdGroup._id],
      });

      // Another client not assigned to this group
      await Client.create({
        company: "Gamma Inc",
        email: "gamma@example.com",
        tenant_id: tenantA._id,
        groups: [],
      });

      const req = { user: adminA };
      const res = { json: jest.fn(), status: jest.fn().mockReturnThis() };

      await getGroups(req, res);

      const groups = res.json.mock.calls[0][0];
      expect(Array.isArray(groups)).toBe(true);

      const targetGroup = groups.find((g) => g._id.toString() === createdGroup._id.toString());
      expect(targetGroup).toBeDefined();
      expect(targetGroup.name).toBe("VIP Wholesale");
      expect(targetGroup.totalCustomers).toBe(2);
    });

    test("Updates customer group name and maintains dynamic customer count", async () => {
      const req = {
        user: adminA,
        params: { id: createdGroup._id.toString() },
        body: { name: "VIP Enterprise" },
      };
      const res = { json: jest.fn(), status: jest.fn().mockReturnThis() };

      await updateGroup(req, res);

      const updated = res.json.mock.calls[0][0];
      expect(updated.name).toBe("VIP Enterprise");
      expect(updated.totalCustomers).toBe(2);

      // Verify in DB
      const dbDoc = await ClientGroup.findById(createdGroup._id);
      expect(dbDoc.name).toBe("VIP Enterprise");
    });

    test("Deletes group and cleans up references from assigned clients", async () => {
      const req = {
        user: adminA,
        params: { id: createdGroup._id.toString() },
      };
      const res = { json: jest.fn(), status: jest.fn().mockReturnThis() };

      await deleteGroup(req, res);

      expect(res.json).toHaveBeenCalledWith({ message: "Group removed" });

      // Group doc is removed
      const dbGroup = await ClientGroup.findById(createdGroup._id);
      expect(dbGroup).toBeNull();

      // Clients should no longer have the deleted group in their groups array
      const clientsWithGroup = await Client.find({
        tenant_id: tenantA._id,
        groups: createdGroup._id,
      });
      expect(clientsWithGroup.length).toBe(0);
    });
  });

  describe("2. Bulk Creation", () => {
    test("Bulk creates multiple customer groups and ignores empty items", async () => {
      const req = {
        user: adminA,
        body: {
          groups: ["Retail", "Suppliers", "Contractors", "   "],
        },
      };
      const res = { status: jest.fn().mockReturnThis(), json: jest.fn() };

      await bulkCreateGroup(req, res);

      expect(res.status).toHaveBeenCalledWith(201);
      const created = res.json.mock.calls[0][0];
      expect(created.length).toBe(3);
      expect(created.map((g) => g.name)).toEqual(["Retail", "Suppliers", "Contractors"]);
    });

    test("Bulk creation rejects invalid or empty groups payload", async () => {
      const req = {
        user: adminA,
        body: { groups: ["   ", ""] },
      };
      const res = { status: jest.fn().mockReturnThis(), json: jest.fn() };

      await bulkCreateGroup(req, res);

      expect(res.status).toHaveBeenCalledWith(400);
      expect(res.json).toHaveBeenCalledWith({ message: "No new valid group names provided" });
    });
  });

  describe("3. Multi-Tenant Isolation", () => {
    let groupTenantA;
    let groupTenantB;

    test("Allows same group name in different tenants without collision", async () => {
      // Tenant A creates "High Priority"
      const reqA = {
        user: adminA,
        body: { name: "High Priority" },
      };
      const resA = { status: jest.fn().mockReturnThis(), json: jest.fn() };
      await createGroup(reqA, resA);
      expect(resA.status).toHaveBeenCalledWith(201);
      groupTenantA = resA.json.mock.calls[0][0];

      // Tenant B creates "High Priority" - must succeed without 500 error!
      const reqB = {
        user: adminB,
        body: { name: "High Priority" },
      };
      const resB = { status: jest.fn().mockReturnThis(), json: jest.fn() };
      await createGroup(reqB, resB);
      expect(resB.status).toHaveBeenCalledWith(201);
      groupTenantB = resB.json.mock.calls[0][0];

      expect(groupTenantA.name).toBe("High Priority");
      expect(groupTenantB.name).toBe("High Priority");
      expect(groupTenantA._id.toString()).not.toBe(groupTenantB._id.toString());
    });

    test("Tenant A cannot view, update, or delete Tenant B's group", async () => {
      // Tenant A tries to update Tenant B's group
      const reqUpdate = {
        user: adminA, // Tenant A
        params: { id: groupTenantB._id.toString() }, // Tenant B's group
        body: { name: "Hacked by Tenant A" },
      };
      const resUpdate = { status: jest.fn().mockReturnThis(), json: jest.fn() };
      await updateGroup(reqUpdate, resUpdate);

      expect(resUpdate.status).toHaveBeenCalledWith(404);
      expect(resUpdate.json).toHaveBeenCalledWith({ message: "Group not found" });

      // Tenant A tries to delete Tenant B's group
      const reqDelete = {
        user: adminA,
        params: { id: groupTenantB._id.toString() },
      };
      const resDelete = { status: jest.fn().mockReturnThis(), json: jest.fn() };
      await deleteGroup(reqDelete, resDelete);

      expect(resDelete.status).toHaveBeenCalledWith(404);
      expect(resDelete.json).toHaveBeenCalledWith({ message: "Group not found" });

      // Verify Tenant B's group was not modified or deleted
      const bDoc = await ClientGroup.findById(groupTenantB._id);
      expect(bDoc).not.toBeNull();
      expect(bDoc.name).toBe("High Priority");
    });
  });

  describe("4. Permissions Engine", () => {
    test("Staff with View only permission is blocked from creating, editing, and deleting groups", async () => {
      const next = jest.fn();
      const res = { status: jest.fn().mockReturnThis(), json: jest.fn() };

      // Try Create
      const reqCreate = { user: staffA, userRole: "staff" };
      const createMiddleware = checkPermission("Customers", "Create");
      await createMiddleware(reqCreate, res, next);
      expect(res.status).toHaveBeenCalledWith(403);

      // Try Edit
      const reqEdit = { user: staffA, userRole: "staff" };
      const editMiddleware = checkPermission("Customers", "Edit");
      await editMiddleware(reqEdit, res, next);
      expect(res.status).toHaveBeenCalledWith(403);

      // Try Delete
      const reqDelete = { user: staffA, userRole: "staff" };
      const deleteMiddleware = checkPermission("Customers", "Delete");
      await deleteMiddleware(reqDelete, res, next);
      expect(res.status).toHaveBeenCalledWith(403);
    });

    test("Staff with View permission can access getGroups", async () => {
      const next = jest.fn();
      const res = { status: jest.fn().mockReturnThis(), json: jest.fn() };
      const req = { user: staffA, userRole: "staff" };

      const viewMiddleware = checkPermission("Customers", "View");
      await viewMiddleware(req, res, next);
      expect(next).toHaveBeenCalled();
    });

    test("Admin bypasses all permission checks automatically", async () => {
      const next = jest.fn();
      const res = { status: jest.fn().mockReturnThis(), json: jest.fn() };
      const req = { user: adminA, userRole: "staff" };

      const deleteMiddleware = checkPermission("Customers", "Delete");
      await deleteMiddleware(req, res, next);
      expect(next).toHaveBeenCalled();
      expect(req.permissionLevel).toBe("global");
    });
  });

  describe("5. Negative Validations & Edge Cases", () => {
    test("Rejects creation with empty or whitespace-only name", async () => {
      const req = {
        user: adminA,
        body: { name: "   " },
      };
      const res = { status: jest.fn().mockReturnThis(), json: jest.fn() };

      await createGroup(req, res);

      expect(res.status).toHaveBeenCalledWith(400);
      expect(res.json).toHaveBeenCalledWith({ message: "Group name is required" });
    });

    test("Rejects duplicate group name within the same tenant (case-insensitive)", async () => {
      const req = {
        user: adminA,
        body: { name: "retail" }, // already created "Retail" earlier
      };
      const res = { status: jest.fn().mockReturnThis(), json: jest.fn() };

      await createGroup(req, res);

      expect(res.status).toHaveBeenCalledWith(409);
      expect(res.json.mock.calls[0][0].message).toMatch(/already exists/);
    });

    test("Rejects updating to an already existing group name in the same tenant", async () => {
      // We have "Retail" and "Suppliers" in Tenant A
      const retailGroup = await ClientGroup.findOne({ name: "Retail", tenant_id: tenantA._id });
      const req = {
        user: adminA,
        params: { id: retailGroup._id.toString() },
        body: { name: "Suppliers" }, // duplicate of Suppliers
      };
      const res = { status: jest.fn().mockReturnThis(), json: jest.fn() };

      await updateGroup(req, res);

      expect(res.status).toHaveBeenCalledWith(409);
      expect(res.json.mock.calls[0][0].message).toMatch(/already exists/);
    });

    test("Returns 404 for non-existent group ID on update and delete", async () => {
      const fakeId = new mongoose.Types.ObjectId().toString();

      const reqUpdate = {
        user: adminA,
        params: { id: fakeId },
        body: { name: "New Name" },
      };
      const resUpdate = { status: jest.fn().mockReturnThis(), json: jest.fn() };
      await updateGroup(reqUpdate, resUpdate);
      expect(resUpdate.status).toHaveBeenCalledWith(404);

      const reqDelete = {
        user: adminA,
        params: { id: fakeId },
      };
      const resDelete = { status: jest.fn().mockReturnThis(), json: jest.fn() };
      await deleteGroup(reqDelete, resDelete);
      expect(resDelete.status).toHaveBeenCalledWith(404);
    });
  });
});
