// Leads module test stack (jest tests and the :5101 UI stack both use it).
// - In-memory MongoDB only: MONGO_URI is overwritten before any app module loads,
//   and start() throws unless the connection is on 127.0.0.1.
// - Meta Graph API is faked through axios' adapter; every Graph call is recorded in
//   guard.graphCalls and answered by graph.handler (override per test).
// - Any REAL outbound network call (http/https/fetch to a non-local host) is blocked
//   and recorded in guard.blockedExternal; guard.realFacebookCalls must stay 0.
// - nodemailer is faked (guard.emails). Crons are never started (only index.js does that).
const http = require("http");
const https = require("https");
const { MongoMemoryServer } = require("mongodb-memory-server");
const mongoose = require("mongoose");
const jwt = require("jsonwebtoken");
const express = require("express");

const guard = { graphCalls: [], blockedExternal: [], realFacebookCalls: 0, emails: [], socketEvents: [] };
const graph = { handler: null };

const LOCAL_HOSTS = new Set(["127.0.0.1", "localhost", "::1", "[::1]"]);
const isFacebook = (host) => /(^|\.)facebook\.com$/i.test(String(host || "").replace(/:\d+$/, ""));

// ---------- fake Graph API ----------
const FAKE_FIELD_DATA = [
  { name: "full_name", values: ["Meta Fake Lead"] },
  { name: "email", values: ["meta.fake@lead.test"] },
  { name: "phone_number", values: ["+919812345678"] },
  { name: "city", values: ["Ahmedabad"] },
];
const fakeLead = (id = "LEADGEN_1", formId = "FORM_A1") => ({
  id, form_id: formId, created_time: "2026-10-01T10:00:00+0000", field_data: FAKE_FIELD_DATA,
});

/** Default Graph answers: page info, leadgen forms, form leads, single lead. Return { __status, data } to fake an error. */
function defaultGraph(url, params) {
  const parts = url.pathname.split("/").filter(Boolean); // ["v19.0", id, edge?]
  const id = parts[1];
  const edge = parts[2];
  if (edge === "leadgen_forms") {
    return { data: [{ id: "FORM_A1", name: "Fake Form", status: "ACTIVE", questions: [
      { key: "full_name", label: "Full name", type: "FULL_NAME" },
      { key: "email", label: "Email", type: "EMAIL" },
      { key: "phone_number", label: "Phone", type: "PHONE" },
      { key: "budget", label: "Budget", type: "CUSTOM" },
    ] }], paging: {} };
  }
  if (edge === "leads") return { data: [fakeLead("LEADGEN_IMPORT_1", id), fakeLead("LEADGEN_IMPORT_2", id)], paging: {} };
  if (edge) return { data: [], paging: {} };
  const fields = String(params.fields || "");
  if (fields.includes("field_data")) return fakeLead(id);
  return { id, name: `Fake Page ${id}`, access_token: "fake-page-token-from-graph", category: "Business" };
}

