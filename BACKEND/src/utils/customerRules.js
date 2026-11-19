// Customers module: server-side field rules, tenant scoping and reference checks.
// Shared by client_controller (create / update / import) and the customer
// sub-resource routes (contacts, files, vault, reminders, notes).
const mongoose = require("mongoose");
const {
  checkEmail, checkContactPhone, checkPan, checkGstin, checkWebsite, checkLength, firstError, isBlank,
} = require("../hrms/utils/fieldRules");
const { withoutProtected, isObjectId } = require("./requestSafety");

const tenantScope = (req) =>
  (!req.user?.is_superadmin && req.user?.tenant_id ? { tenant_id: req.user.tenant_id } : {});

// The customer with this id in the caller's company, or null (other company / missing / malformed id).
const findOwnClient = (req, id) => {
  if (!isObjectId(String(id || ""))) return Promise.resolve(null);
  const Client = mongoose.model("Client");
  return Client.findOne({ _id: id, ...tenantScope(req) });
};

const HTML_TAG = /<\s*[a-zA-Z!/?]/;
const HAS_LETTER = /\p{L}/u;
const escapeRegExp = (s) => String(s).replace(/[.*+?^${}()|[\]\\]/g, "\\$&");

// Plain-text fields and their max lengths.
const TEXT_LIMITS = {
  company: 200,
  customer_reference: 100,
  contact_person: 150,
  vat: 50,
  account_details: 2000,
  address: 2000,
  city: 100,
  state: 100,
  country: 100,
  default_language: 50,
  currency: 50,
  billing_street: 2000,
  billing_city: 100,
  billing_state: 100,
  billing_country: 100,
  shipping_street: 2000,
  shipping_city: 100,
  shipping_state: 100,
  shipping_country: 100,
  latitude: 50,
  longitude: 50,
};
const LABELS = {
  company: "Company", customer_reference: "Customer Reference", contact_person: "Connect Person", vat: "VAT Number",
  account_details: "Account Details", address: "Address", city: "City", state: "State", country: "Country",
  default_language: "Default Language", currency: "Currency",
  billing_street: "Billing Street", billing_city: "Billing City", billing_state: "Billing State", billing_country: "Billing Country",
  shipping_street: "Shipping Street", shipping_city: "Shipping City", shipping_state: "Shipping State", shipping_country: "Shipping Country",
  latitude: "Latitude", longitude: "Longitude",
};
// Fields that must contain at least one letter (a value of only digits is a typo).
const NEEDS_LETTER = ["contact_person", "city", "state", "billing_city", "billing_state", "shipping_city", "shipping_state"];

const isIndia = (country) => isBlank(country) || /^india$/i.test(String(country).trim());
// Zip: 6 digits for India (or when no country is set), otherwise 3–10 letters/digits/space/dash.
function checkZip(label, zip, country) {
  if (isBlank(zip)) return null;
  const z = String(zip).trim();
  if (isIndia(country)) return /^\d{6}$/.test(z) ? null : `${label} must be exactly 6 digits`;
  return /^[A-Za-z0-9][A-Za-z0-9 -]{1,8}[A-Za-z0-9]$/.test(z) ? null : `${label} is not a valid postal code`;
}

/**
 * Validates and normalises a customer body. `data` is what will be written
 * (only the keys the caller sent, for updates); `existing` is the stored doc
 * for updates so cross-field checks (GST vs PAN, zip vs country) use the final values.
 * Returns { error, data }.
 */
