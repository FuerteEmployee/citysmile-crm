const mongoose = require("mongoose");

// An OAuth client registered by Claude (or another MCP client) through
// Dynamic Client Registration on /register. Stored as the full registration
// document the MCP SDK hands us, so getClient() can return it unchanged.
// See src/mcp/oauthProvider.js.
const mcpOAuthClientSchema = new mongoose.Schema(
  {
    client_id: { type: String, required: true, unique: true },
    info: { type: mongoose.Schema.Types.Mixed, required: true },
  },
  { timestamps: true }
);

module.exports = mongoose.model("McpOAuthClient", mcpOAuthClientSchema);
