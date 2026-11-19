const mongoose = require("mongoose");
const MetaAdAccount = require("../models/MetaAdAccount");
const { encryptSecret, decryptSecret, maskSecret, isConfigured } = require("../utils/secretBox");
const {
  normalizeAdAccountId,
  fetchAdAccount,
  syncTenantSpend,
  listAdAccountPages,
  graphError,
} = require("../services/metaAdsService");
const { logActivity } = require("../services/ActivityLogService");

// [" 123 ", "abc", "123"] → ["123"]; undefined when the field wasn't sent.
const normalizePageIds = (raw) => {
  if (raw === undefined) return undefined;
  const list = Array.isArray(raw) ? raw : String(raw || "").split(/[\s,]+/);
  return [...new Set(list.map((p) => String(p).trim()).filter((p) => /^\d{5,25}$/.test(p)))];
};

const serialize = (acc) => ({
  _id: acc._id,
  ad_account_id: acc.ad_account_id,
  page_ids: acc.page_ids || [],
  name: acc.name,
  currency: acc.currency,
  timezone_name: acc.timezone_name,
  token_hint: acc.token_hint,
  is_active: acc.is_active,
  last_synced_at: acc.last_synced_at,
  last_sync_status: acc.last_sync_status,
  last_sync_error: acc.last_sync_error,
  createdAt: acc.createdAt,
});

const ownAccount = (req) => {
  if (!mongoose.Types.ObjectId.isValid(req.params.id)) return null;
  return MetaAdAccount.findOne({ _id: req.params.id, tenant_id: req.user.tenant_id });
};

// GET /api/meta-ads/accounts — this tenant's connected ad accounts (no tokens).
const listAccounts = async (req, res) => {
  try {
    const accounts = await MetaAdAccount.find({ tenant_id: req.user.tenant_id }).sort({ createdAt: 1 });
    res.json({ accounts: accounts.map(serialize), encryptionConfigured: isConfigured() });
  } catch (error) {
    res.status(500).json({ message: error.message });
  }
};

// POST /api/meta-ads/pages { ad_account_id, access_token } — admin only.
// Lists the Facebook Pages an ad account advertises, before connecting it.
const previewPages = async (req, res) => {
  try {
    const adAccountId = normalizeAdAccountId(req.body?.ad_account_id);
    const token = String(req.body?.access_token || "").trim();
    if (!adAccountId) return res.status(400).json({ message: "Enter a valid Ad Account ID (e.g. act_1234567890)" });
    if (token.length < 20) return res.status(400).json({ message: "Enter a valid access token" });
    res.json(await listAdAccountPages(adAccountId, token));
  } catch (error) {
    res.status(400).json({ message: `Meta rejected this ad account/token: ${graphError(error)}` });
  }
};

// GET /api/meta-ads/accounts/:id/pages — same, for an already-connected account.
const accountPages = async (req, res) => {
  try {
    if (!mongoose.Types.ObjectId.isValid(req.params.id)) return res.status(404).json({ message: "Ad account not found" });
    const account = await MetaAdAccount.findOne({ _id: req.params.id, tenant_id: req.user.tenant_id }).select("+access_token_enc");
    if (!account) return res.status(404).json({ message: "Ad account not found" });
    res.json(await listAdAccountPages(account.ad_account_id, decryptSecret(account.access_token_enc)));
  } catch (error) {
    res.status(400).json({ message: `Meta request failed: ${graphError(error)}` });
  }
};

// Another company already syncing this ad account means it's a shared
// (agency) account — then each company must narrow it to its own Page(s).
const sharedWithOtherTenant = (req, adAccountId) =>
  MetaAdAccount.exists({ ad_account_id: adAccountId, tenant_id: { $ne: req.user.tenant_id } });
const SHARED_NEEDS_PAGES =
  "This ad account is also connected to another company. Choose your Facebook Page(s) so only your campaigns are counted.";

