// Optional add-on features a super admin turns on per company
// (Tenant.enabled_features). Companies without a key get the original
// behaviour for that feature.
const TENANT_FEATURES = {
  whatsapp_leads: "WhatsApp lead capture",
  marketing_spend: "Marketing spend / Meta Ads burning amount",
  patient_conversion: "Patient conversion & treatment tracking",
  lead_followups: "Follow-up reminders dashboard",
  face_attendance: "HRMS Face Attendance (BOT Lens kiosk + selfie face check)",
  quotation_approval: "Quotation approval (maker requests, approver approves before sending)",
  purchase_orders: "Purchase Orders (purchase/sales POs, price master, margin approval)",
  procurement_types: "Purchase Procurement Types (Ready to Use, Job Work, Manufacturing)",
};

const TENANT_FEATURE_KEYS = Object.keys(TENANT_FEATURES);

// Add-ons only the companies listed in this server's .env may have (comma-
// separated tenant ids). Unset or empty = no company gets it, even if the
// super admin ticks it. Purchase Orders is built for Trinetra only.
const RESTRICTED_FEATURES = {
  purchase_orders: "PURCHASE_ORDERS_TENANT_IDS",
};

const allowedTenantIds = (key) =>
  String(process.env[RESTRICTED_FEATURES[key]] || "")
    .split(",")
    .map((id) => id.trim())
    .filter(Boolean);

const featureAllowedFor = (key, tenantId) => {
  if (!RESTRICTED_FEATURES[key]) return true;
  if (!tenantId) return false;
  const ids = allowedTenantIds(key);
  if (ids.includes(String(tenantId))) return true;
  if (key === "procurement_types") {
    if (process.env.NODE_ENV !== "production") return true;
    if (ids.length === 0) return true;
  }
  return false;
};

// The company's stored add-ons minus the ones it isn't allowed to have.
const allowedFeatures = (tenantId, keys) => (keys || []).filter((key) => featureAllowedFor(key, tenantId));

// Restricted add-ons this company can't have (hidden from the super admin form).
const lockedFeaturesFor = (tenantId) => Object.keys(RESTRICTED_FEATURES).filter((key) => !featureAllowedFor(key, tenantId));

module.exports = {
  TENANT_FEATURES,
  TENANT_FEATURE_KEYS,
  RESTRICTED_FEATURES,
  featureAllowedFor,
  allowedFeatures,
  lockedFeaturesFor,
};
