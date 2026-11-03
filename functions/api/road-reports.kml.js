/* Road Reports as KML. GET /api/road-reports.kml
 *
 * Emits the LIVE road-reports pins as KML placemarks so they can be
 * opened in Google Earth (Earth web imports a .kml file; the /car
 * page's "Pins for Earth (.kml)" button downloads this with ?dl=1).
 * Freshness mirrors the /car map exactly — same rules as
 * js/road-reports.js: per-type lifetimes, one "Still there" extends
 * the clock once (never past created + 2× lifetime), and 2+ "Gone"
 * votes bury a pin. Expired/buried pins are simply not emitted.
 *
 * Read-only. Rows come from the same docs table the site runs on
 * (coll "roadreports", world-readable by design — display names
 * only, the same data the map already shows everyone). On any
 * database trouble the answer is a valid empty KML, never a 500:
 * Earth should open to an empty folder, not an error page. */
const MIN = 60000, HOUR = 60 * MIN;
const TYPES = {
  police:   { icon: "🚔", label: "Police",        ttl: 45 * MIN },
  traffic:  { icon: "🐢", label: "Heavy Traffic", ttl: 30 * MIN },
  crash:    { icon: "💥", label: "Crash",         ttl: 2 * HOUR },
  hazard:   { icon: "⚠️", label: "Hazard",        ttl: 2 * HOUR },
  roadwork: { icon: "🚧", label: "Road Work",     ttl: 12 * HOUR },
  closed:   { icon: "🚫", label: "Road Closed",   ttl: 12 * HOUR },
};
const GONE_VOTES = 2;
const READ_CAP = 200;

const esc = (s) => String(s == null ? "" : s)
  .replace(/&/g, "&amp;").replace(/</g, "&lt;").replace(/>/g, "&gt;")
  .replace(/"/g, "&quot;").replace(/'/g, "&apos;");

function rowMs(v) { const n = typeof v === "string" ? Date.parse(v) : NaN; return isFinite(n) ? n : 0; }
function createdMs(row) { return rowMs(row && row.created_at) || (+(row && row.data && row.data.at) || 0); }
function uidList(row, key) { const v = row && row.data && row.data[key]; return Array.isArray(v) ? v.map(String) : []; }

/* Pure freshness logic, exported for the node-side fixture tests.
 * Mirrors expiryOf/isAlive in js/road-reports.js — keep them in step. */
export function expiryOf(row) {
  const t = TYPES[row && row.data && row.data.type]; if (!t) return 0;
  const c = createdMs(row); if (!c) return 0;
  const base = c + t.ttl;
  if (uidList(row, "likes").length >= 1) {
    const u = rowMs(row && row.updated_at);
    if (u > c) return Math.min(Math.max(base, u + t.ttl), c + 2 * t.ttl);
  }
  return base;
}
export function isAlive(row, now) {
  if (!row || !row.data || !TYPES[row.data.type]) return false;
  if (uidList(row, "votes").length >= GONE_VOTES) return false;
  const ex = expiryOf(row); return ex > 0 && now < ex;
}

/* Pure KML builder, exported for the node-side fixture tests. */
export function buildKml(rows, now) {
  const marks = [];
  for (const row of rows || []) {
    if (!isAlive(row, now)) continue;
    const d = row.data || {};
    if (!isFinite(d.lat) || !isFinite(d.lng)) continue;
    const t = TYPES[d.type]; if (!t) continue;
    const name = esc(t.icon + " " + t.label);
    const desc = esc(
      t.label +
      (d.name ? " — reported by " + String(d.name).slice(0, 40) : "") +
      " · " + new Date(createdMs(row)).toISOString() +
      " · " + uidList(row, "likes").length + " say still there"
    );
    marks.push(
      "    <Placemark><name>" + name + "</name><description>" + desc + "</description>" +
      "<Point><coordinates>" + d.lng + "," + d.lat + ",0</coordinates></Point></Placemark>"
    );
  }
  return "<?xml version=\"1.0\" encoding=\"UTF-8\"?>\n" +
    "<kml xmlns=\"http://www.opengis.net/kml/2.2\">\n  <Document>\n" +
    "    <name>Meechie's World — Road Reports</name>\n" +
    (marks.length ? marks.join("\n") + "\n" : "") +
    "  </Document>\n</kml>\n";
}

export async function onRequestGet(context) {
  let rows = [];
  try {
    const r = await context.env.DB.prepare(
      "select path, owner, data, created_at, updated_at from docs where coll = ? order by created_at desc limit ?"
    ).bind("roadreports", READ_CAP).all();
    rows = (r.results || []).map((row) => {
      let d = {};
      try { d = JSON.parse(row.data || "{}"); } catch (_) {}
      return { path: row.path, owner: row.owner, data: d, created_at: row.created_at, updated_at: row.updated_at };
    });
  } catch (_) { rows = []; }
  const headers = {
    "Content-Type": "application/vnd.google-earth.kml+xml; charset=utf-8",
    "Cache-Control": "public, max-age=30",
  };
  try {
    if (new URL(context.request.url).searchParams.get("dl") === "1") {
      headers["Content-Disposition"] = "attachment; filename=\"meechies-road-reports.kml\"";
    }
  } catch (_) {}
  return new Response(buildKml(rows, Date.now()), { status: 200, headers });
}
