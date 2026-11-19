const axios = require("axios");
const dns = require("dns").promises;
const net = require("net");
const ExternalDataSource = require("../models/ExternalDataSource");

const FETCH_TIMEOUT_MS = 8000;
const MAX_RESPONSE_BYTES = 5 * 1024 * 1024;

// The server fetches the admin's URL, so it must never be pointed at the
// server itself or the private network (e.g. the cloud metadata service at
// 169.254.169.254, localhost databases, 10.x / 192.168.x hosts).
const isPrivateAddress = (ip) => {
  if (net.isIPv4(ip)) {
    const [a, b] = ip.split(".").map(Number);
    return a === 0 || a === 10 || a === 127 || (a === 100 && b >= 64 && b <= 127) || (a === 169 && b === 254) ||
      (a === 172 && b >= 16 && b <= 31) || (a === 192 && b === 168) || a >= 224;
  }
  const v6 = ip.toLowerCase();
  if (v6.startsWith("::ffff:")) return isPrivateAddress(v6.slice(7));
  return v6 === "::" || v6 === "::1" || v6.startsWith("fc") || v6.startsWith("fd") || v6.startsWith("fe8") || v6.startsWith("fe9") || v6.startsWith("fea") || v6.startsWith("feb");
};
const blockedHostReason = async (hostname) => {
  const host = hostname.replace(/^\[|\]$/g, "");
  if (/^localhost$/i.test(host) || /\.local(host)?$/i.test(host)) return "Local addresses are not allowed.";
  let addresses;
  try {
    addresses = net.isIP(host) ? [{ address: host }] : await dns.lookup(host, { all: true });
  } catch {
    return "Could not find this website (DNS lookup failed).";
  }
  return addresses.some((a) => isPrivateAddress(a.address)) ? "Private / internal network addresses are not allowed." : null;
};

const maskSecret = (value) => {
  if (!value) return "";
  if (value.length <= 4) return "••••••••";
  return `••••••••${value.slice(-2)}`;
};

// Never send stored secrets back to the browser in full — only enough to
// show the admin a source is configured, same convention as MetaIntegration's
// maskToken.
const toSafeJson = (doc) => ({
  _id: doc._id,
  tenant_id: doc.tenant_id,
  name: doc.name,
  api_url: doc.api_url,
  method: doc.method,
  api_key_masked: maskSecret(doc.api_key),
  api_password_masked: maskSecret(doc.api_password),
  has_api_key: !!doc.api_key,
  has_api_password: !!doc.api_password,
  data_path: doc.data_path,
  createdAt: doc.createdAt,
  updatedAt: doc.updatedAt,
});

const listSources = async (req, res) => {
  try {
    const sources = await ExternalDataSource.find({ tenant_id: req.user.tenant_id }).sort({ createdAt: 1 });
    res.json(sources.map(toSafeJson));
  } catch (error) {
    res.status(500).json({ message: error.message });
  }
};

const createSource = async (req, res) => {
  try {
    const { name, api_url, method, api_key, api_password, data_path } = req.body;
    if (!name || !api_url) {
      return res.status(400).json({ message: "Name and API URL are required" });
    }
    const source = await ExternalDataSource.create({
      tenant_id: req.user.tenant_id,
      name,
      api_url,
      method: method === "POST" ? "POST" : "GET",
      api_key: api_key || undefined,
      api_password: api_password || undefined,
      data_path: data_path || undefined,
    });
    res.status(201).json(toSafeJson(source));
  } catch (error) {
    res.status(500).json({ message: error.message });
  }
};

const updateSource = async (req, res) => {
  try {
    const source = await ExternalDataSource.findOne({ _id: req.params.id, tenant_id: req.user.tenant_id });
    if (!source) return res.status(404).json({ message: "Data source not found" });

    const { name, api_url, method, api_key, api_password, data_path } = req.body;
    if (name !== undefined) source.name = name;
    if (api_url !== undefined) source.api_url = api_url;
    if (method !== undefined) source.method = method === "POST" ? "POST" : "GET";
    // Empty string means "clear the credential"; undefined means "leave it alone"
    // (the edit form only shows a masked placeholder, never the real secret).
    if (api_key !== undefined) source.api_key = api_key || undefined;
    if (api_password !== undefined) source.api_password = api_password || undefined;
    if (data_path !== undefined) source.data_path = data_path || undefined;

    await source.save();
    res.json(toSafeJson(source));
  } catch (error) {
    res.status(500).json({ message: error.message });
  }
};

