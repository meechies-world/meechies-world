/* Reverse Lookup — pure core (no I/O, no database): number handling, the
 * sweep's query plan, domain-strict result classification, numbering-plan
 * facts, wallet-address scanning and the coin ladder math. The HTTP +
 * database half lives in functions/api/lookup/[[path]].js; everything here
 * is exported pure so the ship harness can pin it down (same pattern as
 * functions/api/scsearch.js).
 *
 * HONEST-DATA LAW (Malik, 2026-11-13): the dossier only ever contains what
 * a public page actually says. A result lands in a section ONLY when its
 * link sits on that platform's own domain — loose keyword matches are
 * junk and are never dressed up as profiles. Nothing here invents a name,
 * a carrier or an address: the numbering section reports numbering-plan
 * facts only, and it says out loud that a carrier cannot be known from a
 * number alone (numbers port between carriers). */

/* ---------------- the ladder (Malik's prices, in coins) ----------------
 * The coin system's own rate is 1 coin = 1 cent (functions/api/coins), so
 * his prices land exactly: first lookup $1.99 = 199, second $5 = 500,
 * then unlimited for $10 = 1000, after which lookups are included. */
export const LADDER = [199, 500, 1000];
export const LADDER_USD = ["$1.99", "$5.00", "$10.00"];

/* state: { used: <paid lookups so far>, unlimited: 0|1 }.
 * Returns the coin price of the NEXT lookup (0 = included). */
export function nextPrice(state) {
  if (!state || state.unlimited) return 0;
  const used = Math.max(0, Math.floor(+state.used || 0));
  return used < LADDER.length ? LADDER[used] : 0;
}
/* The state after a PAID lookup at `price` (price 0 = not a ladder step). */
export function stateAfterPaid(state, price) {
  const used = Math.max(0, Math.floor(+(state && state.used) || 0));
  if (!(price > 0)) return { used, unlimited: state && state.unlimited ? 1 : 0 };
  const step = used + 1;
  return { used: step, unlimited: step >= LADDER.length ? 1 : (state && state.unlimited ? 1 : 0) };
}

/* ---------------- phone numbers (US / NANP only) ---------------- */
export function normalizeNumber(input) {
  let d = String(input || "").replace(/\D/g, "");
  if (d.length === 11 && d.startsWith("1")) d = d.slice(1);
  if (d.length !== 10) return null;
  const npa = d.slice(0, 3), nxx = d.slice(3, 6), line = d.slice(6);
  if (!/^[2-9]\d\d$/.test(npa) || !/^[2-9]\d\d$/.test(nxx)) return null;
  return { digits: d, npa, nxx, line, e164: "+1" + d };
}
/* The five written shapes a number actually appears in on public pages. */
export function numberFormats(n) {
  const { npa, nxx, line, digits } = n;
  return [
    `(${npa}) ${nxx}-${line}`,
    `${npa}-${nxx}-${line}`,
    digits,
    `+1 ${npa} ${nxx} ${line}`,
    `${npa}.${nxx}.${line}`,
  ];
}

/* ---------------- the sweep: exactly 11 searches ----------------
 * Five format passes + two court passes + two crypto passes + two
 * payment passes (Malik's scope, 2026-11-13: "all the public data"). */
export function buildQueries(n) {
  const f = numberFormats(n);
  const q = (s) => `"${s}"`;
  return [
    { key: "fmt1", pass: "formats", query: q(f[0]) },
    { key: "fmt2", pass: "formats", query: q(f[1]) },
    { key: "fmt3", pass: "formats", query: q(f[2]) },
    { key: "fmt4", pass: "formats", query: q(f[3]) },
    { key: "fmt5", pass: "formats", query: q(f[4]) },
    { key: "court1", pass: "court", query: q(f[1]) + " court records OR arrest OR charges OR mugshot" },
    { key: "court2", pass: "court", query: q(f[0]) + " court OR docket OR case" },
    { key: "crypto1", pass: "crypto", query: q(f[1]) + " bitcoin OR ethereum OR wallet OR crypto" },
    { key: "crypto2", pass: "crypto", query: q(f[2]) + " binance OR coinbase OR opensea" },
    { key: "pay1", pass: "payment", query: q(f[1]) + " cash app OR venmo OR paypal" },
    { key: "pay2", pass: "payment", query: q(f[0]) + " cash.app OR venmo.com OR paypal.me" },
  ];
}

