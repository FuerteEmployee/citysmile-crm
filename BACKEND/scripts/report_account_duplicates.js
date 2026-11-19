// READ-ONLY report for the "one email / one phone = one login account" rule.
// Nothing is written. Run from CRM-BACKEND:  node scripts/report_account_duplicates.js
//
// A "person" is a Staff login plus its linked HRMS User (Staff.hrms_user_id /
// User.staffId, or the legacy same-email-same-tenant pair) — that pair is one
// account, not a duplicate. The report lists:
//   1. emails used by more than one person (across all companies)
//   2. phone numbers used by more than one person (across all companies)
//   3. login phones that are not exactly 10 digits
//   4. HRMS users whose email has capital letters / spaces (login risk once
//      User.email is lowercased)
require("dotenv").config();
const mongoose = require("mongoose");
const Staff = require("../src/models/Staff");
const User = require("../src/hrms/models/user_model");
const Tenant = require("../src/models/Tenant");

const normEmail = (e) => String(e || "").trim().toLowerCase();
const digitsOf = (p) => String(p || "").replace(/\D/g, "");
// Comparable phone key: last 10 digits, so "+91 98765 43210" == "9876543210".
const phoneKey = (p) => {
  const d = digitsOf(p);
  return d.length > 10 ? d.slice(-10) : d;
};

async function main() {
  await mongoose.connect(process.env.MONGO_URI);

  const [staff, users, tenants] = await Promise.all([
    Staff.find({}).select("firstname lastname email phonenumber tenant_id hrms_user_id is_superadmin admin").lean(),
    User.find({}).select("name firstName lastName email mobile tenant_id staffId").lean(),
    Tenant.find({}).select("company_name").lean(),
  ]);
  const tenantName = new Map(tenants.map((t) => [String(t._id), t.company_name]));
  const tName = (id) => (id ? tenantName.get(String(id)) || `(missing company ${id})` : "(no company)");

  // ── Group Staff + linked User into persons (union-find) ──
  const parent = new Map();
  const find = (k) => {
    while (parent.get(k) !== k) k = parent.get(k);
    return k;
  };
  const union = (a, b) => {
    const ra = find(a), rb = find(b);
    if (ra !== rb) parent.set(ra, rb);
  };
  const records = [];
  for (const s of staff) {
    const key = `S:${s._id}`;
    parent.set(key, key);
    records.push({
      key, type: "Staff", id: String(s._id),
      name: `${s.firstname || ""} ${s.lastname || ""}`.trim(),
      email: s.email, phone: s.phonenumber, tenant: s.tenant_id,
      role: s.is_superadmin ? "super admin" : s.admin ? "admin/owner" : "staff",
    });
  }
  for (const u of users) {
    const key = `U:${u._id}`;
    parent.set(key, key);
    records.push({
      key, type: "HRMS User", id: String(u._id),
      name: u.name || `${u.firstName || ""} ${u.lastName || ""}`.trim(),
      email: u.email, phone: u.mobile, tenant: u.tenant_id, role: "hrms",
    });
  }
  const staffIds = new Set(staff.map((s) => String(s._id)));
  const userIds = new Set(users.map((u) => String(u._id)));
  for (const s of staff) {
    if (s.hrms_user_id && userIds.has(String(s.hrms_user_id))) union(`S:${s._id}`, `U:${s.hrms_user_id}`);
  }
  for (const u of users) {
    if (u.staffId && staffIds.has(String(u.staffId))) union(`U:${u._id}`, `S:${u.staffId}`);
  }
  // Legacy pairs linked only by email within the same company.
  const staffByEmailTenant = new Map(staff.map((s) => [`${normEmail(s.email)}|${s.tenant_id || ""}`, s]));
  for (const u of users) {
    const s = staffByEmailTenant.get(`${normEmail(u.email)}|${u.tenant_id || ""}`);
    if (s) union(`U:${u._id}`, `S:${s._id}`);
  }

  const describe = (r) => `    - ${r.type.padEnd(9)} ${r.name || "(no name)"} <${r.email || "-"}> ${r.phone ? "ph:" + r.phone : ""} [${tName(r.tenant)}] (${r.role})`;

  const reportDuplicates = (title, keyOf) => {
    const groups = new Map();
    for (const r of records) {
      const k = keyOf(r);
      if (!k) continue;
      if (!groups.has(k)) groups.set(k, []);
      groups.get(k).push(r);
    }
    const dups = [...groups.entries()].filter(([, rs]) => new Set(rs.map((r) => find(r.key))).size > 1);
    console.log(`\n=== ${title}: ${dups.length} ===`);
    for (const [k, rs] of dups) {
      console.log(`  ${k}  (${new Set(rs.map((r) => find(r.key))).size} different people)`);
      rs.forEach((r) => console.log(describe(r)));
    }
    return dups.length;
  };

  console.log(`Read ${staff.length} Staff logins, ${users.length} HRMS users, ${tenants.length} companies. (read-only, nothing changed)`);

  const dupEmails = reportDuplicates("1. Emails used by more than one person", (r) => normEmail(r.email));
  const dupPhones = reportDuplicates("2. Phone numbers used by more than one person", (r) => phoneKey(r.phone));

  const badPhones = records.filter((r) => r.phone && digitsOf(r.phone).length !== 10);
  const withCountryCode = badPhones.filter((r) => /^91\d{10}$/.test(digitsOf(r.phone)));
  console.log(`\n=== 3. Login phones that are not exactly 10 digits: ${badPhones.length} (of which ${withCountryCode.length} are just +91 + 10 digits) ===`);
  badPhones.forEach((r) => console.log(describe(r) + `  -> ${digitsOf(r.phone).length} digits`));

  const missingPhones = records.filter((r) => !r.phone && r.role !== "super admin");
  console.log(`\n=== 3b. Login accounts with no phone at all: ${missingPhones.length} (not changed; phone becomes required on next edit) ===`);

  const mixedCase = users.filter((u) => u.email && u.email !== normEmail(u.email));
  console.log(`\n=== 4. HRMS users whose email has capitals/spaces: ${mixedCase.length} ===`);
  mixedCase.forEach((u) => console.log(`    - "${u.email}" [${tName(u.tenant_id)}]`));

  console.log(`\nSummary: ${dupEmails} duplicate emails, ${dupPhones} duplicate phones, ${badPhones.length} non-10-digit phones, ${missingPhones.length} accounts without phone, ${mixedCase.length} mixed-case HRMS emails.`);
  await mongoose.disconnect();
}

main().catch((err) => {
  console.error("Report failed:", err.message);
  process.exit(1);
});
