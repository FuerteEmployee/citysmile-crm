// Pure unit tests (no DB) for the HRMS field rules shared by Staff Directory,
// Setup > Staff and bulk import.
const { salaryStructureFromConfig, resolvePfRate, resolvePfMode } = require("../utils/salaryStructureFromConfig");
const { normalizePhone } = require("../../utils/accountUniqueness");

describe("normalizePhone (Staff mobile field)", () => {
  test("[+] keeps a plain 10-digit number", () => {
    expect(normalizePhone("9876543210")).toEqual({ phone: "9876543210" });
  });
  test("[+] strips +91 and spaces", () => {
    expect(normalizePhone("+91 98765 43210")).toEqual({ phone: "9876543210" });
  });
  test("[+] strips a leading 0", () => {
    expect(normalizePhone("09876543210")).toEqual({ phone: "9876543210" });
  });
  test("[-] 9 digits is an error", () => {
    expect(normalizePhone("987654321").error).toBeDefined();
  });
  test("[-] 11 digits not starting with 0 is an error", () => {
    expect(normalizePhone("98765432101").error).toBeDefined();
  });
  test("[-] letters mixed into a valid number are an error, not silently dropped", () => {
    expect(normalizePhone("98765x43210").error).toBeDefined();
  });
});

describe("resolvePfRate (PF % field)", () => {
  test("[+] 12 -> 12", () => expect(resolvePfRate(12)).toBe(12));
  test("[+] '12%' -> 12", () => expect(resolvePfRate("12%")).toBe(12));
  test("[+] Excel fraction 0.12 -> 12", () => expect(resolvePfRate(0.12)).toBe(12));
  test("[+] blank keeps the existing rate (undefined)", () => expect(resolvePfRate("")).toBeUndefined());
  test("[-] 150 is ignored", () => expect(resolvePfRate(150)).toBeUndefined());
  test("[-] -5 is ignored", () => expect(resolvePfRate(-5)).toBeUndefined());
  test("[-] 'abc' is ignored", () => expect(resolvePfRate("abc")).toBeUndefined());
});

describe("resolvePfMode", () => {
  test("[+] fixed_monthly is kept", () => expect(resolvePfMode("fixed_monthly")).toBe("fixed_monthly"));
  test("[-] unknown mode falls back to per_day", () => expect(resolvePfMode("weekly")).toBe("per_day"));
});

describe("salaryStructureFromConfig (salary breakdown fields)", () => {
  test("[+] maps basic / HRA / PT", () => {
    const s = salaryStructureFromConfig({ basic: { value: "15000" }, hra: { value: 5000 }, professionalTax: { value: 200 } });
    expect(s.basic).toBe(15000);
    expect(s.hra).toBe(5000);
    expect(s.professionalTax).toBe(200);
  });
  test("[+] PF toggle Yes with no amount still turns PF on", () => {
    expect(salaryStructureFromConfig({ pf: { isIncluded: true } }).pfApplicable).toBe(true);
  });
  test("[+] ESIC amount > 0 turns ESIC on", () => {
    expect(salaryStructureFromConfig({ esic: { value: 300 } }).esicApplicable).toBe(true);
  });
  test("[-] negative basic is not stored as a negative salary", () => {
    expect(salaryStructureFromConfig({ basic: { value: -5000 } }).basic).toBeGreaterThanOrEqual(0);
  });
  test("[-] negative professional tax is not stored", () => {
    expect(salaryStructureFromConfig({ professionalTax: { value: -200 } }).professionalTax).toBeGreaterThanOrEqual(0);
  });
});
