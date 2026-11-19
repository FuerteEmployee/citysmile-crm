// Single source of truth for turning a Staff form's `salaryConfig` into the
// SalaryStructure fields payroll_controller.generatePayroll reads. Used by
// HRMS > Staff Directory (user_controller create/update), Setup > Staff
// (staff_controller.applySalaryConfig) and the bulk import/bulk add paths, so
// PF Yes/No + PF mode are saved identically everywhere.

const PF_MODES = ["fixed_monthly", "per_day"];

const toBool = (v) => {
  if (typeof v === "boolean") return v;
  if (v === "true") return true;
  if (v === "false") return false;
  return undefined;
};

const resolveVal = (part) => {
  if (part === undefined || part === null) return 0;
  if (typeof part === "object" && part.value !== undefined) return Number(part.value) || 0;
  return Number(part) || 0;
};

// PF Yes/No: an explicit isIncluded wins (the forms now have a toggle). Older
// clients that only send an amount keep the legacy rule "amount > 0 => PF on".
const resolveApplicable = (part) => {
  const explicit = toBool(part?.isIncluded);
  if (explicit !== undefined) return explicit;
  return resolveVal(part) > 0;
};

const resolvePfMode = (mode) => (PF_MODES.includes(mode) ? mode : "per_day");

// PF % of Basic — only returned when a valid rate was given, so saving a staff
// form (which has no rate field) never resets a rate set via import.
const resolvePfRate = (rate) => {
  if (rate === undefined || rate === null || rate === "") return undefined;
  let n = Number(String(rate).replace("%", ""));
  // An Excel cell formatted as a percentage ("12%") is stored as 0.12 — read
  // values between 0 and 1 as a fraction, so 0.12 means 12%, not 0.12%.
  if (n > 0 && n < 1) n = Math.round(n * 10000) / 100;
  return n >= 0 && n <= 100 ? n : undefined;
};

// Amounts are never negative — controllers reject them first; this is the last guard.
const amount = (part) => Math.max(0, resolveVal(part));

const salaryStructureFromConfig = (config = {}) => ({
  basic: amount(config.basic),
  hra: amount(config.hra),
  pfApplicable: resolveApplicable(config.pf),
  pfMode: resolvePfMode(config.pf?.mode),
  ...(resolvePfRate(config.pf?.rate) !== undefined ? { pfRate: resolvePfRate(config.pf.rate) } : {}),
  // ESIC has no Yes/No toggle in the forms — keep the original "flag or amount" rule.
  esicApplicable: toBool(config.esic?.isIncluded) === true || resolveVal(config.esic) > 0,
  professionalTax: amount(config.professionalTax),
  standardDeductions: [
    { name: "PF (Employee)", amount: amount(config.pf) },
    { name: "ESIC", amount: amount(config.esic) },
  ],
});

module.exports = { salaryStructureFromConfig, resolvePfMode, resolvePfRate, PF_MODES };