// POST /api/meta-ads/accounts { ad_account_id, access_token, page_ids? } — admin only.
const connectAccount = async (req, res) => {
  try {
    if (!req.user?.tenant_id) return res.status(400).json({ message: "No company on this account" });
    if (!isConfigured()) {
      return res.status(500).json({ message: "Server is missing INTEGRATION_ENCRYPTION_KEY — ask your provider to configure it" });
    }
    const adAccountId = normalizeAdAccountId(req.body?.ad_account_id);
    const token = String(req.body?.access_token || "").trim();
    const pageIds = normalizePageIds(req.body?.page_ids) || [];
    if (!adAccountId) return res.status(400).json({ message: "Enter a valid Ad Account ID (e.g. act_1234567890)" });
    if (token.length < 20) return res.status(400).json({ message: "Enter a valid access token" });
    if (!pageIds.length && (await sharedWithOtherTenant(req, adAccountId))) {
      return res.status(400).json({ message: SHARED_NEEDS_PAGES });
    }

    const existing = await MetaAdAccount.findOne({ tenant_id: req.user.tenant_id, ad_account_id: adAccountId });

    let info;
    try {
      info = await fetchAdAccount(adAccountId, token);
    } catch (err) {
      return res.status(400).json({ message: `Meta rejected this ad account/token: ${graphError(err)}` });
    }

    const update = {
      tenant_id: req.user.tenant_id,
      ad_account_id: adAccountId,
      page_ids: pageIds,
      name: info?.name || "",
      currency: info?.currency || "",
      timezone_name: info?.timezone_name || "",
      access_token_enc: encryptSecret(token),
      token_hint: maskSecret(token),
      is_active: true,
      connected_by: req.user._id,
      last_sync_status: "never",
      last_sync_error: "",
    };
    const account = await MetaAdAccount.findOneAndUpdate(
      { tenant_id: req.user.tenant_id, ad_account_id: adAccountId },
      update,
      { new: true, upsert: true, setDefaultsOnInsert: true }
    );
    logActivity(
      req,
      `Connected Meta ad account act_${adAccountId}${info?.name ? ` (${info.name})` : ""}` +
        (pageIds.length ? ` for Page(s) ${pageIds.join(", ")}` : "")
    );

    // First sync backfills 30 days; failures are recorded on the account.
    syncTenantSpend(req.user.tenant_id, { days: 30, userId: req.user._id }).catch((err) =>
      console.error("[MetaAds] initial sync failed:", err.message)
    );

    res.status(existing ? 200 : 201).json(serialize(account));
  } catch (error) {
    if (error.code === 11000) return res.status(409).json({ message: "This ad account is already connected" });
    res.status(500).json({ message: error.message });
  }
};

// PATCH /api/meta-ads/accounts/:id { access_token?, is_active?, page_ids? } — admin only.
const updateAccount = async (req, res) => {
  try {
    const account = await ownAccount(req);
    if (!account) return res.status(404).json({ message: "Ad account not found" });

    if (req.body?.access_token !== undefined) {
      if (!isConfigured()) return res.status(500).json({ message: "Server is missing INTEGRATION_ENCRYPTION_KEY" });
      const token = String(req.body.access_token).trim();
      if (token.length < 20) return res.status(400).json({ message: "Enter a valid access token" });
      try {
        await fetchAdAccount(account.ad_account_id, token);
      } catch (err) {
        return res.status(400).json({ message: `Meta rejected this token: ${graphError(err)}` });
      }
      account.access_token_enc = encryptSecret(token);
      account.token_hint = maskSecret(token);
      account.last_sync_status = "never";
      account.last_sync_error = "";
    }
    if (req.body?.is_active !== undefined) account.is_active = !!req.body.is_active;
    const pageIds = normalizePageIds(req.body?.page_ids);
    if (pageIds !== undefined) {
      if (!pageIds.length && (await sharedWithOtherTenant(req, account.ad_account_id))) {
        return res.status(400).json({ message: SHARED_NEEDS_PAGES });
      }
      account.page_ids = pageIds;
    }
    await account.save();
    logActivity(req, `Updated Meta ad account act_${account.ad_account_id}`);
    res.json(serialize(account));
  } catch (error) {
    res.status(500).json({ message: error.message });
  }
};

// DELETE /api/meta-ads/accounts/:id — admin only. Already-synced spend stays.
const disconnectAccount = async (req, res) => {
  try {
    const account = await ownAccount(req);
    if (!account) return res.status(404).json({ message: "Ad account not found" });
    await account.deleteOne();
    logActivity(req, `Disconnected Meta ad account act_${account.ad_account_id}`);
    res.json({ message: "Ad account disconnected" });
  } catch (error) {
    res.status(500).json({ message: error.message });
  }
};

// POST /api/meta-ads/sync { days? } — pull spend now.
const syncNow = async (req, res) => {
  try {
    const days = Math.min(Math.max(parseInt(req.body?.days, 10) || 7, 1), 90);
    const result = await syncTenantSpend(req.user.tenant_id, { days, userId: req.user._id });
    if (result.skipped) return res.status(400).json({ message: `Nothing synced: ${result.reason}` });
    res.json(result);
  } catch (error) {
    res.status(500).json({ message: error.message });
  }
};

module.exports = {
  listAccounts,
  previewPages,
  accountPages,
  connectAccount,
  updateAccount,
  disconnectAccount,
  syncNow,
};
