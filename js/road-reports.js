/* ================================================================
   ROAD REPORTS — Meechie's World's own Waze-style community layer.
   Members drop pins (police, speed trap, camera, road work, crash,
   hazard, heavy traffic, road closed); everybody — guests
   included — sees them.
   Data lives in the site's own docs (coll "roadreports"), one doc
   per report, through the regular /api/cf doors:
     post    → rest insert (signed-in members only, server-checked)
     confirm → rpc merge_doc patching ONLY the open "likes" key
     gone    → rpc merge_doc patching ONLY the open "votes" key
               (the server lets a member move only their own uid in
               those two arrays — nobody can fake a crowd)
     remove  → rest delete (the reporter, or the owner/admin)
   No stale pins: every type has a lifetime (POLICE 45 min …
   ROAD WORK 12 h). One "Still there" resets the clock once
   (capped at 2× the lifetime). Two "Gone" votes bury a pin for
   every viewer. Expired/buried pins simply stop rendering.
   This layer writes ONLY its own roadreports docs. It never
   touches the radio, the TV, or any other part of the site.

   MAP LOOK (2026-11-03): the base map opens SATELLITE — Esri
   World Imagery with its boundaries/places reference layer on
   top, Google-Earth style — with a big 🛰️ Satellite / 🗺️ Street
   switch (Street = the OpenStreetMap tiles). The choice is
   remembered per device. Pins ride on top of either base. A
   ResizeObserver keeps Leaflet's grid matched to the real box
   (the card grows after init when the guide renders — a one-shot
   invalidateSize left the lower half of the box untiled).

   DRIVER FEATURES (2026-11-03, round 2): a "you are here" blue
   dot + accuracy ring rides ONE watchPosition owned by this
   layer (the car page's own one-shot fix feeds the same state
   through MWRR.center — there is never a second watcher). The
   map opens centered on the driver when a fix exists, a big
   📍 LOCATE button re-centers, and a denied/unavailable fix
   says so in plain words instead of failing silently. A driver
   strip shows current speed from GPS and the speed limit of
   the road under the driver from OpenStreetMap's maxspeed
   tags (Overpass, cached per stretch of road) — an untagged
   road shows "Limit —", never an invented number. Location
   stays on the device: the dot is painted locally and never
   written to any doc; only a pin a member deliberately drops
   carries a location, exactly like before.
   ================================================================ */