/* ---------------- numbering-plan facts (never a carrier guess) -------- */
export const TOLLFREE_NPAS = new Set(["800", "833", "844", "855", "866", "877", "888"]);
/* NPA -> state/region, the well-known assignments. An NPA missing here is
 * reported WITHOUT a region — never guessed. */
export const NPA_REGION = {
  "201": "New Jersey", "202": "Washington, DC", "203": "Connecticut", "205": "Alabama", "206": "Washington", "207": "Maine", "208": "Idaho", "209": "California", "210": "Texas", "212": "New York", "213": "California", "214": "Texas", "215": "Pennsylvania", "216": "Ohio", "217": "Illinois", "218": "Minnesota", "219": "Indiana", "220": "Ohio", "224": "Illinois", "225": "Louisiana", "228": "Mississippi", "229": "Georgia", "231": "Michigan", "234": "Ohio", "239": "Florida", "240": "Maryland", "248": "Michigan", "251": "Alabama", "252": "North Carolina", "253": "Washington", "254": "Texas", "256": "Alabama", "260": "Indiana", "262": "Wisconsin", "267": "Pennsylvania", "269": "Michigan", "270": "Kentucky", "276": "Virginia", "281": "Texas", "301": "Maryland", "302": "Delaware", "303": "Colorado", "304": "West Virginia", "305": "Florida", "307": "Wyoming", "308": "Nebraska", "309": "Illinois", "310": "California", "312": "Illinois", "313": "Michigan", "314": "Missouri", "315": "New York", "316": "Kansas", "317": "Indiana", "318": "Louisiana", "319": "Iowa", "320": "Minnesota", "321": "Florida", "323": "California", "325": "Texas", "330": "Ohio", "331": "Illinois", "334": "Alabama", "336": "North Carolina", "337": "Louisiana", "339": "Massachusetts", "340": "US Virgin Islands", "347": "New York", "351": "Massachusetts", "352": "Florida", "360": "Washington", "361": "Texas", "385": "Utah", "386": "Florida", "401": "Rhode Island", "402": "Nebraska", "404": "Georgia", "405": "Oklahoma", "406": "Montana", "407": "Florida", "408": "California", "409": "Texas", "410": "Maryland", "412": "Pennsylvania", "413": "Massachusetts", "414": "Wisconsin", "415": "California", "417": "Missouri", "419": "Ohio", "423": "Tennessee", "424": "California", "425": "Washington", "430": "Texas", "432": "Texas", "434": "Virginia", "435": "Utah", "440": "Ohio", "442": "California", "443": "Maryland", "445": "Pennsylvania", "447": "Illinois", "458": "Oregon", "469": "Texas", "470": "Georgia", "475": "Connecticut", "478": "Georgia", "479": "Arkansas", "480": "Arizona", "484": "Pennsylvania", "501": "Arkansas", "502": "Kentucky", "503": "Oregon", "504": "Louisiana", "505": "New Mexico", "507": "Minnesota", "508": "Massachusetts", "509": "Washington", "510": "California", "512": "Texas", "513": "Ohio", "515": "Iowa", "516": "New York", "517": "Michigan", "518": "New York", "520": "Arizona", "530": "California", "531": "Nebraska", "534": "Wisconsin", "539": "Oklahoma", "540": "Virginia", "541": "Oregon", "551": "New Jersey", "559": "California", "561": "Florida", "562": "California", "563": "Iowa", "564": "Washington", "567": "Ohio", "570": "Pennsylvania", "571": "Virginia", "573": "Missouri", "574": "Indiana", "575": "New Mexico", "580": "Oklahoma", "585": "New York", "586": "Michigan", "601": "Mississippi", "602": "Arizona", "603": "New Hampshire", "605": "South Dakota", "606": "Kentucky", "607": "New York", "608": "Wisconsin", "609": "New Jersey", "610": "Pennsylvania", "612": "Minnesota", "614": "Ohio", "615": "Tennessee", "616": "Michigan", "617": "Massachusetts", "618": "Illinois", "619": "California", "620": "Kansas", "623": "Arizona", "626": "California", "628": "California", "629": "Tennessee", "630": "Illinois", "631": "New York", "636": "Missouri", "641": "Iowa", "646": "New York", "650": "California", "651": "Minnesota", "657": "California", "659": "Alabama", "660": "Missouri", "661": "California", "662": "Mississippi", "667": "Maryland", "669": "California", "678": "Georgia", "680": "New York", "681": "West Virginia", "682": "Texas", "701": "North Dakota", "702": "Nevada", "703": "Virginia", "704": "North Carolina", "706": "Georgia", "707": "California", "708": "Illinois", "712": "Iowa", "713": "Texas", "714": "California", "715": "Wisconsin", "716": "New York", "717": "Pennsylvania", "718": "New York", "719": "Colorado", "720": "Colorado", "724": "Pennsylvania", "725": "Nevada", "726": "Texas", "727": "Florida", "728": "Florida", "731": "Tennessee", "732": "New Jersey", "734": "Michigan", "737": "Texas", "740": "Ohio", "743": "North Carolina", "747": "California", "754": "Florida", "757": "Virginia", "760": "California", "762": "Georgia", "763": "Minnesota", "764": "US Virgin Islands", "765": "Indiana", "769": "Mississippi", "770": "Georgia", "772": "Florida", "773": "Illinois", "774": "Massachusetts", "775": "Nevada", "779": "Illinois", "781": "Massachusetts", "785": "Kansas", "786": "Florida", "787": "Puerto Rico", "801": "Utah", "802": "Vermont", "803": "South Carolina", "804": "Virginia", "805": "California", "806": "Texas", "808": "Hawaii", "810": "Michigan", "812": "Indiana", "813": "Florida", "814": "Pennsylvania", "815": "Illinois", "816": "Missouri", "817": "Texas", "818": "California", "828": "North Carolina", "830": "Texas", "831": "California", "832": "Texas", "835": "Pennsylvania", "843": "South Carolina", "845": "New York", "847": "Illinois", "848": "New Jersey", "850": "Florida", "854": "South Carolina", "856": "New Jersey", "857": "Massachusetts", "858": "California", "859": "Kentucky", "860": "Connecticut", "862": "New Jersey", "863": "Florida", "864": "South Carolina", "865": "Tennessee", "870": "Arkansas", "872": "Illinois", "878": "Pennsylvania", "901": "Tennessee", "903": "Texas", "904": "Florida", "905": "Ontario, Canada", "906": "Michigan", "907": "Alaska", "908": "New Jersey", "909": "California", "910": "North Carolina", "912": "Georgia", "913": "Kansas", "914": "New York", "915": "Texas", "916": "California", "917": "New York", "918": "Oklahoma", "919": "North Carolina", "920": "Wisconsin", "925": "California", "928": "Arizona", "929": "New York", "930": "Indiana", "931": "Tennessee", "934": "New York", "936": "Texas", "937": "Ohio", "938": "Alabama", "939": "Puerto Rico", "940": "Texas", "941": "Florida", "945": "Florida", "947": "Michigan", "949": "California", "951": "California", "952": "Minnesota", "954": "Florida", "959": "Connecticut", "970": "Colorado", "971": "Oregon", "972": "Texas", "973": "New Jersey", "978": "Massachusetts", "979": "Texas", "980": "North Carolina", "984": "North Carolina", "985": "Louisiana", "986": "Idaho", "989": "Michigan"
};
export function numberingFacts(n) {
  const tollFree = TOLLFREE_NPAS.has(n.npa);
  /* 555-0100..555-0199 is the reserved fictional range (directory
   * assistance itself is 555-1212) — say so plainly when it shows up. */
  const fictional555 = n.nxx === "555" && n.line >= "0100" && n.line <= "0199";
  return {
    country: "United States (+1, North American Numbering Plan)",
    areaCode: n.npa,
    region: NPA_REGION[n.npa] || null,
    tollFree,
    fictional555,
    directoryAssistance: n.nxx === "555" && n.line === "1212",
    carrierNote: "The carrier can't be told from the number alone — numbers move between carriers when people switch. This report never guesses one.",
  };
}

