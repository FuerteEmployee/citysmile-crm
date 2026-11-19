const axios = require("axios");
const MetaAdAccount = require("../models/MetaAdAccount");
const MarketingSpend = require("../models/MarketingSpend");
const Lead = require("../models/Lead");
const { decryptSecret } = require("../utils/secretBox");
const { toDayString, addDays, startOfDay } = require("../utils/appDate");
const { tenantHasFeature } = require("../utils/tenantFeatures");

const GRAPH_VERSION = process.env.META_GRAPH_VERSION || "v21.0";
const GRAPH = `https://graph.facebook.com/${GRAPH_VERSION}`;
const MAX_INSIGHT_PAGES = 50;

const round2 = (n) => Math.round((Number(n) || 0) * 100) / 100;

const graphError = (err) =>
  err?.response?.data?.error?.message || err?.message || "Meta Graph API request failed";

// "act_123", "123" → "123"; anything else → null.
const normalizeAdAccountId = (raw) => {
  const id = String(raw || "").trim().replace(/^act_/i, "");
  return /^\d{5,25}$/.test(id) ? id : null;
};

// Validates the token can read this ad account (needs ads_read).
const fetchAdAccount = async (adAccountId, token) => {
  const { data } = await axios.get(`${GRAPH}/act_${adAccountId}`, {
    params: { access_token: token, fields: "name,currency,timezone_name,account_status" },
    timeout: 20000,
  });
  return data;
};

const getAccountToken = async (accountId) => {
  const acc = await MetaAdAccount.findById(accountId).select("+access_token_enc");
  return acc ? decryptSecret(acc.access_token_enc) : null;
};

// Daily spend per campaign for one ad account, [since, until] inclusive.
const fetchCampaignSpend = async (adAccountId, token, since, until) => {
  const rows = [];
  let url = `${GRAPH}/act_${adAccountId}/insights`;
  let params = {
    access_token: token,
    level: "campaign",
    fields: "campaign_id,campaign_name,spend,account_currency",
    time_increment: 1,
    time_range: JSON.stringify({ since, until }),
    limit: 500,
  };
  for (let page = 0; url && page < MAX_INSIGHT_PAGES; page++) {
    const { data } = await axios.get(url, { params, timeout: 30000 });
    for (const r of data?.data || []) {
      rows.push({
        day: r.date_start,
        campaign_id: String(r.campaign_id || ""),
        campaign_name: String(r.campaign_name || r.campaign_id || "Meta campaign").trim().slice(0, 200),
        spend: Number(r.spend) || 0,
        currency: r.account_currency || "",
      });
    }
    url = data?.paging?.next || null;
    params = undefined; // the cursor URL already carries every parameter
  }
  return rows;
};

// Follows Graph paging and returns every row.
const fetchAllPages = async (url, params) => {
  const rows = [];
  for (let page = 0; url && page < MAX_INSIGHT_PAGES; page++) {
    const { data } = await axios.get(url, { params, timeout: 30000 });
    rows.push(...(data?.data || []));
    url = data?.paging?.next || null;
    params = undefined;
  }
  return rows;
};

const addPage = (map, campaignId, pageId) => {
  if (!campaignId || !pageId) return;
  const id = String(campaignId);
  if (!map.has(id)) map.set(id, new Set());
  map.get(id).add(String(pageId));
};

/**
 * campaign_id → Set of Facebook Page ids that campaign advertises. Read from
 * each ad set's promoted_object; campaigns whose ad sets don't name a Page
 * (traffic/messaging set-ups) fall back to the Page their ads run as.
 */
const fetchCampaignPageIds = async (adAccountId, token, campaignIds) => {
  const map = new Map();
  const ids = [...new Set(campaignIds.map(String).filter(Boolean))];
  const inCampaigns = (chunk) => JSON.stringify([{ field: "campaign.id", operator: "IN", value: chunk }]);

  for (let i = 0; i < ids.length; i += 50) {
    const adsets = await fetchAllPages(`${GRAPH}/act_${adAccountId}/adsets`, {
      access_token: token,
      fields: "campaign_id,promoted_object",
      filtering: inCampaigns(ids.slice(i, i + 50)),
      limit: 500,
    });
    for (const s of adsets) addPage(map, s.campaign_id, s.promoted_object?.page_id);
  }

  const missing = ids.filter((id) => !map.has(id));
  for (let i = 0; i < missing.length; i += 50) {
    const ads = await fetchAllPages(`${GRAPH}/act_${adAccountId}/ads`, {
      access_token: token,
      fields: "campaign_id,creative{actor_id,object_story_spec{page_id}}",
      filtering: inCampaigns(missing.slice(i, i + 50)),
      limit: 500,
    });
    for (const a of ads) {
      addPage(map, a.campaign_id, a.creative?.object_story_spec?.page_id || a.creative?.actor_id);
    }
  }
  return map;
};

