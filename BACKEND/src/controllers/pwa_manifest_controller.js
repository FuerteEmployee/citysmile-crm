const Setting = require("../models/Setting");

// The manifest is served at /manifest.webmanifest on the frontend domain, but
// nginx proxies that path here so we can return a dynamically-generated JSON
// that reflects whatever favicon/logo the admin has uploaded in Settings.
// This makes the PWA "Install app" dialog show the real company icon instead
// of the hardcoded Trinetra fallback icon that was baked into the static file.
const FRONTEND_ORIGIN = process.env.FRONTEND_ORIGIN || "https://crm.citysmile.in";
const BACKEND_ORIGIN_PUBLIC = process.env.BACKEND_ORIGIN_PUBLIC || "https://api.citysmile.in";

const resolveIconUrl = (val) => {
  const trimmed = String(val || "").trim();
  if (!trimmed) return null;
  if (/^(data:|https?:|blob:)/.test(trimmed)) return trimmed;
  // Static frontend assets (trinetra branding, generic icons)
  if (/^\/(trinetra-|favicon\.ico|icons\/)/.test(trimmed)) return `${FRONTEND_ORIGIN}${trimmed}`;
  const parts = trimmed.split(/[/\\]/);
  const uploadsIndex = parts.findIndex((p) => p.toLowerCase() === "uploads");
  if (uploadsIndex !== -1) return `${BACKEND_ORIGIN_PUBLIC}/${parts.slice(uploadsIndex).join("/")}`;
  if (trimmed.startsWith("/")) return `${BACKEND_ORIGIN_PUBLIC}${trimmed}`;
  return `${BACKEND_ORIGIN_PUBLIC}/uploads/logos/${trimmed}`;
};

// Guess the MIME type from the URL so the manifest icon type field is correct.
const guessMimeType = (url) => {
  if (!url) return "image/png";
  const ext = url.split("?")[0].split(".").pop().toLowerCase();
  const map = {
    jpg: "image/jpeg",
    jpeg: "image/jpeg",
    png: "image/png",
    webp: "image/webp",
    svg: "image/svg+xml",
    gif: "image/gif",
  };
  return map[ext] || "image/png";
};

const pwaManifest = async (req, res) => {
  try {
    const globalSettings = await Setting.find({ tenant_id: null });
    const byName = {};
    globalSettings.forEach((s) => {
      byName[s.name] = s.value;
    });

    const companyName = byName.companyName || "CRMPro";

    // Prefer the dedicated favicon, fall back through logos, then OG image.
    const iconSource =
      byName.favicon ||
      byName.compLogoLight ||
      byName.compLogoDark ||
      byName.ogImage;

    const iconUrl = resolveIconUrl(iconSource);
    const mimeType = guessMimeType(iconUrl);

    // Fall back to the generic PWA icons already in /icons/ if nothing has
    // been uploaded yet — better than an empty icons array which causes some
    // browsers to skip the install prompt entirely.
    const icons = iconUrl
      ? [
          { src: iconUrl, sizes: "192x192", type: mimeType, purpose: "any" },
          { src: iconUrl, sizes: "512x512", type: mimeType, purpose: "any maskable" },
        ]
      : [
          { src: `${FRONTEND_ORIGIN}/icons/icon-192.png`, sizes: "192x192", type: "image/png", purpose: "any" },
          { src: `${FRONTEND_ORIGIN}/icons/icon-512.png`, sizes: "512x512", type: "image/png", purpose: "any maskable" },
        ];

    const manifest = {
      name: companyName,
      short_name: companyName,
      description: `${companyName} — CRM Dashboard`,
      start_url: "/",
      scope: "/",
      display: "standalone",
      background_color: "#ffffff",
      theme_color: "#1e293b",
      icons,
    };

    res.set("Content-Type", "application/manifest+json");
    // Never cache — we want the logo change to reflect immediately on the
    // next page load without stale-manifest issues.
    res.set("Cache-Control", "no-cache, must-revalidate");
    res.json(manifest);
  } catch (error) {
    // Return a bare-minimum manifest rather than failing; the browser won't
    // show the install prompt if the manifest endpoint returns an error.
    res.set("Content-Type", "application/manifest+json");
    res.json({
      name: "CRMPro",
      short_name: "CRMPro",
      start_url: "/",
      scope: "/",
      display: "standalone",
      background_color: "#ffffff",
      theme_color: "#1e293b",
      icons: [],
    });
  }
};

module.exports = { pwaManifest };
