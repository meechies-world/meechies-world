/* DJ MIDI mapping - OPTIONAL. Nothing runs until someone taps "Connect a MIDI
 * controller" on the DJ Station (index.html loads this file only then). The site
 * works the same without a controller. Web MIDI needs a secure page (https) and the
 * browser's permission. Chrome, Edge and Opera on a computer support it. */
(function () {
  "use strict";
  var KEY = "mw-midi-map-v1";
  var DECKS = ["A", "B", "C", "D"];
  var FUNCS = [];
  DECKS.forEach(function (k) {
    FUNCS.push({ id: "play-" + k, label: "Deck " + k + " play / pause", kind: "button", sel: '[data-play="' + k + '"]' });
    FUNCS.push({ id: "vol-" + k, label: "Deck " + k + " volume", kind: "range", sel: 'input[data-vol="' + k + '"]' });
    FUNCS.push({ id: "pitch-" + k, label: "Deck " + k + " pitch", kind: "range", sel: 'input[data-pitch="' + k + '"]' });
    FUNCS.push({ id: "flt-" + k, label: "Deck " + k + " filter", kind: "range", sel: 'input[data-flt="' + k + '"]' });
    ["lo", "mid", "hi"].forEach(function (b) {
      FUNCS.push({ id: "eq-" + k + "-" + b, label: "Deck " + k + " EQ " + b, kind: "range", sel: 'input[data-eq="' + k + ':' + b + '"]' });
    });
  });
  FUNCS.push({ id: "master-filter", label: "Master filter", kind: "range", sel: "#djx-filter" });
  FUNCS.push({ id: "master-echo", label: "Master echo", kind: "range", sel: "#djx-echo" });
  FUNCS.push({ id: "master-boost", label: "Master boost", kind: "range", sel: "#djx-boost" });

  var map = load();
  var learning = null;
  var inputsSeen = {};

  function load() { try { return JSON.parse(localStorage.getItem(KEY) || "{}") || {}; } catch (_) { return {}; } }
  function save() { try { localStorage.setItem(KEY, JSON.stringify(map)); } catch (_) {} }

  /* raw MIDI bytes -> a plain message; note-off and zero-velocity note-on count as "off" */
  function parse(data) {
    if (!data || data.length < 3) return null;
    var st = data[0] & 0xf0, ch = data[0] & 0x0f, n = data[1], v = data[2];
    if (st === 0x90 && v > 0) return { type: "note", ch: ch, num: n, value: v };
    if (st === 0x90 || st === 0x80) return { type: "note", ch: ch, num: n, value: 0, off: true };
    if (st === 0xb0) return { type: "cc", ch: ch, num: n, value: v };
    return null;
  }

  /* which functions a message drives right now */
  function functionsFor(msg, m) {
    var out = [];
    Object.keys(m).forEach(function (id) {
      var s = m[id];
      if (s.type === msg.type && s.ch === msg.ch && s.num === msg.num) out.push(id);
    });
    return out;
  }

  /* 0..127 -> the control's own min..max (reads the slider's real range) */
  function scale(el, v) {
    var mn = parseFloat(el.min), mx = parseFloat(el.max);
    if (isNaN(mn)) mn = 0;
    if (isNaN(mx)) mx = 1;
    return mn + (mx - mn) * (v / 127);
  }

  function fnById(id) {
    for (var i = 0; i < FUNCS.length; i++) if (FUNCS[i].id === id) return FUNCS[i];
    return null;
  }

  /* drive the existing DJ control; returns true when the control exists on this page */
  function apply(fn, msg) {
    var el = document.querySelector(fn.sel);
    if (!el) return false;
    if (fn.kind === "button") {
      if (!msg.off) el.click();
      return true;
    }
    el.value = String(scale(el, msg.value));
    el.dispatchEvent(new Event("input", { bubbles: true }));
    el.dispatchEvent(new Event("change", { bubbles: true }));
    return true;
  }

  function handle(msg, m) {
    var res = [];
    functionsFor(msg, m || map).forEach(function (id) {
      var fn = fnById(id);
      if (fn) res.push({ id: id, label: fn.label, ok: apply(fn, msg) });
    });
    return res;
  }

  /* learn: the next press or move becomes this function's control; the old owner of that control is cleared */
  function learn(id, msg) {
    Object.keys(map).forEach(function (other) {
      var s = map[other];
      if (s.type === msg.type && s.ch === msg.ch && s.num === msg.num) delete map[other];
    });
    map[id] = { type: msg.type, ch: msg.ch, num: msg.num };
    save();
  }

  var panel = null, ui = {};
  function status(t) { if (ui.status) ui.status.textContent = t; }
  function label(msg) { return (msg.type === "note" ? "Note " : "Control ") + msg.num + " - channel " + (msg.ch + 1); }

  function onMessage(e) {
    var msg = parse(e.data);
    if (!msg) return;
    if (learning && !msg.off) {
      var id = learning; learning = null;
      learn(id, msg);
      ui.monitor.textContent = "Saved: " + label(msg) + " -> " + fnById(id).label;
      if (ui.learn) ui.learn.textContent = "Learn: move the control now";
      if (ui.cancel) ui.cancel.hidden = true;
      render();
      return;
    }
    var hits = handle(msg);
    ui.monitor.textContent = label(msg) + " - value " + msg.value + (hits.length ? " -> " + hits.map(function (h) { return h.label; }).join(", ") + (hits.every(function (h) { return h.ok; }) ? "" : " (not on this page)") : " - not mapped yet");
  }

  function render() {
    if (!ui.list) return;
    var ids = Object.keys(map);
    ui.list.innerHTML = ids.length ? ids.map(function (id) {
      var f = fnById(id), s = map[id];
      return '<div class="dj-item" style="grid-template-columns:minmax(0,1fr) auto;margin-top:6px"><span>' + f.label + ' <small class="muted">' + label(s) + '</small></span><button class="btn ghost sm" type="button" data-unmap="' + id + '">Remove</button></div>';
    }).join("") : '<p class="muted" style="margin:6px 0 0">No controls mapped yet.</p>';
  }

  function attachInputs(access) {
    var list = Array.from(access.inputs.values());
    list.forEach(function (inp) {
      if (!inputsSeen[inp.id]) { inputsSeen[inp.id] = true; inp.onmidimessage = onMessage; }
    });
    var sel = ui.input;
    sel.innerHTML = list.length ? list.map(function (i) { return '<option value="' + i.id + '">' + (i.name || "MIDI controller") + '</option>'; }).join("") : '<option value="">No controller found yet - plug it in</option>';
    status(list.length ? "Connected. Pick a control below to map it, or just play." : "Permission given. No controller found yet - plug it in.");
  }

  function connect() {
    if (!window.isSecureContext) { status("MIDI needs a secure (https) page. Open the site at meechiesworldinc.com."); return; }
    if (!navigator.requestMIDIAccess) { status("This browser can't use MIDI controllers. Chrome, Edge and Opera on a computer can."); return; }
    navigator.requestMIDIAccess({ sysex: false }).then(function (access) {
      attachInputs(access);
      access.onstatechange = function () { attachInputs(access); };
      ui.connect.textContent = "Reconnect";
    }, function () {
      status("MIDI permission was not given. Everything still works with the mouse or touch.");
    });
  }

  function openPanel() {
    var host = document.getElementById("dj-midi-panel");
    if (!host) return;
    if (!panel) {
      host.innerHTML =
        '<div class="dj-panel" style="margin:0 0 12px">' +
        '<h4>MIDI CONTROLLER - optional</h4>' +
        '<p id="midi-status" class="muted" style="margin:4px 0 8px">Not connected. The site works fine without one.</p>' +
        '<div style="display:flex;gap:8px;flex-wrap:wrap;align-items:center"><button class="btn sm" type="button" id="midi-connect">Connect controller</button>' +
        '<label style="font-size:13px">Controller <select id="midi-input" class="btn ghost sm"></select></label></div>' +
        '<div style="display:flex;gap:8px;flex-wrap:wrap;align-items:center;margin-top:10px"><label style="font-size:13px">Function <select id="midi-fn" class="btn ghost sm"></select></label>' +
        '<button class="btn sm" type="button" id="midi-learn">Learn: move the control now</button>' +
        '<button class="btn ghost sm" type="button" id="midi-cancel" hidden>Cancel</button></div>' +
        '<p id="midi-monitor" class="muted" style="margin:8px 0 0">Last control: none yet</p>' +
        '<div id="midi-list"></div>' +
        '<button class="btn ghost sm" type="button" id="midi-clear" style="margin-top:8px">Clear all mappings</button>' +
        '</div>';
      panel = host;
      ui = {
        status: document.getElementById("midi-status"), connect: document.getElementById("midi-connect"),
        input: document.getElementById("midi-input"), fn: document.getElementById("midi-fn"),
        learn: document.getElementById("midi-learn"), cancel: document.getElementById("midi-cancel"),
        monitor: document.getElementById("midi-monitor"), list: document.getElementById("midi-list"), clear: document.getElementById("midi-clear")
      };
      ui.fn.innerHTML = FUNCS.map(function (f) { return '<option value="' + f.id + '">' + f.label + '</option>'; }).join("");
      ui.connect.addEventListener("click", connect);
      ui.learn.addEventListener("click", function () {
        learning = ui.fn.value;
        ui.learn.textContent = "Waiting... move or press the control";
        ui.cancel.hidden = false;
      });
      ui.cancel.addEventListener("click", function () { learning = null; ui.learn.textContent = "Learn: move the control now"; ui.cancel.hidden = true; });
      ui.clear.addEventListener("click", function () { map = {}; save(); render(); });
      host.addEventListener("click", function (e) {
        var b = e.target.closest && e.target.closest("[data-unmap]");
        if (!b) return;
        delete map[b.dataset.unmap]; save(); render();
      });
      render();
    }
    host.hidden = false;
    host.scrollIntoView({ behavior: "smooth", block: "nearest" });
  }

  window.MW_MIDI = { FUNCS: FUNCS.map(function (f) { return { id: f.id, label: f.label, kind: f.kind, sel: f.sel }; }), parse: parse, handle: handle, scale: scale, learn: learn, getMap: function () { return map; }, clearMap: function () { map = {}; save(); } };
  window.MW_MIDI_OPEN = openPanel;
  if (window.MW_MIDI_WANT) openPanel();
})();
