const mongoose = require("mongoose");

// Access + refresh token pair for one Claude connection of one staff member.
// Tokens are opaque random strings; only their SHA-256 hashes are stored, so
// a database leak can't be replayed against /mcp. A refresh rotates the pair
// (the old row is marked revoked). "Revoke all" for a company sets revoked on
// every row with that tenant_id.
const mcpOAuthTokenSchema = new mongoose.Schema(
  {
    access_hash: { type: String, required: true, unique: true },
    refresh_hash: { type: String, required: true, unique: true },
    client_id: { type: String, required: true },
    client_name: String,
    staff_id: { type: mongoose.Schema.Types.ObjectId, ref: "Staff", required: true, index: true },
    tenant_id: { type: mongoose.Schema.Types.ObjectId, ref: "Tenant", index: true },
    scopes: [String],
    resource: String,
    access_expires_at: { type: Date, required: true },
    refresh_expires_at: { type: Date, required: true, index: { expires: 0 } },
    revoked: { type: Boolean, default: false },
    last_used_at: Date,
  },
  { timestamps: true }
);

module.exports = mongoose.model("McpOAuthToken", mcpOAuthTokenSchema);
