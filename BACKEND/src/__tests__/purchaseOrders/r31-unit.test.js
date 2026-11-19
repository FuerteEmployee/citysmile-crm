// Round 31 (2026-10-28 test + fix round): field rules added for PO Settings
// (company, bank, supplier, proforma prefix, minimum margin, WhatsApp template)
// and the PO item Unit. Pure functions — no DB.
const V = require("../../services/poValidation");

const good = (fn, v, opts) => expect(fn(v, opts).error).toBeUndefined();
const badMsg = (fn, v, re, opts) => expect(fn(v, opts).error).toMatch(re);

describe("r31 PO settings field rules", () => {
  test("name: needs a letter, no < >", () => {
    ["Trinetra Technoworld", "3M India Ltd", "A & B Traders (P) Ltd", "Still saves?", ""].forEach((v) => good(V.personOrCompanyName, v));
    badMsg(V.personOrCompanyName, "12345", /letters/);
    badMsg(V.personOrCompanyName, "--//", /letters/);
    badMsg(V.personOrCompanyName, "<b>Co</b>", /< or >/);
    badMsg(V.personOrCompanyName, "", /required/, { required: true });
  });
  test("state: letters, spaces, & . - only", () => {
    ["Gujarat", "Jammu & Kashmir", "Dadra and Nagar Haveli", ""].forEach((v) => good(V.stateName, v));
    ["24", "Guj4rat", "Gujarat!"].forEach((v) => badMsg(V.stateName, v, /letters/));
  });
  test("bank account no.: one number, 9 to 18 digits", () => {
    ["123456789", "123456789012345678", ""].forEach((v) => good(V.bankAccountNo, v));
    badMsg(V.bankAccountNo, "12345678", /9 to 18/);
    badMsg(V.bankAccountNo, "1234567890123456789", /9 to 18/);
    ["12AB5678", "1234 5678 9012", "123456789,987654321", "-123456789"].forEach((v) => badMsg(V.bankAccountNo, v, /digits only/));
  });
  test("IFSC: AAAA0XXXXXX, saved in capitals", () => {
    expect(V.ifsc("sbin0001234").value).toBe("SBIN0001234");
    expect(V.ifsc("HDFC0ABC123").value).toBe("HDFC0ABC123");
    ["SBIN123", "SBIN1234567", "1BIN0001234", "SBIN00012345"].forEach((v) => badMsg(V.ifsc, v, /IFSC/));
  });
  test("logo URL: empty, https link or /path", () => {
    ["", "https://cdn.example.com/logo.png", "http://x.co/a.png", "/uploads/logo.png"].forEach((v) => good(V.logoUrl, v));
    ["not a url", "ftp://x.com/a.png", "https://", "javascript:alert(1)"].forEach((v) => badMsg(V.logoUrl, v, /https/));
  });
  test("proforma prefix: up to 20 letters, digits, - _ /", () => {
    ["", "TT/PI/", "PI-26_", "A".repeat(20)].forEach((v) => good(V.proformaPrefix, v));
    ["P I", "PI#@", "A".repeat(21)].forEach((v) => badMsg(V.proformaPrefix, v, /up to 20/));
  });
  test("minimum margin %: empty = no check, else 0-100", () => {
    expect(V.marginPct("").value).toBeNull();
    expect(V.marginPct(null).value).toBeNull();
    expect(V.marginPct("13").value).toBe(13);
    expect(V.marginPct(0).value).toBe(0);
    ["-5", "150", "abc"].forEach((v) => badMsg(V.marginPct, v, /0 to 100/));
  });
  test("unit: letters needed", () => {
    ["Nos", "Mtr", "Roll", "Pkt 100", ""].forEach((v) => good(V.unitName, v));
    ["12345", "@@", "x".repeat(31)].forEach((v) => badMsg(V.unitName, v, /letters/));
  });
  test("WhatsApp template name + language (Meta format)", () => {
    ["", "po_document", "po_doc_v2"].forEach((v) => good(V.waTemplateName, v));
    ["PO Doc!", "po-document", "Po_doc"].forEach((v) => badMsg(V.waTemplateName, v, /lower-case/));
    expect(V.waLanguage("").value).toBe("en");
    ["en", "en_US", "gu"].forEach((v) => good(V.waLanguage, v));
    ["EN", "english", "en-us"].forEach((v) => badMsg(V.waLanguage, v, /en_US/));
  });
});
