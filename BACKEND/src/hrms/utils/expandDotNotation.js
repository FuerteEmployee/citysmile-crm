// Expands dot-notation form-data keys (e.g. "bankInfo.accountName") into nested
// objects, with light primitive casting for values that arrive as strings via
// multipart/form-data (booleans, "null", and plain numbers).
// Fields that are digits but must stay text: casting them to a number drops
// leading zeros ("0123" -> 123) and corrupts anything past 15 digits (bank
// account numbers). Matched on the last key segment, e.g. "bankInfo.accountNumber".
const KEEP_AS_STRING = new Set([
  "password", "mobile", "phone", "phonenumber", "residentialPhone",
  "accountNumber", "ifscCode", "panNumber", "aadhaarNumber", "salespersonCode",
]);

const CLEARABLE_ARRAYS = new Set(["weeklyHolidays", "departments"]);

const looksLikeIdentifier = (value) =>
  /^0\d/.test(value) || value.replace(/\D/g, "").length > 15;

const expandDotNotation = (obj) => {
  if (!obj || typeof obj !== "object") return obj;
  const result = {};
  for (const key in obj) {
    let value = obj[key];
    const leafKey = key.split(".").pop();

    if (KEEP_AS_STRING.has(leafKey)) {
      // leave as sent
    } else if (value === "true") value = true;
    else if (value === "false") value = false;
    else if (value === "null") value = null;
    else if (typeof value === "string" && value !== "" && !isNaN(value) && !isNaN(parseFloat(value)) && !looksLikeIdentifier(value)) {
      // Only cast if it looks like a pure number and isn't a date string
      if (!value.includes("-") && !value.includes(":")) {
        value = parseFloat(value);
      }
    }

    if (key.indexOf(".") === -1) {
      result[key] = value;
      continue;
    }
    const keys = key.split(".");
    let current = result;

    for (let i = 0; i < keys.length; i++) {
      const k = keys[i];
      if (i === keys.length - 1) {
        current[k] = value;
      } else {
        if (current[k] && typeof current[k] !== "object") {
          current[k] = { _value: current[k] };
        }
        current[k] = current[k] || {};
        current = current[k];
      }
    }
  }
  // An empty array has nothing to append to FormData, so the forms send
  // "clearedArrays=<key>" instead — otherwise unticking every weekly holiday
  // (or member department) would leave the old values in place.
  if (result.clearedArrays !== undefined) {
    const cleared = Array.isArray(result.clearedArrays) ? result.clearedArrays : [result.clearedArrays];
    cleared.forEach((name) => {
      if (CLEARABLE_ARRAYS.has(name) && result[name] === undefined) result[name] = [];
    });
    delete result.clearedArrays;
  }
  return result;
};

module.exports = { expandDotNotation };
