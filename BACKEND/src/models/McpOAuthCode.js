const mongoose = require("mongoose");

// One-time authorization code issued after a staff member signs in on the
// Claude connector's login page. Only the SHA-256 hash of the code is kept.
// Mongo's TTL index removes expired codes on its own.
const mcpOAuthCodeSchema = new mongoose.Schema(
  {
    code_hash: { type: String, required: true, unique: true },
    client_id: { type: String, required: true },
    staff_id: { type: mongoose.Schema.Types.ObjectId, ref: "Staff", required: true },
    tenant_id: { type: mongoose.Schema.Types.ObjectId, ref: "Tenant" },
    code_challenge: { type: String, required: true },
    redirect_uri: { type: String, required: true },
    scopes: [String],
    resource: String,
    used: { type: Boolean, default: false },
    expires_at: { type: Date, required: true, index: { expires: 0 } },
  },
  { timestamps: true }
);

module.exports = mongoose.model("McpOAuthCode", mcpOAuthCodeSchema);
