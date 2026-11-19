const crypto = require("crypto");
const express = require("express");
const Staff = require("../models/Staff");
const Tenant = require("../models/Tenant");
const ActivityLog = require("../models/ActivityLog");
const McpOAuthClient = require("../models/McpOAuthClient");
const McpOAuthCode = require("../models/McpOAuthCode");
const McpOAuthToken = require("../models/McpOAuthToken");
const { isTrinetraPilotUser } = require("../middleware/auth");
const { loadConnectorUser } = require("./access");
const { InvalidTokenError, InvalidGrantError } = require("@modelcontextprotocol/sdk/server/auth/errors.js");

// OAuth 2.1 authorization server for the Claude connector, plugged into the
// MCP SDK's mcpAuthRouter (which handles /authorize, /token, /register,
// /revoke and the .well-known metadata). This file supplies the CRM-specific
// parts: the sign-in page, and storing clients, codes and tokens in MongoDB.
//
// Tokens are opaque random strings tied to one staff member. Only their
// SHA-256 hashes are stored. Access tokens last 1 hour, refresh tokens 30
// days and rotate on every refresh.

const ACCESS_TTL_S = 60 * 60;
const REFRESH_TTL_S = 30 * 24 * 60 * 60;
const CODE_TTL_S = 5 * 60;
const LOGIN_CONTEXT_TTL_S = 15 * 60;

const sha256 = (s) => crypto.createHash("sha256").update(String(s)).digest("hex");
const randomToken = () => crypto.randomBytes(32).toString("base64url");

const escapeHtml = (s) =>
  String(s ?? "").replace(/[&<>"']/g, (c) => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;" })[c]);

// ── Signed login context ──
// The authorize request's parameters ride along in the sign-in form, signed
// so they can't be changed between showing the page and submitting it (e.g.
// swapping the redirect_uri or PKCE challenge).
const signingKey = () => sha256(`mcp-login:${process.env.JWT_SECRET}`);

const signContext = (payload) => {
  const body = Buffer.from(JSON.stringify(payload)).toString("base64url");
  const sig = crypto.createHmac("sha256", signingKey()).update(body).digest("base64url");
  return `${body}.${sig}`;
};

const readContext = (value) => {
  const [body, sig] = String(value || "").split(".");
  if (!body || !sig) return null;
  const expected = crypto.createHmac("sha256", signingKey()).update(body).digest("base64url");
  const a = Buffer.from(sig);
  const b = Buffer.from(expected);
  if (a.length !== b.length || !crypto.timingSafeEqual(a, b)) return null;
  try {
    const payload = JSON.parse(Buffer.from(body, "base64url").toString());
    return payload.exp > Date.now() / 1000 ? payload : null;
  } catch {
    return null;
  }
};

// ── Sign-in rate limit (per email, and per client IP) ──
// The app doesn't set "trust proxy", so behind nginx req.ip is nginx itself;
// the client IP comes from X-Forwarded-For. That header can be forged, which
// only lets someone dodge the IP limit; the per-email limit still holds.
const LOGIN_WINDOW_MS = 15 * 60 * 1000;
const LOGIN_MAX_PER_EMAIL = 10;
const LOGIN_MAX_PER_IP = 30;
const loginAttempts = new Map();

const tooManyAttempts = (key, max) => {
  const now = Date.now();
  const recent = (loginAttempts.get(key) || []).filter((t) => now - t < LOGIN_WINDOW_MS);
  recent.push(now);
  loginAttempts.set(key, recent);
  if (loginAttempts.size > 10000) {
    for (const [k, v] of loginAttempts) if (!v.some((t) => now - t < LOGIN_WINDOW_MS)) loginAttempts.delete(k);
  }
  return recent.length > max;
};

const clientIp = (req) => String(req.headers["x-forwarded-for"] || "").split(",")[0].trim() || req.ip;

