/* /api/bridge/station — STACK-PRIMARY station proxy (2026-11-13, the flip).
 *
 * The DJ booth and every listener client poll /api/station every few
 * seconds (presence, the keeper's rotation state, picks and shouts).
 * In the flipped world the station keeper runs on Malik's phone stack
 * — the same production station.js against his own database, with no
 * D1 meter — so this function forwards /api/bridge/station to the
 * stack's /api/station, resolving the stack's current tunnel address
 * through lib/bridge.js exactly like /api/bridge/cf/* forwards the
 * database door.
 *
 * If the stack is unreachable it answers 502 with error code
 * "bridge_down" and the client (js/dj.js stFetch) falls back to the
 * Cloudflare station function — the backup keeper — automatically,
 * and retries the stack a minute later. This function NEVER touches
 * D1 or env.DB: it is a pure pass-through, so it keeps working while
 * the D1 wall is up.
 */
import { bridgeUpstream } from "../../../lib/bridge.js";

const bridgeDown = () =>
  new Response(
    JSON.stringify({
      data: null,
      error: {
        message: "The station bridge is not reachable right now.",
        code: "bridge_down",
      },
    }),
    { status: 502, headers: { "content-type": "application/json", "cache-control": "no-store" } }
  );

export async function onRequest(context) {
  const { request } = context;
  const url = new URL(request.url);
  const target = (await bridgeUpstream(url.origin)) + "/api/station" + url.search;

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

  // Pass the upstream answer back unchanged (the station answers JSON).
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
