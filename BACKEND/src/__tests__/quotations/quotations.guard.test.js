// Quotation test stack — safety guards. If any of these fail, no other Quotation result can be trusted.
jest.setTimeout(120000);

const axios = require("axios");
const { start, stop, seedAll, client, guard } = require("./quotationStack.cjs");

let baseUrl, uri, A, B;

beforeAll(async () => {
  ({ baseUrl, uri } = await start());
  ({ A, B } = await seedAll());
});
afterAll(stop);

test("DB is the in-memory server on 127.0.0.1", () => {
  const mongoose = require("mongoose");
  expect(uri).toMatch(/^mongodb:\/\/127\.0\.0\.1:\d+\//);
  expect(mongoose.connection.host).toBe("127.0.0.1");
  expect(process.env.MONGO_URI).toBe(uri);
});

test("API runs on 127.0.0.1, never on the live ports :5001 / :5183", () => {
  expect(baseUrl).toMatch(/^http:\/\/127\.0\.0\.1:\d+$/);
  expect(baseUrl).not.toMatch(/:(5001|5183)$/);
});

test("seed counts", async () => {
  const Staff = require("../../models/Staff");
  const Client = require("../../models/Client");
  const QuotationType = require("../../models/QuotationType");
  const Quotation = require("../../models/Quotation");
  const BankDetail = require("../../models/BankDetail");
  const HRMSBranch = require("../../hrms/models/hrms_branch_model");
  expect(await Staff.countDocuments({ tenant_id: A.tenantId })).toBe(6);
  expect(await Staff.countDocuments({ tenant_id: B.tenantId })).toBe(2);
  expect(await HRMSBranch.countDocuments({ tenant_id: A.tenantId })).toBe(2);
  expect(await Client.countDocuments({ tenant_id: A.tenantId, branch: A.branches[0]._id })).toBe(2);
  expect(await Client.countDocuments({ tenant_id: A.tenantId })).toBe(3);
  expect(await Client.countDocuments({ tenant_id: B.tenantId })).toBe(1);
  expect(await BankDetail.countDocuments({ tenant_id: A.tenantId })).toBe(1);
  expect(await QuotationType.countDocuments({ tenant_id: A.tenantId })).toBe(3);
  expect(await QuotationType.countDocuments({ tenant_id: B.tenantId })).toBe(1);
  expect(await Quotation.countDocuments({ tenant_id: A.tenantId })).toBe(0);
  expect(await Quotation.countDocuments({ tenant_id: B.tenantId })).toBe(2);
  const br = await HRMSBranch.findById(A.branches[0]._id).lean();
  expect(br.quotationTypes.map(String)).toEqual([String(A.types.trinetra._id)]);
  const r = await client(A.users.admin.token).get("/api/quotations");
  expect(r.status).toBe(200);
  expect(r.body).toEqual([]);
});

test("real network is blocked, e-mail is faked", async () => {
  await expect(axios.get("https://example.com/")).rejects.toThrow(/blocked/);
  await expect(fetch("https://example.com/")).rejects.toThrow(/blocked/);
  const nodemailer = require("nodemailer");
  await nodemailer.createTransport({}).sendMail({ to: "x@y.z", subject: "t" });
  expect(guard.emails.length).toBe(1);
});