// Keeps only spend rows of campaigns that advertise one of `pageIds`.
const filterRowsByPages = async (adAccountId, token, rows, pageIds) => {
  if (!pageIds?.length) return rows;
  const wanted = new Set(pageIds.map(String));
  const campaignPages = await fetchCampaignPageIds(adAccountId, token, rows.map((r) => r.campaign_id));
  return rows.filter((r) => [...(campaignPages.get(r.campaign_id) || [])].some((p) => wanted.has(p)));
};

/**
 * Facebook Pages advertised from an ad account in the last `days` days, with
 * their spend and a few campaign names, so an admin connecting a shared
 * (agency) ad account can tell which Page is theirs. Page names are included
 * when the token can read them.
 */
const listAdAccountPages = async (adAccountId, token, days = 90) => {
  const until = toDayString();
  const since = addDays(until, -(days - 1));
  const rows = await fetchAllPages(`${GRAPH}/act_${adAccountId}/insights`, {
    access_token: token,
    level: "campaign",
    fields: "campaign_id,campaign_name,spend",
    time_range: JSON.stringify({ since, until }),
    limit: 500,
  });
  const campaignPages = await fetchCampaignPageIds(adAccountId, token, rows.map((r) => r.campaign_id));

  const pages = new Map();
  for (const r of rows) {
    for (const pageId of campaignPages.get(String(r.campaign_id)) || []) {
      const p = pages.get(pageId) || { page_id: pageId, name: "", spend: 0, campaigns: [] };
      p.spend += Number(r.spend) || 0;
      if (r.campaign_name && p.campaigns.length < 3) p.campaigns.push(String(r.campaign_name).slice(0, 80));
      pages.set(pageId, p);
    }
  }

  const list = [...pages.values()].sort((a, b) => b.spend - a.spend);
  await Promise.all(
    list.map(async (p) => {
      p.spend = round2(p.spend);
      try {
        const { data } = await axios.get(`${GRAPH}/${p.page_id}`, {
          params: { access_token: token, fields: "name" },
          timeout: 15000,
        });
        p.name = data?.name || "";
      } catch {
        // token can't read this Page's name — campaign names identify it
      }
    })
  );
  return { since, until, pages: list };
};

// Best-effort: campaign name for an ad, using any active ad account of the tenant.
const resolveCampaignForAd = async (tenantId, adId) => {
  if (!adId) return "";
  const accounts = await MetaAdAccount.find({ tenant_id: tenantId, is_active: true }).select("+access_token_enc");
  for (const acc of accounts) {
    try {
      const { data } = await axios.get(`${GRAPH}/${adId}`, {
        params: { access_token: decryptSecret(acc.access_token_enc), fields: "campaign{name}" },
        timeout: 15000,
      });
      if (data?.campaign?.name) return String(data.campaign.name).trim().slice(0, 200);
    } catch {
      // not this account's ad, or token can't read it — try the next one
    }
  }
  return "";
};

// Fills Lead.campaign for recent Meta leads that know their ad but not its campaign.
const backfillLeadCampaigns = async (tenantId, since) => {
  const leads = await Lead.find({
    tenant_id: tenantId,
    meta_ad_id: { $nin: [null, ""] },
    campaign: { $in: [null, ""] },
    createdAt: { $gte: since },
  })
    .select("_id meta_ad_id")
    .limit(500)
    .lean();
  const cache = new Map();
  let updated = 0;
  for (const l of leads) {
    if (!cache.has(l.meta_ad_id)) cache.set(l.meta_ad_id, await resolveCampaignForAd(tenantId, l.meta_ad_id));
    const name = cache.get(l.meta_ad_id);
    if (name) {
      await Lead.updateOne({ _id: l._id }, { campaign: name });
      updated++;
    }
  }
  return updated;
};

/**
 * Syncs the last `days` days of Meta ad spend for one tenant into
 * MarketingSpend (one row per day + campaign, summed across the tenant's
 * active ad accounts). Returns a summary; per-account errors are recorded on
 * the account and never stop the other accounts.
 */
const runningSyncs = new Set();

