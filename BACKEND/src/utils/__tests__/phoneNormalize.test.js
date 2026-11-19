const { toE164 } = require("../phoneNormalize");

describe("toE164", () => {
  const IN_EXPECTED = "+919876543210";

  test.each([
    ["bare 10-digit", "9876543210"],
    ["leading trunk 0", "09876543210"],
    ["leading 0 with dashes", "091-98765-43210"],
    ["country code, no plus", "919876543210"],
    ["E.164 already", "+919876543210"],
    ["plus with spaces", "+91 98765 43210"],
    ["dashes, no country code", "98765-43210"],
    ["parentheses and space", "(98765) 43210"],
    ["plus with dashes", "+91-98765-43210"],
    ["surrounding whitespace", "  9876543210  "],
  ])("normalizes %s (%s) to E.164", (_label, input) => {
    expect(toE164(input)).toBe(IN_EXPECTED);
  });

  test("returns null for an empty string", () => {
    expect(toE164("")).toBeNull();
  });

  test("returns null for null", () => {
    expect(toE164(null)).toBeNull();
  });

  test("returns null for undefined", () => {
    expect(toE164(undefined)).toBeNull();
  });

  test("returns null for a too-short number", () => {
    expect(toE164("12345")).toBeNull();
  });

  test("returns null for non-numeric garbage", () => {
    expect(toE164("abcdefghij")).toBeNull();
  });

  test("preserves a valid non-Indian number's own country code", () => {
    expect(toE164("+14155552671")).toBe("+14155552671");
  });
});
