// Paths the Claude connector serves at the backend's root. Claude calls them
// from Anthropic's servers or the user's browser, not from a CRM origin, so
// index.js gives them open, credential-less CORS (see corsOptionsDelegate).
const CONNECTOR_PATH = /^\/((mcp|authorize|token|register|revoke)\/?$|mcp-oauth\/|\.well-known\/oauth-)/;
const isConnectorPath = (path) => CONNECTOR_PATH.test(path);

/**
 * Mounts the Claude connector (MCP server + OAuth sign-in) on the app root.
 * Needs MCP_PUBLIC_URL, the backend's public https origin as Claude reaches
 * it (e.g. https://api.citysmile.in). Without it the connector stays off.
 * Must be mounted after express.json().
 */
const mountClaudeConnector = (app) => {
  const publicUrl = process.env.MCP_PUBLIC_URL;
  if (!publicUrl) {
    console.log("[mcp] MCP_PUBLIC_URL not set, Claude connector disabled");
    return;
  }

  // Loaded only when the connector is on, so a server that pulled this code
  // without running `npm install` (no @modelcontextprotocol/sdk yet) still
  // boots normally.
  const { mcpAuthRouter, getOAuthProtectedResourceMetadataUrl } = require("@modelcontextprotocol/sdk/server/auth/router.js");
  const { createOAuthProvider } = require("./oauthProvider");
  const { createMcpRouter } = require("./server");

  const issuerUrl = new URL(publicUrl);
  const mcpUrl = new URL("/mcp", issuerUrl);
  const { provider, loginRouter } = createOAuthProvider({ mcpUrl });

  app.use("/mcp-oauth/login", loginRouter);
  // The SDK rate-limits these endpoints by req.ip. Without "trust proxy" that
  // is nginx's address, so every user of the company shares one bucket: raise
  // the SDK defaults (100/50/20) so normal use never hits them, and skip the
  // library's X-Forwarded-For warning for the same reason.
  const limit = (windowMs, max) => ({ rateLimit: { windowMs, max, validate: { xForwardedForHeader: false } } });
  app.use(
    mcpAuthRouter({
      provider,
      issuerUrl,
      resourceServerUrl: mcpUrl,
      resourceName: "Fuerte CRM",
      authorizationOptions: limit(15 * 60 * 1000, 600),
      tokenOptions: limit(15 * 60 * 1000, 600),
      clientRegistrationOptions: limit(60 * 60 * 1000, 100),
      revocationOptions: limit(15 * 60 * 1000, 300),
    })
  );
  app.use(createMcpRouter({ verifier: provider, resourceMetadataUrl: getOAuthProtectedResourceMetadataUrl(mcpUrl) }));

  console.log(`[mcp] Claude connector ready at ${mcpUrl.href}`);
};

module.exports = { mountClaudeConnector, isConnectorPath };