function installNetworkGuard() {
  if (installNetworkGuard.done) return;
  installNetworkGuard.done = true;

  const axios = require("axios");
  axios.defaults.adapter = async (config) => {
    const url = new URL(axios.getUri(config));
    if (isFacebook(url.hostname)) {
      guard.graphCalls.push({ url: url.toString(), method: config.method, params: config.params || {} });
      const out = await (graph.handler || defaultGraph)(url, config.params || {}, config);
      if (out && out.__status) {
        const err = new Error(`Request failed with status code ${out.__status}`);
        err.response = { status: out.__status, data: out.data, headers: {}, config };
        err.config = config;
        throw err;
      }
      return { data: out, status: 200, statusText: "OK", headers: {}, config, request: {} };
    }
    if (LOCAL_HOSTS.has(url.hostname)) {
      throw new Error(`[leads test guard] axios call to local ${url.host} is not expected in tests`);
    }
    guard.blockedExternal.push(url.toString());
    throw new Error(`[leads test guard] blocked real network call to ${url.host}`);
  };

  const hostOf = (args) => {
    const a = args[0];
    if (typeof a === "string" || a instanceof URL) return new URL(a).hostname;
    return (a && (a.hostname || a.host)) || "localhost";
  };
  for (const mod of [http, https]) {
    for (const fn of ["request", "get"]) {
      const original = mod[fn];
      mod[fn] = function guarded(...args) {
        const host = String(hostOf(args)).replace(/:\d+$/, "");
        if (!LOCAL_HOSTS.has(host)) {
          if (isFacebook(host)) guard.realFacebookCalls += 1;
          guard.blockedExternal.push(`${fn} ${host}`);
          throw new Error(`[leads test guard] blocked real network call to ${host}`);
        }
        return original.apply(this, args);
      };
    }
  }

  const realFetch = globalThis.fetch;
  globalThis.fetch = (input, init) => {
    const host = new URL(typeof input === "string" || input instanceof URL ? input : input.url).hostname;
    if (!LOCAL_HOSTS.has(host)) {
      if (isFacebook(host)) guard.realFacebookCalls += 1;
      guard.blockedExternal.push(`fetch ${host}`);
      return Promise.reject(new Error(`[leads test guard] blocked real network call to ${host}`));
    }
    return realFetch(input, init);
  };

  const nodemailer = require("nodemailer");
  nodemailer.createTransport = () => ({
    sendMail: async (msg) => { guard.emails.push(msg); return { messageId: `fake-${guard.emails.length}` }; },
    verify: async () => true,
    close: () => {},
  });
}

// ---------- server ----------
let mongod;
let server;
let baseUrl;

const ROUTES = [
  ["/api/leads", "routes/lead_routes"],
  ["/api/lead-statuses", "routes/lead_status_routes"],
  ["/api/lead-sources", "routes/lead_source_routes"],
  ["/api/lead-pipeline", "routes/lead_pipeline_routes"],
  ["/api/reminders", "routes/reminder_routes"],
  ["/api/notes", "routes/note_routes"],
  ["/api/files", "routes/file_routes"],
  ["/api/tasks", "routes/task_routes"],
  ["/api/custom-fields", "routes/custom_field_routes"],
  ["/api/staff", "routes/staff_routes"],
  ["/api/clients", "routes/client_routes"],
  ["/api/items", "routes/item_routes"],
  ["/api/activity-logs", "routes/activity_log_routes"],
  ["/api/settings", "routes/setting_routes"],
  ["/api/meta-integration", "routes/meta_integration_routes"],
  ["/api/website-lead-forms", "routes/website_lead_form_routes"],
  ["/api/public/website-leads", "routes/website_lead_public_routes"],
  ["/api/webhooks", "routes/webhook_routes"],
];

/**
 * @param {{ port?: number, extraRoutes?: Array<[string,string]>, beforeRoutes?: (app) => void }} opts
 *   port 0 = random (jest); 5101 for the UI stack.
 */
async function start({ port = 0, extraRoutes = [], beforeRoutes } = {}) {
  mongod = await MongoMemoryServer.create();
  const uri = mongod.getUri();
  if (!uri.startsWith("mongodb://127.0.0.1")) throw new Error(`Refusing to run Leads tests against non-memory DB: ${uri}`);
  process.env.MONGO_URI = uri;
  process.env.JWT_SECRET = "crm-leads-test-secret";
  delete process.env.JOB_SECRET;
  // Webhook fallbacks are read at request time; tests set/unset them explicitly.
  delete process.env.META_WEBHOOK_VERIFY_TOKEN;
  delete process.env.META_PAGE_ACCESS_TOKEN;
  delete process.env.META_LEAD_DEFAULT_TENANT_ID;

  installNetworkGuard(); // after the mongod binary is ready, before any app module loads

  await mongoose.connect(uri);
  const { host } = mongoose.connection;
  if (!LOCAL_HOSTS.has(host)) throw new Error(`Refusing to run Leads tests against non-local DB host: ${host}`);

  const app = express();
  app.use(require("cors")({ origin: true, credentials: true }));
  app.use(express.json({ limit: "10mb" })); // same body limit as index.js
  const fakeIo = { to: () => fakeIo, in: () => fakeIo, emit: (...a) => { guard.socketEvents.push(a); return true; } };
  app.set("io", fakeIo);
  app.get("/api/__test/guard", (req, res) => res.json({
    mongoUri: uri, graphCalls: guard.graphCalls.length, realFacebookCalls: guard.realFacebookCalls,
    blockedExternal: guard.blockedExternal, emails: guard.emails.length,
  }));
  if (beforeRoutes) beforeRoutes(app);
  for (const [mount, mod] of [...ROUTES, ...extraRoutes]) app.use(mount, require(`../../${mod}`));
  app.use((err, req, res, next) => res.status(err.status || 500).json({ message: err.message }));

  await new Promise((resolve) => { server = app.listen(port, "127.0.0.1", resolve); });
  baseUrl = `http://127.0.0.1:${server.address().port}`;
  return { uri, baseUrl, app };
}

