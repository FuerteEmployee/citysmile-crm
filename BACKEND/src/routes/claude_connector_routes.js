const express = require("express");
const mongoose = require("mongoose");
const router = express.Router();
const Setting = require("../models/Setting");
const McpOAuthToken = require("../models/McpOAuthToken");
const { protect, adminOnly } = require("../middleware/auth");
const { isConnectorEnabled } = require("../mcp/access");

// Company-admin controls for the Claude connector (src/mcp): switch it on or
// off for the company, see who has connected, and cut every connection.

router.use(protect, adminOnly);

// GET /api/claude-connector: status and active connections for this company.
router.get("/", async (req, res) => {
  try {
    const tenantId = req.user.tenant_id;
    const connections = await McpOAuthToken.find({
      tenant_id: tenantId,
      revoked: false,
      refresh_expires_at: { $gt: new Date() },
    })
      .select("staff_id client_name createdAt last_used_at")
      .populate("staff_id", "firstname lastname email")
      .sort({ createdAt: -1 })
      .lean();

    res.json({
      enabled: await isConnectorEnabled(tenantId),
      mcp_url: process.env.MCP_PUBLIC_URL ? new URL("/mcp", process.env.MCP_PUBLIC_URL).href : null,
      connections: connections.map((c) => ({
        id: c._id,
        staff: c.staff_id ? { id: c.staff_id._id, name: `${c.staff_id.firstname || ""} ${c.staff_id.lastname || ""}`.trim(), email: c.staff_id.email } : null,
        client_name: c.client_name || "Claude",
        connected_at: c.createdAt,
        last_used_at: c.last_used_at || null,
      })),
    });
  } catch (err) {
    res.status(500).json({ message: err.message });
  }
});

// PUT /api/claude-connector/enabled { enabled: boolean }
router.put("/enabled", async (req, res) => {
  try {
    if (typeof req.body?.enabled !== "boolean") return res.status(400).json({ message: "enabled must be true or false" });
    await Setting.findOneAndUpdate(
      { name: "claudeConnectorEnabled", tenant_id: req.user.tenant_id },
      { value: req.body.enabled },
      { upsert: true, new: true }
    );
    res.json({ enabled: req.body.enabled });
  } catch (err) {
    res.status(500).json({ message: err.message });
  }
});

// POST /api/claude-connector/revoke-all: disconnects every Claude connection
// in this company. Users have to sign in again to reconnect.
router.post("/revoke-all", async (req, res) => {
  try {
    const result = await McpOAuthToken.updateMany({ tenant_id: req.user.tenant_id, revoked: false }, { $set: { revoked: true } });
    res.json({ revoked: result.modifiedCount });
  } catch (err) {
    res.status(500).json({ message: err.message });
  }
});

// DELETE /api/claude-connector/connections/:id: disconnect one connection.
router.delete("/connections/:id", async (req, res) => {
  try {
    if (!mongoose.isValidObjectId(req.params.id)) return res.status(404).json({ message: "Connection not found" });
    const result = await McpOAuthToken.updateOne({ _id: req.params.id, tenant_id: req.user.tenant_id }, { $set: { revoked: true } });
    if (!result.matchedCount) return res.status(404).json({ message: "Connection not found" });
    res.json({ revoked: true });
  } catch (err) {
    res.status(500).json({ message: err.message });
  }
});

module.exports = router;
