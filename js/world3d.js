/* Meechie's World — Virtual World 3D renderer (IMVU-style).
 * Plain browser script. Exposes window.World3D:
 *   mount(containerEl, {onWalk, onPose, onSay}) -> Promise
 *   setRoom("lounge"|"studio"|"rooftop"|"club")
 *   update([{key,isMe,name,look,x,y,pose,poseAt,say,sayAt,faceUrl}])
 *   supported() -> boolean
 * three.js is loaded lazily from W3D_THREE_URL (overridable via window.W3D_THREE_URL).
 */
(function () {
  "use strict";

  var W3D_THREE_URL = "https://cdn.jsdelivr.net/npm/three@0.160.0/build/three.module.js";

  var ROOM_NAMES = { lounge: "Gold Lounge", studio: "Studio B", rooftop: "Rooftop", club: "Club Conscientia" };
  var X_MIN = 0.05, X_MAX = 0.95, Y_MIN = 0.64, Y_MAX = 0.97;
  var HALF_W = 4.6, Z_BACK = -3.3, Z_FRONT = 3.4;
  var WALK_SPEED = 1.45;

  var T = null;              // three module
  var S = null;              // live state after mount
  var pending = { room: "lounge", list: null };
  var mounting = null;
  var supportedCache = null;
  var reduced = false;
  try { reduced = window.matchMedia && window.matchMedia("(prefers-reduced-motion: reduce)").matches; } catch (e) {}

  /* ------------------------------------------------------------------ utils */
  function clamp(v, a, b) { return v < a ? a : v > b ? b : v; }
  function num(v, d) { v = Number(v); return isFinite(v) ? v : d; }
  function toWorld(x, y) {
    x = clamp(num(x, 0.5), X_MIN, X_MAX); y = clamp(num(y, 0.8), Y_MIN, Y_MAX);
    return { x: (x - 0.5) / 0.45 * HALF_W, z: Z_BACK + (y - Y_MIN) / (Y_MAX - Y_MIN) * (Z_FRONT - Z_BACK) };
  }
  function fromWorld(X, Z) {
    var x = 0.5 + X / HALF_W * 0.45, y = Y_MIN + (Z - Z_BACK) / (Z_FRONT - Z_BACK) * (Y_MAX - Y_MIN);
    return { x: +clamp(x, X_MIN, X_MAX).toFixed(4), y: +clamp(y, Y_MIN, Y_MAX).toFixed(4) };
  }
  function toMs(v) { if (v == null) return 0; if (typeof v === "number") return v; var t = Date.parse(v); return isFinite(t) ? t : 0; }
  function hexOk(h, d) { return (typeof h === "string" && /^#?[0-9a-f]{3}([0-9a-f]{3})?$/i.test(h)) ? (h[0] === "#" ? h : "#" + h) : d; }
  function rng(seed) { var s = seed >>> 0; return function () { s += 0x6D2B79F5; var t = s; t = Math.imul(t ^ t >>> 15, t | 1); t ^= t + Math.imul(t ^ t >>> 7, t | 61); return ((t ^ t >>> 14) >>> 0) / 4294967296; }; }
  function hashStr(s) { var h = 2166136261; for (var i = 0; i < s.length; i++) { h ^= s.charCodeAt(i); h = Math.imul(h, 16777619); } return h >>> 0; }
  function angLerp(a, b, f) { var d = ((b - a + Math.PI * 3) % (Math.PI * 2)) - Math.PI; return a + d * f; }
  function shade(hex, k) { var c = new T.Color(hex); c.multiplyScalar(k); return c; }

  function supported() {
    if (supportedCache !== null) return supportedCache;
    try {
      var c = document.createElement("canvas");
      var gl = window.WebGLRenderingContext && (c.getContext("webgl2") || c.getContext("webgl"));
      supportedCache = !!gl;
      try { var ext = gl && gl.getExtension("WEBGL_lose_context"); if (ext) ext.loseContext(); } catch (e) {}
    } catch (e) { supportedCache = false; }
    return supportedCache;
  }

  /* --------------------------------------------------------------- textures */
  function ctex(w, h, draw, rep) {
    var c = document.createElement("canvas"); c.width = w; c.height = h;
    var g = c.getContext("2d"); draw(g, w, h);
    var t = new T.CanvasTexture(c); t.colorSpace = T.SRGBColorSpace; t.anisotropy = 4;
    if (rep) { t.wrapS = t.wrapT = T.RepeatWrapping; t.repeat.set(rep[0], rep[1]); }
    return t;
  }

  function drawEmblem(g, cx, cy, s, col) {
    g.save(); g.translate(cx, cy); g.strokeStyle = col; g.fillStyle = col; g.lineWidth = Math.max(2, s * 0.035); g.lineJoin = "round"; g.lineCap = "round";
    for (var i = -4; i <= 4; i++) { var a = -Math.PI / 2 + i * 0.22; g.beginPath(); g.moveTo(Math.cos(a) * s * 0.52, -s * 0.2 + Math.sin(a) * s * 0.52); g.lineTo(Math.cos(a) * s * 0.66, -s * 0.2 + Math.sin(a) * s * 0.66); g.stroke(); }
    g.beginPath(); g.moveTo(0, -s * 0.5); g.lineTo(s * 0.38, s * 0.16); g.lineTo(-s * 0.38, s * 0.16); g.closePath(); g.stroke();
    g.beginPath(); g.moveTo(-s * 0.15, -s * 0.06); g.quadraticCurveTo(0, -s * 0.2, s * 0.15, -s * 0.06); g.quadraticCurveTo(0, s * 0.08, -s * 0.15, -s * 0.06); g.stroke();
    g.beginPath(); g.arc(0, -s * 0.065, s * 0.05, 0, 7); g.fill();
    g.beginPath(); g.moveTo(0, s * 0.3); g.quadraticCurveTo(-s * 0.22, s * 0.2, -s * 0.46, s * 0.25); g.lineTo(-s * 0.46, s * 0.42);
    g.quadraticCurveTo(-s * 0.22, s * 0.37, 0, s * 0.47); g.quadraticCurveTo(s * 0.22, s * 0.37, s * 0.46, s * 0.42); g.lineTo(s * 0.46, s * 0.25);
    g.quadraticCurveTo(s * 0.22, s * 0.2, 0, s * 0.3); g.closePath(); g.stroke();
    g.beginPath(); g.moveTo(0, s * 0.3); g.lineTo(0, s * 0.47); g.stroke();
    g.restore();
  }
  function drawCompass(g, cx, cy, s, col) {
    g.save(); g.translate(cx, cy); g.strokeStyle = col; g.fillStyle = col; g.lineWidth = Math.max(2, s * 0.03);
    g.beginPath(); g.arc(0, 0, s * 0.42, 0, 7); g.stroke();
    for (var i = 0; i < 8; i++) {
      var a = i * Math.PI / 4, L = i % 2 ? s * 0.26 : s * 0.46, w = s * 0.07;
      g.beginPath(); g.moveTo(Math.cos(a) * L, Math.sin(a) * L); g.lineTo(Math.cos(a + 1.57) * w, Math.sin(a + 1.57) * w); g.lineTo(Math.cos(a - 1.57) * w, Math.sin(a - 1.57) * w); g.closePath();
      if (i % 2) g.stroke(); else g.fill();
    }
    g.font = "bold " + (s * 0.16) + "px sans-serif"; g.textAlign = "center"; g.textBaseline = "middle"; g.fillText("N", 0, -s * 0.58);
    g.restore();
  }

  var SHARED = {};
  function sharedTex() {
    if (SHARED.blob) return;
    SHARED.blob = ctex(128, 128, function (g) {
      var r = g.createRadialGradient(64, 64, 4, 64, 64, 62); r.addColorStop(0, "rgba(0,0,0,0.55)"); r.addColorStop(0.6, "rgba(0,0,0,0.25)"); r.addColorStop(1, "rgba(0,0,0,0)");
      g.fillStyle = r; g.fillRect(0, 0, 128, 128);
    });
    SHARED.glow = ctex(128, 128, function (g) {
      var r = g.createRadialGradient(64, 64, 2, 64, 64, 62); r.addColorStop(0, "rgba(255,255,255,1)"); r.addColorStop(0.35, "rgba(255,255,255,0.35)"); r.addColorStop(1, "rgba(255,255,255,0)");
      g.fillStyle = r; g.fillRect(0, 0, 128, 128);
    });
    SHARED.blob.userData.shared = SHARED.glow.userData.shared = true;
  }

  /* ------------------------------------------------------------- materials */
  function std(color, rough, metal, extra) {
    var o = { color: color, roughness: rough == null ? 0.7 : rough, metalness: metal || 0 };
    if (extra) for (var k in extra) o[k] = extra[k];
    return new T.MeshStandardMaterial(o);
  }
  function glowMat(color, intensity) { return new T.MeshStandardMaterial({ color: 0x000000, emissive: color, emissiveIntensity: intensity || 2, roughness: 1 }); }

  function disposeTree(obj) {
    var seen = new Set();
    obj.traverse(function (o) {
      if (o.geometry && !o.geometry.userData.shared && !seen.has(o.geometry)) { seen.add(o.geometry); o.geometry.dispose(); }
      var ms = o.material ? (Array.isArray(o.material) ? o.material : [o.material]) : [];
      ms.forEach(function (m) {
        if (seen.has(m)) return; seen.add(m);
        ["map", "emissiveMap", "roughnessMap", "alphaMap", "bumpMap"].forEach(function (k) { var t = m[k]; if (t && !t.userData.shared && !seen.has(t)) { seen.add(t); t.dispose(); } });
        m.dispose();
      });
    });
  }

  /* ============================================================== AVATARS */
  var GEO = null;
  function initGeo() {
    if (GEO) return;
    function lathe(pts, seg) { return new T.LatheGeometry(pts.map(function (p) { return new T.Vector2(p[0], p[1]); }), seg || 20); }
    GEO = {
      head: new T.SphereGeometry(1, 32, 24),
      face: new T.SphereGeometry(1.012, 28, 18, Math.PI / 2 - 0.8, 1.6, Math.PI * 0.27, Math.PI * 0.52),
      ball: new T.SphereGeometry(1, 16, 12),
      thigh: new T.CapsuleGeometry(0.07, 0.32, 6, 14).translate(0, -0.21, 0),
      shin: new T.CapsuleGeometry(0.054, 0.34, 6, 14).translate(0, -0.21, 0),
      uarm: new T.CapsuleGeometry(0.049, 0.2, 6, 12).translate(0, -0.14, 0),
      farm: new T.CapsuleGeometry(0.042, 0.19, 6, 12).translate(0, -0.13, 0),
      neck: new T.CylinderGeometry(0.046, 0.05, 0.14, 14),
      torso: lathe([[0.001, 0], [0.135, 0], [0.138, 0.08], [0.128, 0.18], [0.145, 0.3], [0.168, 0.41], [0.172, 0.47], [0.14, 0.53], [0.07, 0.565], [0.001, 0.57]], 24),
      torsoF: lathe([[0.001, 0], [0.128, 0], [0.122, 0.08], [0.108, 0.18], [0.14, 0.3], [0.152, 0.38], [0.15, 0.46], [0.13, 0.53], [0.065, 0.565], [0.001, 0.57]], 24),
      pelvis: lathe([[0.001, 0.02], [0.136, 0.02], [0.148, -0.05], [0.14, -0.12], [0.09, -0.17], [0.001, -0.18]], 20),
      skirt: lathe([[0.112, 0.06], [0.15, -0.05], [0.2, -0.2], [0.27, -0.4], [0.31, -0.52], [0.305, -0.54]], 28),
      stripeArm: new T.BoxGeometry(0.014, 0.3, 0.02),
      stripeLeg: new T.BoxGeometry(0.016, 0.4, 0.022),
      hairCap: new T.SphereGeometry(1.07, 28, 14, 0, Math.PI * 2, 0, Math.PI * 0.5),
      loc: new T.CylinderGeometry(0.016, 0.013, 0.32, 6).translate(0, -0.16, 0),
      blob: new T.PlaneGeometry(0.9, 0.9).rotateX(-Math.PI / 2),
      stool: new T.CylinderGeometry(0.24, 0.26, 0.44, 20),
      print: new T.CylinderGeometry(1, 1, 0.2, 16, 1, true, -0.62, 1.24),
      badge: new T.CylinderGeometry(1, 1, 0.075, 8, 1, true, 0.25, 0.5),
      hood: new T.TorusGeometry(0.1, 0.05, 10, 20, Math.PI * 1.3),
      shoe: new T.SphereGeometry(1, 16, 10, 0, Math.PI * 2, 0, Math.PI * 0.55)
    };
    for (var k in GEO) GEO[k].userData.shared = true;
  }

  function normLook(l) {
    l = l || {};
    var pick = function (v, allowed, d) { return allowed.indexOf(v) >= 0 ? v : d; };
    return {
      skin: hexOk(l.skin, "#8d5a3b"),
      hair: pick(l.hair, ["fade", "locs", "braids", "waves", "long", "bun", "bald"], "fade"),
      hairColor: hexOk(l.hairColor, "#1a1410"),
      outfit: pick(l.outfit, ["suit", "hoodie", "dress", "track"], "hoodie"),
      outfitColor: hexOk(l.outfitColor, "#15130f"),
      extra: pick(l.extra, ["none", "shades", "goldchain", "crown", "cap"], "none"),
      trim: hexOk(l.trim, "#d4a843"),
      print: pick(l.print, ["none", "emblem", "compass", "text"], "none"),
      printColor: hexOk(l.printColor, "#d4a843"),
      printText: String(l.printText == null ? "" : l.printText).slice(0, 10)
    };
  }

  function faceTexture(lk) {
    return ctex(256, 256, function (g) {
      var hc = new T.Color(lk.hairColor).multiplyScalar(0.8).getStyle();
      var sk = new T.Color(lk.skin), lip = sk.clone().lerp(new T.Color("#7a2f2f"), 0.45).getStyle();
      var dark = sk.clone().multiplyScalar(0.72).getStyle();
      g.clearRect(0, 0, 256, 256);
      [-1, 1].forEach(function (s) {
        var ex = 128 + s * 52, ey = 118;
        g.fillStyle = "rgba(0,0,0,0.12)"; g.beginPath(); g.ellipse(ex, ey - 4, 26, 15, 0, 0, 7); g.fill();
        g.fillStyle = "#f6f1ea"; g.beginPath(); g.ellipse(ex, ey, 20, 12, 0, 0, 7); g.fill();
        g.fillStyle = "#3b2414"; g.beginPath(); g.arc(ex, ey + 1, 10, 0, 7); g.fill();
        g.fillStyle = "#0b0705"; g.beginPath(); g.arc(ex, ey + 1, 5, 0, 7); g.fill();
        g.fillStyle = "#fff"; g.beginPath(); g.arc(ex + 3, ey - 3, 2.6, 0, 7); g.fill();
        g.strokeStyle = "#120c08"; g.lineWidth = 3.5; g.beginPath(); g.ellipse(ex, ey, 21, 13, 0, Math.PI * 1.05, Math.PI * 1.95); g.stroke();
        g.strokeStyle = hc; g.lineWidth = 7; g.lineCap = "round"; g.beginPath(); g.moveTo(ex - s * 22, 92); g.quadraticCurveTo(ex, 80, ex + s * 22, 88); g.stroke();
      });
      g.strokeStyle = dark; g.lineWidth = 3; g.beginPath(); g.moveTo(122, 132); g.quadraticCurveTo(116, 160, 120, 166); g.quadraticCurveTo(128, 172, 138, 165); g.stroke();
      g.fillStyle = lip; g.beginPath(); g.moveTo(102, 196); g.quadraticCurveTo(128, 186, 154, 196); g.quadraticCurveTo(128, 214, 102, 196); g.fill();
      g.strokeStyle = "rgba(40,10,10,0.6)"; g.lineWidth = 2; g.beginPath(); g.moveTo(104, 196); g.quadraticCurveTo(128, 202, 152, 196); g.stroke();
      g.fillStyle = "rgba(200,80,80,0.08)"; g.beginPath(); g.arc(70, 160, 18, 0, 7); g.arc(186, 160, 18, 0, 7); g.fill();
    });
  }

  function printTexture(lk, kind) {
    return ctex(256, 256, function (g, w, h) {
      g.clearRect(0, 0, w, h);
      if (kind === "emblem") drawEmblem(g, 128, 132, 150, lk.printColor);
      else if (kind === "compass") drawCompass(g, 128, 140, 150, lk.printColor);
      else if (kind === "text") {
        var t = lk.printText || "MEECHIE"; var fs = Math.min(72, 230 / Math.max(1, t.length) * 1.7);
        g.fillStyle = lk.printColor; g.font = "900 " + fs + "px Arial, sans-serif"; g.textAlign = "center"; g.textBaseline = "middle"; g.fillText(t.toUpperCase(), 128, 128);
      }
    });
  }

  function loadFace(A, url, mesh) {
    try {
      var img = new Image();
      if (!/^data:/i.test(url)) img.crossOrigin = "anonymous";
      img.onload = function () {
        if (A.disposed) return;
        try {
          var tex = ctex(256, 256, function (g) {
            var s = Math.min(img.width, img.height), sx = (img.width - s) / 2, sy = (img.height - s) / 2;
            g.drawImage(img, sx, sy, s, s, 20, 8, 216, 240);
            g.globalCompositeOperation = "destination-in";
            var r = g.createRadialGradient(128, 128, 70, 128, 128, 124); r.addColorStop(0, "rgba(0,0,0,1)"); r.addColorStop(1, "rgba(0,0,0,0)");
            g.fillStyle = r; g.fillRect(0, 0, 256, 256);
          });
          var old = mesh.material.map; mesh.material.map = tex; mesh.material.needsUpdate = true; if (old) old.dispose();
        } catch (e) { /* tainted canvas etc: keep stylized face */ }
      };
      img.src = url;
    } catch (e) {}
  }

  function buildAvatar(item) {
    initGeo(); sharedTex();
    var lk = normLook(item.look);
    var A = { key: item.key, sig: JSON.stringify(lk) + "|" + (item.faceUrl || ""), joints: {}, cur: {}, ph: 0, heading: 0, moving: false };
    var root = new T.Group(); A.root = root;
    function mesh(geo, mat, parent, x, y, z, sx, sy, sz) {
      var m = new T.Mesh(geo, mat); m.position.set(x || 0, y || 0, z || 0);
      if (sx != null) m.scale.set(sx, sy == null ? sx : sy, sz == null ? sx : sz);
      m.castShadow = true; m.receiveShadow = true; parent.add(m); return m;
    }
    function grp(parent, x, y, z) { var g = new T.Group(); g.position.set(x || 0, y || 0, z || 0); parent.add(g); return g; }

    var isF = lk.outfit === "dress";
    var skinM = std(lk.skin, 0.55, 0);
    var oc = lk.outfit;
    var outM = std(lk.outfitColor, oc === "suit" ? 0.5 : oc === "track" ? 0.45 : 0.85, oc === "track" ? 0.05 : 0);
    var trimM = std(lk.trim, 0.35, 0.5);
    var pantsM = oc === "hoodie" ? std("#252c3a", 0.9, 0) : oc === "dress" ? skinM : outM;
    var shoeM = oc === "suit" ? std("#0c0b0a", 0.25, 0.2) : oc === "dress" ? std(lk.trim, 0.3, 0.4) : std("#f2efe8", 0.6, 0);
    var hairM = std(lk.hairColor, 0.8, 0.05);
    var goldM = std("#d4a843", 0.28, 1);

    var blob = new T.Mesh(GEO.blob, new T.MeshBasicMaterial({ map: SHARED.blob, transparent: true, depthWrite: false }));
    blob.position.y = 0.012; blob.renderOrder = 1; root.add(blob);
    A.stool = mesh(GEO.stool, std("#2a1d14", 0.5, 0.1), root, 0, 0.22, -0.12); A.stool.visible = false;
    mesh(new T.TorusGeometry(0.25, 0.02, 8, 24).rotateX(Math.PI / 2), goldM, A.stool, 0, 0.21, 0);

    var body = grp(root, 0, 0.93, 0); A.joints.body = body;
    mesh(GEO.pelvis, outM === pantsM ? outM : (isF ? outM : pantsM), body, 0, 0, 0, 1, 1, 0.72);
    var spine = grp(body, 0, 0, 0); A.joints.spine = spine;
    var bulk = oc === "hoodie" ? 1.1 : oc === "suit" ? 1.04 : 1;
    var torso = mesh(isF ? GEO.torsoF : GEO.torso, outM, spine, 0, 0, 0, bulk, 1, 0.64 * bulk);

    // outfit details
    if (oc === "suit") {
      var shirtM = std("#f4f1ea", 0.6, 0);
      var vg = new T.BufferGeometry(); vg.setAttribute("position", new T.Float32BufferAttribute([-0.07, 0.53, 0, 0.07, 0.53, 0, 0, 0.27, 0], 3)); vg.computeVertexNormals();
      var shirt = mesh(vg, shirtM, spine, 0, 0, 0.113 * bulk); shirt.castShadow = false;
      mesh(new T.BoxGeometry(0.035, 0.22, 0.012), trimM, spine, 0, 0.4, 0.112 * bulk).rotation.x = -0.12;
      var lapM = std(shade(lk.outfitColor, 0.7), 0.45, 0);
      [-1, 1].forEach(function (s) {
        var lp = mesh(new T.BoxGeometry(0.045, 0.26, 0.012), lapM, spine, s * 0.06, 0.41, 0.112 * bulk); lp.rotation.z = s * 0.28; lp.rotation.x = -0.15;
      });
      mesh(new T.BoxGeometry(0.05, 0.022, 0.012), trimM, spine, 0.1, 0.4, 0.098);
      for (var b = 0; b < 2; b++) mesh(GEO.ball, goldM, spine, 0, 0.2 + b * 0.06, 0.088 * bulk + 0.008, 0.009);
    } else if (oc === "hoodie") {
      var hood = mesh(GEO.hood, outM, spine, 0, 0.555, -0.05); hood.rotation.set(-1.1, 0, Math.PI * -0.15 + Math.PI);
      hood.rotation.set(Math.PI / 2 + 0.5, 0, 0); hood.rotation.z = -0.65 * Math.PI;
      mesh(new T.BoxGeometry(0.2, 0.11, 0.03), std(shade(lk.outfitColor, 0.82), 0.9, 0), spine, 0, 0.12, 0.086 * bulk + 0.004);
      [-1, 1].forEach(function (s) { mesh(new T.CylinderGeometry(0.005, 0.005, 0.16, 5), std("#f1ece2", 0.6), spine, s * 0.035, 0.43, 0.112 * bulk); });
    } else if (oc === "track") {
      mesh(new T.BoxGeometry(0.012, 0.5, 0.012), trimM, spine, 0, 0.27, 0.093);
      [-1, 1].forEach(function (s) { mesh(new T.BoxGeometry(0.11, 0.025, 0.02), trimM, spine, s * 0.12, 0.47, 0.06).rotation.z = s * -0.35; });
    } else if (isF) {
      mesh(GEO.skirt, outM, body, 0, 0, 0, 1, 1, 0.82);
      mesh(new T.TorusGeometry(0.115, 0.012, 6, 28).rotateX(Math.PI / 2), trimM, body, 0, 0.06, 0, 1, 1, 0.75);
    }

    // chest print
    if (lk.print !== "none") {
      var pm = new T.MeshStandardMaterial({ map: printTexture(lk, lk.print), transparent: true, roughness: 0.6, depthWrite: false, polygonOffset: true, polygonOffsetFactor: -2 });
      var r = (isF ? 0.15 : 0.163) * bulk * 1.02;
      if (oc === "suit") { var bd = new T.Mesh(GEO.badge, pm); bd.position.set(0, 0.42, 0); bd.scale.set(r, 1, r * 0.64); spine.add(bd); }
      else { var pr = new T.Mesh(GEO.print, pm); pr.position.set(0, oc === "hoodie" ? 0.33 : 0.34, 0); pr.scale.set(r, 1.05, r * 0.66); spine.add(pr); }
    }

    // neck + head
    mesh(GEO.neck, skinM, spine, 0, 0.6, 0);
    if (lk.extra === "goldchain") {
      mesh(new T.TorusGeometry(0.105, 0.012, 8, 32).rotateX(Math.PI / 2 - 0.5), goldM, spine, 0, 0.51, 0.025);
      mesh(new T.CylinderGeometry(0.03, 0.03, 0.01, 16).rotateX(Math.PI / 2), goldM, spine, 0, 0.42, 0.098);
    }
    var head = grp(spine, 0, 0.73, 0.005); A.joints.head = head;
    var HS = [0.105, 0.125, 0.115];
    mesh(GEO.head, skinM, head, 0, 0, 0, HS[0], HS[1], HS[2]);
    var faceM = new T.MeshStandardMaterial({ map: faceTexture(lk), transparent: true, roughness: 0.55, depthWrite: false, polygonOffset: true, polygonOffsetFactor: -2 });
    var face = new T.Mesh(GEO.face, faceM); face.scale.set(HS[0], HS[1], HS[2]); face.renderOrder = 2; head.add(face);
    if (item.faceUrl && typeof item.faceUrl === "string" && /^(data:image\/|https:\/\/|blob:)/i.test(item.faceUrl)) loadFace(A, item.faceUrl, face);
    mesh(GEO.ball, skinM, head, 0, -0.012, 0.112, 0.018, 0.026, 0.02);
    [-1, 1].forEach(function (s) { mesh(GEO.ball, skinM, head, s * 0.103, -0.005, -0.005, 0.016, 0.03, 0.022); });

    // hair
    var hh = lk.hair;
    if (hh !== "bald") {
      var capMat = hairM;
      if (hh === "waves" || hh === "braids") {
        capMat = std(lk.hairColor, 0.75, 0.05, { map: ctex(256, 128, function (g, w, h) {
          g.fillStyle = "#ffffff"; g.fillRect(0, 0, w, h); g.strokeStyle = "rgba(0,0,0,0.55)"; g.lineWidth = hh === "braids" ? 5 : 3;
          if (hh === "waves") { for (var y = 6; y < h; y += 9) { g.beginPath(); for (var x = 0; x <= w; x += 4) g.lineTo(x, y + Math.sin(x * 0.18) * 3); g.stroke(); } }
          else { for (var x2 = 0; x2 < w; x2 += 16) { for (var y2 = 0; y2 < h; y2 += 10) { g.beginPath(); g.ellipse(x2 + 8, y2 + 5, 6, 5, 0, 0, 7); g.stroke(); } } }
        }) });
      }
      var cap = mesh(GEO.hairCap, capMat, head, 0, 0.004, -0.004, HS[0], HS[1] * (hh === "fade" ? 0.98 : 1.02), HS[2]);
      cap.rotation.x = -0.32;
      if (hh === "fade") { cap.scale.multiplyScalar(0.99); }
      if (hh === "locs" || hh === "braids") {
        var n = hh === "locs" ? 16 : 10, rr = rng(hashStr(item.key || "x"));
        for (var i = 0; i < n; i++) {
          var a = Math.PI * 0.12 + (i / (n - 1)) * Math.PI * 0.76; // back half arc (around -z)
          var lx = Math.cos(a) * 0.105, lz = -Math.sin(a) * 0.11;
          var lc = mesh(GEO.loc, hairM, head, lx, 0.04 + rr() * 0.03, lz, 1, hh === "locs" ? 0.9 + rr() * 0.5 : 0.8, 1);
          lc.rotation.z = -lx * 1.6; lc.rotation.x = -lz * 1.6 - 0.1;
          if (hh === "braids") mesh(GEO.ball, trimM, lc, 0, -0.32 * lc.scale.y, 0, 0.018);
        }
      }
      if (hh === "long") {
        mesh(GEO.ball, hairM, head, 0, -0.1, -0.05, 0.125, 0.22, 0.085);
        [-1, 1].forEach(function (s) { mesh(GEO.ball, hairM, head, s * 0.09, -0.07, 0.0, 0.035, 0.17, 0.07); });
        mesh(GEO.ball, hairM, head, 0, 0.085, 0.04, 0.1, 0.045, 0.08).rotation.x = 0.4;
      }
      if (hh === "bun") { mesh(GEO.ball, hairM, head, 0, 0.13, -0.05, 0.06); mesh(new T.TorusGeometry(0.045, 0.01, 6, 16).rotateX(Math.PI / 2 - 0.5), trimM, head, 0, 0.1, -0.045); }
    }
    // extras
    if (lk.extra === "shades") {
      var sm = std("#050505", 0.08, 0.6);
      [-1, 1].forEach(function (s) { var l = mesh(GEO.ball, sm, head, s * 0.045, 0.012, 0.106, 0.038, 0.024, 0.012); l.rotation.y = s * 0.25; });
      mesh(new T.BoxGeometry(0.2, 0.01, 0.01), goldM, head, 0, 0.026, 0.106);
    } else if (lk.extra === "crown") {
      var cr = grp(head, 0, 0.115, -0.01); cr.rotation.x = -0.15;
      mesh(new T.CylinderGeometry(0.085, 0.08, 0.045, 24, 1, true), goldM, cr, 0, 0, 0).material.side = T.DoubleSide;
      for (var c = 0; c < 8; c++) { var ca = c / 8 * Math.PI * 2; mesh(new T.ConeGeometry(0.016, 0.05, 6), goldM, cr, Math.cos(ca) * 0.082, 0.045, Math.sin(ca) * 0.082); mesh(GEO.ball, std("#b3122a", 0.2, 0.3), cr, Math.cos(ca) * 0.086, 0.0, Math.sin(ca) * 0.086, 0.009); }
    } else if (lk.extra === "cap") {
      var cm = std(lk.trim, 0.7, 0.05);
      var ch = mesh(GEO.hairCap, cm, head, 0, 0.02, -0.004, HS[0] * 1.03, HS[1] * 0.92, HS[2] * 1.03); ch.rotation.x = -0.15;
      mesh(new T.CylinderGeometry(0.09, 0.09, 0.01, 20, 1, false, -Math.PI / 2, Math.PI), cm, head, 0, 0.055, 0.1).rotation.x = 0.12;
    }

    // arms
    var sleeveM = isF ? skinM : outM;
    [["L", 1], ["R", -1]].forEach(function (p) {
      var s = p[1], sh = grp(spine, s * 0.2 * bulk, 0.475, 0); A.joints["sh" + p[0]] = sh;
      mesh(GEO.ball, isF ? outM : outM, sh, 0, 0, 0, 0.062 * bulk, 0.058, 0.06);
      mesh(GEO.uarm, sleeveM, sh, 0, 0, 0, bulk, 1, bulk);
      var el = grp(sh, 0, -0.29, 0); A.joints["el" + p[0]] = el;
      mesh(GEO.farm, sleeveM, el, 0, 0, 0, bulk, 1, bulk);
      if (oc === "suit") mesh(new T.CylinderGeometry(0.046, 0.046, 0.03, 12), std("#f4f1ea", 0.6), el, 0, -0.245, 0);
      if (oc === "track") { mesh(GEO.stripeArm, trimM, sh, s * 0.05, -0.15, 0); mesh(GEO.stripeArm, trimM, el, s * 0.044, -0.13, 0); }
      mesh(GEO.ball, skinM, el, 0, -0.3, 0.005, 0.042, 0.062, 0.028);
      if (lk.extra === "goldchain" && s < 0) mesh(new T.TorusGeometry(0.044, 0.008, 6, 18).rotateX(Math.PI / 2), goldM, el, 0, -0.23, 0);
    });
    // legs
    [["L", 1], ["R", -1]].forEach(function (p) {
      var s = p[1], hp = grp(body, s * 0.085, -0.07, 0); A.joints["hip" + p[0]] = hp;
      mesh(GEO.thigh, pantsM, hp, 0, 0, 0, oc === "hoodie" ? 1.08 : 1, 1, oc === "hoodie" ? 1.08 : 1);
      var kn = grp(hp, 0, -0.43, 0); A.joints["kn" + p[0]] = kn;
      mesh(GEO.shin, pantsM, kn, 0, 0, 0, oc === "hoodie" ? 1.1 : 1, 1, oc === "hoodie" ? 1.1 : 1);
      if (oc === "track") { mesh(GEO.stripeLeg, trimM, hp, s * 0.07, -0.22, 0); mesh(GEO.stripeLeg, trimM, kn, s * 0.055, -0.21, 0); }
      var sh2 = mesh(GEO.shoe, shoeM, kn, 0, -0.455, 0.035, 0.062, isF ? 0.06 : 0.075, 0.13);
      if (oc !== "suit" && !isF) mesh(new T.CylinderGeometry(0.066, 0.066, 0.02, 16), std("#ffffff", 0.7), kn, 0, -0.45, 0.035, 1, 1, 2.0);
      if (isF) mesh(new T.CylinderGeometry(0.008, 0.012, 0.07, 6), shoeM, kn, 0, -0.47, -0.07);
      void sh2;
    });

    // overlay DOM (user strings via textContent only)
    A.tag = document.createElement("div"); A.tag.className = "w3d-tag" + (item.isMe ? " w3d-me" : "");
    A.bub = document.createElement("div"); A.bub.className = "w3d-bub"; A.bub.style.display = "none";
    S.tagLayer.appendChild(A.bub); S.tagLayer.appendChild(A.tag);
    return A;
  }

  function removeAvatar(A) {
    A.disposed = true;
    if (A.root.parent) A.root.parent.remove(A.root);
    disposeTree(A.root);
    if (A.tag && A.tag.parentNode) A.tag.parentNode.removeChild(A.tag);
    if (A.bub && A.bub.parentNode) A.bub.parentNode.removeChild(A.bub);
  }

  var POSE_KEYS = ["bodyY", "bodyRY", "spineX", "spineZ", "headX", "headY", "shLx", "shLz", "elLx", "elLz", "shRx", "shRz", "elRx", "elRz", "hipLx", "knLx", "hipRx", "knRx", "hipLz", "hipRz"];

  function animateAvatar(A, t, dt, now, camPos) {
    var root = A.root, dx = A.tx - root.position.x, dz = A.tz - root.position.z, dist = Math.sqrt(dx * dx + dz * dz);
    var g = {}; POSE_KEYS.forEach(function (k) { g[k] = 0; });
    g.bodyY = 0.93; g.shLz = 0.1; g.shRz = -0.1; g.elLx = -0.18; g.elRx = -0.18; g.knLx = 0.04; g.knRx = 0.04;
    var wantHead;
    A.moving = dist > 0.03;
    if (A.moving) {
      var step = Math.min(dist, WALK_SPEED * dt);
      root.position.x += dx / dist * step; root.position.z += dz / dist * step;
      wantHead = Math.atan2(dx, dz);
      A.ph += dt * WALK_SPEED * 5.2;
      var sw = Math.sin(A.ph), cw = Math.cos(A.ph);
      g.hipLx = -sw * 0.5; g.hipRx = sw * 0.5;
      g.knLx = 0.1 + Math.max(0, cw) * 0.75; g.knRx = 0.1 + Math.max(0, -cw) * 0.75;
      g.shLx = sw * 0.42; g.shRx = -sw * 0.42; g.elLx = -0.35; g.elRx = -0.35;
      g.bodyY = 0.93 + Math.abs(cw) * 0.025 - 0.012; g.spineX = 0.04; g.bodyRY = sw * 0.06;
      A.stool.visible = false;
    } else {
      wantHead = Math.atan2(camPos.x - root.position.x, camPos.z - root.position.z) * 0.6;
      var br = reduced ? 0 : Math.sin(t * 1.6 + A.seed) * 0.012;
      g.spineX = br; g.headX = -br; g.shLz += br * 2; g.shRz -= br * 2;
      g.bodyRY = reduced ? 0 : Math.sin(t * 0.5 + A.seed) * 0.05;
      var pose = A.pose;
      if (pose === "wave" && now - A.poseAt > 4000) pose = "stand";
      A.stool.visible = pose === "sit";
      if (pose === "wave") {
        g.shRz = -2.55; g.shRx = -0.15; g.elRz = -0.55 + (reduced ? 0 : Math.sin(t * 9) * 0.45); g.elRx = 0; g.headY = -0.15;
      } else if (pose === "dance") {
        var b = t * Math.PI * 2 * 1.05;
        if (reduced) { g.shLx = -0.4 + Math.sin(t) * 0.15; g.shRx = -0.4 - Math.sin(t) * 0.15; g.elLx = g.elRx = -1.2; }
        else {
          var bob = Math.abs(Math.sin(b));
          g.bodyY = 0.93 - 0.02 - bob * 0.055; g.hipLx = g.hipRx = -0.18 - bob * 0.2; g.knLx = g.knRx = 0.35 + bob * 0.4;
          g.bodyRY = Math.sin(b / 2) * 0.38; g.spineZ = Math.sin(b / 2) * 0.08; g.spineX = 0.12 + bob * 0.05;
          g.shLx = -0.7 + Math.sin(b) * 0.55; g.shRx = -0.7 - Math.sin(b) * 0.55; g.shLz = 0.45; g.shRz = -0.45; g.elLx = g.elRx = -1.4;
          g.headX = Math.sin(b) * 0.12; g.hipLz = 0.06; g.hipRz = -0.06;
        }
      } else if (pose === "sit") {
        g.bodyY = 0.6; g.hipLx = g.hipRx = -1.48; g.knLx = g.knRx = 1.48; g.hipLz = 0.08; g.hipRz = -0.08;
        g.spineX = -0.06 + br; g.shLx = g.shRx = -0.5; g.elLx = g.elRx = -0.55; g.shLz = 0.15; g.shRz = -0.15;
      }
    }
    A.heading = angLerp(A.heading, wantHead, 1 - Math.exp(-dt * (A.moving ? 10 : 3)));
    root.rotation.y = A.heading;
    var f = 1 - Math.exp(-dt * 11);
    POSE_KEYS.forEach(function (k) { var c = A.cur[k]; A.cur[k] = c == null ? g[k] : c + (g[k] - c) * f; });
    var c = A.cur, J = A.joints;
    J.body.position.y = c.bodyY; J.body.rotation.y = c.bodyRY;
    J.spine.rotation.set(c.spineX, 0, c.spineZ); J.head.rotation.set(c.headX, c.headY, 0);
    J.shL.rotation.set(c.shLx, 0, c.shLz); J.shR.rotation.set(c.shRx, 0, c.shRz);
    J.elL.rotation.set(c.elLx, 0, c.elLz); J.elR.rotation.set(c.elRx, 0, c.elRz);
    J.hipL.rotation.set(c.hipLx, 0, c.hipLz); J.hipR.rotation.set(c.hipRx, 0, c.hipRz);
    J.knL.rotation.x = c.knLx; J.knR.rotation.x = c.knRx;
  }

  /* ================================================================ ROOMS */
  function addTo(group, geo, mat, x, y, z, opts) {
    var m = new T.Mesh(geo, mat); m.position.set(x || 0, y || 0, z || 0);
    if (opts) { if (opts.ry) m.rotation.y = opts.ry; if (opts.rx) m.rotation.x = opts.rx; if (opts.rz) m.rotation.z = opts.rz; }
    m.castShadow = !(opts && opts.noCast); m.receiveShadow = !(opts && opts.noRecv);
    group.add(m); return m;
  }
  function box(group, w, h, d, mat, x, y, z, opts) { return addTo(group, new T.BoxGeometry(w, h, d), mat, x, y, z, opts); }
  function cyl(group, rt, rb, h, mat, x, y, z, seg, opts) { return addTo(group, new T.CylinderGeometry(rt, rb, h, seg || 20), mat, x, y, z, opts); }

  function marbleTex(base, vein, gold, tiles) {
    return ctex(1024, 1024, function (g, w, h) {
      var r = rng(7);
      g.fillStyle = base; g.fillRect(0, 0, w, h);
      for (var i = 0; i < 26; i++) {
        var x = r() * w, y = r() * h, a = r() * 6.28;
        g.strokeStyle = vein.replace("A", (0.05 + r() * 0.16).toFixed(2)); g.lineWidth = 0.6 + r() * 2.2;
        g.beginPath(); g.moveTo(x, y);
        for (var k = 0; k < 40; k++) { a += (r() - 0.5) * 0.7; x += Math.cos(a) * 14; y += Math.sin(a) * 14; g.lineTo(x, y); }
        g.stroke();
      }
      if (gold) {
        var n = tiles || 2, s = w / n;
        g.strokeStyle = gold; g.lineWidth = 5;
        for (var j = 0; j <= n; j++) { g.beginPath(); g.moveTo(j * s, 0); g.lineTo(j * s, h); g.stroke(); g.beginPath(); g.moveTo(0, j * s); g.lineTo(w, j * s); g.stroke(); }
        g.fillStyle = gold;
        for (var a2 = 0; a2 <= n; a2++) for (var b2 = 0; b2 <= n; b2++) { g.save(); g.translate(a2 * s, b2 * s); g.rotate(Math.PI / 4); g.fillRect(-14, -14, 28, 28); g.restore(); }
      }
    });
  }
  function planksTex(c1, c2, seed) {
    return ctex(1024, 1024, function (g, w, h) {
      var r = rng(seed || 3), ph = 64;
      for (var y = 0; y < h; y += ph) {
        var off = r() * w;
        for (var x = -off; x < w; x += 340) {
          var c = new T.Color(c1).lerp(new T.Color(c2), r());
          g.fillStyle = c.getStyle(); g.fillRect(x, y, 340, ph);
          g.strokeStyle = "rgba(0,0,0,0.12)"; g.lineWidth = 1;
          for (var k = 0; k < 6; k++) { g.beginPath(); var yy = y + 6 + r() * (ph - 12); g.moveTo(x, yy); g.bezierCurveTo(x + 100, yy + (r() - 0.5) * 8, x + 220, yy + (r() - 0.5) * 8, x + 340, yy); g.stroke(); }
          g.fillStyle = "rgba(0,0,0,0.55)"; g.fillRect(x, y, 3, ph);
        }
        g.fillStyle = "rgba(0,0,0,0.6)"; g.fillRect(0, y, w, 3);
      }
    });
  }

  function sofa(group, x, z, ry, width, velvet, legM, trimM) {
    var s = new T.Group(); s.position.set(x, 0, z); s.rotation.y = ry; group.add(s);
    box(s, width, 0.34, 0.9, velvet, 0, 0.3, 0);
    box(s, width, 0.62, 0.22, velvet, 0, 0.62, -0.36).rotation.x = -0.1;
    [-1, 1].forEach(function (k) { box(s, 0.2, 0.52, 0.9, velvet, k * (width / 2 - 0.1), 0.4, 0); });
    var nc = Math.max(2, Math.round(width / 0.9)), cw = (width - 0.4) / nc;
    for (var i = 0; i < nc; i++) {
      var cu = addTo(s, new T.CapsuleGeometry(0.1, cw - 0.22, 4, 12), velvet, -width / 2 + 0.2 + cw * (i + 0.5), 0.54, 0.05); cu.rotation.z = Math.PI / 2; cu.scale.set(1, 1, 3.3);
    }
    if (trimM) box(s, width + 0.02, 0.03, 0.92, trimM, 0, 0.14, 0);
    [[-1, -1], [1, -1], [-1, 1], [1, 1]].forEach(function (p) { cyl(s, 0.03, 0.02, 0.14, legM, p[0] * (width / 2 - 0.08), 0.07, p[1] * 0.38, 8); });
    return s;
  }
  function plant(group, x, z, potM, leafM, scale) {
    var g = new T.Group(); g.position.set(x, 0, z); g.scale.setScalar(scale || 1); group.add(g);
    cyl(g, 0.26, 0.2, 0.55, potM, 0, 0.275, 0, 20);
    var r = rng(Math.floor(x * 100 + z * 7) >>> 0);
    for (var i = 0; i < 7; i++) {
      var l = addTo(g, new T.IcosahedronGeometry(0.22 + r() * 0.12, 1), leafM, (r() - 0.5) * 0.4, 0.75 + r() * 0.7, (r() - 0.5) * 0.4);
      l.scale.y = 1.3;
    }
    return g;
  }
  function wallSet(G, opt) {
    // back wall + 2 side walls with wainscot and trim
    var H = opt.h || 5.5;
    var back = addTo(G, new T.PlaneGeometry(12.4, H), opt.wall, 0, H / 2, -4.6, { noCast: true });
    var L = addTo(G, new T.PlaneGeometry(12, H), opt.wall, -6.2, H / 2, 1.4, { ry: Math.PI / 2, noCast: true });
    var R = addTo(G, new T.PlaneGeometry(12, H), opt.wall, 6.2, H / 2, 1.4, { ry: -Math.PI / 2, noCast: true });
    if (opt.lower) {
      box(G, 12.4, 1.1, 0.06, opt.lower, 0, 0.55, -4.57, { noCast: true });
      box(G, 0.06, 1.1, 12, opt.lower, -6.17, 0.55, 1.4, { noCast: true }); box(G, 0.06, 1.1, 12, opt.lower, 6.17, 0.55, 1.4, { noCast: true });
    }
    if (opt.trim) {
      [0.04, 1.12, H - 0.15].forEach(function (y) {
        box(G, 12.4, 0.06, 0.1, opt.trim, 0, y, -4.54, { noCast: true });
        box(G, 0.1, 0.06, 12, opt.trim, -6.14, y, 1.4, { noCast: true }); box(G, 0.1, 0.06, 12, opt.trim, 6.14, y, 1.4, { noCast: true });
      });
    }
    if (opt.ceil) addTo(G, new T.PlaneGeometry(12.4, 12), opt.ceil, 0, H, 1.4, { rx: Math.PI / 2, noCast: true });
    return { back: back, L: L, R: R };
  }
  function frame(G, x, y, z, w, h, tex, frameM, ry) {
    var g = new T.Group(); g.position.set(x, y, z); if (ry) g.rotation.y = ry; G.add(g);
    box(g, w + 0.16, h + 0.16, 0.07, frameM, 0, 0, 0, { noCast: true });
    addTo(g, new T.PlaneGeometry(w, h), new T.MeshStandardMaterial({ map: tex, roughness: 0.5, emissive: 0xffffff, emissiveMap: tex, emissiveIntensity: 0.12 }), 0, 0, 0.04, { noCast: true });
    return g;
  }
  function stdLights(G, o) {
    var hemi = new T.HemisphereLight(o.sky, o.ground, o.hemi); G.add(hemi);
    var d = new T.DirectionalLight(o.dirColor, o.dir); d.position.set(o.dx || 3, 9, o.dz || 5); d.target.position.set(0, 0, -0.5);
    d.castShadow = true; d.shadow.mapSize.set(1024, 1024);
    var sc = d.shadow.camera; sc.left = -7.5; sc.right = 7.5; sc.top = 7; sc.bottom = -7; sc.near = 1; sc.far = 25;
    d.shadow.bias = -0.0006; d.shadow.normalBias = 0.02; d.shadow.radius = 4;
    G.add(d); G.add(d.target);
  }
  function point(G, color, intensity, dist, x, y, z) { var p = new T.PointLight(color, intensity, dist, 2); p.position.set(x, y, z); G.add(p); return p; }

  function buildLounge(G, R) {
    var gold = std("#d4a843", 0.25, 1), floorT = marbleTex("#0c0b0a", "rgba(235,228,215,A)", "#c79a3a", 2);
    floorT.wrapS = floorT.wrapT = T.RepeatWrapping; floorT.repeat.set(3, 3);
    addTo(G, new T.PlaneGeometry(12.4, 12), std("#ffffff", 0.18, 0.15, { map: floorT, envMapIntensity: 1.2 }), 0, 0, 1.4, { rx: -Math.PI / 2, noCast: true });
    var wallT = ctex(512, 512, function (g, w, h) { g.fillStyle = "#1c1814"; g.fillRect(0, 0, w, h); g.strokeStyle = "rgba(212,168,67,0.22)"; g.lineWidth = 3; g.strokeRect(40, 40, w - 80, h - 80); g.strokeStyle = "rgba(0,0,0,0.35)"; g.strokeRect(52, 52, w - 104, h - 104); }, [6, 2]);
    wallSet(G, { wall: std("#ffffff", 0.8, 0, { map: wallT }), lower: std("#100e0c", 0.45, 0.1), trim: gold, ceil: std("#0d0b09", 0.9) });
    // rug
    var rugT = ctex(512, 320, function (g, w, h) { g.fillStyle = "#2a0f15"; g.fillRect(0, 0, w, h); g.strokeStyle = "#c99a3c"; g.lineWidth = 8; g.strokeRect(18, 18, w - 36, h - 36); g.lineWidth = 2; g.strokeRect(34, 34, w - 68, h - 68); drawEmblem(g, w / 2, h / 2, 140, "rgba(212,168,67,0.55)"); });
    addTo(G, new T.PlaneGeometry(5.2, 3.2), std("#ffffff", 0.95, 0, { map: rugT }), 0, 0.006, -2.6, { rx: -Math.PI / 2, noCast: true });
    // pillars
    var pillarT = marbleTex("#16130f", "rgba(240,230,210,A)"); var pillarM = std("#ffffff", 0.2, 0.1, { map: pillarT });
    [[-4.6, -4.15], [4.6, -4.15], [-5.7, 0.2], [5.7, 0.2], [-5.7, 3.4], [5.7, 3.4]].forEach(function (p) {
      cyl(G, 0.26, 0.26, 5.5, pillarM, p[0], 2.75, p[1], 24);
      cyl(G, 0.34, 0.36, 0.2, gold, p[0], 0.1, p[1], 24); cyl(G, 0.36, 0.3, 0.22, gold, p[0], 5.35, p[1], 24);
      cyl(G, 0.3, 0.3, 0.05, gold, p[0], 1.12, p[1], 24);
    });
    // art
    var artT = ctex(512, 512, function (g, w, h) { var gr = g.createLinearGradient(0, 0, 0, h); gr.addColorStop(0, "#15120d"); gr.addColorStop(1, "#050403"); g.fillStyle = gr; g.fillRect(0, 0, w, h); drawEmblem(g, w / 2, h / 2 + 10, 360, "#e2b85a"); });
    frame(G, 0, 2.85, -4.55, 1.7, 1.7, artT, gold);
    [-1, 1].forEach(function (s, i) {
      var t = ctex(320, 400, function (g, w, h) { var r = rng(11 + i); g.fillStyle = "#0e0c0a"; g.fillRect(0, 0, w, h); for (var k = 0; k < 9; k++) { g.fillStyle = ["#d4a843", "#f0cf78", "#6b1b24", "#2b2620"][k % 4]; g.globalAlpha = 0.75; g.beginPath(); g.arc(r() * w, r() * h, 20 + r() * 80, 0, 7); g.fill(); } g.globalAlpha = 1; g.strokeStyle = "#f0cf78"; g.lineWidth = 3; g.beginPath(); g.moveTo(0, h * 0.7); g.bezierCurveTo(w * 0.3, h * 0.3, w * 0.7, h * 0.9, w, h * 0.4); g.stroke(); });
      frame(G, s * 2.9, 2.75, -4.55, 1.1, 1.4, t, gold);
      box(G, 0.08, 0.2, 0.12, gold, s * 1.55, 2.75, -4.52, { noCast: true });
      addTo(G, new T.SphereGeometry(0.08, 12, 8), glowMat(0xffd89a, 3), s * 1.55, 2.92, -4.47, { noCast: true });
    });
    // furniture
    var velvet = std("#4a1220", 0.92, 0), velvet2 = std("#14231c", 0.92, 0);
    sofa(G, 0, -3.95, 0, 3.2, velvet, gold, gold);
    sofa(G, -5.2, -1.3, Math.PI / 2, 2.6, velvet2, gold, gold);
    sofa(G, 5.2, -1.3, -Math.PI / 2, 2.6, velvet2, gold, gold);
    var glass = new T.MeshStandardMaterial({ color: 0x223040, roughness: 0.05, metalness: 0.2, transparent: true, opacity: 0.35 });
    box(G, 1.6, 0.04, 0.8, glass, 0, 0.42, -2.75, { noCast: true }); box(G, 1.64, 0.03, 0.84, gold, 0, 0.4, -2.75);
    [[-1, -1], [1, -1], [-1, 1], [1, 1]].forEach(function (p) { box(G, 0.04, 0.4, 0.04, gold, p[0] * 0.78, 0.2, -2.75 + p[1] * 0.38); });
    cyl(G, 0.09, 0.07, 0.22, std("#0c0c0c", 0.2, 0.6), 0.4, 0.55, -2.75, 14); addTo(G, new T.IcosahedronGeometry(0.11, 1), std("#7a1b2c", 0.8), 0.4, 0.72, -2.75);
    // side tables + lamps
    [-1, 1].forEach(function (s) {
      cyl(G, 0.28, 0.28, 0.05, gold, s * 2.15, 0.55, -4.0, 20); cyl(G, 0.04, 0.04, 0.55, gold, s * 2.15, 0.28, -4.0, 8);
      cyl(G, 0.18, 0.24, 0.3, std("#f0e2c0", 0.9, 0, { emissive: 0xffd9a0, emissiveIntensity: 0.8 }), s * 2.15, 1.05, -4.0, 20); cyl(G, 0.025, 0.025, 0.4, gold, s * 2.15, 0.75, -4.0, 6);
    });
    var pot = std("#0f0d0b", 0.3, 0.3), leaf = std("#1f4a2a", 0.85);
    plant(G, -5.3, -4.0, pot, leaf, 1.1); plant(G, 5.3, -4.0, pot, leaf, 1.1);
    box(G, 1.2, 1.0, 0.45, std("#120f0c", 0.4, 0.2), -5.8, 0.5, 2.0, { ry: Math.PI / 2 });
    // chandelier
    var ch = new T.Group(); ch.position.set(0, 4.15, -1.2); G.add(ch);
    cyl(ch, 0.012, 0.012, 1.4, gold, 0, 0.8, 0, 6, { noCast: true });
    addTo(ch, new T.TorusGeometry(0.85, 0.035, 8, 48), gold, 0, 0, 0, { rx: Math.PI / 2, noCast: true });
    addTo(ch, new T.TorusGeometry(0.5, 0.03, 8, 36), gold, 0, 0.32, 0, { rx: Math.PI / 2, noCast: true });
    addTo(ch, new T.SphereGeometry(0.16, 16, 12), gold, 0, -0.1, 0, { noCast: true });
    var bulbM = glowMat(0xffe1a8, 4);
    for (var i = 0; i < 10; i++) {
      var a = i / 10 * Math.PI * 2;
      cyl(ch, 0.022, 0.022, 0.14, std("#f5efe2", 0.6), Math.cos(a) * 0.85, 0.08, Math.sin(a) * 0.85, 8, { noCast: true });
      addTo(ch, new T.SphereGeometry(0.045, 8, 6), bulbM, Math.cos(a) * 0.85, 0.18, Math.sin(a) * 0.85, { noCast: true });
    }
    var crys = new T.InstancedMesh(new T.OctahedronGeometry(0.045, 0), std("#ffffff", 0.02, 0.1, { emissive: 0xffe9c4, emissiveIntensity: 0.4, envMapIntensity: 2 }), 48);
    var m4 = new T.Matrix4(), q = new T.Quaternion(), sv = new T.Vector3(1, 1.8, 1);
    for (var k = 0; k < 48; k++) { var ring = k < 30 ? 0.78 : 0.45, aa = k / (k < 30 ? 30 : 18) * Math.PI * 2, yy = k < 30 ? -0.2 - (k % 3) * 0.12 : 0.1 - (k % 2) * 0.12; m4.compose(new T.Vector3(Math.cos(aa) * ring, yy, Math.sin(aa) * ring), q, sv); crys.setMatrixAt(k, m4); }
    ch.add(crys);
    point(G, 0xffd29a, 26, 12, 0, 3.7, -1.2);
    point(G, 0xffcf8a, 7, 6, -1.55, 2.6, -4.0); point(G, 0xffcf8a, 7, 6, 1.55, 2.6, -4.0);
    stdLights(G, { sky: 0xfff0d8, ground: 0x2a1f14, hemi: 0.75, dirColor: 0xffe2b8, dir: 1.6 });
    R.bg = 0x0b0a08; R.fog = new T.Fog(0x0b0a08, 16, 30); R.env = { base: "#1a140c", panels: ["#ffe2b0", "#d4a843", "#fff5e0"] };
    R.tick = function (t) { if (!reduced) { ch.rotation.y = t * 0.05; } };
  }

  function buildStudio(G, R) {
    var floorT = planksTex("#3a2618", "#24170e", 5); floorT.wrapS = floorT.wrapT = T.RepeatWrapping; floorT.repeat.set(3, 3);
    addTo(G, new T.PlaneGeometry(12.4, 12), std("#ffffff", 0.35, 0.05, { map: floorT }), 0, 0, 1.4, { rx: -Math.PI / 2, noCast: true });
    var foamT = ctex(256, 256, function (g, w, h) { for (var y = 0; y < 4; y++) for (var x = 0; x < 4; x++) { var gx = x * 64, gy = y * 64, gr = g.createLinearGradient(gx, gy, gx + 64, gy + 64); var v = (x + y) % 2; gr.addColorStop(0, v ? "#2a2d38" : "#1a1c24"); gr.addColorStop(1, v ? "#121319" : "#262a35"); g.fillStyle = gr; g.fillRect(gx, gy, 64, 64); g.strokeStyle = "rgba(0,0,0,0.5)"; g.strokeRect(gx, gy, 64, 64); } }, [1, 1]);
    wallSet(G, { wall: std("#17181d", 0.85), lower: std("#101116", 0.6), ceil: std("#0c0d10", 0.9) });
    // foam pyramids on back wall (instanced)
    var pyr = new T.ConeGeometry(0.16, 0.12, 4, 1).rotateX(Math.PI / 2).rotateZ(Math.PI / 4);
    var fm = new T.InstancedMesh(pyr, std("#1e2230", 0.95), 160), m4 = new T.Matrix4(), q = new T.Quaternion(), one = new T.Vector3(1, 1, 1), idx = 0;
    [[-3.6, 1], [3.6, 1]].forEach(function (zone) { for (var r = 0; r < 8; r++) for (var c = 0; c < 10; c++) { if (idx >= 160) return; m4.compose(new T.Vector3(zone[0] - 1.1 + c * 0.24, 1.6 + r * 0.24, -4.54), q, one); fm.setMatrixAt(idx++, m4); } });
    fm.count = idx; fm.receiveShadow = true; G.add(fm);
    [-1, 1].forEach(function (s) { for (var p = 0; p < 3; p++) box(G, 0.08, 1.6, 1.4, std("#ffffff", 0.95, 0, { map: foamT }), s * 6.12, 2.6, -3 + p * 2.2, { noCast: true }); });
    // neon
    var blue = glowMat(0x2f7bff, 3), purple = glowMat(0xa040ff, 3), pink = glowMat(0xff3fa6, 3);
    box(G, 12.2, 0.04, 0.04, blue, 0, 0.08, -4.5, { noCast: true }); box(G, 12.2, 0.04, 0.04, purple, 0, 4.9, -4.5, { noCast: true });
    [-1, 1].forEach(function (s) { box(G, 0.04, 3.6, 0.04, s < 0 ? pink : blue, s * 6.1, 2.4, -4.4, { noCast: true }); box(G, 0.04, 0.04, 12, blue, s * 6.12, 0.08, 1.4, { noCast: true }); });
    var signT = ctex(512, 128, function (g, w, h) { g.clearRect(0, 0, w, h); g.font = "italic 900 80px Arial, sans-serif"; g.textAlign = "center"; g.textBaseline = "middle"; g.shadowColor = "#5aa0ff"; g.shadowBlur = 18; g.fillStyle = "#cfe3ff"; g.fillText("STUDIO B", w / 2, h / 2); });
    addTo(G, new T.PlaneGeometry(2.6, 0.65), new T.MeshBasicMaterial({ map: signT, transparent: true, toneMapped: false }), 0, 4.05, -4.52, { noCast: true });
    // mixing desk
    var deskM = std("#121214", 0.35, 0.3), woodM = std("#3b2416", 0.5, 0.05);
    box(G, 3.4, 0.78, 1.1, deskM, 0, 0.39, -3.55); box(G, 3.5, 0.05, 0.3, woodM, 0, 0.8, -3.0);
    var consT = ctex(1024, 256, function (g, w, h) {
      g.fillStyle = "#1a1b20"; g.fillRect(0, 0, w, h); var r = rng(9);
      for (var i = 0; i < 32; i++) { var x = 16 + i * 31; g.fillStyle = "#2c2e36"; g.fillRect(x, 10, 24, h - 20); for (var k = 0; k < 4; k++) { g.fillStyle = ["#d4a843", "#5aa0ff", "#ff4d6d", "#e8e8e8"][k]; g.beginPath(); g.arc(x + 12, 26 + k * 24, 6, 0, 7); g.fill(); } g.fillStyle = "#08080a"; g.fillRect(x + 10, 130, 4, 100); g.fillStyle = "#ddd"; g.fillRect(x + 4, 140 + r() * 70, 16, 10); g.fillStyle = r() > 0.5 ? "#36ff7a" : "#ffcc33"; g.fillRect(x + 19, 120, 3, 8); }
    });
    box(G, 3.3, 0.05, 1.0, std("#ffffff", 0.4, 0.2, { map: consT, emissive: 0xffffff, emissiveMap: consT, emissiveIntensity: 0.25 }), 0, 0.84, -3.6, { rx: 0.12 });
    var dawT = ctex(512, 300, function (g, w, h) { g.fillStyle = "#0b0f18"; g.fillRect(0, 0, w, h); var r = rng(4); var cols = ["#3d8bff", "#ff5d8f", "#d4a843", "#3ddc97", "#a678ff"]; for (var t = 0; t < 7; t++) { var y = 20 + t * 38; g.fillStyle = "#141a26"; g.fillRect(0, y, w, 34); g.strokeStyle = cols[t % 5]; g.beginPath(); for (var x = 60; x < w; x += 2) g.lineTo(x, y + 17 + (r() - 0.5) * 28 * Math.abs(Math.sin(x * 0.03 + t))); g.stroke(); g.fillStyle = cols[t % 5]; g.fillRect(4, y + 4, 50, 26); } g.fillStyle = "#fff"; g.fillRect(260, 10, 2, h - 20); });
    var scrM = new T.MeshBasicMaterial({ map: dawT, toneMapped: false });
    [-0.75, 0.75].forEach(function (x) { box(G, 1.2, 0.72, 0.05, deskM, x, 1.35, -3.98); addTo(G, new T.PlaneGeometry(1.12, 0.64), scrM, x, 1.35, -3.95, { noCast: true }); cyl(G, 0.03, 0.03, 0.4, deskM, x, 0.98, -4.0, 8); });
    var spkM = std("#0e0e10", 0.4, 0.2), coneM = std("#2a2a2e", 0.6, 0.4), ringM = std("#d4a843", 0.3, 1);
    [-1, 1].forEach(function (s) {
      var g = new T.Group(); g.position.set(s * 2.1, 0.86, -3.55); g.rotation.y = -s * 0.35; G.add(g);
      box(g, 0.32, 0.48, 0.34, spkM, 0, 0.24, 0);
      addTo(g, new T.CylinderGeometry(0.11, 0.11, 0.02, 24), coneM, 0, 0.17, 0.17, { rx: Math.PI / 2 }); addTo(g, new T.TorusGeometry(0.11, 0.008, 6, 24), ringM, 0, 0.17, 0.18);
      addTo(g, new T.CylinderGeometry(0.04, 0.04, 0.02, 16), coneM, 0, 0.37, 0.17, { rx: Math.PI / 2 });
      // big floor monitors
      var b = new T.Group(); b.position.set(s * 4.4, 0, -4.05); b.rotation.y = -s * 0.4; G.add(b);
      box(b, 0.7, 1.5, 0.6, spkM, 0, 0.75, 0);
      [0.45, 1.0].forEach(function (y, i) { addTo(b, new T.CylinderGeometry(i ? 0.12 : 0.22, i ? 0.12 : 0.22, 0.03, 24), coneM, 0, y, 0.3, { rx: Math.PI / 2 }); addTo(b, new T.TorusGeometry(i ? 0.12 : 0.22, 0.012, 6, 24), ringM, 0, y, 0.31); });
    });
    // chair
    var chair = new T.Group(); chair.position.set(0, 0, -2.5); G.add(chair);
    cyl(chair, 0.26, 0.26, 0.1, std("#141414", 0.5), 0, 0.5, 0); box(chair, 0.5, 0.6, 0.08, std("#141414", 0.5), 0, 0.85, 0.24); cyl(chair, 0.03, 0.03, 0.45, ringM, 0, 0.25, 0, 8);
    // mic stand
    var mic = new T.Group(); mic.position.set(-3.4, 0, -1.2); G.add(mic);
    var metal = std("#2a2a2a", 0.3, 0.9);
    cyl(mic, 0.22, 0.24, 0.03, metal, 0, 0.015, 0, 20); cyl(mic, 0.015, 0.015, 1.5, metal, 0, 0.76, 0, 8);
    var boom = cyl(mic, 0.012, 0.012, 0.6, metal, 0.15, 1.6, 0.1, 8); boom.rotation.z = -1.1; boom.rotation.y = -0.6;
    addTo(mic, new T.CapsuleGeometry(0.045, 0.12, 4, 12), std("#c9c9c9", 0.3, 0.9), 0.38, 1.72, 0.32, { rx: 0.4 });
    addTo(mic, new T.TorusGeometry(0.1, 0.008, 6, 24), metal, 0.38, 1.72, 0.46);
    addTo(mic, new T.CircleGeometry(0.1, 24), new T.MeshStandardMaterial({ color: 0x111111, transparent: true, opacity: 0.55, side: T.DoubleSide }), 0.38, 1.72, 0.46, { noCast: true });
    // keyboard synth
    var kbT = ctex(512, 64, function (g, w, h) { g.fillStyle = "#f5f5f0"; g.fillRect(0, 0, w, h); g.strokeStyle = "#333"; for (var i = 0; i < 52; i++) { g.beginPath(); g.moveTo(i * w / 52, 0); g.lineTo(i * w / 52, h); g.stroke(); if ([0, 1, 3, 4, 5].indexOf(i % 7) >= 0) { g.fillStyle = "#111"; g.fillRect(i * w / 52 + 6, 0, 6, h * 0.6); } } });
    var kb = new T.Group(); kb.position.set(4.3, 0, -1.4); kb.rotation.y = -Math.PI / 2 + 0.3; G.add(kb);
    box(kb, 1.4, 0.1, 0.4, std("#111", 0.4, 0.3), 0, 0.9, 0); addTo(kb, new T.PlaneGeometry(1.3, 0.16), std("#ffffff", 0.5, 0, { map: kbT }), 0, 0.955, 0.08, { rx: -Math.PI / 2, noCast: true });
    [-1, 1].forEach(function (s) { box(kb, 0.04, 0.85, 0.04, metal, s * 0.5, 0.43, 0, { rz: s * 0.3 }); });
    sofa(G, 5.3, 1.6, -Math.PI / 2, 2.2, std("#121212", 0.45, 0.1), metal, null);
    addTo(G, new T.CircleGeometry(1.6, 40), std("#1b2340", 0.95), 0, 0.006, -2.6, { rx: -Math.PI / 2, noCast: true });
    point(G, 0x3a7bff, 22, 10, -3, 3, -2.5); point(G, 0x9d4dff, 18, 10, 3, 3, -2.5); point(G, 0xffd9a0, 10, 8, 0, 3.5, 1.5);
    stdLights(G, { sky: 0x9fb8ff, ground: 0x15121c, hemi: 0.55, dirColor: 0xc8d8ff, dir: 1.1 });
    R.bg = 0x07080c; R.fog = new T.Fog(0x07080c, 16, 30); R.env = { base: "#0a0d18", panels: ["#5a8cff", "#c08bff", "#ffffff"] };
    R.tick = function (t) { if (!reduced) { blue.emissiveIntensity = 2.6 + Math.sin(t * 2) * 0.6; purple.emissiveIntensity = 2.6 + Math.cos(t * 1.7) * 0.6; } };
  }

  function buildRooftop(G, R) {
    var floorT = ctex(512, 512, function (g, w, h) { var r = rng(21); for (var y = 0; y < 4; y++) for (var x = 0; x < 4; x++) { var v = 40 + r() * 14; g.fillStyle = "rgb(" + v + "," + (v - 2) + "," + (v - 4) + ")"; g.fillRect(x * 128, y * 128, 128, 128); for (var k = 0; k < 120; k++) { g.fillStyle = "rgba(255,255,255," + r() * 0.05 + ")"; g.fillRect(x * 128 + r() * 128, y * 128 + r() * 128, 2, 2); } g.strokeStyle = "#141210"; g.lineWidth = 4; g.strokeRect(x * 128, y * 128, 128, 128); } }, [4, 4]);
    addTo(G, new T.PlaneGeometry(13, 12), std("#ffffff", 0.55, 0.05, { map: floorT }), 0, 0, 1.4, { rx: -Math.PI / 2, noCast: true });
    var skyT = ctex(512, 1024, function (g, w, h) { var gr = g.createLinearGradient(0, 0, 0, h); gr.addColorStop(0, "#02030a"); gr.addColorStop(0.38, "#0a1030"); gr.addColorStop(0.5, "#2b1d44"); gr.addColorStop(0.56, "#5a2e40"); gr.addColorStop(0.62, "#0a0a12"); gr.addColorStop(1, "#050508"); g.fillStyle = gr; g.fillRect(0, 0, w, h); var r = rng(5); for (var i = 0; i < 500; i++) { var y = r() * h * 0.48; g.fillStyle = "rgba(255,255,255," + (0.3 + r() * 0.7) * (1 - y / (h * 0.5)) + ")"; var s = r() < 0.08 ? 2 : 1; g.fillRect(r() * w, y, s, s); } });
    addTo(G, new T.SphereGeometry(90, 32, 16), new T.MeshBasicMaterial({ map: skyT, side: T.BackSide, fog: false, toneMapped: false }), 0, 0, 0, { noCast: true, noRecv: true });
    addTo(G, new T.SphereGeometry(2.2, 24, 16), new T.MeshBasicMaterial({ color: 0xfff4d6, fog: false }), -28, 34, -70, { noCast: true });
    // skyline
    var winTex = [0, 1, 2].map(function (n) { return ctex(256, 512, function (g, w, h) { var r = rng(30 + n); g.fillStyle = "#000"; g.fillRect(0, 0, w, h); for (var y = 8; y < h; y += 16) for (var x = 6; x < w; x += 14) { if (r() < (n === 2 ? 0.25 : 0.42)) { g.fillStyle = r() < 0.75 ? "rgba(255,206,130," + (0.5 + r() * 0.5) + ")" : "rgba(170,210,255," + (0.5 + r() * 0.5) + ")"; g.fillRect(x, y, 8, 10); } } }); });
    var r = rng(77), bmats = [];
    for (var i = 0; i < 34; i++) {
      var far = i > 18, x = (r() - 0.5) * (far ? 140 : 90), z = far ? -55 - r() * 25 : -16 - r() * 30;
      if (!far && Math.abs(x) < 8 && z > -22) x += x < 0 ? -10 : 10;
      var bw = 3 + r() * 6, bh = (far ? 20 : 10) + r() * (far ? 40 : 28), bd = 3 + r() * 5;
      var tex = winTex[i % 3].clone(); tex.needsUpdate = true; tex.wrapS = tex.wrapT = T.RepeatWrapping; tex.repeat.set(Math.max(1, Math.round(bw / 4)), Math.max(1, Math.round(bh / 10)));
      var m = std(far ? "#07080d" : "#0c0e15", 0.6, 0.3, { emissive: 0xffffff, emissiveMap: tex, emissiveIntensity: far ? 0.7 : 1.1 }); bmats.push(m);
      box(G, bw, bh, bd, m, x, bh / 2 - 14, z, { noCast: true, noRecv: true });
      if (r() < 0.35) addTo(G, new T.SphereGeometry(0.25, 8, 6), new T.MeshBasicMaterial({ color: 0xff2020 }), x, bh - 14 + 0.4, z, { noCast: true });
    }
    // railing
    var glass = new T.MeshStandardMaterial({ color: 0x9fc4d8, roughness: 0.05, metalness: 0.1, transparent: true, opacity: 0.16, side: T.DoubleSide, depthWrite: false });
    var rail = std("#c8c8c8", 0.25, 1);
    addTo(G, new T.PlaneGeometry(12.4, 1.05), glass, 0, 0.55, -4.6, { noCast: true }); box(G, 12.4, 0.05, 0.08, rail, 0, 1.08, -4.6);
    [-1, 1].forEach(function (s) { addTo(G, new T.PlaneGeometry(12, 1.05), glass, s * 6.2, 0.55, 1.4, { ry: Math.PI / 2, noCast: true }); box(G, 0.08, 0.05, 12, rail, s * 6.2, 1.08, 1.4); });
    for (var p = -6; p <= 6; p += 2) box(G, 0.05, 1.1, 0.05, rail, p, 0.55, -4.6);
    box(G, 13, 0.25, 0.3, std("#2a2724", 0.8), 0, 0.12, -4.75); [-1, 1].forEach(function (s) { box(G, 0.3, 0.25, 12, std("#2a2724", 0.8), s * 6.35, 0.12, 1.4); });
    // string lights
    var poleM = std("#1a1a1a", 0.5, 0.6), poles = [[-5.8, -4.3], [5.8, -4.3], [-5.8, 2.5], [5.8, 2.5]];
    poles.forEach(function (pp) { cyl(G, 0.04, 0.05, 3.4, poleM, pp[0], 1.7, pp[1], 8); });
    var spans = [[0, 1], [0, 3], [1, 2], [2, 3]], N = 22, bulbs = new T.InstancedMesh(new T.SphereGeometry(0.05, 8, 6), new T.MeshBasicMaterial({ color: 0xffd28a, toneMapped: false }), spans.length * N);
    var m4 = new T.Matrix4(), bi = 0;
    spans.forEach(function (sp) {
      var a = poles[sp[0]], b = poles[sp[1]], pts = [];
      for (var k = 0; k <= N; k++) { var t = k / N, x = a[0] + (b[0] - a[0]) * t, z = a[1] + (b[1] - a[1]) * t, y = 3.35 - Math.sin(t * Math.PI) * 0.7; pts.push(new T.Vector3(x, y, z)); if (k < N) { m4.makeTranslation(x, y - 0.07, z); bulbs.setMatrixAt(bi++, m4); } }
      G.add(new T.Line(new T.BufferGeometry().setFromPoints(pts), new T.LineBasicMaterial({ color: 0x111111 })));
    });
    G.add(bulbs);
    // furniture: loungers, planters, fire pit
    var cushion = std("#e9e1d0", 0.9), frameW = std("#3d2a1c", 0.55);
    [[-4.6, -2.6, 0.5], [4.6, -2.6, -0.5], [-4.8, 1.2, Math.PI / 2 - 0.3], [4.8, 1.2, -Math.PI / 2 + 0.3]].forEach(function (c) {
      var g = new T.Group(); g.position.set(c[0], 0, c[1]); g.rotation.y = c[2]; G.add(g);
      box(g, 0.7, 0.22, 1.5, frameW, 0, 0.2, 0); box(g, 0.66, 0.1, 1.0, cushion, 0, 0.36, 0.22);
      var back = box(g, 0.66, 0.1, 0.65, cushion, 0, 0.55, -0.5); back.rotation.x = 0.9;
      addTo(g, new T.CapsuleGeometry(0.07, 0.36, 4, 10), std("#d4a843", 0.7), 0, 0.5, 0.1, { rz: Math.PI / 2 });
    });
    var planterM = std("#22201d", 0.7), leaf = std("#24502c", 0.85), leaf2 = std("#2f6b36", 0.85);
    [[-5.5, -4.1], [5.5, -4.1], [-2.6, -4.2], [2.6, -4.2]].forEach(function (pp, i) { plant(G, pp[0], pp[1], planterM, i % 2 ? leaf : leaf2, i < 2 ? 1.2 : 0.9); });
    var pit = new T.Group(); pit.position.set(0, 0, -3.3); G.add(pit);
    cyl(pit, 0.7, 0.75, 0.38, std("#3a3632", 0.85), 0, 0.19, 0, 28); addTo(pit, new T.TorusGeometry(0.66, 0.06, 8, 32), std("#d4a843", 0.3, 1), 0, 0.39, 0, { rx: Math.PI / 2 });
    var flameM = new T.MeshBasicMaterial({ color: 0xff8a2a, transparent: true, opacity: 0.85, toneMapped: false, depthWrite: false }), flames = [];
    for (var f = 0; f < 5; f++) { var fl = addTo(pit, new T.ConeGeometry(0.12, 0.5, 8), flameM, Math.cos(f * 1.26) * 0.25, 0.62, Math.sin(f * 1.26) * 0.25, { noCast: true }); flames.push(fl); }
    var fire = point(G, 0xff8a3a, 14, 7, 0, 1.0, -3.3);
    point(G, 0xffd29a, 10, 9, -3, 3, -1); point(G, 0xffd29a, 10, 9, 3, 3, -1);
    stdLights(G, { sky: 0x6f7fbf, ground: 0x1a1410, hemi: 0.7, dirColor: 0xaebfff, dir: 0.9, dx: -4, dz: 3 });
    R.bg = 0x05060c; R.fog = new T.Fog(0x120f22, 40, 110); R.env = { base: "#0b0d1c", panels: ["#ffcf8a", "#6f84d8", "#ffffff"] };
    R.tick = function (t) {
      if (reduced) return;
      flames.forEach(function (fl, i) { var s = 0.8 + Math.sin(t * 9 + i * 1.7) * 0.18 + Math.sin(t * 13 + i) * 0.08; fl.scale.set(1, s, 1); fl.position.y = 0.4 + 0.25 * s; });
      fire.intensity = 12 + Math.sin(t * 11) * 2 + Math.sin(t * 17) * 1.5;
    };
  }

  function buildClub(G, R) {
    addTo(G, new T.PlaneGeometry(12.4, 12), std("#0a0a0d", 0.12, 0.4), 0, 0, 1.4, { rx: -Math.PI / 2, noCast: true });
    wallSet(G, { wall: std("#0e0c12", 0.7), lower: std("#09080b", 0.4, 0.2), trim: std("#d4a843", 0.3, 1), ceil: std("#060508", 0.9) });
    // dance floor
    var NX = 8, NZ = 5, tileG = new T.BoxGeometry(0.88, 0.04, 0.88);
    var tiles = new T.InstancedMesh(tileG, new T.MeshBasicMaterial({ color: 0xffffff }), NX * NZ), m4 = new T.Matrix4(), col = new T.Color();
    for (var i = 0; i < NX; i++) for (var j = 0; j < NZ; j++) { m4.makeTranslation(-3.6 + 0.45 + i * 0.9, 0.02, -1.6 + j * 0.9); tiles.setMatrixAt(i * NZ + j, m4); tiles.setColorAt(i * NZ + j, col.set(0x333333)); }
    G.add(tiles); box(G, NX * 0.9 + 0.12, 0.03, NZ * 0.9 + 0.12, std("#d4a843", 0.3, 1), 0, 0.012, -1.6 + NZ * 0.45 - 0.45 + 0.0, { noCast: true });
    var palette = [0xff2fa0, 0x2fd0ff, 0xd4a843, 0x8a3dff, 0x30ff9a, 0xff6a2f].map(function (h) { return new T.Color(h); });
    // DJ booth
    var boothT = ctex(1024, 256, function (g, w, h) { g.fillStyle = "#07060a"; g.fillRect(0, 0, w, h); drawEmblem(g, 120, 130, 170, "#f0cf78"); g.font = "900 70px Arial, sans-serif"; g.fillStyle = "#f0cf78"; g.textBaseline = "middle"; g.shadowColor = "#d4a843"; g.shadowBlur = 20; g.fillText("CLUB CONSCIENTIA", 230, 130); });
    var booth = new T.Group(); booth.position.set(0, 0, -3.75); G.add(booth);
    box(booth, 3.2, 1.1, 0.9, std("#0c0b0e", 0.3, 0.4), 0, 0.55, 0);
    var boothFace = new T.MeshStandardMaterial({ color: 0x000000, emissive: 0xffffff, emissiveMap: boothT, emissiveIntensity: 1.3 });
    addTo(booth, new T.PlaneGeometry(3.1, 0.78), boothFace, 0, 0.55, 0.455, { noCast: true });
    box(booth, 3.3, 0.06, 1.0, std("#d4a843", 0.25, 1), 0, 1.13, 0);
    [-0.85, 0.85].forEach(function (x) { cyl(booth, 0.24, 0.24, 0.04, std("#141414", 0.3, 0.5), x, 1.18, 0.05, 28); cyl(booth, 0.2, 0.2, 0.045, std("#1d1d1d", 0.6), x, 1.19, 0.05, 28); });
    box(booth, 0.5, 0.06, 0.4, std("#202020", 0.4, 0.4), 0, 1.19, 0.05);
    var ledT = ctex(512, 256, function (g, w, h) { var gr = g.createLinearGradient(0, 0, w, h); gr.addColorStop(0, "#3a0a4a"); gr.addColorStop(0.5, "#0a1a4a"); gr.addColorStop(1, "#4a0a2a"); g.fillStyle = gr; g.fillRect(0, 0, w, h); drawEmblem(g, w / 2, h / 2 + 8, 200, "#f0cf78"); for (var y = 0; y < h; y += 4) { g.fillStyle = "rgba(0,0,0,0.25)"; g.fillRect(0, y, w, 1); } });
    var ledM = new T.MeshBasicMaterial({ map: ledT, toneMapped: false });
    addTo(G, new T.PlaneGeometry(4.6, 2.3), ledM, 0, 3.0, -4.55, { noCast: true });
    // speaker stacks
    var spk = std("#0c0c0e", 0.45, 0.2), cone = std("#222", 0.6, 0.4), ringM = std("#d4a843", 0.3, 1);
    [-1, 1].forEach(function (s) { for (var k = 0; k < 2; k++) { box(G, 1.0, 1.0, 0.8, spk, s * 2.8, 0.5 + k * 1.02, -4.1); addTo(G, new T.CylinderGeometry(0.34, 0.34, 0.03, 28), cone, s * 2.8, 0.5 + k * 1.02, -3.69, { rx: Math.PI / 2 }); addTo(G, new T.TorusGeometry(0.34, 0.02, 6, 28), ringM, s * 2.8, 0.5 + k * 1.02, -3.68); } });
    // LED bars on walls
    var barMs = [];
    for (var b = 0; b < 6; b++) { var bm = glowMat(palette[b % palette.length], 2.5); barMs.push(bm); var bx = -5.5 + b * 2.2; if (Math.abs(bx) > 2.4) box(G, 0.06, 4.0, 0.05, bm, bx, 2.6, -4.52, { noCast: true }); box(G, 0.05, 3.6, 0.06, bm, b < 3 ? -6.12 : 6.12, 2.4, -3 + (b % 3) * 2.8, { noCast: true }); }
    // bar
    var bar = new T.Group(); bar.position.set(5.2, 0, 1.0); G.add(bar);
    box(bar, 0.7, 1.05, 3.4, std("#100e12", 0.3, 0.3), 0, 0.525, 0); box(bar, 0.8, 0.05, 3.5, std("#d4a843", 0.25, 1), 0, 1.07, 0);
    box(bar, 0.04, 0.04, 3.3, glowMat(0x8a3dff, 3), -0.36, 0.1, 0, { noCast: true });
    var bottleCols = [0x2f8a3f, 0x8a2f2f, 0xd4a843, 0x2f4f8a, 0xe0e0e0];
    for (var bb = 0; bb < 9; bb++) cyl(bar, 0.04, 0.05, 0.3, std(bottleCols[bb % 5], 0.1, 0.1, { transparent: true, opacity: 0.85, emissive: bottleCols[bb % 5], emissiveIntensity: 0.25 }), 0.88, 1.65, -1.4 + bb * 0.35, 10);
    box(bar, 0.25, 0.04, 3.4, std("#d4a843", 0.3, 1), 0.88, 1.48, 0);
    sofa(G, -5.3, 0.6, Math.PI / 2, 2.6, std("#2b0d36", 0.9), std("#d4a843", 0.3, 1), std("#d4a843", 0.3, 1));
    // disco ball
    var disco = addTo(G, new T.IcosahedronGeometry(0.42, 3), std("#e8e8f0", 0.08, 1, { flatShading: true, envMapIntensity: 2.5 }), 0, 4.2, -0.8, { noCast: true });
    cyl(G, 0.01, 0.01, 1.2, std("#888", 0.4, 1), 0, 5.0, -0.8, 6, { noCast: true });
    // spotlights + beams
    var beamG = new T.ConeGeometry(1, 1, 24, 1, true).translate(0, -0.5, 0).rotateX(-Math.PI / 2);
    var spots = [[-3.5, 0xff2fa0], [0, 0x2fd0ff], [3.5, 0xd4a843]].map(function (c, n) {
      var s = new T.SpotLight(c[1], 60, 14, 0.32, 0.6, 1.4); s.position.set(c[0], 5.2, -2.5); G.add(s); G.add(s.target);
      var bm = new T.MeshBasicMaterial({ color: c[1], transparent: true, opacity: 0.09, blending: T.AdditiveBlending, depthWrite: false, side: T.DoubleSide, fog: false });
      var beam = new T.Mesh(beamG, bm); beam.position.copy(s.position); G.add(beam);
      return { light: s, beam: beam, ph: n * 2.1 };
    });
    // haze sprites
    var hazes = [];
    for (var hz = 0; hz < 4; hz++) { var sp = new T.Sprite(new T.SpriteMaterial({ map: SHARED.glow, color: palette[hz], transparent: true, opacity: 0.16, blending: T.AdditiveBlending, depthWrite: false })); sp.scale.set(6, 3, 1); sp.position.set(-4 + hz * 2.7, 0.9, -2.5 + (hz % 2) * 2); G.add(sp); hazes.push(sp); }
    stdLights(G, { sky: 0x9a6fd0, ground: 0x0e0814, hemi: 0.45, dirColor: 0xd0b0ff, dir: 0.6 });
    point(G, 0xff3fb0, 10, 9, -4, 3, 1); point(G, 0xd4a843, 10, 9, 4, 3, 1);
    R.bg = 0x060409; R.fog = new T.FogExp2(0x1a0b24, 0.035); R.env = { base: "#120818", panels: ["#ff4fb0", "#4fd0ff", "#f0cf78"] };
    var v3 = new T.Vector3(), lastTile = -1;
    function aimSpots(t) {
      spots.forEach(function (sp, n) {
        var tx = reduced ? (n - 1) * 2.2 : Math.sin(t * 0.7 + sp.ph) * 3.6, tz = reduced ? 0 : Math.cos(t * 0.53 + sp.ph * 1.3) * 2.2 + 0.4;
        sp.light.target.position.set(tx, 0, tz);
        v3.set(tx, 0, tz).sub(sp.light.position); var L = v3.length();
        sp.beam.scale.set(Math.tan(0.32) * L, Math.tan(0.32) * L, L); sp.beam.lookAt(tx, 0, tz);
      });
    }
    aimSpots(0);
    R.tick = function (t) {
      if (reduced) return;
      disco.rotation.y = t * 0.6; aimSpots(t);
      var step = Math.floor(t * 2.2);
      if (step !== lastTile) {
        lastTile = step; var rr = rng(step * 7919 + 1);
        for (var k = 0; k < NX * NZ; k++) { var ii = Math.floor(k / NZ), jj = k % NZ, on = ((ii + jj + step) % 3 === 0) || rr() < 0.25; col.copy(palette[(ii + step) % palette.length]).multiplyScalar(on ? 0.95 : 0.12); tiles.setColorAt(k, col); }
        tiles.instanceColor.needsUpdate = true;
      }
      barMs.forEach(function (m, n) { m.emissiveIntensity = 1.6 + Math.sin(t * 3 + n) * 1.2; });
      hazes.forEach(function (h, n) { h.position.x = -4 + n * 2.7 + Math.sin(t * 0.3 + n) * 0.6; });
    };
  }

  var BUILDERS = { lounge: buildLounge, studio: buildStudio, rooftop: buildRooftop, club: buildClub };

  function makeEnv(env) {
    var sc = new T.Scene();
    var bx = new T.Mesh(new T.BoxGeometry(20, 20, 20), new T.MeshBasicMaterial({ color: env.base, side: T.BackSide })); sc.add(bx);
    var pg = new T.PlaneGeometry(6, 3);
    env.panels.forEach(function (c, i) { var m = new T.Mesh(pg, new T.MeshBasicMaterial({ color: c, side: T.DoubleSide })); var a = i / env.panels.length * Math.PI * 2; m.position.set(Math.cos(a) * 9, 4 + i, Math.sin(a) * 9); m.lookAt(0, 0, 0); sc.add(m); });
    var top = new T.Mesh(new T.PlaneGeometry(8, 8), new T.MeshBasicMaterial({ color: 0x8a7a66 })); top.position.y = 9.5; top.rotation.x = Math.PI / 2; sc.add(top);
    var rt = S.pmrem.fromScene(sc, 0.04);
    sc.traverse(function (o) { if (o.geometry) o.geometry.dispose(); if (o.material) o.material.dispose(); });
    return rt;
  }

  function applyRoom(name) {
    if (!BUILDERS[name]) name = "lounge";
    if (S.roomName === name && S.room) return;
    if (S.room) { S.scene.remove(S.room.group); disposeTree(S.room.group); if (S.envRT) { S.envRT.dispose(); S.envRT = null; } }
    var G = new T.Group(), R = { group: G, tick: null };
    BUILDERS[name](G, R);
    S.scene.add(G); S.room = R; S.roomName = name;
    S.scene.background = new T.Color(R.bg); S.scene.fog = R.fog;
    try { S.envRT = makeEnv(R.env); S.scene.environment = S.envRT.texture; } catch (e) { S.scene.environment = null; }
    S.ui.room.textContent = ROOM_NAMES[name];
  }

  /* ================================================================ UI */
  var CSS = [
    ".w3d-root{position:absolute;inset:0;overflow:hidden;border-radius:inherit;background:#0b0a08;font-family:inherit;color:#f3ecdc;-webkit-user-select:none;user-select:none}",
    ".w3d-root canvas{position:absolute;inset:0;width:100%!important;height:100%!important;display:block;touch-action:pan-y;outline:none}",
    ".w3d-fs .w3d-root canvas,.w3d-native .w3d-root canvas{touch-action:none}",
    ".w3d-ui{position:absolute;inset:0;pointer-events:none}",
    ".w3d-ui button,.w3d-ui input,.w3d-ui form{pointer-events:auto;font-family:inherit}",
    ".w3d-top{position:absolute;top:10px;left:10px;right:10px;display:flex;gap:6px;align-items:center}",
    ".w3d-sp{flex:1}",
    ".w3d-pill{background:rgba(11,10,8,.72);border:1px solid rgba(212,168,67,.55);color:#f0cf78;border-radius:999px;padding:4px 11px;font-size:12px;font-weight:700;letter-spacing:.04em;white-space:nowrap;backdrop-filter:blur(6px);-webkit-backdrop-filter:blur(6px)}",
    ".w3d-ib{width:32px;height:32px;border-radius:50%;border:1px solid rgba(212,168,67,.55);background:rgba(11,10,8,.72);color:#f0cf78;font-size:16px;line-height:1;cursor:pointer;display:inline-flex;align-items:center;justify-content:center;padding:0}",
    ".w3d-ib:hover,.w3d-bar button:hover{background:rgba(212,168,67,.25)}",
    ".w3d-recenter{position:absolute;right:10px;top:50px}",
    ".w3d-hint{position:absolute;left:50%;top:48px;transform:translateX(-50%);background:rgba(11,10,8,.7);color:#f3ecdc;font-size:12px;padding:5px 12px;border-radius:999px;border:1px solid rgba(212,168,67,.35);transition:opacity .8s;white-space:nowrap}",
    ".w3d-hint.w3d-gone{opacity:0}",
    ".w3d-bar{position:absolute;left:8px;right:8px;bottom:8px;display:flex;gap:5px;align-items:center;flex-wrap:nowrap}",
    ".w3d-bar>button{border:1px solid rgba(212,168,67,.5);background:rgba(21,19,15,.85);color:#f3ecdc;border-radius:999px;padding:6px 10px;font-size:12px;cursor:pointer;display:inline-flex;gap:4px;align-items:center;white-space:nowrap}",
    ".w3d-say{flex:1;display:flex;gap:5px;min-width:0}",
    ".w3d-say input{flex:1;min-width:40px;background:rgba(11,10,8,.85);border:1px solid rgba(212,168,67,.45);color:#f3ecdc;border-radius:999px;padding:7px 12px;font-size:16px;outline:none;-webkit-user-select:text;user-select:text}",
    ".w3d-say input:focus{border-color:#f0cf78}",
    ".w3d-say button{border:0;background:linear-gradient(#f0cf78,#d4a843);color:#0b0a08;font-weight:800;border-radius:999px;padding:6px 14px;font-size:13px;cursor:pointer}",
    ".w3d-narrow .w3d-bar>button b{display:none}",
    ".w3d-narrow .w3d-bar>button{padding:6px 8px}",
    ".w3d-narrow .w3d-say button{padding:6px 10px}",
    ".w3d-tags{position:absolute;inset:0;overflow:hidden}",
    ".w3d-tag{position:absolute;left:0;top:0;transform-origin:0 0;background:rgba(11,10,8,.7);color:#f3ecdc;font-size:11px;font-weight:600;padding:2px 8px;border-radius:999px;white-space:nowrap;max-width:140px;overflow:hidden;text-overflow:ellipsis;will-change:transform}",
    ".w3d-tag.w3d-me{color:#0b0a08;background:linear-gradient(#f0cf78,#d4a843);font-weight:800}",
    ".w3d-bub{position:absolute;left:0;top:0;background:#fff;color:#15130f;font-size:12.5px;line-height:1.3;padding:6px 10px;border-radius:14px;max-width:190px;width:max-content;word-wrap:break-word;overflow-wrap:anywhere;box-shadow:0 3px 12px rgba(0,0,0,.45);will-change:transform}",
    ".w3d-bub:after{content:'';position:absolute;left:50%;bottom:-6px;margin-left:-6px;border:6px solid transparent;border-bottom:0;border-top-color:#fff}",
    ".w3d-fs{position:fixed!important;inset:0!important;z-index:10050!important;border-radius:0!important;aspect-ratio:auto!important;width:100vw!important;height:100vh!important;height:100dvh!important;max-width:none!important;max-height:none!important;margin:0!important}",
    ".w3d-native{border-radius:0!important;aspect-ratio:auto!important}",
    "html.w3d-lock,body.w3d-lock{overflow:hidden!important;overscroll-behavior:none}",
    ".w3d-fs .w3d-bar,.w3d-native .w3d-bar{bottom:max(10px,env(safe-area-inset-bottom))}",
    ".w3d-fs .w3d-top,.w3d-native .w3d-top{top:max(10px,env(safe-area-inset-top))}"
  ].join("\n");

  function injectCss() {
    if (document.getElementById("w3d-style")) return;
    var st = document.createElement("style"); st.id = "w3d-style"; st.textContent = CSS; document.head.appendChild(st);
  }

  function buildUi(root, handlers) {
    var ui = document.createElement("div"); ui.className = "w3d-ui";
    ui.innerHTML =
      '<div class="w3d-tags"></div>' +
      '<div class="w3d-top"><span class="w3d-pill w3d-roomp"></span><span class="w3d-sp"></span><span class="w3d-pill w3d-count"></span>' +
      '<button type="button" class="w3d-ib w3d-fsb" title="Fullscreen" aria-label="Fullscreen">⛶</button></div>' +
      '<button type="button" class="w3d-ib w3d-recenter" title="Re-center camera" aria-label="Re-center camera">◎</button>' +
      '<div class="w3d-hint">Tap the floor to walk · Drag to look around</div>' +
      '<div class="w3d-bar">' +
      '<button type="button" data-pose="wave" title="Wave"><span>👋</span><b>Wave</b></button>' +
      '<button type="button" data-pose="dance" title="Dance"><span>💃</span><b>Dance</b></button>' +
      '<button type="button" data-pose="sit" title="Sit"><span>🪑</span><b>Sit</b></button>' +
      '<button type="button" data-pose="stand" title="Stand"><span>🧍</span><b>Stand</b></button>' +
      '<form class="w3d-say" autocomplete="off"><input type="text" maxlength="120" placeholder="Say something…" enterkeyhint="send" aria-label="Say something"><button type="submit">Say</button></form>' +
      "</div>";
    root.appendChild(ui);
    var q = function (s) { return ui.querySelector(s); };
    var out = { el: ui, room: q(".w3d-roomp"), count: q(".w3d-count"), fsb: q(".w3d-fsb"), recenter: q(".w3d-recenter"), hint: q(".w3d-hint"), tags: q(".w3d-tags"), input: q(".w3d-say input"), form: q(".w3d-say") };
    Array.prototype.forEach.call(ui.querySelectorAll("[data-pose]"), function (b) {
      b.addEventListener("click", function (e) { e.stopPropagation(); try { handlers.onPose && handlers.onPose(b.getAttribute("data-pose")); } catch (err) { console.warn("[World3D] onPose", err); } });
    });
    out.form.addEventListener("submit", function (e) {
      e.preventDefault(); e.stopPropagation();
      var v = String(out.input.value || "").trim().slice(0, 120);
      if (!v) return; out.input.value = "";
      try { handlers.onSay && handlers.onSay(v); } catch (err) { console.warn("[World3D] onSay", err); }
    });
    ["keydown", "keyup", "keypress"].forEach(function (ev) { out.input.addEventListener(ev, function (e) { e.stopPropagation(); }); });
    ui.addEventListener("pointerdown", function (e) { if (e.target !== ui) e.stopPropagation(); });
    return out;
  }

  /* ---------------------------------------------------------- fullscreen */
  function fsEl() { return document.fullscreenElement || document.webkitFullscreenElement || null; }
  function isFs() { return !!S && (S.cssFs || fsEl() === S.container); }
  function setCssFs(on) {
    S.cssFs = on;
    S.container.classList.toggle("w3d-fs", on);
    document.documentElement.classList.toggle("w3d-lock", on); document.body.classList.toggle("w3d-lock", on);
    syncFsUi(); setTimeout(resize, 30);
  }
  function enterFs() {
    var el = S.container, req = el.requestFullscreen || el.webkitRequestFullscreen;
    if (req) {
      try {
        var p = req.call(el);
        if (p && typeof p.then === "function") p.catch(function () { setCssFs(true); });
        setTimeout(function () { if (!fsEl() && !S.cssFs) setCssFs(true); }, 600);
        return;
      } catch (e) { /* fall through */ }
    }
    setCssFs(true);
  }
  function exitFs() {
    if (S.cssFs) setCssFs(false);
    if (fsEl() === S.container) { try { (document.exitFullscreen || document.webkitExitFullscreen).call(document); } catch (e) {} }
  }
  function syncFsUi() {
    var native = fsEl() === S.container;
    S.container.classList.toggle("w3d-native", native);
    S.ui.fsb.textContent = (native || S.cssFs) ? "✕" : "⛶";
    S.ui.fsb.title = (native || S.cssFs) ? "Exit fullscreen" : "Fullscreen";
  }

  /* ---------------------------------------------------------- camera */
  var CAM0 = { yaw: 0, pitch: 0.4, dist: 10.6 };
  function updateCamera(dt) {
    var c = S.cam, me = null;
    S.avatars.forEach(function (A) { if (A.isMe) me = A; });
    var fx = 0, fz = 0.2;
    if (me && c.follow) { fx = clamp(me.root.position.x * 0.5, -2.6, 2.6); fz = clamp(0.2 + me.root.position.z * 0.35, -1, 1.6); }
    var f = 1 - Math.exp(-dt * 1.6);
    c.tx += (fx - c.tx) * f; c.tz += (fz - c.tz) * f;
    var cp = Math.cos(c.pitch);
    S.camera.position.set(c.tx + Math.sin(c.yaw) * cp * c.dist, 0.9 + Math.sin(c.pitch) * c.dist, c.tz + Math.cos(c.yaw) * cp * c.dist);
    S.camera.lookAt(c.tx, 0.9, c.tz);
  }

  function resize() {
    if (!S) return;
    var w = Math.max(1, S.container.clientWidth), h = Math.max(1, S.container.clientHeight);
    if (w === S.w && h === S.h) return;
    S.w = w; S.h = h;
    S.renderer.setSize(w, h, false);
    var aspect = w / h;
    S.camera.aspect = aspect;
    var hf = 2 * Math.atan(Math.tan(32 * Math.PI / 180) / aspect) * 180 / Math.PI;
    S.camera.fov = clamp(Math.max(42, hf), 42, 72);
    S.camera.updateProjectionMatrix();
    S.container.classList.toggle("w3d-narrow", w < 600);
  }

  /* ---------------------------------------------------------- input */
  function bindInput() {
    var cv = S.renderer.domElement, ptrs = new Map(), down = null, pinch0 = 0, dist0 = 0;
    var ray = new T.Raycaster(), ndc = new T.Vector2(), plane = new T.Plane(new T.Vector3(0, 1, 0), 0), hit = new T.Vector3();
    function onDown(e) {
      ptrs.set(e.pointerId, { x: e.clientX, y: e.clientY });
      try { cv.setPointerCapture(e.pointerId); } catch (er) {}
      if (ptrs.size === 1) down = { x: e.clientX, y: e.clientY, lx: e.clientX, ly: e.clientY, drag: false, t: Date.now() };
      else if (ptrs.size === 2) { var a = Array.from(ptrs.values()); pinch0 = Math.hypot(a[0].x - a[1].x, a[0].y - a[1].y); dist0 = S.cam.dist; if (down) down.drag = true; }
    }
    function onMove(e) {
      if (!ptrs.has(e.pointerId)) return;
      ptrs.set(e.pointerId, { x: e.clientX, y: e.clientY });
      if (ptrs.size >= 2) {
        var a = Array.from(ptrs.values()), d = Math.hypot(a[0].x - a[1].x, a[0].y - a[1].y);
        if (pinch0 > 0) S.cam.dist = clamp(dist0 * pinch0 / Math.max(10, d), 5.5, 14);
        e.preventDefault(); return;
      }
      if (!down) return;
      if (!down.drag && Math.hypot(e.clientX - down.x, e.clientY - down.y) > 6) down.drag = true;
      if (down.drag) {
        S.cam.yaw = clamp(S.cam.yaw - (e.clientX - down.lx) * 0.006, -0.85, 0.85);
        S.cam.pitch = clamp(S.cam.pitch + (e.clientY - down.ly) * 0.004, 0.18, 0.95);
        down.lx = e.clientX; down.ly = e.clientY;
      }
    }
    function onUp(e) {
      var had = ptrs.has(e.pointerId); ptrs.delete(e.pointerId);
      if (!had) return;
      if (e.type === "pointerup" && down && !down.drag && ptrs.size === 0) tap(e.clientX, e.clientY);
      if (ptrs.size === 0) down = null;
    }
    function tap(cx, cy) {
      var r = cv.getBoundingClientRect();
      ndc.set((cx - r.left) / r.width * 2 - 1, -((cy - r.top) / r.height) * 2 + 1);
      ray.setFromCamera(ndc, S.camera);
      if (!ray.ray.intersectPlane(plane, hit)) return;
      var p = fromWorld(hit.x, hit.z);
      S.ui.hint.classList.add("w3d-gone"); S.cam.follow = true;
      try { S.handlers.onWalk && S.handlers.onWalk(p.x, p.y); } catch (err) { console.warn("[World3D] onWalk", err); }
    }
    cv.addEventListener("pointerdown", onDown); cv.addEventListener("pointermove", onMove, { passive: false });
    cv.addEventListener("pointerup", onUp); cv.addEventListener("pointercancel", onUp);
    cv.addEventListener("wheel", function (e) { e.preventDefault(); S.cam.dist = clamp(S.cam.dist * Math.exp(e.deltaY * 0.0012), 5.5, 14); }, { passive: false });
    cv.addEventListener("contextmenu", function (e) { e.preventDefault(); });
    S.ui.recenter.addEventListener("click", function (e) { e.stopPropagation(); S.cam.yaw = CAM0.yaw; S.cam.pitch = CAM0.pitch; S.cam.dist = CAM0.dist; S.cam.follow = true; });
    S.ui.fsb.addEventListener("click", function (e) { e.stopPropagation(); if (isFs()) exitFs(); else enterFs(); });
    S.onFsChange = function () { syncFsUi(); setTimeout(resize, 50); };
    S.onKey = function (e) { if (e.key === "Escape" && S.cssFs) setCssFs(false); };
    document.addEventListener("fullscreenchange", S.onFsChange); document.addEventListener("webkitfullscreenchange", S.onFsChange);
    document.addEventListener("keydown", S.onKey);
  }

  /* ---------------------------------------------------------- people */
  function applyList(list) {
    if (!Array.isArray(list)) return;
    var seen = new Set(), now = Date.now();
    list.forEach(function (it) {
      if (!it || it.key == null) return;
      var key = String(it.key); seen.add(key);
      var A = S.avatars.get(key), sig = JSON.stringify(normLook(it.look)) + "|" + (it.faceUrl || "");
      var w = toWorld(it.x, it.y);
      if (A && (A.sig !== sig || A.isMe !== !!it.isMe)) { var keep = { x: A.root.position.x, z: A.root.position.z, h: A.heading }; removeAvatar(A); S.avatars.delete(key); A = null; it.__keep = keep; }
      if (!A) {
        A = buildAvatar(Object.assign({}, it, { key: key }));
        A.seed = (hashStr(key) % 1000) / 100;
        var k = it.__keep; delete it.__keep;
        A.root.position.set(k ? k.x : w.x, 0, k ? k.z : w.z); A.heading = k ? k.h : 0;
        S.scene.add(A.root); S.avatars.set(key, A);
      }
      A.isMe = !!it.isMe; A.tx = w.x; A.tz = w.z;
      A.pose = ["stand", "wave", "dance", "sit"].indexOf(it.pose) >= 0 ? it.pose : "stand";
      A.poseAt = toMs(it.poseAt) || (A.pose !== A.lastPose ? now : A.poseAt || now); A.lastPose = A.pose;
      var nm = String(it.name == null ? "Guest" : it.name).slice(0, 40) || "Guest";
      if (A.tag.textContent !== nm) A.tag.textContent = nm;
      A.say = it.say ? String(it.say).slice(0, 160) : ""; A.sayAt = toMs(it.sayAt) || 0;
      if (A.bub.textContent !== A.say) A.bub.textContent = A.say;
      if (A.isMe && S.lastMeTarget && (Math.abs(S.lastMeTarget.x - w.x) > 0.05 || Math.abs(S.lastMeTarget.z - w.z) > 0.05)) S.ui.hint.classList.add("w3d-gone");
      if (A.isMe) S.lastMeTarget = w;
    });
    S.avatars.forEach(function (A, key) { if (!seen.has(key)) { removeAvatar(A); S.avatars.delete(key); } });
    S.ui.count.textContent = "👥 " + S.avatars.size;
  }

  var v3 = null;
  function placeOverlays(now) {
    var w = S.w, h = S.h;
    S.avatars.forEach(function (A) {
      var top = A.root.position.y + (A.cur.bodyY || 0.93) + 0.93;
      v3.set(A.root.position.x, top + 0.04, A.root.position.z).project(S.camera);
      var vis = v3.z < 1 && v3.x > -1.2 && v3.x < 1.2 && v3.y > -1.2 && v3.y < 1.3;
      var sx = (v3.x * 0.5 + 0.5) * w, sy = (-v3.y * 0.5 + 0.5) * h;
      A.tag.style.display = vis ? "" : "none";
      if (vis) { var tw = A.tag.offsetWidth; A.tag.style.transform = "translate(" + Math.round(sx - tw / 2) + "px," + Math.round(sy - 22) + "px)"; }
      var showB = vis && A.say && now - A.sayAt < 8000;
      A.bub.style.display = showB ? "" : "none";
      if (showB) { var bw = A.bub.offsetWidth, bh = A.bub.offsetHeight; A.bub.style.transform = "translate(" + Math.round(clamp(sx - bw / 2, 4, w - bw - 4)) + "px," + Math.round(Math.max(4, sy - 30 - bh)) + "px)"; }
    });
  }

  /* ---------------------------------------------------------- loop */
  function frame() {
    if (!S || S.dead) return;
    S.raf = requestAnimationFrame(frame);
    if (!S.visible || document.hidden) { S.clock.getDelta(); return; }
    var dt = Math.min(0.05, S.clock.getDelta()), t = S.clock.elapsedTime, now = Date.now();
    try {
      updateCamera(dt);
      var cp = S.camera.position;
      S.avatars.forEach(function (A) { animateAvatar(A, t, dt, now, cp); });
      if (S.room && S.room.tick) S.room.tick(t, dt);
      S.renderer.render(S.scene, S.camera);
      placeOverlays(now);
    } catch (e) { if (!S.warned) { S.warned = true; console.error("[World3D] frame", e); } }
  }

  /* ---------------------------------------------------------- mount */
  function loadThree() {
    if (T) return Promise.resolve(T);
    var url = (typeof window.W3D_THREE_URL === "string" && window.W3D_THREE_URL) || W3D_THREE_URL;
    return import(url).then(function (m) { T = m; return m; });
  }

  function destroy() {
    if (!S) return;
    var s = S; s.dead = true; cancelAnimationFrame(s.raf);
    try { if (s.cssFs) setCssFs(false); } catch (e) {}
    try { s.ro && s.ro.disconnect(); s.io && s.io.disconnect(); } catch (e) {}
    document.removeEventListener("fullscreenchange", s.onFsChange); document.removeEventListener("webkitfullscreenchange", s.onFsChange);
    document.removeEventListener("keydown", s.onKey);
    try { s.avatars.forEach(removeAvatar); if (s.room) disposeTree(s.room.group); if (s.envRT) s.envRT.dispose(); s.pmrem.dispose(); s.renderer.dispose(); } catch (e) {}
    if (s.root && s.root.parentNode) s.root.parentNode.removeChild(s.root);
    S = null;
  }

  function mount(containerEl, handlers) {
    if (!containerEl) return Promise.reject(new Error("World3D: no container"));
    if (S && S.container === containerEl) { S.handlers = handlers || {}; return Promise.resolve(); }
    if (mounting) return mounting;
    if (!supported()) return Promise.reject(new Error("World3D: WebGL not supported"));
    mounting = loadThree().then(function () {
      destroy();
      injectCss();
      var root = document.createElement("div"); root.className = "w3d-root";
      var renderer;
      try { renderer = new T.WebGLRenderer({ antialias: true, powerPreference: "high-performance" }); }
      catch (e) { throw new Error("World3D: WebGL init failed: " + e.message); }
      renderer.setPixelRatio(Math.min(window.devicePixelRatio || 1, 1.75));
      renderer.outputColorSpace = T.SRGBColorSpace; renderer.toneMapping = T.ACESFilmicToneMapping; renderer.toneMappingExposure = 1.15;
      renderer.shadowMap.enabled = true; renderer.shadowMap.type = T.PCFSoftShadowMap;
      root.appendChild(renderer.domElement);
      renderer.domElement.addEventListener("webglcontextlost", function (e) { e.preventDefault(); });
      containerEl.appendChild(root);
      S = {
        container: containerEl, root: root, renderer: renderer, handlers: handlers || {},
        scene: new T.Scene(), camera: new T.PerspectiveCamera(42, 16 / 9, 0.1, 220), clock: new T.Clock(),
        avatars: new Map(), cam: { yaw: CAM0.yaw, pitch: CAM0.pitch, dist: CAM0.dist, tx: 0, tz: 0.2, follow: true },
        visible: true, w: 0, h: 0, cssFs: false, pmrem: new T.PMREMGenerator(renderer)
      };
      v3 = new T.Vector3();
      S.ui = buildUi(root, S.handlers); S.tagLayer = S.ui.tags;
      bindInput(); resize();
      if (window.ResizeObserver) { S.ro = new ResizeObserver(function () { resize(); }); S.ro.observe(containerEl); }
      else window.addEventListener("resize", resize);
      if (window.IntersectionObserver) { S.io = new IntersectionObserver(function (en) { if (S) S.visible = en[0].isIntersecting || isFs(); }); S.io.observe(containerEl); }
      applyRoom(pending.room || "lounge");
      if (pending.list) applyList(pending.list); else S.ui.count.textContent = "👥 0";
      syncFsUi();
      frame();
    }).then(function () { mounting = null; }, function (err) {
      mounting = null; try { destroy(); } catch (e) {}
      throw err;
    });
    return mounting;
  }

  window.World3D = {
    mount: mount,
    setRoom: function (name) {
      name = BUILDERS[name] ? name : "lounge"; pending.room = name;
      if (S && !mounting) { try { applyRoom(name); } catch (e) { console.error("[World3D] setRoom", e); } }
    },
    update: function (list) {
      if (!Array.isArray(list)) return; pending.list = list;
      if (S && !mounting) { try { applyList(list); } catch (e) { console.error("[World3D] update", e); } }
    },
    supported: supported,
    destroy: destroy
  };
})();
