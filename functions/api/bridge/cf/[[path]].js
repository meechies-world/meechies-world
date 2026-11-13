/* /api/bridge/cf/* — LOGIN BRIDGE proxy (2026-11-08, Malik: log ins must work now).
 * While the Cloudflare D1 daily quota is walled, the site backend (/api/cf/*) answers
 * HTTP 500 server_error and nobody can sign in. Malik's own phone runs the SAME
 * production /api/cf handler against his own local database with no quota, exposed
 * through a free cloudflared quick tunnel. This function forwards
 * /api/bridge/cf/<path> to that stack's /api/cf/<path> so the site's sign-in (and
 * the rest of the cf client) can ride the phone until the quota resets.
 * Same-origin by design: the browser only ever talks to this domain, the session
 * the phone issues is stored by the page exactly like a main-backend session, and
 * the google-redirect sign-in page the handler returns (it sets localStorage
 * mw-cf-session, then location.replace("/")) works untouched because it is
 * served from this origin.
 * This function NEVER touches D1 or env.DB — it is a pure pass-through, so it
 * keeps working while the wall is up. If the phone tunnel is unreachable it
 * answers 502 with error code "bridge_down" and the client falls back to the
 * main backend's own answer.
 * ADDRESS: the upstream is resolved per call by lib/bridge.js (rendezvous
 * files the phone-side publisher keeps current, every candidate validated
 * by health + settings probes), so a tunnel restart no longer needs a
 * code edit or a redeploy. */
import { bridgeUpstream } from "../../../../lib/bridge.js";

const bridgeDown = () =>
  new Response(
    JSON.stringify({
      data: null,
      error: {
        message: "The login bridge is not reachable right now. Sign-in comes back when the main service recovers.",
        code: "bridge_down",
      },
    }),
    { status: 502, headers: { "content-type": "application/json", "cache-control": "no-store" } }
  );

const notFound = () =>
  new Response(JSON.stringify({ data: null, error: { message: "Not found", code: "not_found" } }), {
    status: 404,
    headers: { "content-type": "application/json", "cache-control": "no-store" },
  });

export async function onRequest(context) {
  const { request, params } = context;
  // Scope: only /api/cf/* exists upstream. The catch-all segments are the path
  // after /api/bridge/cf/ — re-encode each segment so nothing can escape the prefix.
  const segments = (params && params.path) || [];
  if (!segments.length) return notFound();
  const rest = segments.map((s) => encodeURIComponent(String(s))).join("/");
  const url = new URL(request.url);
  const target = (await bridgeUpstream(url.origin)) + "/api/cf/" + rest + url.search;

  const headers = new Headers(request.headers);
  headers.delete("host");
  const init = { method: request.method, headers, redirect: "manual" };
  if (request.method !== "GET" && request.method !== "HEAD" && request.body) {
    init.body = request.body;
    init.duplex = "half"; // required by the runtime when streaming a request body through
  }

  let upstream;
  try {
    upstream = await fetch(target, init);
  } catch (_) {
    return bridgeDown();
  }

  // Pass the upstream answer back unchanged: status, content type, cache
  // headers, cookies and any redirect location, with the body streamed as-is
  // (JSON for the client calls, the signed-in HTML page for google-redirect).
  const out = new Headers();
  const ct = upstream.headers.get("content-type");
  if (ct) out.set("content-type", ct);
  const cc = upstream.headers.get("cache-control");
  if (cc) out.set("cache-control", cc);
  const loc = upstream.headers.get("location");
  if (loc) out.set("location", loc);
  const cookies = typeof upstream.headers.getSetCookie === "function" ? upstream.headers.getSetCookie() : [];
  if (cookies.length) for (const c of cookies) out.append("set-cookie", c);
  else {
    const sc = upstream.headers.get("set-cookie");
    if (sc) out.set("set-cookie", sc);
  }
  return new Response(upstream.body, { status: upstream.status, headers: out });
}