var MWRR = (function () {
  "use strict";

  /* ---------------- pure logic (harness-tested) ---------------- */
  var MIN = 60000, HOUR = 60 * MIN;
  var TYPES = {
    police:   { icon: "🚔", label: "Police",                ttl: 45 * MIN },
    trap:     { icon: "🚨", label: "Speed Trap",            ttl: 3 * HOUR },
    camera:   { icon: "📸", label: "Speed/Red-Light Camera", ttl: 30 * 24 * HOUR },
    traffic:  { icon: "🐢", label: "Heavy Traffic",         ttl: 30 * MIN },
    crash:    { icon: "💥", label: "Crash",                 ttl: 2 * HOUR },
    hazard:   { icon: "⚠️", label: "Hazard",                ttl: 2 * HOUR },
    roadwork: { icon: "🚧", label: "Road Work",             ttl: 12 * HOUR },
    closed:   { icon: "🚫", label: "Road Closed",           ttl: 12 * HOUR }
  };
  var TYPE_ORDER = ["police", "trap", "camera", "roadwork", "crash", "hazard", "traffic", "closed"];
  var GONE_VOTES = 2;          // "Gone" taps from 2 different members bury a pin
  var POST_GAP_MS = 2 * MIN;   // one report per member per 2 minutes (owner exempt)
  var READ_CAP = 200;          // newest reports fetched per refresh

  /* Malik's home turf — used only to name the nearest town on a pin
   * ("near Uniontown"). A town shows only when the pin is within
   * ~15 miles of it; otherwise the pin just says "on the map". */
  var TOWNS = [
    ["Uniontown", 39.9004, -79.7163], ["Connellsville", 40.0176, -79.5892],
    ["Brownsville", 40.0223, -79.8815], ["Masontown", 39.8458, -79.9018],
    ["Perryopolis", 40.0859, -79.7532], ["Fairchance", 39.8238, -79.5884],
    ["Smithfield", 39.7973, -79.8093], ["Point Marion", 39.7354, -79.8993],
    ["Dunbar", 39.9754, -79.6137], ["Dawson", 40.0451, -79.6562],
    ["Everson", 40.0895, -79.5865]
  ];
  function distMi(aLat, aLng, bLat, bLng) {
    var R = 3958.8, dLa = (bLat - aLat) * Math.PI / 180, dLo = (bLng - aLng) * Math.PI / 180;
    var s = Math.sin(dLa / 2) * Math.sin(dLa / 2) + Math.cos(aLat * Math.PI / 180) * Math.cos(bLat * Math.PI / 180) * Math.sin(dLo / 2) * Math.sin(dLo / 2);
    return 2 * R * Math.asin(Math.min(1, Math.sqrt(s)));
  }
  function nearestTown(lat, lng) {
    var best = null, bd = 15;
    for (var i = 0; i < TOWNS.length; i++) { var d = distMi(lat, lng, TOWNS[i][1], TOWNS[i][2]); if (d < bd) { bd = d; best = TOWNS[i][0]; } }
    return best;
  }

  function ttlFor(type) { var t = TYPES[type]; return t ? t.ttl : 0; }
  function rowMs(row, key) { var v = row && row[key]; var n = typeof v === "string" ? Date.parse(v) : NaN; return isFinite(n) ? n : 0; }
  function createdMs(row) { return rowMs(row, "created_at") || (+(row && row.data && row.data.at) || 0); }
  function uidList(row, key) { var v = row && row.data && row.data[key]; return Array.isArray(v) ? v.map(String) : []; }
  /* Expiry: created + ttl. With at least one "Still there", the clock
   * resets once — expiry becomes last-update + ttl, never beyond
   * created + 2×ttl, so a pin cannot live forever on confirmations. */
  function expiryOf(row) {
    var ttl = ttlFor(row && row.data && row.data.type); if (!ttl) return 0;
    var c = createdMs(row); if (!c) return 0;
    var base = c + ttl;
    if (uidList(row, "likes").length >= 1) {
      var u = rowMs(row, "updated_at");
      if (u > c) return Math.min(Math.max(base, u + ttl), c + 2 * ttl);
    }
    return base;
  }
  function isAlive(row, now) {
    if (!row || !row.data || !TYPES[row.data.type]) return false;
    if (uidList(row, "votes").length >= GONE_VOTES) return false;
    var ex = expiryOf(row); return ex > 0 && now < ex;
  }
  function ageLabel(created, now) {
    var s = Math.max(0, Math.floor((now - created) / 1000));
    if (s < 90) return "just now";
    var m = Math.floor(s / 60); if (m < 60) return m + " min ago";
    var h = Math.floor(m / 60); if (h < 24) return h + (h === 1 ? " hr ago" : " hrs ago");
    return Math.floor(h / 24) + " d ago";
  }
  function toggleUid(list, uid) {
    var a = (Array.isArray(list) ? list.map(String) : []), i = a.indexOf(String(uid));
    if (i >= 0) a.splice(i, 1); else a.push(String(uid));
    return a;
  }
  function canPost(lastMs, now, isAdmin) { return !!isAdmin || !lastMs || (now - lastMs) >= POST_GAP_MS; }
  function validateReport(type, lat, lng) {
    if (!TYPES[type]) return "Pick what you saw first.";
    if (!isFinite(lat) || !isFinite(lng) || lat < -90 || lat > 90 || lng < -180 || lng > 180) return "That spot isn't on the map.";
    return "";
  }
  function newId() { return Date.now().toString(36) + Math.random().toString(36).slice(2, 10); }

  /* ---------------- driver logic (harness-tested) ----------------
   * Speed limit source of truth: the OpenStreetMap `maxspeed` tag
   * on the way the driver is on. OSM's unit rule: a bare number is
   * km/h; "35 mph" is explicit. Anything that isn't a clean number
   * ("signals", "none", "walk", zone refs like "DE:urban") means
   * UNKNOWN — the strip shows "Limit —", never a guess. */
  var KMH_TO_MPH = 0.621371;
  function parseMaxspeed(raw) {
    if (raw == null) return null;
    var s = String(raw).trim().toLowerCase();
    if (!s) return null;
    var m = /^(\d+(?:\.\d+)?)\s*(mph|km\/h|kmh|kph)?/.exec(s);
    if (!m) return null;
    var rest = s.slice(m[0].length).trim();
    if (rest && rest !== ";") return null; // trailing junk → not a clean tag
    var v = parseFloat(m[1]);
    if (!isFinite(v) || v <= 0 || v > 250) return null;
    var mph = (m[2] === "mph") ? v : v * KMH_TO_MPH; // unitless = km/h, per OSM
    return Math.round(mph);
  }
  /* GPS speed arrives in metres/second; null/negative = no reading. */
  function speedMphFromMs(ms) {
    if (ms == null || !isFinite(ms) || ms < 0) return null;
    return Math.round(ms * 2.236936);
  }
  function isOverLimit(nowMph, limitMph) {
    return typeof nowMph === "number" && typeof limitMph === "number" && nowMph > limitMph;
  }
  /* The plain-words note a driver sees when the map can't place
   * them. Shown when geolocation is unsupported, denied, or
   * unavailable before any fix; hidden the moment a fix lands. */
  var LOC_NOTE = "Location is off — the map can't show where you are. Turn on location for this site in your browser settings.";
  function locNoteText(state) {
    if (!state) return "";
    if (state.hasFix) return "";
    if (!state.supported) return LOC_NOTE;
    if (state.status === "denied" || state.status === "unavailable") return LOC_NOTE;
    return "";
  }
  /* One light Overpass ask: every highway way within `radiusM` of
   * the driver, tags + geometry, so the nearest way can be picked
   * locally. Cached per stretch of road by the caller — this is a
   * shared free service and gets asked politely, not hammered. */
  function overpassQuery(lat, lng, radiusM) {
    return "[out:json][timeout:8];way(around:" + Math.round(radiusM) + "," +
      lat.toFixed(6) + "," + lng.toFixed(6) + ")[\"highway\"];out tags geom;";
  }
  /* Distance in metres from a point to a segment (equirectangular
   * approximation — plenty at road scale). */
  function segDistM(pLat, pLng, aLat, aLng, bLat, bLng) {
    var k = 111320, kx = k * Math.cos(pLat * Math.PI / 180);
    var px = pLng * kx, py = pLat * k, ax = aLng * kx, ay = aLat * k, bx = bLng * kx, by = bLat * k;
    var dx = bx - ax, dy = by - ay, L2 = dx * dx + dy * dy;
    var t = L2 ? Math.max(0, Math.min(1, ((px - ax) * dx + (py - ay) * dy) / L2)) : 0;
    var ex = ax + t * dx - px, ey = ay + t * dy - py;
    return Math.sqrt(ex * ex + ey * ey);
  }
  function wayDistM(geom, lat, lng) {
    if (!Array.isArray(geom) || !geom.length) return Infinity;
    if (geom.length === 1) return segDistM(lat, lng, geom[0].lat, geom[0].lon, geom[0].lat, geom[0].lon);
    var best = Infinity;
    for (var i = 0; i < geom.length - 1; i++) {
      var d = segDistM(lat, lng, geom[i].lat, geom[i].lon, geom[i + 1].lat, geom[i + 1].lon);
      if (d < best) best = d;
    }
    return best;
  }
  /* The road the driver is ON is the nearest way. If that way has
   * no maxspeed tag, the honest answer is "unknown" — a tagged
   * side street nearby must not lend its limit. Ways farther than
   * maxDistM aren't the driver's road at all. */
  function pickLimit(elements, lat, lng, maxDistM) {
    var best = null, bestD = Infinity;
    (Array.isArray(elements) ? elements : []).forEach(function (el) {
      if (!el || el.type !== "way" || !el.geometry) return;
      var d = wayDistM(el.geometry, lat, lng);
      if (d < bestD) { bestD = d; best = el; }
    });
    if (!best || bestD > maxDistM) return null;
    var mph = parseMaxspeed(best.tags && best.tags.maxspeed);
    return mph == null ? null : { mph: mph, distM: bestD };
  }

  var PURE = {
    TYPES: TYPES, TYPE_ORDER: TYPE_ORDER, GONE_VOTES: GONE_VOTES, POST_GAP_MS: POST_GAP_MS, READ_CAP: READ_CAP,
    ttlFor: ttlFor, createdMs: createdMs, expiryOf: expiryOf, isAlive: isAlive, ageLabel: ageLabel,
    toggleUid: toggleUid, canPost: canPost, validateReport: validateReport, nearestTown: nearestTown, distMi: distMi, newId: newId,
    parseMaxspeed: parseMaxspeed, speedMphFromMs: speedMphFromMs, isOverLimit: isOverLimit,
    LOC_NOTE: LOC_NOTE, locNoteText: locNoteText, overpassQuery: overpassQuery, pickLimit: pickLimit, wayDistM: wayDistM
  };
  if (typeof module !== "undefined" && module.exports) module.exports = PURE;
  if (typeof window === "undefined" || typeof document === "undefined") return PURE;

  /* ---------------- browser layer ---------------- */
  var REST = "/api/cf/rest", RPC = "/api/cf/rpc";
  var HOME = [39.8238, -79.5884]; // Fairchance / Uniontown area — the map's home view
  var HOME_ZOOM = 13; // street-readable, like the original embed's framing
  /* Base layers: satellite first (Esri World Imagery + its labels
   * reference layer), street = OpenStreetMap. Choice persists. */
  var SAT_URL = "https://server.arcgisonline.com/ArcGIS/rest/services/World_Imagery/MapServer/tile/{z}/{y}/{x}";
  var SAT_ATTR = "Tiles &copy; Esri &mdash; Source: Esri, Maxar, Earthstar Geographics";
  var REF_URL = "https://server.arcgisonline.com/ArcGIS/rest/services/Reference/World_Boundaries_and_Places/MapServer/tile/{z}/{y}/{x}";
  var OSM_URL = "https://tile.openstreetmap.org/{z}/{x}/{y}.png";
  var OSM_ATTR = "&copy; OpenStreetMap contributors";
  var BASE_KEY = "mw-rr-base";
  var map = null, layer = null, dropMark = null;
  var satLayer = null, refLayer = null, streetLayer = null, baseMode = "sat";
  var satBtn = null, stBtn = null;
  var rows = [], admins = {}, started = false, lastFix = null;
  var pending = null; // {type, lat, lng} waiting on the confirm bar
  var placing = false;
  /* Driver state: lastFix = {lat, lng, acc (m), spd (m/s), at}.
   * follow = the map rides with the driver until they drag it.
   * geoStatus: "pending" | "ok" | "denied" | "unavailable". */
  var meDot = null, meRing = null, watchId = null, gotFix = false;
  var follow = true, geoStatus = "pending";

  function $(id) { return document.getElementById(id); }
  function session() { try { var s = JSON.parse(localStorage.getItem("mw-cf-session") || "null"); return (s && s.access_token && s.user) ? s : null; } catch (_) { return null; } }
  function myUid() { var s = session(); return s ? String(s.user.id || "") : ""; }
  function myName() {
    var s = session(); if (!s) return "";
    var m = (s.user && s.user.user_metadata) || {};
    return String(m.full_name || m.name || "").slice(0, 40);
  }
  function isAdmin() { var u = myUid(); return !!u && !!admins[u]; }
  function isOwnerRow(row) { return !!row && !!admins[String(row.owner || "")]; }
  function headers() { var s = session(), h = { "Content-Type": "application/json" }; if (s) h.Authorization = "Bearer " + s.access_token; return h; }
  function call(url, body) {
    return fetch(url, { method: "POST", headers: headers(), body: JSON.stringify(body), cache: "no-store" })
      .then(function (r) { return r.json().catch(function () { return { error: { message: "Server error (" + r.status + ")" } }; }); })
      .catch(function () { return { error: { message: "Network problem. Check your connection and try again." } }; });
  }
  function rest(q) { return call(REST, q); }
  function rpc(name, args) { return call(RPC, { name: name, args: args }); }

  function loadAdmins() {
    return rest({ table: "admins", op: "select" }).then(function (j) {
      admins = {}; ((j && j.data) || []).forEach(function (r) { if (r && r.user_id) admins[String(r.user_id)] = 1; });
    }).catch(function () {});
  }
  function loadReports() {
    return rest({ table: "docs", op: "select", select: "path,owner,data,created_at,updated_at", filters: [["coll", "eq", "roadreports"]], order: { col: "created_at", asc: false }, limit: READ_CAP })
      .then(function (j) { if (j && Array.isArray(j.data)) { rows = j.data; paint(); } });
  }

  /* ---------- pins ---------- */
  function pinIcon(row) {
    var t = TYPES[row.data.type];
    return L.divIcon({
      className: "rr-pinwrap",
      html: "<div class='rr-pin" + (isOwnerRow(row) ? " rr-pin-owner" : "") + "'>" + t.icon + "</div>",
      iconSize: [46, 46], iconAnchor: [23, 23], popupAnchor: [0, -20]
    });
  }
  function paint() {
    if (!map || !layer) return;
    layer.clearLayers();
    var now = Date.now(), alive = 0;
    rows.forEach(function (row) {
      if (!isAlive(row, now)) return;
      var d = row.data; if (!isFinite(d.lat) || !isFinite(d.lng)) return;
      alive++;
      var mk = L.marker([d.lat, d.lng], { icon: pinIcon(row) });
      mk.bindPopup(popupEl(row), { closeButton: true, maxWidth: 280 });
      mk.addTo(layer);
    });
    var c = $("rr-count");
    if (c) c.textContent = alive === 0 ? "No reports on the road right now — the map is clear." :
      alive + (alive === 1 ? " report" : " reports") + " on the road near here.";
  }
  function popupEl(row) {
    var d = row.data, t = TYPES[d.type], now = Date.now();
    var box = document.createElement("div"); box.className = "rr-pop";
    var h = document.createElement("div"); h.className = "rr-pop-t";
    h.textContent = t.icon + " " + t.label + (isOwnerRow(row) ? " 👑" : "");
    var meta = document.createElement("div"); meta.className = "rr-pop-m";
    var town = nearestTown(d.lat, d.lng);
    meta.textContent = (town ? "Near " + town + " · " : "") + ageLabel(createdMs(row), now) +
      (d.name ? " · by " + d.name : "") +
      " · " + uidList(row, "likes").length + " say still there";
    box.appendChild(h); box.appendChild(meta);
    var rowEl = document.createElement("div"); rowEl.className = "rr-pop-btns";
    var uid = myUid();
    var still = document.createElement("button"); still.type = "button"; still.textContent = "✅ Still there";
    var gone = document.createElement("button"); gone.type = "button"; gone.textContent = "❌ Gone";
    var act = function (key) {
      if (!uid) { note("Sign in on the main site to confirm reports — viewing is open to everyone."); return; }
      var patch = {}; patch[key] = toggleUid(uidList(row, key), uid);
      rpc("merge_doc", { p_path: row.path, p_patch: patch }).then(function (j) {
        if (j && j.error) { note(j.error.message || "That didn't go through."); return; }
        loadReports();
      });
    };
    still.addEventListener("click", function () { act("likes"); });
    gone.addEventListener("click", function () { act("votes"); });
    rowEl.appendChild(still); rowEl.appendChild(gone);
    if (uid && (uid === String(row.owner || "") || isAdmin())) {
      var del = document.createElement("button"); del.type = "button"; del.textContent = "🗑 Remove";
      del.addEventListener("click", function () {
        rest({ table: "docs", op: "delete", filters: [["path", "eq", row.path]] }).then(function () { if (map) map.closePopup(); loadReports(); });
      });
      rowEl.appendChild(del);
    }
    box.appendChild(rowEl);
    return box;
  }

  /* ---------- reporting ---------- */
  function note(msg) { var n = $("rr-note"); if (n) { n.textContent = msg || ""; } }
  function lastPostMs() { var v = 0; try { v = +localStorage.getItem("mw-rr-last") || 0; } catch (_) {} return v; }
  function stampPost() { try { localStorage.setItem("mw-rr-last", String(Date.now())); } catch (_) {} }

  function openSheet() {
    var sh = $("rr-sheet"); if (!sh) return;
    if (!session()) { note("👀 Viewing is open to everyone. To drop a report, sign in on the main site first, then come back here."); return; }
    pending = null; placing = false;
    sh.style.display = "block"; note("");
    var cf = $("rr-confirm"); if (cf) cf.style.display = "none";
  }
  function closeSheet() { var sh = $("rr-sheet"); if (sh) sh.style.display = "none"; pending = null; placing = false; spotForNext = null; if (dropMark && map) { map.removeLayer(dropMark); dropMark = null; } }
  var spotForNext = null; // set by a long-press on the map: "report right here"
  function pickType(type) {
    if (spotForNext) { var s = spotForNext; spotForNext = null; setPending(type, s.lat, s.lng); return; }
    if (lastFix) { setPending(type, lastFix.lat, lastFix.lng); return; }
    pending = { type: type }; placing = true;
    note("Getting your location… or tap the spot on the map.");
    askGeo(function (fix) {
      if (pending && pending.type === type && pending.lat == null && fix) setPending(type, fix.lat, fix.lng);
    });
  }
  function setPending(type, lat, lng) {
    pending = { type: type, lat: lat, lng: lng }; placing = false;
    if (map) {
      if (dropMark) map.removeLayer(dropMark);
      dropMark = L.marker([lat, lng], { icon: L.divIcon({ className: "rr-pinwrap", html: "<div class='rr-pin rr-pin-drop'>" + TYPES[type].icon + "</div>", iconSize: [46, 46], iconAnchor: [23, 23] }) }).addTo(map);
    }
    var town = nearestTown(lat, lng), cf = $("rr-confirm"), tx = $("rr-confirm-tx");
    if (tx) tx.textContent = TYPES[type].icon + " " + TYPES[type].label + (town ? " — near " + town : " — at this spot") + "?";
    if (cf) cf.style.display = "flex";
    note("");
  }
  function dropReport() {
    if (!pending || pending.lat == null) { note("Tap the spot on the map first."); return; }
    var bad = validateReport(pending.type, pending.lat, pending.lng); if (bad) { note(bad); return; }
    if (!canPost(lastPostMs(), Date.now(), isAdmin())) { note("One report every couple of minutes — give the road a breath."); return; }
    var data = {
      type: pending.type,
      lat: Math.round(pending.lat * 1e5) / 1e5, lng: Math.round(pending.lng * 1e5) / 1e5,
      name: myName() || "Member",
      at: Date.now(), likes: [], votes: []
    };
    var path = "roadreports/" + newId();
    rest({ table: "docs", op: "insert", values: { path: path, coll: "roadreports", data: data } }).then(function (j) {
      if (j && j.error) { note(j.error.message || "That didn't go through — try again."); return; }
      stampPost(); closeSheet(); note("📍 Dropped — thanks for looking out."); loadReports();
    });
  }

  /* ---------- location: one watcher, one blue dot ----------
   * This layer owns the site's single watchPosition. The car
   * page's Map preset still runs its own one-shot ask and hands
   * the fix in through center() — same state, never a second
   * watcher. The dot and ring are painted locally only; nothing
   * about the driver's position is ever written to a doc. */
  function paintMe() {
    if (!map || !lastFix || typeof L === "undefined") return;
    try {
      var ll = [lastFix.lat, lastFix.lng];
      if (lastFix.acc && isFinite(lastFix.acc)) {
        if (!meRing) meRing = L.circle(ll, { radius: lastFix.acc, color: "#3d8bff", weight: 1, opacity: 0.55, fillColor: "#3d8bff", fillOpacity: 0.15, interactive: false }).addTo(map);
        else { meRing.setLatLng(ll); meRing.setRadius(lastFix.acc); }
      }
      if (!meDot) meDot = L.circleMarker(ll, { radius: 9, color: "#ffffff", weight: 3, fillColor: "#1c7dff", fillOpacity: 1, interactive: false }).addTo(map);
      else meDot.setLatLng(ll);
      if (meRing && meRing.bringToFront) meRing.bringToFront();
      if (meDot && meDot.bringToFront) meDot.bringToFront();
    } catch (_) {}
  }
  function paintLocNote() {
    var el = $("rr-locnote"); if (!el) return;
    var txt = locNoteText({ supported: !!navigator.geolocation, status: geoStatus, hasFix: gotFix });
    el.textContent = txt;
    el.style.display = txt ? "block" : "none";
  }
  function onFix(p, opts) {
    if (!p || !p.coords) return;
    var first = !gotFix;
    lastFix = {
      lat: p.coords.latitude, lng: p.coords.longitude,
      acc: (p.coords.accuracy != null && isFinite(p.coords.accuracy)) ? p.coords.accuracy : null,
      spd: (p.coords.speed != null && isFinite(p.coords.speed)) ? p.coords.speed : null,
      at: Date.now()
    };
    gotFix = true; geoStatus = "ok";
    paintLocNote(); paintMe(); paintSpeed(); updateLimit();
    if (map && follow && !(opts && opts.noPan)) {
      if (first) map.setView([lastFix.lat, lastFix.lng], Math.max(map.getZoom() || HOME_ZOOM, 15));
      else if (map.panTo) map.panTo([lastFix.lat, lastFix.lng]);
      updateEarthLink();
    }
  }
  function onGeoErr(e) {
    geoStatus = (e && e.code === 1) ? "denied" : "unavailable";
    paintLocNote();
  }
  function startWatch() {
    if (watchId != null) return;
    if (!navigator.geolocation) { paintLocNote(); return; }
    try {
      watchId = navigator.geolocation.watchPosition(function (p) { onFix(p); }, onGeoErr,
        { enableHighAccuracy: true, maximumAge: 4000, timeout: 20000 });
    } catch (_) { geoStatus = "unavailable"; paintLocNote(); }
  }
  function askGeo(cb) {
    if (!navigator.geolocation) { cb(null); return; }
    navigator.geolocation.getCurrentPosition(function (p) {
      onFix(p, { noPan: true }); cb(lastFix);
    }, function (e) { onGeoErr(e); cb(null); }, { timeout: 8000, maximumAge: 60000 });
  }
  /* 📍 LOCATE: ride back to the dot. With no fix yet, ask once —
   * a denial lands on the plain-words note, never silence. */
  function locateMe() {
    if (lastFix && map) {
      follow = true;
      map.setView([lastFix.lat, lastFix.lng], Math.max(map.getZoom() || HOME_ZOOM, 16));
      paintMe(); updateEarthLink();
      return;
    }
    if (!navigator.geolocation) { paintLocNote(); return; }
    navigator.geolocation.getCurrentPosition(function (p) {
      follow = true; onFix(p);
    }, function (e) { onGeoErr(e); }, { enableHighAccuracy: true, timeout: 10000, maximumAge: 0 });
  }
  function buildLocateCtl() {
    if (typeof L === "undefined" || !L.control) return;
    var ctl = L.control({ position: "topright" });
    ctl.onAdd = function () {
      var div = L.DomUtil.create("div", "rr-nav");
      var b = document.createElement("button"); b.type = "button"; b.className = "rr-locate-btn"; b.textContent = "📍 Locate me";
      b.addEventListener("click", locateMe);
      div.appendChild(b);
      if (L.DomEvent) { L.DomEvent.disableClickPropagation(div); L.DomEvent.disableScrollPropagation(div); }
      return div;
    };
    ctl.addTo(map);
  }
  /* Called by the car page's own Map preset (it runs the geolocation
   * ask there, exactly like it did for the old embed). Its fuller
   * fix (accuracy, GPS speed) feeds the same driver state. */
  function center(lat, lng, acc, spd) {
    onFix({ coords: { latitude: lat, longitude: lng, accuracy: acc, speed: spd } }, { noPan: true });
    follow = true;
    if (map) { map.setView([lat, lng], Math.max(map.getZoom(), 12)); try { map.invalidateSize(); } catch (_) {} updateEarthLink(); }
  }

  /* ---------- speed + the limit of the road you're on ----------
   * Current speed: straight off the GPS fix. Limit: the maxspeed
   * tag of the nearest OpenStreetMap way, via one light Overpass
   * ask, cached per stretch of road — re-asked only after the
   * driver has moved LIMIT_MOVE_M from the last ask (and never
   * more often than LIMIT_GAP_MS, failures included). A cached
   * limit is only trusted within LIMIT_KEEP_M of where it was
   * read; past that, or on any doubt, the strip shows "—". */
  var OVERPASS_URL = "https://overpass-api.de/api/interpreter";
  var LIMIT_RADIUS_M = 40, LIMIT_WAY_MAX_M = 35;
  var LIMIT_MOVE_M = 150, LIMIT_GAP_MS = 12000, LIMIT_KEEP_M = 300;
  var lim = { mph: null, qLat: 0, qLng: 0, qAt: 0, triedAt: 0, inflight: false };

  function curSpeedMph() { return lastFix ? speedMphFromMs(lastFix.spd) : null; }
  function paintSpeed() {
    var n = $("rr-speed-now"), l = $("rr-speed-limit");
    var spd = curSpeedMph();
    if (n) {
      n.textContent = spd == null ? "—" : String(spd);
      n.classList.toggle("over", isOverLimit(spd, lim.mph));
    }
    if (l) l.textContent = lim.mph == null ? "—" : String(lim.mph);
  }
  function updateLimit() {
    if (!lastFix || typeof fetch === "undefined") return;
    if (typeof document !== "undefined" && document.hidden) return; // parked tab: don't spend asks
    var now = Date.now();
    var movedM = lim.qAt ? distMi(lim.qLat, lim.qLng, lastFix.lat, lastFix.lng) * 1609.34 : Infinity;
    if (lim.qAt && movedM > LIMIT_KEEP_M && lim.mph != null) { lim.mph = null; paintSpeed(); } // outran the cached stretch
    if (lim.inflight) return;
    if (lim.qAt && movedM < LIMIT_MOVE_M) return;                 // same stretch — cache holds
    if (now - lim.triedAt < LIMIT_GAP_MS) return;                 // polite spacing, success or failure
    lim.inflight = true; lim.triedAt = now;
    var qLat = lastFix.lat, qLng = lastFix.lng;
    var body = "data=" + encodeURIComponent(overpassQuery(qLat, qLng, LIMIT_RADIUS_M));
    var done = function () { lim.inflight = false; };
    var ctl = (typeof AbortController !== "undefined") ? new AbortController() : null;
    var timer = ctl ? setTimeout(function () { try { ctl.abort(); } catch (_) {} }, 9000) : null;
    fetch(OVERPASS_URL, {
      method: "POST", cache: "no-store",
      headers: { "Content-Type": "application/x-www-form-urlencoded; charset=UTF-8" },
      body: body, signal: ctl ? ctl.signal : undefined
    }).then(function (r) { return r.json(); }).then(function (j) {
      if (timer) clearTimeout(timer); done();
      var picked = pickLimit(j && j.elements, qLat, qLng, LIMIT_WAY_MAX_M);
      lim.mph = picked ? picked.mph : null;
      lim.qLat = qLat; lim.qLng = qLng; lim.qAt = Date.now();
      paintSpeed();
    }).catch(function () {
      if (timer) clearTimeout(timer); done();
      // no answer: the cached stretch (if still in range) stands; nothing invented
    });
  }

  /* ---------- base layers: satellite default, street on tap ---------- */
  function savedBase() { try { return localStorage.getItem(BASE_KEY) === "street" ? "street" : "sat"; } catch (_) { return "sat"; } }
  function paintBaseCtl() {
    if (satBtn) { satBtn.classList.toggle("on", baseMode === "sat"); satBtn.setAttribute("aria-pressed", baseMode === "sat" ? "true" : "false"); }
    if (stBtn) { stBtn.classList.toggle("on", baseMode !== "sat"); stBtn.setAttribute("aria-pressed", baseMode !== "sat" ? "true" : "false"); }
  }
  function applyBase(name, save) {
    baseMode = name === "street" ? "street" : "sat";
    if (!map) return;
    try {
      if (baseMode === "sat") {
        if (streetLayer && map.hasLayer(streetLayer)) map.removeLayer(streetLayer);
        if (satLayer && !map.hasLayer(satLayer)) satLayer.addTo(map);
        if (refLayer && !map.hasLayer(refLayer)) refLayer.addTo(map);
      } else {
        if (satLayer && map.hasLayer(satLayer)) map.removeLayer(satLayer);
        if (refLayer && map.hasLayer(refLayer)) map.removeLayer(refLayer);
        if (streetLayer && !map.hasLayer(streetLayer)) streetLayer.addTo(map);
      }
    } catch (_) {}
    if (save !== false) { try { localStorage.setItem(BASE_KEY, baseMode); } catch (_) {} }
    paintBaseCtl();
  }
  function buildBaseCtl() {
    if (typeof L === "undefined" || !L.control) return;
    var ctl = L.control({ position: "topright" });
    ctl.onAdd = function () {
      var div = L.DomUtil.create("div", "rr-layers");
      satBtn = document.createElement("button"); satBtn.type = "button"; satBtn.className = "rr-layer-btn"; satBtn.textContent = "🛰️ Satellite";
      stBtn = document.createElement("button"); stBtn.type = "button"; stBtn.className = "rr-layer-btn"; stBtn.textContent = "🗺️ Street";
      satBtn.addEventListener("click", function () { applyBase("sat"); });
      stBtn.addEventListener("click", function () { applyBase("street"); });
      div.appendChild(satBtn); div.appendChild(stBtn);
      if (L.DomEvent) { L.DomEvent.disableClickPropagation(div); L.DomEvent.disableScrollPropagation(div); }
      return div;
    };
    ctl.addTo(map);
    paintBaseCtl();
  }

  /* ---------- Google Earth link: follows the map's current view ---------- */
  function earthUrl() {
    var c = (map && map.getCenter) ? map.getCenter() : { lat: HOME[0], lng: HOME[1] };
    var z = (map && map.getZoom) ? map.getZoom() : HOME_ZOOM;
    var d = Math.round(Math.min(120000, Math.max(900, 2600 * Math.pow(2, HOME_ZOOM - z))));
    return "https://earth.google.com/web/@" + (+c.lat).toFixed(5) + "," + (+c.lng).toFixed(5) + ",900a," + d + "d";
  }
  function updateEarthLink() { var a = $("earthlink"); if (a) a.href = earthUrl(); }

  /* ---------- size keeper: Leaflet's grid must match the real box ----------
   * The car card grows after init (the guide list renders, fonts land),
   * and a one-shot invalidateSize left tiles only in a top strip with
   * black below. Re-sync on every size signal: staged retries, window
   * resize/orientation, tab visibility, the container entering view —
   * and a ResizeObserver on the container itself, the definitive one. */
  function sizeKeeper() {
    var fix = function () { if (map) { try { map.invalidateSize(); } catch (_) {} } };
    if (window.requestAnimationFrame) requestAnimationFrame(fix);
    [150, 450, 1200, 2600].forEach(function (ms) { setTimeout(fix, ms); });
    window.addEventListener("resize", fix);
    window.addEventListener("orientationchange", fix);
    window.addEventListener("load", fix);
    document.addEventListener("visibilitychange", function () { if (!document.hidden) fix(); });
    var el = null; try { el = map.getContainer ? map.getContainer() : $("map"); } catch (_) { el = $("map"); }
    if (el && "ResizeObserver" in window) { try { new ResizeObserver(fix).observe(el); } catch (_) {} }
    if (el && "IntersectionObserver" in window) {
      try { new IntersectionObserver(function (es) { es.forEach(function (e) { if (e.isIntersecting) fix(); }); }, { threshold: [0.1, 0.5, 0.9] }).observe(el); } catch (_) {}
    }
  }

  /* ---------- build the UI ---------- */
  function buildUI() {
    var ui = $("rr-ui"); if (!ui) return;
    ui.innerHTML =
      "<div class='rr-drive' id='rr-drive'>" +
        "<div class='rr-speedbox'><span class='rr-speednum' id='rr-speed-now'>—</span><span class='rr-speedunit'>mph</span></div>" +
        "<div class='rr-limitbox'><span class='rr-limitlab'>LIMIT</span><span class='rr-limitnum' id='rr-speed-limit'>—</span></div>" +
      "</div>" +
      "<p class='rr-limitsrc'>Speed from your GPS · limit from OpenStreetMap, shown only where the road is tagged.</p>" +
      "<p class='rr-locnote' id='rr-locnote' role='status' style='display:none'></p>" +
      "<button type='button' id='rr-open' class='rr-open'>⚠️ REPORT ON THE ROAD</button>" +
      "<p class='rr-count' id='rr-count'>Loading road reports…</p>" +
      "<div id='rr-sheet' class='rr-sheet' style='display:none'>" +
        "<div class='rr-grid' id='rr-grid'></div>" +
        "<div class='rr-confirm' id='rr-confirm' style='display:none'><span id='rr-confirm-tx'></span>" +
          "<button type='button' id='rr-drop' class='rr-drop'>📍 Drop it</button>" +
          "<button type='button' id='rr-cancel' class='rr-cancel'>Cancel</button></div>" +
        "<p class='rr-safe'>Report when parked or as a passenger — drive safe.</p>" +
        "<button type='button' id='rr-close' class='rr-cancel'>Close</button>" +
      "</div>" +
      "<p class='rr-note' id='rr-note' role='status'></p>";
    var grid = $("rr-grid");
    TYPE_ORDER.forEach(function (key) {
      var b = document.createElement("button"); b.type = "button"; b.className = "rr-type";
      b.textContent = TYPES[key].icon + " " + TYPES[key].label;
      b.addEventListener("click", function () { pickType(key); });
      grid.appendChild(b);
    });
    $("rr-open").addEventListener("click", function () { spotForNext = null; openSheet(); });
    $("rr-close").addEventListener("click", closeSheet);
    $("rr-cancel").addEventListener("click", closeSheet);
    $("rr-drop").addEventListener("click", dropReport);
  }

  function fallbackEmbed() {
    var el = $("map"); if (!el || el.dataset.rrFallback) return; el.dataset.rrFallback = "1";
    el.innerHTML = "<iframe title='Map — satellite view' style='width:100%;height:100%;min-height:300px;border:0;display:block' loading='lazy' src='https://maps.google.com/maps?q=39.8238%2C-79.5884&amp;z=13&amp;t=k&amp;output=embed'></iframe>";
    var c = $("rr-count"); if (c) c.textContent = "Road reports need the interactive map — it's having a moment. A satellite map is up instead.";
    var o = $("rr-open"); if (o) o.style.display = "none";
  }

  function init() {
    if (started) return; started = true;
    buildUI();
    startWatch(); // GPS speed + the blue dot work even if the map CDN stumbles
    paintLocNote();
    if (typeof L === "undefined") { fallbackEmbed(); return; }
    var el = $("map"); if (!el) return;
    map = L.map(el, { scrollWheelZoom: true }).setView(HOME, HOME_ZOOM);
    satLayer = L.tileLayer(SAT_URL, { maxZoom: 19, attribution: SAT_ATTR });
    refLayer = L.tileLayer(REF_URL, { maxZoom: 19 });
    streetLayer = L.tileLayer(OSM_URL, { maxZoom: 19, attribution: OSM_ATTR });
    applyBase(savedBase(), false); // satellite unless this device chose street
    layer = L.layerGroup().addTo(map);
    try { buildBaseCtl(); } catch (_) {}
    try { buildLocateCtl(); } catch (_) {}
    sizeKeeper();
    updateEarthLink();
    map.on("moveend", updateEarthLink);
    map.on("dragstart", function () { follow = false; }); // the driver's hand wins; 📍 rides back
    if (lastFix) { // a fix beat the map here — open on the driver, not the home view
      follow = true;
      map.setView([lastFix.lat, lastFix.lng], Math.max(HOME_ZOOM, 15));
      paintMe(); paintSpeed(); updateEarthLink();
    }
    map.on("click", function (e) { if (placing && pending && pending.type) setPending(pending.type, e.latlng.lat, e.latlng.lng); });
    map.on("contextmenu", function (e) {
      if (!session()) { note("👀 Viewing is open to everyone. To drop a report, sign in on the main site first."); return; }
      openSheet(); spotForNext = e.latlng;
      note("📍 Spot set — now pick what you saw.");
    });
    loadAdmins().then(loadReports);
    setInterval(function () { if (!document.hidden) loadReports(); }, 60000);
    document.addEventListener("visibilitychange", function () { if (!document.hidden) loadReports(); });
  }
  function boot() {
    var el = $("map"); if (!el) return;
    if ("IntersectionObserver" in window) {
      var io = new IntersectionObserver(function (es) { if (es.some(function (e) { return e.isIntersecting; })) { io.disconnect(); init(); } }, { rootMargin: "600px" });
      io.observe(el); setTimeout(init, 4000); // parked-car dashboards may never scroll
    } else init();
  }
  if (document.readyState === "loading") document.addEventListener("DOMContentLoaded", boot); else boot();

  return { init: init, center: center, pure: PURE };
})();
if (typeof window !== "undefined") window.MWRR = MWRR;