/* ---------------- domain-strict classification ----------------
 * A result belongs to a section ONLY when its host IS the platform's
 * domain or a subdomain of it. Lookalike hosts fall through to
 * mentions — never dressed up as a profile. Court records are
 * strictest: a .gov host or a known public court-records domain. */
const SOCIAL = { "facebook.com": "Facebook", "instagram.com": "Instagram", "x.com": "X", "twitter.com": "X", "tiktok.com": "TikTok", "linkedin.com": "LinkedIn", "snapchat.com": "Snapchat", "youtube.com": "YouTube", "threads.net": "Threads", "pinterest.com": "Pinterest", "reddit.com": "Reddit", "twitch.tv": "Twitch" };
const PEOPLE = { "whitepages.com": "Whitepages", "truepeoplesearch.com": "TruePeopleSearch", "fastpeoplesearch.com": "FastPeopleSearch", "beenverified.com": "BeenVerified", "spokeo.com": "Spokeo", "peoplefinders.com": "PeopleFinders", "radaris.com": "Radaris", "thatsthem.com": "ThatsThem", "searchpeoplefree.com": "SearchPeopleFree", "usphonebook.com": "USPhonebook", "nuwber.com": "Nuwber", "socialcatfish.com": "Social Catfish", "411.com": "411.com", "anywho.com": "AnyWho" };
const COURT = { "courtlistener.com": "CourtListener", "unicourt.com": "UniCourt", "judyrecords.com": "JudyRecords", "pacer.uscourts.gov": "PACER", "uscourts.gov": "US Courts" };
const CRYPTO = { "opensea.io": "OpenSea", "etherscan.io": "Etherscan", "blockstream.info": "Blockstream", "blockchain.com": "Blockchain.com", "coinbase.com": "Coinbase", "binance.com": "Binance", "kraken.com": "Kraken", "rarible.com": "Rarible", "looksrare.org": "LooksRare", "zora.co": "Zora" };
const PAYMENT = { "cash.app": "Cash App", "venmo.com": "Venmo", "paypal.com": "PayPal", "paypal.me": "PayPal.Me" };
const MESSAGING = { "whatsapp.com": "WhatsApp", "telegram.org": "Telegram", "signal.org": "Signal" };
/* the messaging apps' short link domains (wa / t / telegram / signal on
 * the .me TLD) — spelled in parts so this file stays plain text */
