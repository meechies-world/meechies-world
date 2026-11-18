// lib/cj.js — CJdropshipping API client (Open API 2.0) for Meechies World.
// Used by the shop auto-order: when a customer pays via Stripe, the server
// creates the CJ order and pays it from Malik's CJ balance, so CJ ships it.
// Docs: https://developers.cjdropshipping.com (API V2.0)
// Auth: POST /authentication/getAccessToken {apiKey} -> accessToken (180 days).
// Every call sends the token in the CJ-Access-Token header.
// Orders: POST /shopping/order/createOrderV2, shopLogisticsType=2 means
// "CJ Logistics" — CJ ships it themselves, no waybill upload needed.
// Pay: POST /shopping/pay/payBalance (pays from the CJ account balance).
import { getSecret } from "./secrets.js";

const CJ_BASE = "https://developers.cjdropshipping.com/api2.0/v1";

// In-memory token cache (per isolate). Token lives 180 days; we refresh
// when it is expired or CJ returns an auth error.
let _token = null;
let _tokenExp = 0;

async function cjToken(env) {
  const now = Date.now();
  if (_token && now < _tokenExp - 60 * 1000) return _token;
  const apiKey = await getSecret(env, "CJ_API_KEY");
  if (!apiKey) throw new Error("CJ_API_KEY is not set. Paste it on the site's API Keys page.");
  const r = await fetch(CJ_BASE + "/authentication/getAccessToken", {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify({ apiKey }),
  });
  const j = await r.json().catch(() => ({}));
  if (!r.ok || !j.result || !j.data || !j.data.accessToken) {
    throw new Error("CJ getAccessToken failed: " + (j.message || ("HTTP " + r.status)));
  }
  _token = j.data.accessToken;
  const exp = j.data.accessTokenExpiryDate ? Date.parse(j.data.accessTokenExpiryDate) : now + 150 * 24 * 3600 * 1000;
  _tokenExp = Number.isFinite(exp) ? exp : now + 150 * 24 * 3600 * 1000;
  return _token;
}

async function cjCall(env, path, body, retry = true) {
  const token = await cjToken(env);
  const r = await fetch(CJ_BASE + path, {
    method: "POST",
    headers: { "content-type": "application/json", "CJ-Access-Token": token },
    body: JSON.stringify(body || {}),
  });
  const j = await r.json().catch(() => ({}));
  // CJ returns result:false with code 1001 (token expired/invalid) — refresh once and retry.
  if ((!r.ok || j.result === false) && retry && (j.code === 1001 || j.code === "1001" || r.status === 401)) {
    _token = null; _tokenExp = 0;
    return cjCall(env, path, body, false);
  }
  if (!r.ok || j.result === false) {
    throw new Error("CJ " + path + " failed: " + (j.message || ("HTTP " + r.status)) + " (code " + (j.code ?? "?") + ")");
  }
  return j.data ?? j;
}

// Create a CJ order (CJ Logistics: CJ ships it). address = {firstName,lastName,
// countryCode ("US"), country, province, city, address, address2, zip, phone, email}.
// items = [{vid, quantity}] — vid is the CJ variant id for the product.
// Returns the CJ order data (orderId, orderNumber, amounts).
export async function cjCreateOrder(env, { orderNumber, address, items, logisticName }) {
  const a = address || {};
  const body = {
    orderNumber: String(orderNumber),
    shippingCountryCode: a.countryCode || "US",
    shippingCountry: a.country || "United States",
    shippingProvince: a.province || "",
    shippingCity: a.city || "",
    shippingAddress: a.address || "",
    shippingAddress2: a.address2 || "",
    shippingZip: a.zip || "",
    shippingPhone: a.phone || "",
    shippingEmail: a.email || "",
    shippingCustomerName: [a.firstName || "", a.lastName || ""].join(" ").trim(),
    shopLogisticsType: 2,
    products: (items || []).map((it) => ({ vid: String(it.vid), quantity: Number(it.quantity || 1) })),
  };
  if (logisticName) body.logisticName = logisticName;
  return cjCall(env, "/shopping/order/createOrderV2", body);
}

// Pay a CJ order from the CJ account balance. orderIds = [cjOrderId].
// Returns the pay result. Throws if the balance is too low.
export async function cjPayBalance(env, orderIds) {
  return cjCall(env, "/shopping/pay/payBalance", { orderIds: (orderIds || []).map(String) });
}

// Estimate freight for an order (optional, for showing shipping cost).
export async function cjFreight(env, { countryCode, province, city, zip, items }) {
  return cjCall(env, "/logistic/freightCalculate", {
    countryCode: countryCode || "US",
    province: province || "",
    city: city || "",
    zip: zip || "",
    products: (items || []).map((it) => ({ vid: String(it.vid), quantity: Number(it.quantity || 1) })),
  });
}