const syncTenantSpend = async (tenantId, opts = {}) => {
  const key = String(tenantId);
  if (runningSyncs.has(key)) return { skipped: true, reason: "a sync is already running for this account" };
  runningSyncs.add(key);
  try {
    return await doSyncTenantSpend(tenantId, opts);
  } finally {
    runningSyncs.delete(key);
  }
};

const doSyncTenantSpend = async (tenantId, { days = 3, userId } = {}) => {
  if (!(await tenantHasFeature(tenantId, "marketing_spend"))) {
    return { skipped: true, reason: "marketing_spend feature not enabled" };
  }
  const accounts = await MetaAdAccount.find({ tenant_id: tenantId, is_active: true }).select("+access_token_enc");
  if (!accounts.length) return { skipped: true, reason: "no active ad accounts" };

  const span = Math.min(Math.max(parseInt(days, 10) || 3, 1), 90);
  const until = toDayString();
  const since = addDays(until, -(span - 1));

  const grouped = new Map(); // `${day}|${campaign}` → { day, campaign, amount, ids:Set, currency }
  const results = [];
  let allOk = true;

  for (const acc of accounts) {
    try {
      const token = decryptSecret(acc.access_token_enc);
      const allRows = await fetchCampaignSpend(acc.ad_account_id, token, since, until);
      const rows = await filterRowsByPages(acc.ad_account_id, token, allRows, acc.page_ids);
      for (const r of rows) {
        const key = `${r.day}|${r.campaign_name}`;
        const g = grouped.get(key) || { day: r.day, campaign: r.campaign_name, amount: 0, ids: new Set(), currency: r.currency };
        g.amount += r.spend;
        if (r.campaign_id) g.ids.add(r.campaign_id);
        grouped.set(key, g);
      }
      await MetaAdAccount.updateOne(
        { _id: acc._id },
        { last_synced_at: new Date(), last_sync_status: "ok", last_sync_error: "" }
      );
      results.push({ ad_account_id: acc.ad_account_id, ok: true, rows: rows.length });
    } catch (err) {
      allOk = false;
      const message = graphError(err).slice(0, 500);
      console.error(`[MetaAds] sync failed tenant=${tenantId} act_${acc.ad_account_id}: ${message}`);
      await MetaAdAccount.updateOne(
        { _id: acc._id },
        { last_synced_at: new Date(), last_sync_status: "error", last_sync_error: message }
      );
      results.push({ ad_account_id: acc.ad_account_id, ok: false, error: message });
    }
  }

  const now = new Date();
  let upserted = 0;
  for (const g of grouped.values()) {
    if (!/^\d{4}-\d{2}-\d{2}$/.test(g.day)) continue;
    await MarketingSpend.findOneAndUpdate(
      { tenant_id: tenantId, day: g.day, source: null, campaign: g.campaign },
      {
        $set: {
          date: startOfDay(g.day),
          amount: round2(g.amount),
          source_name: "",
          sync_source: "meta_ads",
          synced_at: now,
          currency: g.currency,
          meta_campaign_ids: [...g.ids],
          updated_by: userId,
        },
        $setOnInsert: { created_by: userId, notes: "Synced from Meta Ads" },
      },
      { upsert: true, setDefaultsOnInsert: true }
    );
    upserted++;
  }

  // Campaigns that no longer report spend for a day in the window. Only when
  // every account synced, so a failing account never wipes its own rows.
  let removed = 0;
  if (allOk) {
    const keep = new Set(grouped.keys());
    const existing = await MarketingSpend.find({
      tenant_id: tenantId,
      sync_source: "meta_ads",
      day: { $gte: since, $lte: until },
    })
      .select("_id day campaign")
      .lean();
    const stale = existing.filter((r) => !keep.has(`${r.day}|${r.campaign}`)).map((r) => r._id);
    if (stale.length) removed = (await MarketingSpend.deleteMany({ _id: { $in: stale } })).deletedCount;
  }

  let leadsTagged = 0;
  try {
    leadsTagged = await backfillLeadCampaigns(tenantId, startOfDay(since));
  } catch (err) {
    console.error(`[MetaAds] lead campaign backfill failed tenant=${tenantId}:`, err.message);
  }

  return { since, until, accounts: results, upserted, removed, leadsTagged };
};

module.exports = {
  GRAPH_VERSION,
  normalizeAdAccountId,
  fetchAdAccount,
  getAccountToken,
  fetchCampaignSpend,
  listAdAccountPages,
  resolveCampaignForAd,
  syncTenantSpend,
  graphError,
};
