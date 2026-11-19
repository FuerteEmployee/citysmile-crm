// Leads test stack — safety guards. If any of these fail, no other Leads result can be trusted.
jest.setTimeout(120000);

const axios = require("axios");
const { start, stop, seedAll, client, guard } = require("./leadsStack.cjs");

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

test("seed: 2 tenants, 30 leads each, users, statuses, sources", async () => {
  const Lead = require("../../models/Lead");
  expect(await Lead.countDocuments({ tenant_id: A.tenantId })).toBe(30);
  expect(await Lead.countDocuments({ tenant_id: B.tenantId })).toBe(30);
  const r = await client(A.users.admin.token).get("/api/leads");
  expect(r.status).toBe(200);
});

test("Graph API calls are answered by the fake, real facebook.com is never reached", async () => {
  const before = guard.graphCalls.length;
  const { data } = await axios.get("https://graph.facebook.com/v19.0/LEADGEN_X", { params: { fields: "form_id,field_data" } });
  expect(data.field_data.length).toBeGreaterThan(0);
  expect(guard.graphCalls.length).toBe(before + 1);
  await expect(axios.get("https://example.com/")).rejects.toThrow(/blocked real network call/);
  await expect(fetch("https://graph.facebook.com/v19.0/x")).rejects.toThrow(/blocked/);
  guard.realFacebookCalls -= 1; // the line above was a deliberate probe
  expect(guard.realFacebookCalls).toBe(0);
});

test("e-mail is faked", async () => {
  const nodemailer = require("nodemailer");
  await nodemailer.createTransport({}).sendMail({ to: "x@y.z", subject: "t" });
  expect(guard.emails.length).toBeGreaterThan(0);
});
