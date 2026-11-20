/* Meechie-JARVIS site widget — VISITOR-facing only.
 * Stateless. No memory. No owner data. NEVER calls the hub or any API endpoint.
 * Only reads the bundled public catalog (window.MW_JARVIS_CATALOG) + public FAQ below.
 * Price rule: quote ONLY the exact price in the catalog for ONE specific product.
 * If a price is not in the catalog, say "check the exact price on the site" and state NO number.
 * Voice v1 (free): Web Speech API input + SpeechSynthesis output — labelled "device voice".
 * This is NOT Meechie's neural voice. Real Meechie voice on the site is a v2 item.
 */
(function () {
  'use strict';
  var CATALOG = (window.MW_JARVIS_CATALOG && window.MW_JARVIS_CATALOG.items) || [];
  var LOOKUP = (window.MW_JARVIS_CATALOG && window.MW_JARVIS_CATALOG.lookup) || null;
  var SHOP_URL = 'https://meechiesworldinc.com/#shop';
  var TIKTOK_SHOP = 'https://shop.tiktok.com/us/store/meechies-world-inc/7494976370425890255';
  var LOOKUP_URL = 'https://meechiesworldinc.com/lookup-app/';
  var DOTY_URL = 'https://meechiesworldinc.com/caprice/';
  var SITE_URL = 'https://meechiesworldinc.com';

  function money(n) { return '$' + Number(n).toFixed(2); }
  function esc(s) {
    return String(s).replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;').replace(/"/g, '&quot;');
  }
  function norm(s) { return String(s || '').toLowerCase().replace(/[^a-z0-9 $]/g, ' ').replace(/\s+/g, ' ').trim(); }
  function stopwords(t) {
    return t.split(' ').filter(function (w) { return w.length > 2 && ['the','and','for','with','how','much','does','cost','price','buy','get','show','me','find','what','your','shop','please','that','this'].indexOf(w) === -1; });
  }
  function findProduct(q) {
    var words = stopwords(norm(q));
    if (!words.length) return null;
    var best = null, bestScore = 0;
    CATALOG.forEach(function (p) {
      var name = norm(p.name);
      var score = 0;
      words.forEach(function (w) { if (name.indexOf(w) !== -1) score += w.length; });
      // Exact-name bonus: full query contained in name
      if (name.indexOf(norm(q)) !== -1 && norm(q).length > 4) score += 20;
      if (score > bestScore) { bestScore = score; best = p; }
    });
    return bestScore >= 4 ? best : null;
  }
  function searchProducts(q) {
    var words = stopwords(norm(q));
    var out = [];
    CATALOG.forEach(function (p) {
      var name = norm(p.name);
      var score = 0;
      words.forEach(function (w) { if (name.indexOf(w) !== -1) score += 1; });
      if (score) out.push({ p: p, score: score });
    });
    out.sort(function (a, b) { return b.score - a.score; });
    return out.slice(0, 5).map(function (r) { return r.p; });
  }

  function answer(raw) {
    var q = norm(raw);
    if (!q) return "Say the word — ask me about a product, a price, the lookup, books, or Doty's World.";
    // Greetings / small talk — Meechie's voice: witty, slang, short.
    if (/^(hi|hey|hello|yo|wassup|whats up|what up|sup|good morning|good afternoon|good evening)\b/.test(q) || q === 'hi' || q === 'hey' || q === 'yo')
      return "Yo, what up! It's Meechie — your JARVIS for Meechies World. Ask me about a product, a price, the lookup, books, or what's playing. I got you.";
    if (q.indexOf('who are you') !== -1 || q.indexOf('your name') !== -1)
      return "I'm Meechie — Malik's JARVIS for Meechies World Inc. Loyal, witty, always on. I help you find products, prices, books, and the lookup — right here on the site.";
    if (q.indexOf('thank') !== -1) return "You got it, fam. Meechie to the world.";
    if (q.indexOf('bye') !== -1 || q === 'goodbye') return "Aight, stay up. Meechie to the world.";
    if (q.indexOf('how are you') !== -1) return "Running smooth, arc reactor charged. What you need?";
    // Reverse Lookup FAQ
    if (q.indexOf('lookup') !== -1 || q.indexOf('reverse') !== -1 || q.indexOf('phone number') !== -1) {
      return "MW Reverse Lookup — find what's public about any US phone number: social profiles, people-search listings, public court records, crypto/payment profiles, each linked to its source. First lookup $1.99, second $5, then $10 for unlimited lookups. Never charged for an empty report, and reports stay private to your account. Run it here: " + LOOKUP_URL;
    }
    // Books FAQ
    if (q.indexOf('book') !== -1) {
      return "Books are $10 each — 6 paid books (From Harlem to Fort Dix, TikTok: The Opportunity, Meechie's World: The Story and the Blueprint, Faith: The Foundation, SpaceX: The Mission, and The Pyramids of Egypt Complete Luxury Edition) — plus 3 free ones. Find them in the Books section: " + SITE_URL;
    }
    // Doty FAQ
    if (q.indexOf('doty') !== -1 || q.indexOf('caprice') !== -1) {
      return "Doty's World is Caprice's line — 12 products: mugs, blankets, tees, hoodies, bath mat set, trinket trays, shower curtains, posters, quilt set, and sherpa blanket. Peep the whole line here: " + DOTY_URL;
    }
    // TikTok Shop
    if (q.indexOf('tiktok') !== -1) {
      return "Our TikTok Shop is live — shop right there on TikTok: " + TIKTOK_SHOP + " — 14 products, exact prices in the shop. And right here on the site you got the full Shop section too: " + SHOP_URL;
    }
    // Radio / TV
    if (q.indexOf('radio') !== -1) return "The radio is live on the site — hit play on the player and let it roll. If it ever skips, close the site fully and reopen it fresh.";
    if (q.indexOf('tv') !== -1 || q.indexOf('mwtv') !== -1 || q.indexOf('my empire') !== -1) return "MWTV is live on the site — My Empire, new episode daily at 8, rerun at 10. Tap the TV section and press play.";
    if (q.indexOf('hiring') !== -1 || q.indexOf('job') !== -1 || q.indexOf('work for') !== -1)
      return "Meechies World is hiring. Keep an eye on meechiesworldinc.com for details on open roles and how to apply.";
    if (q.indexOf('shipping') !== -1 || q.indexOf('delivery') !== -1 || q.indexOf('return') !== -1)
      return "For shipping or returns on a specific order, check the exact details on the site — I don't have order info here.";
    if (q.indexOf('contact') !== -1 || q.indexOf('email') !== -1 || q.indexOf('reach') !== -1)
      return "You can reach Meechies World through meechiesworldinc.com — check the site for the contact links.";
    // Product search / price — exact price only, one specific product.
    var p = findProduct(raw);
    if (p) {
      var cat = p.cat === 'doty' ? 'Doty\'s World' : (p.cat === 'books' ? 'Books section' : (p.cat === 'cheap-deals' ? 'Cheap Deals' : 'Shop section'));
      var buy = p.buy || SHOP_URL;
      var priceTxt = (p.price === 0) ? 'FREE' : money(p.price);
      return p.name + ' — ' + priceTxt + '. That\'s the exact price. Grab it in the ' + cat + ' on the site: ' + buy;
    }
    if (/price|cost|how much|buy|shop|hoodie|jacket|parka|shirt|tee|blanket|mug|poster|slippers|wallet|case|umbrella|clock|pillow|suitcase|car mat|grater|comb|nails|oil|light|vacuum|cable|holder|cloth|mat|brush|warmer|sealer|patches/.test(q)) {
      var hits = searchProducts(raw);
      if (hits.length) {
        var lines = hits.map(function (h) { return '• ' + h.name + ' — ' + (h.price === 0 ? 'FREE' : money(h.price)); });
        return "Here's what I found — exact prices, one per product:\n" + lines.join('\n') + "\nTap the Shop section on the site to grab one: " + SHOP_URL;
      }
      return "I don't have an exact price for that one in my catalog — check the exact price on the site: " + SHOP_URL;
    }
    if (q.indexOf('price') !== -1 || q.indexOf('how much') !== -1)
      return "Tell me the exact product name and I'll give you its exact price — or check the exact price on the site: " + SHOP_URL;
    return "I got you — but I only speak facts I can check. Ask me about a specific product or price, the $1.99 lookup, books, Doty's World, the TikTok Shop, or the radio/TV. Or tap a quick button below.";
  }

  // ---- Voice v1 (free, device voice) ----
  var voiceOn = false;
  var recog = null;
  function speak(text) {
    if (!voiceOn || !('speechSynthesis' in window)) return;
    try {
      window.speechSynthesis.cancel();
      var u = new SpeechSynthesisUtterance(text.replace(/https?:\/\/\S+/g, 'on the site'));
      u.rate = 1; u.pitch = 1;
      window.speechSynthesis.speak(u);
    } catch (e) { /* voice is best-effort */ }
  }
  function startListening(inputEl, onText) {
    var SR = window.SpeechRecognition || window.webkitSpeechRecognition;
    if (!SR) { onText(''); return 'unsupported'; }
    try {
      if (recog) { recog.stop(); recog = null; return 'stopped'; }
      recog = new SR();
      recog.lang = 'en-US'; recog.interimResults = false; recog.maxAlternatives = 1;
      recog.onresult = function (ev) { var t = ev.results[0][0].transcript; recog = null; onText(t); };
      recog.onerror = function () { recog = null; };
      recog.onend = function () { recog = null; };
      recog.start();
      return 'listening';
    } catch (e) { recog = null; return 'unsupported'; }
  }

  function linkify(text) {
    var e = esc(text);
    return e.replace(/https?:\/\/[^\s]+/g, function (u) { return '<a href="' + u + '" target="_blank" rel="noopener">' + u + '</a>'; });
  }

  function init() {
    // Diagnostics self-check: widget load state only (does NOT monitor the rest of the site).
    console.log('[Meechie-JARVIS] widget loaded, catalog items: ' + CATALOG.length);
    if (!CATALOG.length) console.warn('[Meechie-JARVIS] catalog empty — check jarvis-catalog.js loaded before jarvis-widget.js');

    var host = document.getElementById('mw-jarvis');
    if (!host) return;
    host.innerHTML =
      '<button class="mw-jarvis-fab" id="mw-jarvis-fab" aria-label="Open Meechie JARVIS chat" aria-expanded="false">' +
        '<span class="mw-jarvis-status-dot" title="JARVIS online"></span>' +
        '<span class="mw-jarvis-core" aria-hidden="true">M</span>' +
      '</button>' +
      '<div class="mw-jarvis-panel" id="mw-jarvis-panel" role="dialog" aria-label="Meechie JARVIS chat">' +
        '<div class="mw-jarvis-head"><span class="mw-jarvis-core" aria-hidden="true">M</span>' +
        '<div><div class="mw-jarvis-title">MEECHIE <span>JARVIS</span></div><div class="mw-jarvis-sub">Meechies World Inc — ask me anything on the site</div></div>' +
        '<span class="mw-jarvis-online">● JARVIS online</span>' +
        '<button class="mw-jarvis-close" id="mw-jarvis-close" aria-label="Close chat">✕</button></div>' +
        '<div class="mw-jarvis-log" id="mw-jarvis-log" aria-live="polite"></div>' +
        '<div class="mw-jarvis-chips" id="mw-jarvis-chips">' +
          '<button class="mw-jarvis-chip" data-q="What is MW Reverse Lookup?">Reverse Lookup $1.99</button>' +
          '<button class="mw-jarvis-chip" data-q="Show me the softstyle t-shirt price">Tee price</button>' +
          '<button class="mw-jarvis-chip" data-q="Tell me about the books">Books $10</button>' +
          '<button class="mw-jarvis-chip" data-q="Tell me about Doty">Doty\'s World</button>' +
          '<button class="mw-jarvis-chip" data-q="TikTok Shop">TikTok Shop</button>' +
        '</div>' +
        '<div class="mw-jarvis-input-row">' +
          '<input class="mw-jarvis-input" id="mw-jarvis-input" type="text" placeholder="Ask Meechie…" autocomplete="off" aria-label="Message Meechie JARVIS">' +
          '<button class="mw-jarvis-btn" id="mw-jarvis-mic" aria-pressed="false" title="Voice input (device voice)">🎙</button>' +
          '<button class="mw-jarvis-btn" id="mw-jarvis-voice" aria-pressed="false" title="Voice replies (device voice)">🔊</button>' +
          '<button class="mw-jarvis-btn" id="mw-jarvis-send">Send</button>' +
        '</div>' +
        '<div class="mw-jarvis-voice-note">Voice is your device voice (Web Speech) — not Meechie\'s neural voice yet (v2).</div>' +
      '</div>';

    var fab = document.getElementById('mw-jarvis-fab');
    var panel = document.getElementById('mw-jarvis-panel');
    var log = document.getElementById('mw-jarvis-log');
    var input = document.getElementById('mw-jarvis-input');
    var micBtn = document.getElementById('mw-jarvis-mic');
    var voiceBtn = document.getElementById('mw-jarvis-voice');

    function addMsg(text, who) {
      var d = document.createElement('div');
      d.className = 'mw-jarvis-msg mw-jarvis-' + who;
      d.innerHTML = linkify(text);
      log.appendChild(d);
      log.scrollTop = log.scrollHeight;
    }
    function respond(text) {
      addMsg(text, 'user');
      var reply = answer(text);
      addMsg(reply, 'bot');
      speak(reply);
    }
    function toggle(open) {
      var willOpen = (typeof open === 'boolean') ? open : !panel.classList.contains('mw-jarvis-open');
      panel.classList.toggle('mw-jarvis-open', willOpen);
      fab.setAttribute('aria-expanded', willOpen ? 'true' : 'false');
      if (willOpen) input.focus();
    }
    fab.addEventListener('click', function () { toggle(); });
    document.getElementById('mw-jarvis-close').addEventListener('click', function () { toggle(false); });
    document.getElementById('mw-jarvis-send').addEventListener('click', function () {
      var v = input.value.trim(); if (!v) return; input.value = ''; respond(v);
    });
    input.addEventListener('keydown', function (ev) {
      if (ev.key === 'Enter') { var v = input.value.trim(); if (!v) return; input.value = ''; respond(v); }
    });
    document.getElementById('mw-jarvis-chips').addEventListener('click', function (ev) {
      var b = ev.target.closest('[data-q]'); if (b) respond(b.getAttribute('data-q'));
    });
    voiceBtn.addEventListener('click', function () {
      voiceOn = !voiceOn;
      voiceBtn.setAttribute('aria-pressed', voiceOn ? 'true' : 'false');
      if (!voiceOn && 'speechSynthesis' in window) { try { window.speechSynthesis.cancel(); } catch (e) {} }
      if (voiceOn && !('speechSynthesis' in window)) addMsg('Voice replies need a browser with SpeechSynthesis — this one doesn\'t have it.', 'bot');
    });
    micBtn.addEventListener('click', function () {
      var r = startListening(input, function (t) { if (t) { input.value = t; respond(t); } });
      if (r === 'unsupported') addMsg('Voice input needs a browser with SpeechRecognition — this one doesn\'t have it. Type it instead.', 'bot');
      micBtn.setAttribute('aria-pressed', r === 'listening' ? 'true' : 'false');
    });

    addMsg("Yo, what up! It's Meechie — your JARVIS for Meechies World. Ask me about a product and I'll give you its exact price, or ask about the $1.99 lookup, books, Doty's World, or the TikTok Shop.", 'bot');
  }

  if (document.readyState === 'loading') document.addEventListener('DOMContentLoaded', init);
  else init();
})();
