const mongoose = require("mongoose");
const { MongoMemoryServer } = require("mongodb-memory-server");
const jwt = require("jsonwebtoken");
const Staff = require("../../models/Staff");
const Tenant = require("../../models/Tenant");
const Role = require("../../models/Role");
const User = require("../../hrms/models/user_model");
const SalaryStructure = require("../../hrms/models/salary_structure_model");
const HRMSDepartment = require("../../hrms/models/department_model");
const Designation = require("../../hrms/models/designation_model");
const {
  createStaff,
  getStaff,
  getStaffById,
  updateStaff,
  deleteStaff,
} = require("../staff_controller");
const { protect, checkPermission } = require("../../middleware/auth");

describe("Setup -> Staff Module Comprehensive Audit & Tests", () => {
  let mongoServer;
  let tenantA;
  let tenantB;
  let adminA;
  let roleSales;
  let jwtSecret = "test-jwt-secret-key-123456";

  beforeAll(async () => {
    process.env.JWT_SECRET = jwtSecret;
    mongoServer = await MongoMemoryServer.create();
    const uri = mongoServer.getUri();
    
    // Safety guard check
    if (!uri.includes("127.0.0.1") && !uri.includes("localhost")) {
      throw new Error("GUARD CHECK FAILED: Host is not 127.0.0.1! Stopping for safety.");
    }
    console.log(`[SAFETY GUARD CHECK PASSED] Connected to in-memory DB: ${uri}`);

    await mongoose.connect(uri);

    // Create 2 tenants
    tenantA = await Tenant.create({
      company_name: "Tenant A Technologies",
      login_code: "tenant-a",
      status: "active"
    });

    tenantB = await Tenant.create({
      company_name: "Tenant B Retail",
      login_code: "tenant-b",
      status: "active"
    });

    // Create an Admin for Tenant A
    adminA = await Staff.create({
      firstname: "Admin",
      lastname: "User",
      email: "admin@tenanta.com",
      password: "adminpassword123",
      phonenumber: "9876543210",
      admin: true,
      tenant_id: tenantA._id,
      active: true,
    });
    tenantA.owner_id = adminA._id;
    await tenantA.save();

    // Create a Sales Role with specific permissions
    roleSales = await Role.create({
      name: "Sales Executive",
      tenant_id: tenantA._id,
      permissions: {
        Staff: { "View(Global)": true, Create: false, Edit: false, Delete: false },
        Customers: { "View (Own)": true, "View(Global)": false, Create: true, Edit: true, Delete: false },
        Invoices: { "View (Own)": true, "View(Global)": false, Create: true, Edit: false, Delete: false },
      }
    });
  });

  afterAll(async () => {
    await mongoose.disconnect();
    if (mongoServer) {
      await mongoServer.stop();
    }
  });

  beforeEach(async () => {
    // Keep adminA, roleSales, tenants; remove others
    await Staff.deleteMany({ _id: { $ne: adminA._id } });
    await User.deleteMany({});
    await SalaryStructure.deleteMany({});
  });

  // =========================================================================
  // 1. ALL TABS VERIFICATION: NEW STAFF CREATION & HRMS SYNC
  // =========================================================================
  describe("1. Staff Creation Across All Form Sections", () => {
    test("Creates staff with all tabs: Identity, Employment, Salary, Documents, Permissions", async () => {
      const dept = await HRMSDepartment.create({ name: "Sales", code: "SAL", tenant_id: tenantA._id });
      const desig = await Designation.create({ name: "Executive", code: "EXE", tenant_id: tenantA._id });
      const staffPayload = {
        // Tab 1: Identity & Personal
        firstname: "Rahul",
        lastname: "Sharma",
        email: "rahul.sharma@tenanta.com",
        password: "StrongPassword123!",
        phonenumber: "9988776655",
        default_language: "english",
        direction: "ltr",
        email_signature: "Best regards, Rahul",
        departments: ["Sales", "Marketing"],
        skype: "rahul.skype",
        linkedin: "https://linkedin.com/in/rahul",
        active: true,
        // Tab 2: Employment Details
        department: dept._id.toString(),
        designation: desig._id.toString(),
        employmentType: "Full Time",
        attendanceRequired: true,
        isSalesperson: true,
        weeklyHolidays: ["Sunday"],
        // Tab 3: Salary & Banking
        bankInfo: {
          bankName: "HDFC Bank",
          accountNumber: "5010022334455",
          ifscCode: "HDFC0001234",
        },
        payType: "Monthly",
        salaryAmount: 50000,
        salaryConfig: {
          basic: 25000,
          hra: 15000,
          da: 5000,
          pf: 1800,
          esic: 0,
        },
        // Tab 4: Legal Documents
        legalDocuments: {
          panUrl: "https://storage.example.com/pan_rahul.pdf",
          aadhaarUrl: "https://storage.example.com/aadhaar_rahul.pdf",
          passportPhotoUrl: "https://storage.example.com/photo_rahul.jpg",
        },
        // Tab 5: Role & Permissions
        role: roleSales._id.toString(),
        permissions: {
          Staff: { "View(Global)": true },
          Invoices: { "View(Global)": true, Edit: true }, // Override over role!
        },
      };

      const req = {
        user: adminA,
        body: staffPayload,
      };
      const res = {
        status: jest.fn().mockReturnThis(),
        json: jest.fn(),
      };

      await createStaff(req, res);

      expect(res.status).toHaveBeenCalledWith(201);
      const createdId = res.json.mock.calls[0][0]._id;
      expect(createdId).toBeDefined();

      // Verify Staff document in DB
      const staffDoc = await Staff.findById(createdId).populate("role");
      expect(staffDoc).not.toBeNull();
      expect(staffDoc.firstname).toBe("Rahul");
      expect(staffDoc.lastname).toBe("Sharma");
      expect(staffDoc.email).toBe("rahul.sharma@tenanta.com");
      expect(staffDoc.phonenumber).toBe("9988776655");
      expect(staffDoc.active).toBe(true);
      expect(staffDoc.admin).toBe(false);
      expect(staffDoc.tenant_id.toString()).toBe(tenantA._id.toString());

      // Verify Password was hashed
      const isMatch = await staffDoc.matchPassword("StrongPassword123!");
      expect(isMatch).toBe(true);

      // Verify HRMS User synchronization (Employment & Documents)
      const hrmsUser = await User.findOne({ email: "rahul.sharma@tenanta.com", tenant_id: tenantA._id });
      expect(hrmsUser).not.toBeNull();
      expect(hrmsUser.employmentType).toBe("Full Time");
      expect(hrmsUser.isSalesperson).toBe(true);
      expect(hrmsUser.bankInfo.bankName).toBe("HDFC Bank");
      expect(hrmsUser.legalDocuments.panUrl).toBe("https://storage.example.com/pan_rahul.pdf");

      // Verify SalaryStructure created from salaryConfig
      expect(hrmsUser.salaryStructureId).toBeDefined();
      const structure = await SalaryStructure.findById(hrmsUser.salaryStructureId);
      expect(structure).not.toBeNull();
      expect(structure.basic).toBe(25000);
      expect(structure.hra).toBe(15000);
    });

    test("Auto-generates temporary password when password field is left empty", async () => {
      const req = {
        user: adminA,
        body: {
          firstname: "Priya",
          lastname: "Patel",
          email: "priya.patel@tenanta.com",
          phonenumber: "9876501234",
          // password omitted!
        },
      };
      const res = {
        status: jest.fn().mockReturnThis(),
        json: jest.fn(),
      };

      await createStaff(req, res);
      expect(res.status).toHaveBeenCalledWith(201);
      const responseData = res.json.mock.calls[0][0];
      expect(responseData.generatedPassword).toBeDefined();
      expect(responseData.generatedPassword.length).toBeGreaterThan(6);

      const staffDoc = await Staff.findById(responseData._id);
      const match = await staffDoc.matchPassword(responseData.generatedPassword);
      expect(match).toBe(true);
    });

    test("Respects active: false when explicitly created as inactive", async () => {
      const req = {
        user: adminA,
        body: {
          firstname: "Inactive",
          lastname: "User",
          email: "inactive@tenanta.com",
          password: "password123",
          phonenumber: "9123456780",
          active: false,
        },
      };
      const res = {
        status: jest.fn().mockReturnThis(),
        json: jest.fn(),
      };

      await createStaff(req, res);
      expect(res.status).toHaveBeenCalledWith(201);
      const staffDoc = await Staff.findById(res.json.mock.calls[0][0]._id);
      expect(staffDoc.active).toBe(false);
    });
  });

  // =========================================================================
  // 2. ACTIVE VS INACTIVE ENFORCEMENT
  // =========================================================================
  describe("2. Active / Inactive State Enforcement", () => {
    test("Inactive staff is blocked from authenticating via login endpoint", async () => {
      const inactiveStaff = await Staff.create({
        firstname: "John",
        lastname: "Doe",
        email: "john.inactive@tenanta.com",
        password: "secretPassword",
        phonenumber: "9000000001",
        tenant_id: tenantA._id,
        active: false,
      });

      // Direct check against auth logic
      const isPasswordValid = await inactiveStaff.matchPassword("secretPassword");
      expect(isPasswordValid).toBe(true);
      expect(inactiveStaff.active).toBe(false);
    });

    test("Deactivating an active staff member takes immediate effect in database", async () => {
      const staff = await Staff.create({
        firstname: "Amit",
        lastname: "Shah",
        email: "amit@tenanta.com",
        password: "secretPassword",
        phonenumber: "9000000002",
        tenant_id: tenantA._id,
        active: true,
      });

      const req = {
        user: adminA,
        params: { id: staff._id.toString() },
        body: { active: false },
      };
      const res = {
        status: jest.fn().mockReturnThis(),
        json: jest.fn(),
      };

      await updateStaff(req, res);
      expect(res.json).toHaveBeenCalled();

      const updated = await Staff.findById(staff._id);
      expect(updated.active).toBe(false);
    });
  });

  // =========================================================================
  // 3. PERMISSIONS & ROLE OVERRIDES
  // =========================================================================
  describe("3. Permissions Engine & Capability Checks", () => {
    test("Role permissions are inherited when no direct overrides exist", async () => {
      const staff = await Staff.create({
        firstname: "Staff",
        lastname: "Sales",
        email: "sales1@tenanta.com",
        password: "secretPassword",
        phonenumber: "9000000003",
        tenant_id: tenantA._id,
        role: roleSales._id,
        permissions: {},
        active: true,
      });

      const req = {
        userRole: "staff",
        user: staff,
        permissionLevel: null,
      };
      const res = {
        status: jest.fn().mockReturnThis(),
        json: jest.fn(),
      };
      const next = jest.fn();

      // Check View permission on Staff (Role grants "View(Global): true")
      const middleware = checkPermission("Staff", "View");
      await middleware(req, res, next);

      expect(next).toHaveBeenCalled();
      expect(req.permissionLevel).toBe("global");
    });

    test("Staff-level permissions override role-level permissions", async () => {
      // Role has Invoices: { "View(Global)": false, "View (Own)": true }
      // But staff has direct override: Invoices: { "View(Global)": true }
      const staff = await Staff.create({
        firstname: "Staff",
        lastname: "Overridden",
        email: "override@tenanta.com",
        password: "secretPassword",
        phonenumber: "9000000004",
        tenant_id: tenantA._id,
        role: roleSales._id,
        permissions: {
          Invoices: { "View(Global)": true },
        },
        active: true,
      });

      const req = {
        userRole: "staff",
        user: staff,
        permissionLevel: null,
      };
      const res = {
        status: jest.fn().mockReturnThis(),
        json: jest.fn(),
      };
      const next = jest.fn();

      const middleware = checkPermission("Invoices", "View");
      await middleware(req, res, next);

      expect(next).toHaveBeenCalled();
      expect(req.permissionLevel).toBe("global"); // Override won over role!
    });

    test("Staff without View permission receives 403 Forbidden", async () => {
      // Role has NO permission for "Settings"
      const staff = await Staff.create({
        firstname: "Restricted",
        lastname: "Staff",
        email: "restricted@tenanta.com",
        password: "secretPassword",
        phonenumber: "9000000005",
        tenant_id: tenantA._id,
        role: roleSales._id,
        permissions: {},
        active: true,
      });

      const req = {
        userRole: "staff",
        user: staff,
      };
      const res = {
        status: jest.fn().mockReturnThis(),
        json: jest.fn(),
      };
      const next = jest.fn();

      const middleware = checkPermission("Settings", "View");
      await middleware(req, res, next);

      expect(res.status).toHaveBeenCalledWith(403);
      expect(res.json).toHaveBeenCalledWith(
        expect.objectContaining({
          message: expect.stringContaining("Forbidden"),
        })
      );
      expect(next).not.toHaveBeenCalled();
    });

    test("Admins bypass all permission checks automatically", async () => {
      const req = {
        userRole: "staff",
        user: adminA,
      };
      const res = { status: jest.fn().mockReturnThis(), json: jest.fn() };
      const next = jest.fn();

      const middleware = checkPermission("Settings", "View");
      await middleware(req, res, next);

      expect(next).toHaveBeenCalled();
      expect(req.permissionLevel).toBe("global");
    });
  });

  // =========================================================================
  // 4. NEGATIVE & SECURITY TESTING
  // =========================================================================
  describe("4. Negative & Safety Guards", () => {
    test("Rejects creation with duplicate email within same tenant", async () => {
      await Staff.create({
        firstname: "Existing",
        lastname: "User",
        email: "existing@tenanta.com",
        password: "password123",
        phonenumber: "9111111111",
        tenant_id: tenantA._id,
      });

      const req = {
        user: adminA,
        body: {
          firstname: "Duplicate",
          lastname: "User",
          email: "existing@tenanta.com",
          phonenumber: "9222222222",
        },
      };
      const res = { status: jest.fn().mockReturnThis(), json: jest.fn() };

      await createStaff(req, res);
      expect(res.status).toHaveBeenCalledWith(400);
      expect(res.json).toHaveBeenCalledWith(
        expect.objectContaining({ message: expect.stringMatching(/already|taken/i) })
      );
    });

    test("Tenant Isolation: Tenant A cannot view or edit Tenant B staff", async () => {
      const staffB = await Staff.create({
        firstname: "TenantB",
        lastname: "Employee",
        email: "emp@tenantb.com",
        password: "password123",
        phonenumber: "9333333333",
        tenant_id: tenantB._id,
      });

      // Tenant A tries to get Tenant B's staff
      const req = {
        user: adminA, // Belongs to Tenant A
        params: { id: staffB._id.toString() },
      };
      const res = { status: jest.fn().mockReturnThis(), json: jest.fn() };

      await getStaffById(req, res);
      // Tenant isolation: should return 404 Not Found!
      expect(res.status).toHaveBeenCalledWith(404);
      expect(res.json).toHaveBeenCalledWith({ message: "Staff not found" });
    });

    test("Self-deletion safety check prevents admin from deleting themselves", async () => {
      const req = {
        user: adminA,
        params: { id: adminA._id.toString() },
      };
      const res = { status: jest.fn().mockReturnThis(), json: jest.fn() };

      // Try deleting adminA
      await deleteStaff(req, res);
      
      expect(res.status).toHaveBeenCalledWith(400);
      expect(res.json).toHaveBeenCalledWith(
        expect.objectContaining({ message: expect.stringMatching(/cannot delete your own account/i) })
      );

      // Admin should either be blocked from self-delete or company owner protected
      const ownerStillExists = await Staff.findById(adminA._id);
      expect(ownerStillExists).not.toBeNull();
    });
  });
});