const deleteSource = async (req, res) => {
  try {
    const source = await ExternalDataSource.findOneAndDelete({ _id: req.params.id, tenant_id: req.user.tenant_id });
    if (!source) return res.status(404).json({ message: "Data source not found" });
    res.json({ message: "Data source removed" });
  } catch (error) {
    res.status(500).json({ message: error.message });
  }
};

// Resolves a dot-path like "data.items" against a parsed JSON object.
// Returns undefined if any segment along the way is missing.
const resolvePath = (obj, path) => {
  if (!path) return undefined;
  return path.split(".").reduce((acc, key) => (acc && typeof acc === "object" ? acc[key] : undefined), obj);
};

// Turns whatever shape an external API returns into a flat array of rows,
// so the Dashboard can render it as a table without knowing the shape ahead
// of time.
const extractRows = (payload, dataPath) => {
  if (Array.isArray(payload)) return payload;

  if (dataPath) {
    const atPath = resolvePath(payload, dataPath);
    if (Array.isArray(atPath)) return atPath;
  }

  if (payload && typeof payload === "object") {
    const firstArrayValue = Object.values(payload).find((v) => Array.isArray(v));
    if (firstArrayValue) return firstArrayValue;
    return [payload];
  }

  return [];
};

// Server-side proxy — the browser never calls the admin's external API
// directly (avoids CORS and keeps any credentials off the client).
const fetchData = async (req, res) => {
  try {
    const source = await ExternalDataSource.findOne({ _id: req.params.id, tenant_id: req.user.tenant_id });
    if (!source) return res.status(404).json({ message: "Data source not found" });

    let parsedUrl;
    try {
      parsedUrl = new URL(source.api_url);
    } catch {
      return res.json({ name: source.name, error: "This data source's API URL is not valid." });
    }
    if (!["http:", "https:"].includes(parsedUrl.protocol)) {
      return res.json({ name: source.name, error: "Only http:// and https:// API URLs are supported." });
    }
    const blocked = await blockedHostReason(parsedUrl.hostname);
    if (blocked) return res.json({ name: source.name, error: blocked });

    const headers = {};
    if (source.api_key) headers["X-API-Key"] = source.api_key;
    if (source.api_password) headers["X-API-Password"] = source.api_password;
    for (const h of source.headers || []) {
      if (h.key) headers[h.key] = h.value;
    }

    let response;
    try {
      response = await axios.request({
        url: source.api_url,
        method: source.method || "GET",
        headers,
        timeout: FETCH_TIMEOUT_MS,
        // A redirect could lead to an internal address; a huge body could exhaust memory.
        maxRedirects: 0,
        maxContentLength: MAX_RESPONSE_BYTES,
      });
    } catch (fetchErr) {
      const reason = fetchErr.code === "ECONNABORTED"
        ? "The request timed out."
        : fetchErr.code === "ERR_FR_MAX_BODY_LENGTH_EXCEEDED" || /maxContentLength/i.test(fetchErr.message || "")
        ? "The response is too large (over 5 MB)."
        : fetchErr.response && fetchErr.response.status >= 300 && fetchErr.response.status < 400
        ? "The API URL redirects to another address — use the final URL."
        : fetchErr.response
          ? `The website returned an error (status ${fetchErr.response.status}).`
          : "Could not reach this API URL.";
      return res.json({ name: source.name, error: reason });
    }

    const rows = extractRows(response.data, source.data_path);
    res.json({ name: source.name, rows });
  } catch (error) {
    res.status(500).json({ message: error.message });
  }
};

module.exports = {
  listSources,
  createSource,
  updateSource,
  deleteSource,
  fetchData,
};
