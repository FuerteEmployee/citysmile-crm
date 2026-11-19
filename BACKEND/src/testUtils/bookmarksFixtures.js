// Shared in-memory seed for the Bookmarks module tests (test-prompts/03-bookmarks.md).
// Used by the jest API suite (src/__tests__/bookmarks/*) and by the UI stack
// (startBookmarksTestStack.js, port 5203). Test data only — never a real DB.
//
// Tenants: BeOnTime, CitySmile, Kiran, OffixNest, Rudraverse (owner info@trinetratechnoworld.com)
// + "NoBookmarksPlan" (plan module_access.bookmarks = false).
// Logins per tenant (password given to seedBookmarkTenants, hashed by the Staff model):
//   admin      admin flag, no role                     (admin on screen AND API)
//   full       Bookmarks View(Global)                  (the only Bookmarks capability)
//   full2      Bookmarks View(Global), second staff    (owner checks)
//   noPerm     no permissions at all                   (PROPOSED: no access)
//   roleAdmin  admin flag + a role                     (screen treats as staff, API as admin)
// Bookmarks per tenant (folders vary to test grouping/counts):
//   pubAdmin   public, admin,  "/admin/customers",           folder "CRM Shortcuts"
//   pubFull    public, full,   "https://<key>.example.com",   folder "Work"   chrome id "11"
//   privFull   private, full,  "https://private-full.example.com", "Personal" chrome id "12"
//   privFull2  private, full2, "https://private-full2.example.com", "Secret"  chrome id "11"  (same chrome id as pubFull!)
//   privAdmin  private, admin, "https://private-admin.example.com", "Admin only"
//   pubFull2   public, full2,  "https://shared.example.com",  folder " Work " (untrimmed, raw insert)
const mongoose = require("mongoose");
const jwt = require("jsonwebtoken");

const TENANTS = [
  { key: "BeOnTime", email: "admin@beontime.test" },
  { key: "CitySmile", email: "admin@citysmile.test" },
  { key: "Kiran", email: "admin@kiran.test" },
  { key: "OffixNest", email: "admin@offixnest.test" },
  { key: "Rudraverse", email: "info@trinetratechnoworld.com" },
];

const tokenFor = (id, role = "staff", opts = {}) => jwt.sign({ id: String(id), role }, process.env.JWT_SECRET, opts);
const refreshFor = (id) =>
  jwt.sign({ id: String(id), role: "staff", type: "refresh" }, process.env.JWT_REFRESH_SECRET || `${process.env.JWT_SECRET}_refresh`, { expiresIn: "30d" });

