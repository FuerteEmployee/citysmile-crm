// ---------------------------------------------------------------------------
// Reverse geocoding with a pluggable provider chain.
//
// Precision is limited by the PROVIDER'S DATA, not our code: OSM/Nominatim is
// free and keyless but has no street/house data in many Indian localities
// (e.g. central Rajkot resolves to just "Rajkot, Gujarat"). For street-level
// addresses ("1102, 150ft Ring Road, Punit Nagar, ...") add ONE of these keys
// to the server .env and restart — no code change needed:
//
//   GOOGLE_MAPS_API_KEY   Google Geocoding API (needs GCP billing enabled)
//   MAPPLS_API_KEY        Mappls / MapmyIndia REST key (free dev tier)
//   OLA_MAPS_API_KEY      Ola Maps (Krutrim) API key (free dev tier)
//
// Providers are tried in that order; Nominatim is the always-on fallback.
// reverseGeocode() never throws — worst case it returns "lat, lng".
// ---------------------------------------------------------------------------
const axios = require("axios");

const coordString = (lat, lng) =>
  `${Number(lat).toFixed(5)}, ${Number(lng).toFixed(5)}`;

async function viaGoogle(lat, lng) {
  const key = process.env.GOOGLE_MAPS_API_KEY;
  if (!key) return null;
  const r = await axios.get("https://maps.googleapis.com/maps/api/geocode/json", {
    params: { latlng: `${lat},${lng}`, key },
    timeout: 5000,
  });
  return r.data?.results?.[0]?.formatted_address || null;
}

async function viaMappls(lat, lng) {
  const key = process.env.MAPPLS_API_KEY;
  if (!key) return null;
  const r = await axios.get(
    `https://apis.mappls.com/advancedmaps/v1/${key}/rev_geocode`,
    { params: { lat, lng }, timeout: 5000 },
  );
  return r.data?.results?.[0]?.formatted_address || null;
}

async function viaOla(lat, lng) {
  const key = process.env.OLA_MAPS_API_KEY;
  if (!key) return null;
  const r = await axios.get("https://api.olamaps.io/places/v1/reverse-geocode", {
    params: { latlng: `${lat},${lng}`, api_key: key },
    timeout: 5000,
  });
  return r.data?.results?.[0]?.formatted_address || null;
}

async function viaNominatim(lat, lng) {
  const r = await axios.get("https://nominatim.openstreetmap.org/reverse", {
    params: { format: "json", lat, lon: lng, zoom: 18, addressdetails: 1 },
    headers: { "User-Agent": "ScreenTimeERP/1.0 (admin@fuertedevelopers.com)" },
    timeout: 5000,
  });
  // Compose the most specific parts OSM has instead of trusting display_name,
  // which can lead with coarse admin areas.
  const a = r.data?.address || {};
  const parts = [
    a.house_number,
    a.amenity || a.building,
    a.road,
    a.neighbourhood || a.quarter,
    a.suburb,
    a.city || a.town || a.village,
    a.postcode,
  ].filter(Boolean);
  return parts.length >= 2 ? parts.join(", ") : r.data?.display_name || null;
}

// Most precise address available across configured providers. Never throws.
// Returns null for missing coordinates (callers store null, not garbage).
async function reverseGeocode(lat, lng) {
  if (!lat || !lng) return null;
  for (const provider of [viaGoogle, viaMappls, viaOla, viaNominatim]) {
    try {
      const addr = await provider(lat, lng);
      if (addr) return addr;
    } catch {
      /* provider down or key invalid — try the next one */
    }
  }
  return coordString(lat, lng);
}

module.exports = { reverseGeocode };
