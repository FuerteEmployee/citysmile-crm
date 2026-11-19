// Bookmarks Module Test Stack (test-prompts/03-bookmarks.md)
// In-memory MongoDB -> Backend on 127.0.0.1:5203 (frontend: vite.config.test.bookmarks.ts on :5303).
// NEVER touches the live database (never reads .env MONGO_URI), NEVER uses :5001 / :5183.
// Seeds bookmarksFixtures tenants (BeOnTime, CitySmile, Kiran, OffixNest, Rudraverse, NoBookmarksPlan)
// + 2,000 bookmarks in Kiran for the performance check. Every login's password is "Test@1234".
const { MongoMemoryServer } = require("mongodb-memory-server");
const mongoose = require("mongoose");
const express = require("express");
const cors = require("cors");
const cookieParser = require("cookie-parser");

const PASSWORD = "Test@1234";
const PORT = 5203;
const FE = [`http://127.0.0.1:5303`, `http://localhost:5303`];

async function boot() {
  console.log("STARTING BOOKMARKS TEST STACK (In-memory DB + Backend :5203)");
  const mongod = await MongoMemoryServer.create();
  const uri = mongod.getUri();
  process.env.MONGO_URI = uri;
  process.env.JWT_SECRET = "crm-bookmarks-test-secret";
  process.env.PORT = String(PORT);
  delete process.env.JOB_SECRET;

  console.log(`[GUARD CHECK 1] In-memory Mongo URI: ${uri}`);
  if (!uri.startsWith("mongodb://127.0.0.1")) throw new Error(`GUARD FAILURE: expected in-memory URI on 127.0.0.1, got ${uri}`);
  await mongoose.connect(uri);
  if (!["127.0.0.1", "localhost"].includes(mongoose.connection.host)) {
    throw new Error(`GUARD FAILURE: refusing non-local DB host ${mongoose.connection.host}`);
  }
  console.log(`[GUARD CHECK 1 PASSED] Connected to in-memory DB at ${mongoose.connection.host}`);

  const { seedBookmarkTenants, seedBulk } = require("./bookmarksFixtures");
  const seeded = await seedBookmarkTenants({ password: PASSWORD });
  const { T } = seeded;
  await seedBulk(T.Kiran.tenantId, T.Kiran.full.id, 2000);
  // Long text + XSS rows for UI checks (BeOnTime).
  const Bookmark = require("../models/Bookmark");
  await Bookmark.create([
    { tenant_id: T.BeOnTime.tenantId, title: `Long ${"Title ".repeat(60)}`, url: `https://long.example.com/${"p".repeat(400)}`, folder: "Long folder", created_by: T.BeOnTime.full.id },
    { tenant_id: T.BeOnTime.tenantId, title: `<img src=x onerror="window.__xss=1"><script>window.__xss=2</script>`, url: "https://xss.example.com", folder: `<b onmouseover="window.__xss=3">XSS</b>`, created_by: T.BeOnTime.full.id },
  ]);

  const app = express();
  app.use(cors({ origin: (o, cb) => cb(null, !o || FE.includes(o) || o.startsWith("chrome-extension://")), credentials: true }));
  app.use(express.json({ limit: "25mb" }));
  app.use(cookieParser());
  app.use((req, res, next) => { if (process.env.BM_LOG) console.log(`[REQ] ${req.method} ${req.originalUrl}`); next(); });

  app.use("/api", require("../middleware/planModules").planModuleGate);
  app.use("/api/auth", require("../routes/auth_routes"));
  app.use("/api/bookmarks", require("../routes/bookmark_routes"));
  app.use("/api/staff", require("../routes/staff_routes"));
  app.use("/api/mainsidebar", require("../routes/mainsidebar_routes"));
  app.get("/api/health", (req, res) => res.json({ status: "ok", inMemory: true, port: PORT }));
  app.use("/api", (req, res) => res.status(404).json({ message: "Not mounted in Bookmarks test stack", path: req.originalUrl }));
  app.use((err, req, res, next) => res.status(err.status || 500).json({ message: err.message || "Internal server error" }));

  const server = await new Promise((resolve) => { const s = app.listen(PORT, "127.0.0.1", () => resolve(s)); });
  console.log(`[GUARD CHECK 2] Test backend running at http://127.0.0.1:${PORT}`);
  for (const t of Object.values(T)) console.log(`[LOGIN] ${t.key}: admin ${t.email}, staff ${t.full.email}, ${t.full2.email}, ${t.noPerm.email}, ${t.roleAdmin.email} — password ${PASSWORD}`);
  console.log("[READY]");
  return { mongod, server, T };
}

if (require.main === module) {
  boot().catch((err) => { console.error("Failed to start Bookmarks Test Stack:", err); process.exit(1); });
}

module.exports = { boot, PASSWORD };