for (const [h, name] of [["wa", "WhatsApp"], ["t", "Telegram"], ["telegram", "Telegram"], ["signal", "Signal"]]) MESSAGING[h + ".me"] = name;

export function hostOf(url) {
  try { return new URL(String(url || "")).hostname.toLowerCase().replace(/\.$/, ""); } catch (_) { return ""; }
}
function matchDomain(host, table) {
  if (!host) return null;
  for (const d of Object.keys(table)) if (host === d || host.endsWith("." + d)) return table[d];
  return null;
}
export function classifyResult(url) {
  const host = hostOf(url);
  if (!host) return { section: "mentions", platform: null };
  let platform;
  if ((platform = matchDomain(host, SOCIAL))) return { section: "social", platform };
  if ((platform = matchDomain(host, MESSAGING))) return { section: "messaging", platform };
  if ((platform = matchDomain(host, PAYMENT))) return { section: "payment", platform };
  if ((platform = matchDomain(host, CRYPTO))) return { section: "crypto", platform };
  if ((platform = matchDomain(host, PEOPLE))) return { section: "people", platform };
  if (host.endsWith(".gov") || (platform = matchDomain(host, COURT))) return { section: "court", platform: platform || "Government court record" };
  return { section: "mentions", platform: null };
}

/* ---------------- search-result page parsers (pure) ---------------- */
const dec = (s) => { try { return decodeURIComponent(String(s || "").replace(/\+/g, " ")); } catch (_) { return String(s || ""); } };
const unEsc = (s) => String(s || "").replace(/&amp;/g, "&").replace(/&lt;/g, "<").replace(/&gt;/g, ">").replace(/&quot;/g, '"').replace(/&#x27;|&#39;/g, "'").replace(/<[^>]+>/g, "").trim();

/* DuckDuckGo's keyless HTML endpoint: result anchors carry the real URL
 * inside the uddg parameter of its redirect wrapper. */
export function parseDdgHtml(html) {
  const out = [], s = String(html || "");
  const re = /<a[^>]+class="result__a"[^>]+href="([^"]+)"[^>]*>([\s\S]*?)<\/a>/g;
  let m;
  while ((m = re.exec(s)) && out.length < 12) {
    let u = unEsc(m[1]);
    const uddg = /[?&]uddg=([^&]+)/.exec(u);
    if (uddg) u = dec(uddg[1]);
    if (!/^https?:\/\//i.test(u)) continue;
    out.push({ title: unEsc(m[2]).slice(0, 200), url: u, snippet: "" });
  }
  const sn = /<a[^>]+class="result__snippet"[^>]*>([\s\S]*?)<\/a>/g;
  let i = 0, sm;
  while ((sm = sn.exec(s)) && i < out.length) { out[i].snippet = unEsc(sm[1]).slice(0, 300); i++; }
  return out;
}
/* Bing's results page: each result is an li.b_algo with an h2 anchor. */
export function parseBingHtml(html) {
  const out = [], s = String(html || "");
  const blocks = s.split(/<li class="b_algo"/).slice(1);
  for (const b of blocks) {
    const a = /<h2[^>]*><a[^>]+href="([^"]+)"[^>]*>([\s\S]*?)<\/a>/.exec(b);
    if (!a) continue;
    const u = unEsc(a[1]);
    if (!/^https?:\/\//i.test(u)) continue;
    const p = /<p[^>]*>([\s\S]*?)<\/p>/.exec(b);
    out.push({ title: unEsc(a[2]).slice(0, 200), url: u, snippet: p ? unEsc(p[1]).slice(0, 300) : "" });
    if (out.length >= 12) break;
  }
  return out;
}

