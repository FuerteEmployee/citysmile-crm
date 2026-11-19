const HOME_STATE = "gujarat";
const HOME_STATE_GST_CODE = "24"; // GSTIN prefix for Gujarat

const INDIAN_STATES = [
  "Andhra Pradesh", "Arunachal Pradesh", "Assam", "Bihar", "Chhattisgarh",
  "Delhi", "Goa", "Gujarat", "Haryana", "Himachal Pradesh", "Jammu and Kashmir",
  "Jharkhand", "Karnataka", "Kerala", "Madhya Pradesh", "Maharashtra", "Manipur",
  "Meghalaya", "Mizoram", "Nagaland", "Odisha", "Punjab", "Rajasthan", "Sikkim",
  "Tamil Nadu", "Telangana", "Tripura", "Uttar Pradesh", "Uttarakhand", "West Bengal",
];

// Finds a state name inside a free-text "Address with State" value.
const detectStateFromAddress = (address) => {
  const a = String(address || "").toLowerCase();
  if (!a) return "";
  // Longest names first so "Arunachal Pradesh" wins over "Pradesh"-partials
  const sorted = [...INDIAN_STATES].sort((x, y) => y.length - x.length);
  return sorted.find((s) => a.includes(s.toLowerCase())) || "";
};

module.exports = {
  HOME_STATE,
  HOME_STATE_GST_CODE,
  INDIAN_STATES,
  detectStateFromAddress,
};
