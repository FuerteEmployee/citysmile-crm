// Single-company lock: Super Admins and other companies are refused, and the
// server refuses to start on a DB that isn't exactly this one company.
const { MongoMemoryServer } = require("mongodb-memory-server");
const mongoose = require("mongoose");

let mongod, Tenant, own, other;
const { getTenantBlock, invalidateTenantAccess } = require("../../utils/tenantAccess");
const { assertSingleTenantDatabase, singleTenantBlock } = require("../../utils/singleTenant");

beforeAll(async () => {
  mongod = await MongoMemoryServer.create();
  const uri = mongod.getUri();
  if (!uri.startsWith("mongodb://127.0.0.1")) throw new Error("Refusing to run against a non-memory DB");
  await mongoose.connect(uri);
  Tenant = require("../../models/Tenant");
  own = await Tenant.create({ company_name: "City Smile", status: "active" });
  process.env.TENANT_ID = String(own._id);
}, 60000);

afterAll(async () => {
  delete process.env.TENANT_ID; // don't leak the lock into other test files
  await mongoose.disconnect();
  if (mongod) await mongod.stop();
});

beforeEach(() => invalidateTenantAccess());

test("own company is allowed", async () => {
  expect(await getTenantBlock(own._id)).toBeNull();
});

test("super admin is always refused", async () => {
  const b = await getTenantBlock(null, { isSuperadmin: true });
  expect(b.code).toBe("SUPERADMIN_NOT_ALLOWED");
  expect(b.status).toBe(403);
});

test("other company's account is refused", async () => {
  const b = await getTenantBlock(new mongoose.Types.ObjectId());
  expect(b.code).toBe("WRONG_COMPANY");
});

test("suspended own company is still blocked", async () => {
  await Tenant.updateOne({ _id: own._id }, { status: "inactive" });
  expect((await getTenantBlock(own._id)).code).toBe("TENANT_SUSPENDED");
  await Tenant.updateOne({ _id: own._id }, { status: "active" });
});

test("startup check passes with exactly this company", async () => {
  const t = await assertSingleTenantDatabase();
  expect(String(t._id)).toBe(String(own._id));
});

test("startup check fails when TENANT_ID is missing", async () => {
  const saved = process.env.TENANT_ID;
  delete process.env.TENANT_ID;
  await expect(assertSingleTenantDatabase()).rejects.toThrow(/TENANT_ID is not set/);
  process.env.TENANT_ID = saved;
});

test("startup check fails when the DB holds another company (e.g. main shared DB)", async () => {
  other = await Tenant.create({ company_name: "Someone Else", status: "active" });
  await expect(assertSingleTenantDatabase()).rejects.toThrow(/exactly one company/);
  await Tenant.deleteOne({ _id: other._id });
});

test("without TENANT_ID only super admins are refused", () => {
  const saved = process.env.TENANT_ID;
  delete process.env.TENANT_ID;
  expect(singleTenantBlock(new mongoose.Types.ObjectId())).toBeNull();
  expect(singleTenantBlock(null, { isSuperadmin: true }).code).toBe("SUPERADMIN_NOT_ALLOWED");
  process.env.TENANT_ID = saved;
});