async function seedBookmarkTenants({ password = "x" } = {}) {
  const Staff = require("../models/Staff");
  const Role = require("../models/Role");
  const SaasPlan = require("../models/SaasPlan");
  const Bookmark = require("../models/Bookmark");
  require("../models/Client");
  const db = mongoose.connection.db;

  const fullPlan = await SaasPlan.create({ name: "BM Full Plan", price: 0, module_access: { bookmarks: true } });
  const offPlan = await SaasPlan.create({ name: "BM No Bookmarks Plan", price: 0, module_access: { bookmarks: false } });

  const T = {};
  const list = [...TENANTS, { key: "NoBookmarksPlan", email: "admin@nobookmarks.test", plan: offPlan }];
  for (const { key, email, plan } of list) {
    const tenantId = new mongoose.Types.ObjectId();
    await db.collection("tenants").insertOne({ _id: tenantId, company_name: key, status: "active", plan_id: (plan || fullPlan)._id });
    const role = await Role.create({ name: `BM Sales ${key}`, permissions: { Bookmarks: { "View(Global)": true } } });
    const mk = async (first, extra = {}) => {
      const s = await Staff.create({
        firstname: first, lastname: key,
        email: first === "Admin" ? email : `${first}.${key}@bm-test.local`.toLowerCase(),
        password, active: true, tenant_id: tenantId, ...extra,
      });
      return { id: s._id, token: tokenFor(s._id), refresh: refreshFor(s._id), email: s.email, doc: s };
    };
    const t = { key, tenantId, email };
    t.admin = await mk("Admin", { admin: true });
    t.full = await mk("Full", { permissions: { Bookmarks: { "View(Global)": true } } });
    t.full2 = await mk("Fulltwo", { permissions: { Bookmarks: { "View(Global)": true } } });
    t.noPerm = await mk("Noperm", { permissions: {} });
    t.roleAdmin = await mk("Roleadmin", { admin: true, role: role._id });

    const mkB = (doc) => Bookmark.create({ tenant_id: tenantId, ...doc });
    t.b = {};
    t.b.pubAdmin = await mkB({ title: `${key} Customers`, url: "/admin/customers", folder: "CRM Shortcuts", created_by: t.admin.id });
    t.b.pubFull = await mkB({ title: `${key} Public Site`, url: `https://${key.toLowerCase()}.example.com`, folder: "Work", created_by: t.full.id, chromeBookmarkId: "11" });
    t.b.privFull = await mkB({ title: `${key} Private Full`, url: "https://private-full.example.com", folder: "Personal", created_by: t.full.id, is_private: true, chromeBookmarkId: "12" });
    t.b.privFull2 = await mkB({ title: `${key} Private Fulltwo`, url: "https://private-full2.example.com", folder: "Secret", created_by: t.full2.id, is_private: true, chromeBookmarkId: "11" });
    t.b.privAdmin = await mkB({ title: `${key} Private Admin`, url: "https://private-admin.example.com", folder: "Admin only", created_by: t.admin.id, is_private: true });
    // Untrimmed folder, as older data / raw inserts can hold (suspected bug 13).
    const raw = await db.collection("bookmarks").insertOne({
      tenant_id: tenantId, title: `${key} Shared`, url: "https://shared.example.com", folder: " Work ",
      created_by: t.full2.id, is_private: false, createdAt: new Date(Date.now() - 1000), updatedAt: new Date(),
    });
    t.b.pubFull2 = { _id: raw.insertedId };

    // A customer of this company (for the `client` field cross-tenant check).
    const c = await db.collection("clients").insertOne({ company: `${key} Secret Client`, tenant_id: tenantId, active: true });
    t.clientId = c.insertedId;
    T[key] = t;
  }

  // Customer-portal contact (role "contact" token).
  const contactId = new mongoose.Types.ObjectId();
  await db.collection("contacts").insertOne({ _id: contactId, firstname: "Portal", lastname: "Contact", email: "portal@bm-test.local", password: "x", active: true, tenant_id: T.BeOnTime.tenantId });
  const contact = { id: contactId, token: tokenFor(contactId, "contact") };

  // Super admin (no tenant).
  const sa = await Staff.create({ firstname: "Super", lastname: "Admin", email: "super@bm-test.local", password, active: true, admin: true, is_superadmin: true });
  const superadmin = { id: sa._id, token: tokenFor(sa._id) };

  return { T, contact, superadmin, Bookmark, Staff, fullPlan, offPlan };
}

// Bulk rows for the performance phase.
async function seedBulk(tenantId, createdBy, n = 2000) {
  const db = mongoose.connection.db;
  const folders = ["Work", "Finance", "Vendors", "Docs", "Personal", "GST", "Banks", "Tools"];
  const rows = [];
  for (let i = 0; i < n; i++) {
    rows.push({
      tenant_id: tenantId, title: `Perf bookmark ${String(i).padStart(4, "0")}`, url: `https://perf${i}.example.com/path/${i}`,
      folder: folders[i % folders.length], created_by: createdBy, is_private: i % 10 === 0,
      createdAt: new Date(Date.now() - i * 1000), updatedAt: new Date(),
    });
  }
  await db.collection("bookmarks").insertMany(rows);
}

module.exports = { TENANTS, tokenFor, refreshFor, seedBookmarkTenants, seedBulk };

// Jest boot: in-memory Mongo (guarded in crmTestApp.start) + plan gate + auth + bookmarks routes.
async function bootBookmarks() {
  const { start, stop, client } = require("./crmTestApp");
  const { uri, baseUrl } = await start([
    ["/api", "testUtils/planModuleGateOnly"],
    ["/api/auth", "routes/auth_routes"],
    ["/api/bookmarks", "routes/bookmark_routes"],
  ]);
  if (!uri.startsWith("mongodb://127.0.0.1")) throw new Error("GUARD: not an in-memory DB");
  const seeded = await seedBookmarkTenants();
  return { uri, baseUrl, stop, client, ...seeded };
}

module.exports.bootBookmarks = bootBookmarks;
