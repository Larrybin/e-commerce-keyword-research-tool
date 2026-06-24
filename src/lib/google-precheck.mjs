export const DEFAULT_GOOGLE_LOCATION = {
  hl: "en",
  gl: "US",
  latitude: 37.421,
  longitude: -122.084
};

export function buildGoogleUule({
  latitude = DEFAULT_GOOGLE_LOCATION.latitude,
  longitude = DEFAULT_GOOGLE_LOCATION.longitude,
  now = Date.now()
} = {}) {
  const lat = Math.round(1e7 * Number(latitude));
  const lng = Math.round(1e7 * Number(longitude));
  if (!Number.isFinite(lat) || !Number.isFinite(lng)) {
    throw new Error("Google UULE requires numeric latitude and longitude");
  }

  const body = [
    "role:", 1,
    "\nproducer:", 12,
    "\nprovenance:", 6,
    "\ntimestamp:", String(1000 * Number(now)),
    "\nlatlng{\nlatitude_e7:", lat,
    "\nlongitude_e7:", lng,
    "\n}\nradius:", 150 * 620
  ].join("");

  return `a ${Buffer.from(body).toString("base64").replace(/\+/g, "-").replace(/\//g, "_")}`;
}

export function buildGoogleSearchUrl({
  keyword,
  hl = DEFAULT_GOOGLE_LOCATION.hl,
  gl = DEFAULT_GOOGLE_LOCATION.gl,
  latitude = DEFAULT_GOOGLE_LOCATION.latitude,
  longitude = DEFAULT_GOOGLE_LOCATION.longitude,
  num = 20,
  now = Date.now(),
  baseUrl = "https://www.google.com/search"
} = {}) {
  const q = String(keyword || "").trim();
  if (!q) {
    throw new Error("Google search keyword is required");
  }

  const url = new URL(baseUrl);
  url.searchParams.set("q", q);
  url.searchParams.set("hl", hl);
  url.searchParams.set("gl", gl);
  url.searchParams.set("ie", "utf-8");
  url.searchParams.set("oe", "utf-8");
  url.searchParams.set("pws", "0");
  url.searchParams.set("num", String(num));
  url.searchParams.set("uule", buildGoogleUule({ latitude, longitude, now }));
  return url.toString();
}

export function normalizeGoogleResultUrl(href) {
  try {
    const parsed = new URL(href);
    const unwrapped = parsed.hostname.endsWith("google.com") &&
      parsed.pathname === "/url" &&
      parsed.searchParams.get("q")
      ? new URL(parsed.searchParams.get("q"))
      : parsed;

    if (!/^https?:$/.test(unwrapped.protocol)) {
      return "";
    }
    if (/(^|\.)google\./i.test(unwrapped.hostname)) {
      return "";
    }
    return unwrapped.toString();
  } catch {
    return "";
  }
}