function validateClientData(rawBody, { isCreate, existing = null } = {}) {
  const { custom_fields, ...rest } = rawBody || {};
  const data = withoutProtected(rest);
  // Server-managed fields a form must not set directly.
  delete data.phoneE164;
  delete data.datecreated;

  const final = (k) => (k in data ? data[k] : existing ? existing[k] : undefined);

  // Trim strings first.
  for (const [k, v] of Object.entries(data)) if (typeof v === "string") data[k] = v.trim();

  if (isCreate || "company" in data) {
    if (isBlank(data.company) || typeof data.company !== "string") return { error: "Company name is required" };
  }

  for (const [k, max] of Object.entries(TEXT_LIMITS)) {
    if (!(k in data) || isBlank(data[k])) continue;
    if (typeof data[k] !== "string") return { error: `${LABELS[k]} must be text` };
    const err = checkLength(LABELS[k], data[k], max);
    if (err) return { error: err };
    if (HTML_TAG.test(data[k])) return { error: `${LABELS[k]} must not contain HTML tags` };
    if (NEEDS_LETTER.includes(k) && !HAS_LETTER.test(data[k])) return { error: `${LABELS[k]} must contain letters` };
  }

  if ("pan_number" in data && !isBlank(data.pan_number)) data.pan_number = String(data.pan_number).toUpperCase();
  if ("gst_number" in data && !isBlank(data.gst_number)) data.gst_number = String(data.gst_number).toUpperCase();
  if ("email" in data && !isBlank(data.email)) data.email = String(data.email).toLowerCase();

  const error = firstError(
    "email" in data ? checkEmail("Email", data.email) : null,
    "email" in data ? checkLength("Email", data.email, 200) : null,
    "phonenumber" in data ? checkContactPhone("Phone", data.phonenumber) : null,
    "website" in data ? checkWebsite("Website", data.website) : null,
    "pan_number" in data ? checkPan("PAN Number", data.pan_number) : null,
    ("gst_number" in data || "pan_number" in data) ? checkGstin("GST Number", final("gst_number"), final("pan_number")) : null,
    ("zip" in data || "country" in data) ? checkZip("Zip Code", final("zip"), final("country")) : null,
    ("billing_zip" in data || "billing_country" in data) ? checkZip("Billing Zip", final("billing_zip"), final("billing_country")) : null,
    ("shipping_zip" in data || "shipping_country" in data) ? checkZip("Shipping Zip", final("shipping_zip"), final("shipping_country")) : null,
  );
  if (error) return { error };

  if ("active" in data && typeof data.active !== "boolean") return { error: "Active must be true or false" };

  // Reference fields: empty means "none"; anything else must be a well-formed id.
  for (const k of ["sales_person", "branch"]) {
    if (!(k in data)) continue;
    if (isBlank(data[k])) { data[k] = null; continue; }
    const id = typeof data[k] === "object" && data[k]._id ? String(data[k]._id) : String(data[k]);
    if (!isObjectId(id)) return { error: `${k === "branch" ? "Branch" : "Sales Person"} is not valid` };
    data[k] = id;
  }
  if ("groups" in data) {
    if (data.groups === null || data.groups === "") data.groups = [];
    if (!Array.isArray(data.groups)) return { error: "Groups must be a list" };
    data.groups = [...new Set(data.groups.map((g) => (g && typeof g === "object" && g._id ? String(g._id) : String(g))))];
    if (data.groups.some((g) => !isObjectId(g))) return { error: "Groups contain an invalid id" };
  }
  if ("admins" in data) {
    if (!Array.isArray(data.admins)) return { error: "Customer admins must be a list" };
    for (const a of data.admins) {
      const sid = a && (a.staff?._id || a.staff);
      if (!sid || !isObjectId(String(sid))) return { error: "Customer admin is not valid" };
    }
  }

  return { error: null, data, custom_fields };
}

// Sales person / branch / groups / currency must exist in the caller's company.
async function checkClientRefs(req, data, existing = null) {
  const scope = tenantScope(req);
  const Staff = mongoose.model("Staff");
  const ClientGroup = mongoose.model("ClientGroup");
  const HRMSBranch = require("../hrms/models/hrms_branch_model");

  if (data.sales_person && String(data.sales_person) !== String(existing?.sales_person || "")) {
    if (!(await Staff.exists({ _id: data.sales_person, ...scope }))) return "Sales Person was not found in your company";
  }
  if (data.branch && String(data.branch) !== String(existing?.branch || "")) {
    if (!(await HRMSBranch.exists({ _id: data.branch, ...scope }))) return "Branch was not found in your company";
  }
  if (Array.isArray(data.admins)) {
    const had = new Set((existing?.admins || []).map((a) => String(a.staff?._id || a.staff)));
    const ids = [...new Set(data.admins.map((a) => String(a.staff?._id || a.staff)))].filter((x) => !had.has(x));
    if (ids.length && (await Staff.countDocuments({ _id: { $in: ids }, ...scope })) !== ids.length) {
      return "Customer admin was not found in your company";
    }
  }
  if (Array.isArray(data.groups) && data.groups.length) {
    // Only newly added groups are checked, so an old (since deleted) group already
    // on the customer doesn't block an unrelated edit.
    const had = new Set((existing?.groups || []).map((g) => String(g?._id || g)));
    const added = data.groups.filter((g) => !had.has(String(g)));
    if (added.length && (await ClientGroup.countDocuments({ _id: { $in: added }, ...scope })) !== added.length) {
      return "Group was not found in your company";
    }
  }
  if (!isBlank(data.currency) && data.currency !== existing?.currency) {
    const Currency = mongoose.models.Currency || require("../models/Currency");
    if (!(await Currency.exists({ name: data.currency, ...scope }))) return "Currency was not found in your company";
  }
  return null;
}

// Same company name in the same company (case-insensitive, trimmed) -> conflict.
async function findDuplicateCompany(req, company, excludeId = null) {
  const Client = mongoose.model("Client");
  const q = { ...tenantScope(req), company: new RegExp(`^\\s*${escapeRegExp(String(company).trim())}\\s*$`, "i") };
  if (excludeId) q._id = { $ne: excludeId };
  return Client.findOne(q).select("_id company");
}
async function findDuplicateReference(req, ref, excludeId = null) {
  if (isBlank(ref)) return null;
  const Client = mongoose.model("Client");
  const q = { ...tenantScope(req), customer_reference: new RegExp(`^${escapeRegExp(String(ref).trim())}$`, "i") };
  if (excludeId) q._id = { $ne: excludeId };
  return Client.findOne(q).select("_id");
}

// In-process guard so two identical create requests sent at the same moment
// (double click) can't both pass the duplicate check. A DB unique index is the
// real guarantee — see the report ("Needs DB change").
const pendingCreates = new Set();
const createLockKey = (req, company) => `${req.user?.tenant_id || "-"}|${String(company).trim().toLowerCase()}`;

module.exports = {
  tenantScope, findOwnClient, validateClientData, checkClientRefs, findDuplicateCompany, findDuplicateReference,
  pendingCreates, createLockKey, escapeRegExp, checkZip, HTML_TAG,
};
