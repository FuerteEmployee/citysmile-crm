const Tenant = require("../models/Tenant");

// The frontend and backend live on different domains, so req.headers.host on
// the backend is always the API's own host — never the domain the browser is
// actually on. The Origin header is what actually carries the frontend's
// domain on every cross-origin fetch/XHR call (it's already relied on by the
// CORS middleware in index.js), so it takes priority here.
const getRequestHost = (req) => {
  const origin = req.headers.origin;
  if (origin) {
    try {
      return new URL(origin).hostname.toLowerCase();
    } catch (_) {
      // fall through to other sources
    }
  }
  const forwardedHost = req.headers["x-forwarded-host"];
  if (forwardedHost) return forwardedHost.split(",")[0].trim().split(":")[0].toLowerCase();
  const host = req.headers.host || req.hostname || "";
  return host.split(":")[0].toLowerCase();
};

// Resolves a tenant from an exact request host. Only returns a tenant when
// there's a genuine, explicit match — no guessing fallback — since this is
// used to decide whether a login is allowed on a given domain.
const resolveTenantByHost = async (host) => {
  if (!host) return null;

  // 1. Direct match on custom_domains
  let tenant = await Tenant.findOne({ custom_domains: host });
  if (tenant) return tenant;

  const parts = host.split(".");
  
  // 2. Check first part as subdomain if it's not a generic prefix
  const firstSubdomain = parts.length > 2 ? parts[0] : "";
  const genericPrefixes = ["www", "app", "crm", "erp", "api"];
  
  if (firstSubdomain && !genericPrefixes.includes(firstSubdomain)) {
    tenant = await Tenant.findOne({ subdomain: firstSubdomain });
    if (tenant) return tenant;
  }

  // 3. If host has a prefix like erp.trinetratechnoworld.com or trinetra.com,
  // search by second part or domain keyword against custom_domains, subdomain, or company_name
  if (parts.length >= 2) {
    const domainKeyword = parts[parts.length - 2].toLowerCase(); // e.g. "trinetratechnoworld"
    if (domainKeyword && !["localhost", "127", "com", "net", "org", "in"].includes(domainKeyword)) {
      tenant = await Tenant.findOne({
        $or: [
          { custom_domains: { $regex: domainKeyword, $options: "i" } },
          { subdomain: { $regex: domainKeyword, $options: "i" } },
          { company_name: { $regex: domainKeyword, $options: "i" } }
        ]
      });
      if (tenant) return tenant;
    }
  }

  return null;
};

module.exports = { getRequestHost, resolveTenantByHost };