// ── Sign-in page ──
const renderLoginPage = (res, { ctx, clientName, email = "", error = "", status = 200 }) => {
  res.status(status);
  res.set({
    "Content-Type": "text/html; charset=utf-8",
    "Cache-Control": "no-store",
    "X-Frame-Options": "DENY",
    "Content-Security-Policy": "default-src 'none'; style-src 'unsafe-inline'; frame-ancestors 'none'",
    "Referrer-Policy": "no-referrer",
  });
  res.send(`<!doctype html>
<html lang="en">
<head>
<meta charset="utf-8">
<meta name="viewport" content="width=device-width, initial-scale=1">
<title>Connect ${escapeHtml(clientName)} to your CRM</title>
<style>
  :root { color-scheme: light dark; --bg:#f1f5f9; --card:#fff; --text:#0f172a; --muted:#475569; --border:#cbd5e1; --accent:#2563eb; --err-bg:#fef2f2; --err:#b91c1c; }
  @media (prefers-color-scheme: dark) { :root { --bg:#0f172a; --card:#1e293b; --text:#f1f5f9; --muted:#94a3b8; --border:#334155; --err-bg:#450a0a; --err:#fecaca; } }
  * { box-sizing: border-box; }
  body { margin:0; min-height:100vh; display:flex; align-items:center; justify-content:center; padding:16px; background:var(--bg); color:var(--text); font:15px/1.5 -apple-system,BlinkMacSystemFont,"Segoe UI",Roboto,sans-serif; }
  main { width:100%; max-width:400px; background:var(--card); border:1px solid var(--border); border-radius:12px; padding:28px; }
  h1 { font-size:20px; margin:0 0 8px; }
  p { margin:0 0 16px; color:var(--muted); }
  ul { margin:0 0 20px; padding-left:20px; color:var(--muted); }
  label { display:block; font-weight:600; margin:12px 0 4px; }
  input { width:100%; padding:10px 12px; border:1px solid var(--border); border-radius:8px; font:inherit; background:var(--card); color:var(--text); }
  .err { background:var(--err-bg); color:var(--err); border-radius:8px; padding:10px 12px; margin-bottom:12px; }
  .row { display:flex; gap:10px; margin-top:20px; }
  button { flex:1; padding:11px; border-radius:8px; font:inherit; font-weight:600; cursor:pointer; border:1px solid var(--border); background:transparent; color:var(--text); }
  button.primary { background:var(--accent); border-color:var(--accent); color:#fff; }
</style>
</head>
<body>
<main>
  <h1>Connect ${escapeHtml(clientName)} to your CRM</h1>
  <p>Sign in with your CRM account. ${escapeHtml(clientName)} will then be able to, as you and only within your role's permissions:</p>
  <ul>
    <li>search and read your company's CRM records</li>
    <li>create and update leads, customers, tasks, projects, tickets, expenses and meetings</li>
    <li>delete records, only after you confirm twice</li>
  </ul>
  ${error ? `<div class="err" role="alert">${escapeHtml(error)}</div>` : ""}
  <form method="post" action="/mcp-oauth/login">
    <input type="hidden" name="ctx" value="${escapeHtml(ctx)}">
    <label for="email">Email</label>
    <input id="email" name="email" type="email" autocomplete="username" required value="${escapeHtml(email)}">
    <label for="password">Password</label>
    <input id="password" name="password" type="password" autocomplete="current-password" required>
    <div class="row">
      <button type="submit" name="decision" value="deny" formnovalidate>Cancel</button>
      <button type="submit" name="decision" value="allow" class="primary">Allow</button>
    </div>
  </form>
</main>
</body>
</html>`);
};

const redirectWith = (redirectUri, params) => {
  const url = new URL(redirectUri);
  for (const [k, v] of Object.entries(params)) if (v !== undefined && v !== null) url.searchParams.set(k, v);
  return url.href;
};

// The Trinetra pilot company signs its staff in with an emailed OTP. The
// connector's page doesn't do OTP yet, so those accounts can't connect rather
// than skipping their second factor.
const requiresOtp = async (staff) => {
  if (!staff.tenant_id) return false;
  const tenant = await Tenant.findById(staff.tenant_id).select("owner_id").lean();
  if (!tenant?.owner_id) return false;
  const owner = await Staff.findById(tenant.owner_id).select("email").lean();
  return isTrinetraPilotUser(owner) && !isTrinetraPilotUser(staff);
};

