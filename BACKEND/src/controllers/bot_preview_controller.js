const Setting = require("../models/Setting");
const Tenant = require("../models/Tenant");
const { getRequestHost, resolveTenantByHost } = require("../utils/resolveTenantByHost");

// Serves a minimal, valid HTML document with live Open Graph/Twitter meta
// tags for social-media crawlers only. Standard nginx (no Lua/njs module)
// can't fetch live settings data itself, so it instead proxies known bot
// User-Agents here — this process already has direct DB access to Settings,
// no extra HTTP round trip needed like the (unused, wrong-platform) Netlify
// Edge Function version required. Real visitors never hit this route; nginx
// keeps serving them the actual SPA from static files, untouched.
const FRONTEND_ORIGIN = process.env.FRONTEND_ORIGIN || "https://crm.citysmile.in";
const BACKEND_ORIGIN_PUBLIC = process.env.BACKEND_ORIGIN_PUBLIC || "https://api.citysmile.in";

const escapeHtml = (str) =>
  String(str ?? "")
    .replace(/&/g, "&amp;")
    .replace(/</g, "&lt;")
    .replace(/>/g, "&gt;")
    .replace(/"/g, "&quot;");

// Mirrors Frontend/src/lib/resolveImageUrl.ts's rules, but always returns an
// ABSOLUTE url since og:image/twitter:image are only valid as fully-qualified
// URLs — returns null when no image is set so callers can omit the tag
// entirely rather than falling back to logo-icon.png (which is actually the
// Trinetra logo — a pre-existing mislabeled asset in the repo).
const resolveOgImageUrl = (val) => {
  const trimmed = String(val || "").trim();
  if (!trimmed) return null;
  if (/^(data:|https?:|blob:)/.test(trimmed)) return trimmed;
  if (/^\/(trinetra-|favicon\.ico|icons\/)/.test(trimmed)) return `${FRONTEND_ORIGIN}${trimmed}`;

  const parts = trimmed.split(/[/\\]/);
  const uploadsIndex = parts.findIndex((p) => p.toLowerCase() === "uploads");
  if (uploadsIndex !== -1) return `${BACKEND_ORIGIN_PUBLIC}/${parts.slice(uploadsIndex).join("/")}`;
  if (trimmed.startsWith("/")) return `${BACKEND_ORIGIN_PUBLIC}${trimmed}`;
  return `${BACKEND_ORIGIN_PUBLIC}/uploads/logos/${trimmed}`;
};

const botPreview = async (req, res) => {
  try {
    const globalSettings = await Setting.find({ tenant_id: null });
    const byName = {};
    globalSettings.forEach((s) => {
      byName[s.name] = s.value;
    });

    // Override with the requesting domain's own tenant settings (e.g.
    // rudraverse.trinetratechnoworld.com shows "Fuerte CRM" instead of the
    // global company name) — same host resolution used for per-tenant
    // branding in setting_controller.js. Only the matched tenant's own
    // domain is affected; every other domain keeps the global fallback.
    //
    // The frontend's .htaccess reaches this route via an external redirect
    // (R=302), not a reverse proxy — the crawler's request lands here as a
    // fresh request to this backend's own host, so Origin/Host/X-Forwarded-Host
    // never carry the original tenant domain. The redirect rule instead
    // forwards it explicitly as ?host=, which takes priority; the normal
    // header-based resolution stays as a fallback for any other caller.
    const requestedHost = typeof req.query.host === "string" ? req.query.host.toLowerCase() : "";
    const host = requestedHost || getRequestHost(req);
    const tenant = host ? await resolveTenantByHost(host) : null;
    if (tenant) {
      const tenantSettings = await Setting.find({ tenant_id: tenant._id });
      tenantSettings.forEach((s) => {
        byName[s.name] = s.value;
      });
      if (tenant.company_name) byName.companyName = tenant.company_name;
    }

    const ogImage = resolveOgImageUrl(byName.ogImage || byName.compLogoDark || byName.compLogoLight);
    const companyName = byName.companyName || "CRMPro";
    const title = `${companyName} — CRM Dashboard`;
    const description = `${companyName}'s CRM — manage leads, customers, and your team in one place.`;

    const rawPath = typeof req.query.path === "string" && req.query.path.startsWith("/") ? req.query.path : "/welcome";
    const pageUrl = `${FRONTEND_ORIGIN}${rawPath}`;

    // Only emit og:image/twitter:image when we have a real URL — omitting the
    // tag entirely is better than serving a broken/wrong placeholder image.
    const imageTags = ogImage
      ? `<meta property="og:image" content="${escapeHtml(ogImage)}" />
<meta name="twitter:image" content="${escapeHtml(ogImage)}" />`
      : "";

    res.set("Content-Type", "text/html; charset=utf-8");
    res.send(`<!doctype html>
<html lang="en">
<head>
<meta charset="UTF-8" />
<title>${escapeHtml(title)}</title>
<meta name="description" content="${escapeHtml(description)}" />
<meta property="og:title" content="${escapeHtml(title)}" />
<meta property="og:description" content="${escapeHtml(description)}" />
<meta property="og:type" content="website" />
<meta property="og:url" content="${escapeHtml(pageUrl)}" />
${imageTags}
<meta name="twitter:card" content="summary_large_image" />
<meta name="twitter:title" content="${escapeHtml(title)}" />
<meta name="twitter:description" content="${escapeHtml(description)}" />
</head>
<body></body>
</html>`);
  } catch (error) {
    // Never fail a crawler request outright — fall back to a bare document
    // with no dynamic data rather than a 500.
    res.status(200).set("Content-Type", "text/html; charset=utf-8").send("<!doctype html><html><head></head><body></body></html>");
  }
};

module.exports = { botPreview };