async function stop() {
  if (server) await new Promise((resolve) => server.close(resolve));
  await mongoose.disconnect();
  if (mongod) await mongod.stop();
}

// ---------- seed ----------
const FULL = { "View(Global)": true, Create: true, Edit: true, Delete: true };
const sign = (id) => jwt.sign({ id: String(id), role: "staff" }, process.env.JWT_SECRET);

/**
 * Seeds one company. Users: admin, ownView ("View (Own)"), viewOnly ("View(Global)" only),
 * full (View(Global)+Create+Edit+Delete), noAccess (no Leads permission), noTenant
 * (full Leads permission but no tenant_id), and pilot (admin with the Trinetra pilot e-mail; A only).
 */
async function seedCompany(label, { pilot = false } = {}) {
  const Tenant = require("../../models/Tenant");
  const Staff = require("../../models/Staff");
  const LeadStatus = require("../../models/LeadStatus");
  const LeadSource = require("../../models/LeadSource");
  const Item = require("../../models/Item");
  const CustomField = require("../../models/CustomField");
  const Lead = require("../../models/Lead");

  const tenantId = new mongoose.Types.ObjectId();
  await Tenant.create({ _id: tenantId, company_name: `Leads Co ${label}`, status: "active", enabled_features: [] });

  const users = {};
  const mk = async (key, extra) => {
    const _id = new mongoose.Types.ObjectId();
    await Staff.create({
      _id, firstname: key, lastname: label, email: `${key}.${label.toLowerCase()}@leads-test.local`,
      password: "password123", active: true, tenant_id: tenantId, admin: false, ...extra,
    });
    users[key] = { id: _id, token: sign(_id), email: `${key}.${label.toLowerCase()}@leads-test.local`, ...(extra.email ? { email: extra.email } : {}) };
  };
  await mk("admin", { admin: true });
  await mk("ownView", { permissions: { Leads: { "View (Own)": true } } });
  await mk("viewOnly", { permissions: { Leads: { "View(Global)": true } } });
  await mk("full", { permissions: { Leads: FULL } });
  await mk("noAccess", { permissions: {} });
  await mk("noTenant", { permissions: { Leads: FULL }, tenant_id: undefined });
  await mk("inactive", { permissions: { Leads: FULL }, active: false });
  if (pilot) await mk("pilot", { admin: true, email: "info@trinetratechnoworld.com" });

  const statuses = {};
  for (const [i, name] of ["New", "Contacted", "Confirmed", "Customer"].entries()) {
    statuses[name] = (await LeadStatus.create({ name, statusorder: i, isdefault: i === 0 ? 1 : 0, tenant_id: tenantId }))._id;
  }
  const sources = {};
  for (const name of ["Website", "Facebook", "WhatsApp"]) {
    sources[name] = (await LeadSource.create({ name, tenant_id: tenantId }))._id;
  }
  const items = [
    (await Item.create({ name: `Root Canal ${label}`, rate: 5000, tenant_id: tenantId }))._id,
    (await Item.create({ name: `Cleaning ${label}`, rate: 1500, tenant_id: tenantId }))._id,
  ];
  const requiredField = await CustomField.create({
    name: "Budget Range", slug: "leads_budget_range", fieldto: "leads", type: "input", required: true, tenant_id: tenantId,
  });

  const statusIds = Object.values(statuses);
  const sourceIds = Object.values(sources);
  const leadDocs = [];
  for (let i = 0; i < 30; i++) {
    const assigned = i % 3 === 0 ? users.ownView.id : i % 3 === 1 ? users.full.id : undefined;
    leadDocs.push({
      name: `Lead ${label}${String(i).padStart(2, "0")}`,
      email: i % 2 === 0 ? `lead${i}.${label.toLowerCase()}@example.com` : undefined,
      phonenumber: i % 4 === 0 ? `+91 98765${String(43200 + i)}` : i % 4 === 1 ? `98765${String(10000 + i)}` : undefined,
      company: i % 5 === 0 ? `Company ${label}${i}` : undefined,
      status: statusIds[i % statusIds.length],
      source: sourceIds[i % sourceIds.length],
      assigned,
      addedfrom: i % 7 === 0 ? users.ownView.id : users.admin.id,
      is_public: i % 5 === 0,
      lead_value: String(i * 1000),
      followup_date: i % 6 === 0 ? new Date(Date.now() + (i - 12) * 86400000) : undefined,
      converted: i % 10 === 9,
      converted_at: i % 10 === 9 ? new Date() : undefined,
      tenant_id: tenantId,
    });
  }
  const leads = await Lead.create(leadDocs); // create() runs the pre-save hook (phone_last10)

  return { label, tenantId, users, statuses, sources, items, requiredField, leads: leads.map((l) => l._id) };
}