/**
 * Creates the provider for mcpAuthRouter plus the router for the sign-in
 * form's POST. `mcpUrl` is the public URL of /mcp: tokens are only issued
 * for, and only accepted by, that resource.
 */
const createOAuthProvider = ({ mcpUrl }) => {
  const resourceHref = mcpUrl.href;

  const clientsStore = {
    async getClient(clientId) {
      const row = await McpOAuthClient.findOne({ client_id: String(clientId) }).lean();
      return row?.info;
    },
    async registerClient(client) {
      const info = { ...client, client_id: client.client_id || crypto.randomUUID() };
      info.client_id_issued_at = info.client_id_issued_at || Math.floor(Date.now() / 1000);
      await McpOAuthClient.create({ client_id: info.client_id, info });
      return info;
    },
  };

  const checkResource = (resource) => {
    if (resource && resource.href !== resourceHref) {
      throw new InvalidGrantError(`Tokens can only be issued for ${resourceHref}`);
    }
  };

  const issueTokens = async (client, staff, scopes) => {
    const access = randomToken();
    const refresh = randomToken();
    const now = Date.now();
    await McpOAuthToken.create({
      access_hash: sha256(access),
      refresh_hash: sha256(refresh),
      client_id: client.client_id,
      client_name: client.client_name,
      staff_id: staff._id,
      tenant_id: staff.tenant_id,
      scopes,
      resource: resourceHref,
      access_expires_at: new Date(now + ACCESS_TTL_S * 1000),
      refresh_expires_at: new Date(now + REFRESH_TTL_S * 1000),
    });
    return {
      access_token: access,
      token_type: "Bearer",
      expires_in: ACCESS_TTL_S,
      refresh_token: refresh,
      ...(scopes?.length ? { scope: scopes.join(" ") } : {}),
    };
  };

  const provider = {
    get clientsStore() {
      return clientsStore;
    },

    // Called by the SDK's /authorize handler once client_id and
    // redirect_uri are validated: show the sign-in page.
    async authorize(client, params, res) {
      checkResource(params.resource);
      const ctx = signContext({
        c: client.client_id,
        r: params.redirectUri,
        cc: params.codeChallenge,
        s: params.state,
        sc: params.scopes || [],
        exp: Math.floor(Date.now() / 1000) + LOGIN_CONTEXT_TTL_S,
      });
      renderLoginPage(res, { ctx, clientName: client.client_name || "Claude" });
    },

    async challengeForAuthorizationCode(client, authorizationCode) {
      const row = await McpOAuthCode.findOne({ code_hash: sha256(authorizationCode) }).lean();
      if (!row || row.used || row.client_id !== client.client_id || row.expires_at < new Date()) {
        throw new InvalidGrantError("Invalid or expired authorization code");
      }
      return row.code_challenge;
    },

    async exchangeAuthorizationCode(client, authorizationCode, _codeVerifier, redirectUri, resource) {
      checkResource(resource);
      // Atomic single use: a replayed code finds nothing.
      const row = await McpOAuthCode.findOneAndUpdate(
        { code_hash: sha256(authorizationCode), used: false },
        { $set: { used: true } },
        { new: true }
      ).lean();
      if (!row || row.client_id !== client.client_id || row.expires_at < new Date()) {
        throw new InvalidGrantError("Invalid or expired authorization code");
      }
      if (redirectUri && redirectUri !== row.redirect_uri) throw new InvalidGrantError("redirect_uri does not match");

      const { user, error } = await loadConnectorUser(row.staff_id);
      if (error) throw new InvalidGrantError(error);
      return issueTokens(client, user, row.scopes);
    },

    async exchangeRefreshToken(client, refreshToken, scopes, resource) {
      checkResource(resource);
      const row = await McpOAuthToken.findOneAndUpdate(
        { refresh_hash: sha256(refreshToken), revoked: false },
        { $set: { revoked: true } },
        { new: true }
      ).lean();
      if (!row || row.client_id !== client.client_id || row.refresh_expires_at < new Date()) {
        throw new InvalidGrantError("Invalid or expired refresh token");
      }
      const { user, error } = await loadConnectorUser(row.staff_id);
      if (error) throw new InvalidGrantError(error);
      // A refresh may narrow the scopes, never widen them.
      const granted = scopes?.length ? scopes.filter((s) => (row.scopes || []).includes(s)) : row.scopes;
      return issueTokens(client, user, granted);
    },

    async verifyAccessToken(token) {
      const row = await McpOAuthToken.findOne({ access_hash: sha256(token) }).lean();
      if (!row || row.revoked || row.access_expires_at < new Date() || row.resource !== resourceHref) {
        throw new InvalidTokenError("Invalid or expired access token");
      }
      if (!row.last_used_at || Date.now() - new Date(row.last_used_at).getTime() > 5 * 60 * 1000) {
        McpOAuthToken.updateOne({ _id: row._id }, { $set: { last_used_at: new Date() } }).catch(() => {});
      }
      return {
        token,
        clientId: row.client_id,
        scopes: row.scopes || [],
        expiresAt: Math.floor(new Date(row.access_expires_at).getTime() / 1000),
        resource: new URL(row.resource),
        extra: { staffId: String(row.staff_id) },
      };
    },

    async revokeToken(client, { token }) {
      const hash = sha256(token);
      await McpOAuthToken.updateMany(
        { client_id: client.client_id, $or: [{ access_hash: hash }, { refresh_hash: hash }] },
        { $set: { revoked: true } }
      );
    },
  };

  // POST /mcp-oauth/login: the sign-in form. Success redirects back to Claude
  // with a one-time code; Cancel redirects back with access_denied.
  const loginRouter = express.Router();
  loginRouter.post("/", express.urlencoded({ extended: false, limit: "10kb" }), async (req, res) => {
    const ctx = readContext(req.body?.ctx);
    if (!ctx) {
      return res.status(400).type("text/plain").send("This sign-in link has expired. Go back to Claude and connect again.");
    }
    const client = await clientsStore.getClient(ctx.c);
    if (!client || !client.redirect_uris?.includes(ctx.r)) {
      return res.status(400).type("text/plain").send("Unknown application. Go back to Claude and connect again.");
    }
    const clientName = client.client_name || "Claude";

    if (req.body.decision !== "allow") {
      return res.redirect(302, redirectWith(ctx.r, { error: "access_denied", error_description: "The user cancelled sign-in", state: ctx.s }));
    }

    const email = String(req.body.email || "").trim().toLowerCase();
    const password = String(req.body.password || "");
    const fail = (error, status = 401) => renderLoginPage(res, { ctx: req.body.ctx, clientName, email, error, status });

    if (tooManyAttempts(`ip:${clientIp(req)}`, LOGIN_MAX_PER_IP) || tooManyAttempts(`email:${email}`, LOGIN_MAX_PER_EMAIL)) {
      return fail("Too many sign-in attempts. Please wait 15 minutes and try again.", 429);
    }
    if (!email || !password) return fail("Enter your email and password.", 400);

    const staff = await Staff.findOne({ email });
    if (!staff || !(await staff.matchPassword(password))) return fail("Invalid email or password.");

    const { user, error } = await loadConnectorUser(staff._id);
    if (error) return fail(error, 403);
    if (await requiresOtp(user)) {
      return fail("Your company signs in with an email code, which the Claude connector doesn't support yet.", 403);
    }

    const code = randomToken();
    await McpOAuthCode.create({
      code_hash: sha256(code),
      client_id: client.client_id,
      staff_id: user._id,
      tenant_id: user.tenant_id,
      code_challenge: ctx.cc,
      redirect_uri: ctx.r,
      scopes: ctx.sc,
      resource: resourceHref,
      expires_at: new Date(Date.now() + CODE_TTL_S * 1000),
    });

    const who = [user.firstname, user.lastname].filter(Boolean).join(" ") || user.email;
    ActivityLog.create({
      description: `${who} connected ${clientName} to the CRM`,
      staffid: user._id,
      tenant_id: user.tenant_id,
    }).catch((err) => console.error("[mcp] activity log failed:", err.message));

    return res.redirect(302, redirectWith(ctx.r, { code, state: ctx.s }));
  });

  return { provider, loginRouter };
};

module.exports = { createOAuthProvider };
