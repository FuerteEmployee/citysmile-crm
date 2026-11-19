// Calendar-day helpers in the business timezone, so "today" / "this month"
// on the Leads page match the clinic's local day rather than the server's UTC
// day. Configure with APP_TIMEZONE (IANA name); defaults to Asia/Kolkata.
const APP_TIMEZONE = process.env.APP_TIMEZONE || "Asia/Kolkata";

const partsInTz = (date) => {
  const parts = new Intl.DateTimeFormat("en-US", {
    timeZone: APP_TIMEZONE,
    hourCycle: "h23",
    year: "numeric",
    month: "2-digit",
    day: "2-digit",
    hour: "2-digit",
    minute: "2-digit",
    second: "2-digit",
  }).formatToParts(date);
  const map = {};
  for (const p of parts) map[p.type] = p.value;
  return {
    year: Number(map.year),
    month: Number(map.month),
    day: Number(map.day),
    hour: Number(map.hour),
    minute: Number(map.minute),
    second: Number(map.second),
  };
};

// Minutes the timezone is ahead of UTC at the given instant.
const tzOffsetMinutes = (date) => {
  const p = partsInTz(date);
  const asUtc = Date.UTC(p.year, p.month - 1, p.day, p.hour, p.minute, p.second);
  return Math.round((asUtc - Math.floor(date.getTime() / 1000) * 1000) / 60000);
};

const pad = (n) => String(n).padStart(2, "0");

const isValidDay = (day) => typeof day === "string" && /^\d{4}-\d{2}-\d{2}$/.test(day) && !isNaN(Date.parse(`${day}T00:00:00Z`));

// "YYYY-MM-DD" of the instant in the business timezone.
const toDayString = (date = new Date()) => {
  const p = partsInTz(date);
  return `${p.year}-${pad(p.month)}-${pad(p.day)}`;
};

// UTC instant at which the given business-timezone day starts.
const startOfDay = (day) => {
  const [y, m, d] = day.split("-").map(Number);
  const guess = new Date(Date.UTC(y, m - 1, d));
  return new Date(guess.getTime() - tzOffsetMinutes(guess) * 60000);
};

const addDays = (day, n) => {
  const [y, m, d] = day.split("-").map(Number);
  const dt = new Date(Date.UTC(y, m - 1, d + n));
  return `${dt.getUTCFullYear()}-${pad(dt.getUTCMonth() + 1)}-${pad(dt.getUTCDate())}`;
};

// { start, end } UTC instants for a business-timezone day (end exclusive).
const dayRange = (day = toDayString()) => ({ start: startOfDay(day), end: startOfDay(addDays(day, 1)) });

const monthRange = (day = toDayString()) => {
  const [y, m] = day.split("-").map(Number);
  const first = `${y}-${pad(m)}-01`;
  const next = m === 12 ? `${y + 1}-01-01` : `${y}-${pad(m + 1)}-01`;
  return { start: startOfDay(first), end: startOfDay(next) };
};

module.exports = { APP_TIMEZONE, toDayString, startOfDay, addDays, dayRange, monthRange, isValidDay };
