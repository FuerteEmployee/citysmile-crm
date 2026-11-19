// Runs the REAL Chrome extension scripts (chrome-extension/api.js + background.js,
// unmodified) inside a Node vm context with a fake `chrome` API, so their HTTP calls
// go to the in-memory test backend. Used by __tests__/bookmarks/bookmarks.extension.test.js.
const fs = require("fs");
const path = require("path");
const vm = require("vm");

const EXT_DIR = path.resolve(__dirname, "../../../chrome-extension");

function loadExtension({ storage = {}, tree = [] } = {}) {
  const store = { ...storage };
  const listeners = { created: [], moved: [], removed: [], importBegan: [], importEnded: [], message: [] };
  const badge = { text: "", color: null, title: "" };
  const calls = [];
  const pending = new Set();
  let nodes = tree;

  const findNode = (id, list = nodes) => {
    for (const n of list) {
      if (String(n.id) === String(id)) return n;
      const hit = n.children && findNode(id, n.children);
      if (hit) return hit;
    }
    return null;
  };
  const ev = (arr) => ({ addListener: (fn) => arr.push(fn) });

  const chrome = {
    storage: {
      local: {
        get: (keys, cb) => {
          const out = {};
          (Array.isArray(keys) ? keys : [keys]).forEach((k) => { if (k in store) out[k] = store[k]; });
          setImmediate(() => cb(out));
        },
        set: (vals, cb) => { Object.assign(store, vals); if (cb) setImmediate(cb); },
      },
    },
    bookmarks: {
      getTree: async () => nodes,
      get: async (id) => { const n = findNode(id); if (!n) throw new Error("not found"); return [n]; },
      onCreated: ev(listeners.created), onMoved: ev(listeners.moved), onRemoved: ev(listeners.removed),
      onImportBegan: ev(listeners.importBegan), onImportEnded: ev(listeners.importEnded),
    },
    action: {
      setBadgeText: ({ text }) => { badge.text = text; },
      setBadgeBackgroundColor: ({ color }) => { badge.color = color; },
      setTitle: ({ title }) => { badge.title = title; },
    },
    runtime: { onMessage: ev(listeners.message) },
  };

  const trackedFetch = (url, opts = {}) => {
    calls.push({ url: String(url), method: opts.method || "GET", body: opts.body ? JSON.parse(opts.body) : undefined });
    const p = fetch(url, opts);
    pending.add(p);
    p.finally(() => pending.delete(p)).catch(() => {});
    return p;
  };

  const ctx = vm.createContext({
    chrome, fetch: trackedFetch, atob, console, setTimeout, clearTimeout, setImmediate, URL, encodeURIComponent, Date, JSON, Promise,
    importScripts: () => {}, // api.js is loaded below into the same global scope
  });
  vm.runInContext(fs.readFileSync(path.join(EXT_DIR, "api.js"), "utf8"), ctx, { filename: "api.js" });
  vm.runInContext(fs.readFileSync(path.join(EXT_DIR, "background.js"), "utf8"), ctx, { filename: "background.js" });

  // Wait until every async listener and fetch has finished.
  const idle = async () => {
    for (let i = 0; i < 50; i++) {
      await new Promise((r) => setTimeout(r, 30));
      if (pending.size === 0) { await new Promise((r) => setTimeout(r, 60)); if (pending.size === 0) return; }
    }
  };
  const sendMessage = (msg) => new Promise((resolve) => {
    for (const fn of listeners.message) fn(msg, {}, resolve);
  });

  return {
    store, listeners, badge, calls, idle, sendMessage, ctx,
    setTree: (t) => { nodes = t; },
    fire: (name, ...args) => listeners[name].forEach((fn) => fn(...args)),
  };
}

module.exports = { loadExtension, EXT_DIR };
