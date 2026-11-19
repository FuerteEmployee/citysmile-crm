# 🔑 Facebook Page — Never-Expiring Token Generation Guide

> **Purpose:** Step-by-step guide to generate a never-expiring Page Access Token for any new Facebook Page added to the Fuerte CRM system.

---

## 📋 Prerequisites

Before starting, make sure you have:

| Requirement | Value / Where to Find |
|-------------|----------------------|
| **Business Account** | business.facebook.com (Fuerte Developers) |
| **System User** | CRM Integration (ID: 6159276106 7848) |
| **App Name** | FUERTE CRM LEAD |
| **App ID** | `1334440645499838` |
| **App Secret** | `cf466626c6acbe5ea6535789631556ef` |
| **New Page** | Already owned or added to Fuerte Developers Business |

---

## 🚀 Step-by-Step Process

---

### STEP 1 — Add the New Page to Business Portfolio

1. Go to: **https://business.facebook.com/settings**
2. Left sidebar → **Accounts → Pages**
3. Click **"+ Add"** button (top right)
4. Select **"Add a Page"** → Search your new page name
5. Click **Claim** or **Add**

---

### STEP 2 — Connect Page to CRM Integration System User

1. Left sidebar → **Users → System Users**
2. Click **"CRM Integration"**
3. Click **"Add assets"** button
4. Select **Pages** category
5. Find and select your **new page**
6. Set permission to **Full access**
7. Click **Save**

---

### STEP 3 — Connect Page to FUERTE CRM LEAD App

1. Left sidebar → **Accounts → Pages**
2. Click on your **new page**
3. Click **"Connected assets"** tab
4. Click **"Connect assets"**
5. Select **Apps → FUERTE CRM LEAD**
6. Grant **Full access**
7. Click **Save**

---

### STEP 4 — Get Short-Lived Token from Graph API Explorer

1. Go to: **https://developers.facebook.com/tools/explorer/**
2. Top right → App dropdown → Select **"FUERTE CRM LEAD"**
3. **User or Page** dropdown → Select your **new page name**
4. Click **"Generate Access Token"** blue button
5. Authorize all permissions when prompted:
   - ✅ `pages_show_list`
   - ✅ `pages_read_engagement`
   - ✅ `pages_manage_messages`
   - ✅ `pages_messaging`
   - ✅ `leads_retrieval`
   - ✅ `pages_manage_ads` (REQUIRED for Lead Forms!)
6. Change URL to:
   ```
   YOUR_PAGE_ID?fields=id,name,access_token
   ```
7. Click **Submit**
8. Copy the `access_token` from the response

> ⚠️ This is a **short-lived token** (~1 hour). Proceed to Step 5.

---

### STEP 5 — Convert to Long-Lived User Token (60 days)

Paste this URL in your **browser** (replace `SHORT_LIVED_TOKEN`):

```
https://graph.facebook.com/oauth/access_token?grant_type=fb_exchange_token&client_id=1334440645499838&client_secret=cf466626c6acbe5ea6535789631556ef&fb_exchange_token=SHORT_LIVED_TOKEN
```

**Response:**
```json
{
  "access_token": "EAAS9qqy...LONG_TOKEN...",
  "token_type": "bearer",
  "expires_in": 5183944
}
```

> ✅ `expires_in` ~5183944 seconds = **~60 days** = Long-lived user token confirmed!

Copy the new `access_token` value.

---

### STEP 6 — Get Never-Expiring Page Token

Paste this URL in your **browser** (replace `YOUR_PAGE_ID` and `LONG_LIVED_TOKEN`):

```
https://graph.facebook.com/YOUR_PAGE_ID?fields=access_token&access_token=LONG_LIVED_TOKEN
```

**Response:**
```json
{
  "access_token": "EAAS9qqy...PAGE_TOKEN...",
  "id": "YOUR_PAGE_ID"
}
```

> ✅ This `access_token` = **Never expires!**

Copy the `access_token` from this response.

---

### STEP 7 — Verify Token (Optional but Recommended)

Paste this URL in browser to confirm the token never expires:

```
https://graph.facebook.com/debug_token?input_token=YOUR_PAGE_TOKEN&access_token=1334440645499838|cf466626c6acbe5ea6535789631556ef
```

**Look for:**
```json
{
  "data": {
    "expires_at": 0,       ← 0 means NEVER expires ✅
    "is_valid": true,      ← Token is valid ✅
    "scopes": [...]
  }
}
```

---

### STEP 8 — Add Token to `.env` File

Open `d:\CRM ALL\Backend\.env` and add at the bottom:

```env
# YOUR_PAGE_NAME Page Access Token (Never Expires)
META_PAGE_ACCESS_TOKEN_YOUR_PAGE_ID=PASTE_NEVER_EXPIRE_TOKEN_HERE
```

**Example:**
```env
# Herbal King's Man Page Access Token (Never Expires)
META_PAGE_ACCESS_TOKEN_1231822966682478=EAAS9qqymG74BSIziIG...
```

---

## 📋 Current Pages in CRM

| Page Name | Page ID | ENV Key | Status |
|-----------|---------|---------|--------|
| Citysmile A dental & aesthetic clinic | `1969386696646212` | `META_PAGE_ACCESS_TOKEN_1969386696646212` | ✅ Active |
| Herbal King's Man | `1231822966682478` | `META_PAGE_ACCESS_TOKEN_1231822966682478` | ✅ Active |

---

## 🔄 Token Format in `.env`

```
META_PAGE_ACCESS_TOKEN_{PAGE_ID}=TOKEN_VALUE
```

---

## ⚠️ Important Notes

- **Never commit `.env` to GitHub** — it contains secret tokens
- **Page tokens from long-lived user tokens = Never expire**
- If token stops working, repeat from **Step 4**
- App Secret is sensitive — do not share publicly
- Always verify token with **Step 7** after generating

---

## 📞 Quick Reference URLs

| Action | URL |
|--------|-----|
| Business Settings | https://business.facebook.com/settings |
| Graph API Explorer | https://developers.facebook.com/tools/explorer/ |
| Token Debugger | https://developers.facebook.com/tools/debug/accesstoken/ |
| App Dashboard | https://developers.facebook.com/apps/1334440645499838 |

---

*Last Updated: August 2026 | Maintained by: Fuerte Developers*
