const { parsePhoneNumberFromString } = require("libphonenumber-js");

const DEFAULT_COUNTRY = "IN";

// Callers paste numbers in every shape imaginable — with/without country
// code, a stray leading 0, spaces, dashes, parentheses. libphonenumber-js
// resolves most of these once given a default country, but a bare
// "91XXXXXXXXXX" (country code with no "+") and a leading trunk "0" both
// parse as invalid national numbers on the first attempt, so we retry with
// those two variants before giving up. This is the single source of truth
// for turning any stored/incoming phone string into E.164 — used by both
// the Client/Contact pre-save hooks and the incoming-call lookup.
function toE164(raw, defaultCountry = DEFAULT_COUNTRY) {
  if (raw === null || raw === undefined) return null;
  const cleaned = String(raw).trim().replace(/[\s\-().]/g, "");
  if (!cleaned) return null;

  const attempts = [cleaned];
  if (/^0\d+$/.test(cleaned)) attempts.push(cleaned.replace(/^0+/, ""));
  if (!cleaned.startsWith("+")) attempts.push(`+${cleaned}`);

  for (const attempt of attempts) {
    const parsed = parsePhoneNumberFromString(attempt, defaultCountry);
    if (parsed && parsed.isValid()) return parsed.number;
  }
  return null;
}

module.exports = { toE164 };