/** Seeds Tenant A (with pilot user, website form, Meta page) and Tenant B. */
async function seedAll() {
  const WebsiteLeadForm = require("../../models/WebsiteLeadForm");
  const MetaIntegration = require("../../models/MetaIntegration");
  const A = await seedCompany("A", { pilot: true });
  const B = await seedCompany("B");
  A.websiteForm = await WebsiteLeadForm.create({ tenant_id: A.tenantId, name: "Site Contact Form A", created_by: A.users.admin.id });
  B.websiteForm = await WebsiteLeadForm.create({ tenant_id: B.tenantId, name: "Site Contact Form B", created_by: B.users.admin.id });
  A.meta = await MetaIntegration.create({
    tenant_id: A.tenantId, page_id: "PAGE_A_TEST", page_name: "Fake Page A", page_access_token: "fake-page-token-A",
    forms: [{ form_id: "FORM_A1", name: "Fake Form", status: "ACTIVE", questions: [{ key: "budget", label: "Budget" }] }],
    connected_by: A.users.admin.id,
  });
  return { A, B };
}

/** Turns tenant add-ons on/off, e.g. setFeatures(A.tenantId, ["lead_followups", "patient_conversion"]). */
async function setFeatures(tenantId, keys) {
  const Tenant = require("../../models/Tenant");
  await Tenant.updateOne({ _id: tenantId }, { $set: { enabled_features: keys } });
}

// Minimal HTTP client: { status, body, text }, never throws on 4xx/5xx.
function client(token, { headers: extra = {} } = {}) {
  const call = async (method, path, body, headers = {}) => {
    const res = await fetch(baseUrl + path, {
      method,
      headers: { "Content-Type": "application/json", ...(token ? { Authorization: `Bearer ${token}` } : {}), ...extra, ...headers },
      body: body === undefined ? undefined : typeof body === "string" ? body : JSON.stringify(body),
    });
    const text = await res.text();
    let json = null;
    try { json = JSON.parse(text); } catch { /* not JSON */ }
    return { status: res.status, body: json, text, headers: res.headers };
  };
  return {
    get: (p, h) => call("GET", p, undefined, h),
    post: (p, b, h) => call("POST", p, b, h),
    put: (p, b, h) => call("PUT", p, b, h),
    patch: (p, b, h) => call("PATCH", p, b, h),
    del: (p, b, h) => call("DELETE", p, b, h),
  };
}

// Jest also collects .cjs files under __tests__ as suites; give it one no-op test
// only when this file itself is the suite being run.
if (typeof test === "function" && expect.getState().testPath === __filename) {
  test("leadsStack.cjs is a helper, not a suite", () => {});
}

module.exports = {
  start, stop, seedCompany, seedAll, setFeatures, client, sign,
  guard, graph, defaultGraph, fakeLead, FAKE_FIELD_DATA,
  getBaseUrl: () => baseUrl,
};