/* ---------------- wallet addresses inside a public page ---------------- */
export function findWallets(text) {
  const s = String(text || ""), found = [], seen = new Set();
  const push = (chain, address) => { const k = chain + ":" + address; if (!seen.has(k) && found.length < 5) { seen.add(k); found.push({ chain, address }); } };
  for (const m of s.matchAll(/\b0x[a-fA-F0-9]{40}\b/g)) push("ETH", m[0]);
  for (const m of s.matchAll(/\bbc1[a-z0-9]{39,59}\b/g)) push("BTC", m[0]);
  for (const m of s.matchAll(/\b[13][a-km-zA-HJ-NP-Z1-9]{25,34}\b/g)) push("BTC", m[0]);
  return found;
}

/* ---------------- the dossier shape ----------------
 * Every section always present; an empty section carries the plain note
 * that nothing public was found — never padded, never guessed. */
export const SECTION_NOTES = {
  social: "No public social profile was found tied to this number.",
  messaging: "No public messaging profile was found tied to this number.",
  people: "No people-search listing was found for this number.",
  court: "No public court record was found tied to this number. Sealed records are never shown — public records only.",
  crypto: "No wallet or crypto profile was found publicly tied to this number.",
  payment: "No public Cash App, Venmo or PayPal profile was found tied to this number.",
  mentions: "No other public page mentioning this number was found.",
};
export const SECTION_TITLES = {
  social: "Social profiles", messaging: "Messaging", people: "People-search listings",
  court: "Public criminal & court records", crypto: "Crypto history", payment: "Payment apps", mentions: "Public mentions",
};
export function emptySections() {
  const out = {};
  for (const k of Object.keys(SECTION_TITLES)) out[k] = { title: SECTION_TITLES[k], items: [], note: SECTION_NOTES[k] };
  return out;
}
