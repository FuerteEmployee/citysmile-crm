// Shared server-side field checks for HRMS forms. Each check returns an error
// message, or null when the value is fine. A field that was not sent
// (undefined) is skipped, so partial updates only check what they change.

const isBlank = (v) => v === undefined || v === null || v === "";

// Numbers: rejects text ("abc"), and values outside the allowed range.
function checkNumber(label, value, { min, max, integer = false, positive = false, required = false } = {}) {
  if (isBlank(value)) return required ? `${label} is required` : null;
  const n = Number(value);
  if (typeof value === "boolean" || !Number.isFinite(n)) return `${label} must be a number`;
  if (integer && !Number.isInteger(n)) return `${label} must be a whole number`;
  if (positive && !(n > 0)) return `${label} must be greater than 0`;
  if (min !== undefined && n < min) return `${label} must be ${min} or more`;
  if (max !== undefined && n > max) return `${label} must be ${max} or less`;
  return null;
}

const PHONE_10 = /^\d{10}$/;
const PINCODE_6 = /^\d{6}$/;
const EMAIL = /^[^\s@]+@[^\s@]+\.[^\s@]+$/;

function checkFormat(label, value, pattern, hint) {
  if (isBlank(value)) return null;
  return pattern.test(String(value).trim()) ? null : `${label} ${hint}`;
}
const checkPhone = (label, v) => checkFormat(label, v, PHONE_10, "must be exactly 10 digits");
const checkPincode = (label, v) => checkFormat(label, v, PINCODE_6, "must be exactly 6 digits");
const checkEmail = (label, v) => checkFormat(label, v, EMAIL, "is not a valid email address");

// "YYYY-MM-DD" that is a real calendar day (rejects 2026-13-45, 2026-02-30).
function isRealDate(ymd) {
  if (typeof ymd !== "string" || !/^\d{4}-\d{2}-\d{2}$/.test(ymd)) return false;
  const [y, m, d] = ymd.split("-").map(Number);
  const dt = new Date(Date.UTC(y, m - 1, d));
  return dt.getUTCFullYear() === y && dt.getUTCMonth() === m - 1 && dt.getUTCDate() === d;
}

const firstError = (...errors) => errors.find(Boolean) || null;

// Indian tax / bank / ID formats. Each accepts lower case input (callers upper-case before saving).
const PAN = /^[A-Z]{5}[0-9]{4}[A-Z]$/;
// GSTIN: 2-digit state code (01–38, 97 other territory, 99 centre), PAN, entity no., "Z", check char.
const GSTIN = /^(0[1-9]|[12][0-9]|3[0-8]|97|99)[A-Z]{5}[0-9]{4}[A-Z][1-9A-Z]Z[0-9A-Z]$/;
const IFSC = /^[A-Z]{4}0[A-Z0-9]{6}$/;
const AADHAAR = /^[2-9][0-9]{11}$/;
const HSN = /^([0-9]{4}|[0-9]{6}|[0-9]{8})$/;
const upper = (v) => String(v).trim().toUpperCase();

const checkPan = (label, v) => (isBlank(v) ? null : PAN.test(upper(v)) ? null : `${label} must look like ABCDE1234F`);
function checkGstin(label, v, panValue) {
  if (isBlank(v)) return null;
  const g = upper(v);
  if (!GSTIN.test(g)) return `${label} must be a valid 15-character GSTIN (e.g. 24ABCDE1234F1Z5)`;
  if (!isBlank(panValue) && g.slice(2, 12) !== upper(panValue)) return `${label} does not match the PAN number`;
  return null;
}
const checkIfsc = (label, v) => (isBlank(v) ? null : IFSC.test(upper(v)) ? null : `${label} must look like HDFC0001234`);
const checkAadhaar = (label, v) =>
  (isBlank(v) ? null : AADHAAR.test(String(v).replace(/[\s-]/g, "")) ? null : `${label} must be 12 digits`);
const checkHsn = (label, v) => (isBlank(v) ? null : HSN.test(String(v).trim()) ? null : `${label} must be 4, 6 or 8 digits`);
// Only http(s) links — blocks "javascript:" and other schemes that run code when clicked.
function checkWebsite(label, v) {
  if (isBlank(v)) return null;
  const s = String(v).trim();
  const withScheme = /^[a-z][a-z0-9+.-]*:/i.test(s) ? s : `https://${s}`;
  try {
    const u = new URL(withScheme);
    if (!["http:", "https:"].includes(u.protocol) || !u.hostname.includes(".")) throw new Error();
    return s.length > 300 ? `${label} is too long` : null;
  } catch {
    return `${label} must be a web address like https://example.com`;
  }
}
const checkLength = (label, v, max) => (isBlank(v) ? null : String(v).length > max ? `${label} must be ${max} characters or less` : null);
// Phone numbers stored on companies (customers / vendors): digits with optional + spaces dashes, 10–15 digits.
function checkContactPhone(label, v) {
  if (isBlank(v)) return null;
  const s = String(v).trim();
  const digits = s.replace(/\D/g, "").length;
  return /^\+?[\d\s()-]+$/.test(s) && digits >= 10 && digits <= 15 ? null : `${label} must be a valid phone number (10–15 digits)`;
}

module.exports = {
  checkNumber, checkPhone, checkPincode, checkEmail, isRealDate, firstError, isBlank,
  checkPan, checkGstin, checkIfsc, checkAadhaar, checkHsn, checkWebsite, checkLength, checkContactPhone,
};
