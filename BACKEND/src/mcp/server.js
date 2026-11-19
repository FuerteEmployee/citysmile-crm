const express = require("express");
const mongoose = require("mongoose");
const { Server } = require("@modelcontextprotocol/sdk/server/index.js");
const { StreamableHTTPServerTransport } = require("@modelcontextprotocol/sdk/server/streamableHttp.js");
const { ListToolsRequestSchema, CallToolRequestSchema } = require("@modelcontextprotocol/sdk/types.js");
const { requireBearerAuth } = require("@modelcontextprotocol/sdk/server/auth/middleware/bearerAuth.js");
const { TOOLS, callTool } = require("./tools");
const { loadConnectorUser } = require("./access");

const INSTRUCTIONS =
  "These tools read and change the user's own company CRM, signed in as that user and limited to what their CRM role allows. " +
  "Answer only from what the tools return; never invent a name, amount, date or status, and say so plainly when nothing is found. " +
  "When several records match, list them and ask which one; never pick for the user. " +
  "Users write in English, Gujarati or Hindi (either script, or Roman letters). Reply in the language and script they used, and keep business words like invoice, payment, pending, follow-up, GST and quotation in English. " +
  "Amounts: લાખ/लाख = 100,000 and કરોડ/करोड़ = 10,000,000; show amounts grouped the Indian way (45,00,000). " +
  "Deleting always needs two separate confirmations from the user (see delete_record).";

// A fresh MCP server per request (stateless Streamable HTTP): nothing is kept
// between calls, so this works behind PM2/nginx without sticky sessions.
const buildServer = (req) => {
  const server = new Server(
    { name: "fuerte-crm", title: "Fuerte CRM", version: "1.0.0" },
    { capabilities: { tools: {} }, instructions: INSTRUCTIONS }
  );
  server.setRequestHandler(ListToolsRequestSchema, async () => ({ tools: TOOLS }));
  server.setRequestHandler(CallToolRequestSchema, async (request) => {
    try {
      return await callTool(req, request.params.name, request.params.arguments);
    } catch (err) {
      console.error("[mcp] tool error:", request.params.name, err);
      return { content: [{ type: "text", text: `The CRM couldn't complete this: ${err.message}` }], isError: true };
    }
  });
  return server;
};

const jsonRpcError = (res, status, message) =>
  res.status(status).json({ jsonrpc: "2.0", error: { code: -32000, message }, id: null });

/**
 * Router serving POST /mcp. `verifier` is the OAuth provider (verifies the
 * Claude access token); `resourceMetadataUrl` is advertised in 401 responses
 * so Claude can discover how to sign in.
 */
const createMcpRouter = ({ verifier, resourceMetadataUrl }) => {
  const router = express.Router();
  const auth = requireBearerAuth({ verifier, resourceMetadataUrl });

  router.post("/mcp", auth, async (req, res) => {
    if (mongoose.connection.readyState !== 1) return jsonRpcError(res, 503, "Database is not connected yet, please retry shortly");

    const { user, error } = await loadConnectorUser(req.auth.extra.staffId);
    if (error) return jsonRpcError(res, 403, error);
    // Same shape protect() gives the REST controllers, so hasCapability() and
    // the shared CRM Agent tools treat this exactly like a logged-in staff user.
    req.user = user;
    req.userRole = "staff";

    const server = buildServer(req);
    const transport = new StreamableHTTPServerTransport({ sessionIdGenerator: undefined });
    res.on("close", () => {
      transport.close();
      server.close();
    });
    try {
      await server.connect(transport);
      await transport.handleRequest(req, res, req.body);
    } catch (err) {
      console.error("[mcp] request failed:", err);
      if (!res.headersSent) jsonRpcError(res, 500, "Internal server error");
    }
  });

  // Stateless server: no server-initiated stream and no sessions to end.
  router.get("/mcp", (req, res) => jsonRpcError(res, 405, "Method not allowed."));
  router.delete("/mcp", (req, res) => jsonRpcError(res, 405, "Method not allowed."));

  return router;
};

module.exports = { createMcpRouter };
