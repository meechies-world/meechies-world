/* Gold graphics pack (Oct 2026, owner asked for "10 times better" graphics)
 * 1. Gold line icons: swaps the cartoon emoji in the site's menus, tabs and buttons
 *    for matching gold-foil SVG icons. It only touches site menus, never what members write.
 * 2. Gold medallion icon beside every section title.
 * 3. Soft drifting gold dust in the background (stops when the tab is hidden, and
 *    turns off for people who ask their phone for less motion).
 * Nothing here covers the screen or takes taps: the dust canvas ignores the pointer.
 */
(function () {
  if (window.MW_GOLD_ICONS) return; window.MW_GOLD_ICONS = true;
  const D = document, H = D.documentElement;

  // 24×24 line icons (stroke paths). "f:" marks a filled shape.
  const P = {
    home: "M3 10.5 12 3l9 7.5M5 9v12h5v-6h4v6h5V9",
    users: "M9 11.5a3.5 3.5 0 1 0 0-7 3.5 3.5 0 0 0 0 7zM2.5 20c0-3.6 2.9-6 6.5-6s6.5 2.4 6.5 6M16.5 11a2.6 2.6 0 1 0 0-5.2M17 14.2c2.6.4 4.5 2.4 4.5 5.8",
    tv: "M4 5h16a2 2 0 0 1 2 2v9a2 2 0 0 1-2 2H4a2 2 0 0 1-2-2V7a2 2 0 0 1 2-2zM8 21h8M12 18v3M10 8.8l5 2.7-5 2.7z",
    bag: "M5 8h14l-1.2 13H6.2zM9 10V6.5a3 3 0 0 1 6 0V10",
    bell: "M6 16v-5a6 6 0 0 1 12 0v5l2 2H4zM10 20.5a2 2 0 0 0 4 0",
    menu: "M4 6.5h16M4 12h16M4 17.5h16",
    vcam: "M4 7h9a2 2 0 0 1 2 2v6a2 2 0 0 1-2 2H4a2 2 0 0 1-2-2V9a2 2 0 0 1 2-2zM15 10.5 22 7v10l-7-3.5",
    image: "M5 4h14a2 2 0 0 1 2 2v12a2 2 0 0 1-2 2H5a2 2 0 0 1-2-2V6a2 2 0 0 1 2-2zM8.5 11.3a1.8 1.8 0 1 0 0-3.6 1.8 1.8 0 0 0 0 3.6zM21 16l-5-5-9.5 9",
    smile: "M12 21a9 9 0 1 0 0-18 9 9 0 0 0 0 18zM8.3 14.3a4.6 4.6 0 0 0 7.4 0M9 9.5h.01M15 9.5h.01",
    search: "M11 18a7 7 0 1 0 0-14 7 7 0 0 0 0 14zM20.5 20.5 16 16",
    chat: "M5 4h14a2 2 0 0 1 2 2v9a2 2 0 0 1-2 2H10l-5 4v-4a2 2 0 0 1-2-2V6a2 2 0 0 1 2-2zM8 10.5h.01M12 10.5h.01M16 10.5h.01",
    user: "M12 12a4 4 0 1 0 0-8 4 4 0 0 0 0 8zM4 21c0-4.4 3.6-7 8-7s8 2.6 8 7",
    heart: "M12 20s-8-5-8-11a4.5 4.5 0 0 1 8-2.8A4.5 4.5 0 0 1 20 9c0 6-8 11-8 11z",
    plus: "M12 5v14M5 12h14",
    scale: "M12 3v17M7 21h10M4 7h16M6.5 7 3.5 14a3 3 0 0 0 6 0zM17.5 7l-3 7a3 3 0 0 0 6 0zM12 3.5h.01",
    camera: "M3 8.5h4l2-3h6l2 3h4V20H3zM12 17.3a3.8 3.8 0 1 0 0-7.6 3.8 3.8 0 0 0 0 7.6z",
    gift: "M3 9h18v4H3zM5 13v8h14v-8M12 9v12M12 9C10 5 6 5 6 7.5S9 9 12 9zm0 0c2-4 6-4 6-1.5S15 9 12 9z",
    crown: "M3 18h18l-1.6-10-4.6 4.2L12 5.5l-2.8 6.7L4.6 8zM4 21h16",
    mic: "M12 3a3 3 0 0 1 3 3v5a3 3 0 0 1-6 0V6a3 3 0 0 1 3-3zM5.5 11a6.5 6.5 0 0 0 13 0M12 17.5V21M9 21h6",
    radio: "M5 8h14a2 2 0 0 1 2 2v9a2 2 0 0 1-2 2H5a2 2 0 0 1-2-2v-9a2 2 0 0 1 2-2zM7 8l10-5M15.5 17.5a3 3 0 1 0 0-6 3 3 0 0 0 0 6zM6.5 12.5h4M6.5 16h4",
    cart: "M2.5 4h2.3l2.4 11h11.3l2-8H6M9 20.5a1.3 1.3 0 1 0 0-.01M17.5 20.5a1.3 1.3 0 1 0 0-.01",
    case: "M5 7h14a2 2 0 0 1 2 2v9a2 2 0 0 1-2 2H5a2 2 0 0 1-2-2V9a2 2 0 0 1 2-2zM9 7V5h6v2M3 12.5h18M11 12.5h2v2h-2z",
    phone: "M5 3h3.5l2 5-2.5 1.6a11 11 0 0 0 6.4 6.4L16 13.5l5 2V19a2 2 0 0 1-2 2A17 17 0 0 1 3 5a2 2 0 0 1 2-2z",
    mail: "M5 5h14a2 2 0 0 1 2 2v10a2 2 0 0 1-2 2H5a2 2 0 0 1-2-2V7a2 2 0 0 1 2-2zM3.5 7l8.5 6 8.5-6",
    music: "M9 18V5.5L20 3.5V16M6 21a3 3 0 1 0 0-6 3 3 0 0 0 0 6zM17 19a3 3 0 1 0 0-6 3 3 0 0 0 0 6z",
    book: "M12 6.5C10 5 7 4.5 3 4.5v14c4 0 7 .5 9 2 2-1.5 5-2 9-2v-14c-4 0-7 .5-9 2zM12 6.5v14",
    star: "M12 3l2.7 5.6 6.1.9-4.4 4.3 1 6.1L12 17l-5.4 2.9 1-6.1-4.4-4.3 6.1-.9z",
    globe: "M12 21a9 9 0 1 0 0-18 9 9 0 0 0 0 18zM3 12h18M12 3c2.5 2.6 3.8 5.6 3.8 9S14.5 18.4 12 21M12 3C9.5 5.6 8.2 8.6 8.2 12s1.3 6.4 3.8 9",
    live: "f:M12 17a5 5 0 1 0 0-10 5 5 0 0 0 0 10z|M5.6 5.6a9 9 0 0 0 0 12.8M18.4 5.6a9 9 0 0 1 0 12.8",
    sparkle: "M12 3l1.9 5.1L19 10l-5.1 1.9L12 17l-1.9-5.1L5 10l5.1-1.9zM19 15l.8 2.2L22 18l-2.2.8L19 21l-.8-2.2L16 18l2.2-.8z",
    shirt: "M8.5 3.5 3 6.5l2 4 2-1V21h10V9.5l2 1 2-4-5.5-3a3.5 3.5 0 0 1-7 0z",
    cal: "M5 5h14a2 2 0 0 1 2 2v12a2 2 0 0 1-2 2H5a2 2 0 0 1-2-2V7a2 2 0 0 1 2-2zM3 10h18M8 3v4M16 3v4",
    gear: "M12 15a3 3 0 1 0 0-6 3 3 0 0 0 0 6zM12 2.5v3M12 18.5v3M2.5 12h3M18.5 12h3M5.3 5.3l2.1 2.1M16.6 16.6l2.1 2.1M5.3 18.7l2.1-2.1M16.6 7.4l2.1-2.1",
    lock: "M6 11h12a1 1 0 0 1 1 1v8a1 1 0 0 1-1 1H6a1 1 0 0 1-1-1v-8a1 1 0 0 1 1-1zM8 11V7.5a4 4 0 0 1 8 0V11M12 15v2.5",
    money: "M3 6h18a1 1 0 0 1 1 1v10a1 1 0 0 1-1 1H3a1 1 0 0 1-1-1V7a1 1 0 0 1 1-1zM12 15a3 3 0 1 0 0-6 3 3 0 0 0 0 6zM5.5 9.5v5M18.5 9.5v5",
    coin: "M12 21a9 9 0 1 0 0-18 9 9 0 0 0 0 18zM12 17a5 5 0 1 0 0-10 5 5 0 0 0 0 10zM12 9.5v5",
    pin: "M12 21s-7-6.2-7-12a7 7 0 0 1 14 0c0 5.8-7 12-7 12zM12 11.5a2.5 2.5 0 1 0 0-5 2.5 2.5 0 0 0 0 5z",
    clap: "M3 10h18v10a1 1 0 0 1-1 1H4a1 1 0 0 1-1-1zM3 10l1.6-5.4 15.8-1.5L21 6 3 10M8 4.4l1.5 4.4M14 3.8l1.5 4.4",
    trophy: "M7 4h10v5a5 5 0 0 1-10 0zM7 6H4a3 3 0 0 0 3.5 4M17 6h3a3 3 0 0 1-3.5 4M12 14v4M8 21h8M9.5 18h5",
    swords: "M14.5 17.5 3 6V3h3l11.5 11.5M13 19l6-6M16 16l4 4M19 21l2-2M9.5 17.5 21 6V3h-3L6.5 14.5M11 19l-6-6M8 16l-4 4M5 21l-2-2",
    game: "M7 8h10a5 5 0 0 1 0 10c-1.5 0-2.3-.8-3-2h-4c-.7 1.2-1.5 2-3 2A5 5 0 0 1 7 8zM8 11v4M6 13h4M15.5 12.5h.01M17.5 14.5h.01",
    palette: "M12 3a9 9 0 0 0 0 18c1.4 0 2-1 2-2s-1-1.6-1-2.5S13.8 15 15 15h2a4 4 0 0 0 4-4c0-4.4-4-8-9-8zM7.5 11.5h.01M10 7.5h.01M15 7.5h.01",
    chart: "M3 3v18h18M7 15l4-4 3 3 6-7",
    megaphone: "M3 10v4a1 1 0 0 0 1 1h3l7 5V4L7 9H4a1 1 0 0 0-1 1zM18 8.5a5 5 0 0 1 0 7M7 15l1.5 5h3L10 15.5",
    board: "M4 4h16v13H4zM12 17v4M8 21h8M8 8h8M8 11.5h5",
    sliders: "M5 3v6M5 13v8M12 3v10M12 17v4M19 3v4M19 11v10M3 11h4M10 15h4M17 9h4",
    cross: "M10 3h4v6h5v4h-5v8h-4v-8H5V9h5z",
    handshake: "M3 8l4-3 5 2 5-2 4 3v6l-4 3-2.5-1.5M3 8v6l5 4.5a1.6 1.6 0 0 0 2.3-2.2M9 9.5l3-1.5 4.5 4.5a1.5 1.5 0 0 1-2 2.2L11 11.5M10.3 16.3l1.8 1.6a1.5 1.5 0 0 0 2-2.2",
    tools: "M14.5 6.5a4 4 0 0 0 5 5L11 20a2.1 2.1 0 0 1-3-3l8.5-8.5M14.5 6.5l3-3 3 3-3 3M4 4l5 5M3 7l4-4",
    bot: "M6 8h12a2 2 0 0 1 2 2v8a2 2 0 0 1-2 2H6a2 2 0 0 1-2-2v-8a2 2 0 0 1 2-2zM12 4v4M12 3.5h.01M9 13h.01M15 13h.01M9.5 16.5h5",
    satellite: "M4 10a9 9 0 0 1 10 10M4 14.5A4.5 4.5 0 0 1 9.5 20M5 19.5h.01M13 4l7 7M15.5 2.5l6 6-3 3-6-6z",
    flame: "M12 21c-4 0-7-2.8-7-6.5 0-3.7 3-5.5 3.5-9C11 7 12 9 12 11c1.2-1 1.8-2.6 1.6-4.5C17.2 8.5 19 11.3 19 14.5 19 18.2 16 21 12 21z",
    diamond: "M6 3h12l4 6-10 12L2 9zM2 9h20M9 3l3 18M15 3l-3 18",
    eye: "M2 12s3.5-7 10-7 10 7 10 7-3.5 7-10 7S2 12 2 12zM12 15a3 3 0 1 0 0-6 3 3 0 0 0 0 6z",
    link: "M10 14a4.5 4.5 0 0 0 6.4 0l3.2-3.2a4.5 4.5 0 0 0-6.4-6.4L12 5.6M14 10a4.5 4.5 0 0 0-6.4 0l-3.2 3.2a4.5 4.5 0 0 0 6.4 6.4l1.2-1.2",
    adult: "M12 21a9 9 0 1 0 0-18 9 9 0 0 0 0 18zM7.5 9.5l1.5-1v7M13.5 12a1.75 1.75 0 1 1 0-3.5 1.75 1.75 0 0 1 0 3.5zm0 0a1.9 1.9 0 1 1 0 3.8 1.9 1.9 0 0 1 0-3.8z",
    crystal: "M12 17a7 7 0 1 0 0-14 7 7 0 0 0 0 14zM6 21h12M8 17.5 7 21M16 17.5l1 4M10 7.5a3 3 0 0 1 3-1.5",
    pinned: "M9 3h6l-1 6 4 3v2H6v-2l4-3zM12 14v7",
    save: "M5 3h11l3 3v13a2 2 0 0 1-2 2H5a2 2 0 0 1-2-2V5a2 2 0 0 1 2-2zM7 3v5h8V3M7 21v-7h10v7",
    folder: "M3 6a2 2 0 0 1 2-2h4l2 2.5h8a2 2 0 0 1 2 2V18a2 2 0 0 1-2 2H5a2 2 0 0 1-2-2z",
    pen: "M4 20l4.5-1 10-10a2.1 2.1 0 0 0-3-3l-10 10zM14 7.5l3 3M4 20h16",
    check: "M12 21a9 9 0 1 0 0-18 9 9 0 0 0 0 18zM8 12.3l2.8 2.8L16.5 9.5",
    doc: "M6 3h8l5 5v11a2 2 0 0 1-2 2H6a2 2 0 0 1-2-2V5a2 2 0 0 1 2-2zM14 3v5h5M8 13h8M8 17h6",
    print: "M7 9V3h10v6M7 17H5a2 2 0 0 1-2-2v-4a2 2 0 0 1 2-2h14a2 2 0 0 1 2 2v4a2 2 0 0 1-2 2h-2M7 14h10v7H7z",
    clip: "M9 4h6v3H9zM9 5.5H6a1 1 0 0 0-1 1V20a1 1 0 0 0 1 1h12a1 1 0 0 0 1-1V6.5a1 1 0 0 0-1-1h-3M8.5 12h7M8.5 16h5",
    repeat: "M4 11V9a3 3 0 0 1 3-3h12l-3-3M20 13v2a3 3 0 0 1-3 3H5l3 3",
    send: "M21 3 3 10.5l7 2.5 2.5 7zM10 13l5-5",
    card: "M4 5h16a2 2 0 0 1 2 2v10a2 2 0 0 1-2 2H4a2 2 0 0 1-2-2V7a2 2 0 0 1 2-2zM2 10h20M6 15h4",
    trash: "M4 7h16M10 11v6M14 11v6M6 7l1 13h10l1-13M9 7V4h6v3",
    upload: "M12 16V4M7 9l5-5 5 5M4 16v3a2 2 0 0 0 2 2h12a2 2 0 0 0 2-2v-3",
    download: "M12 4v12M7 11l5 5 5-5M4 16v3a2 2 0 0 0 2 2h12a2 2 0 0 0 2-2v-3",
    share: "M18 8a3 3 0 1 0 0-6 3 3 0 0 0 0 6zM6 15a3 3 0 1 0 0-6 3 3 0 0 0 0 6zM18 22a3 3 0 1 0 0-6 3 3 0 0 0 0 6zM8.6 13.5l6.8 4M15.4 6.5l-6.8 4",
    thumb: "M7 11v10H4V11zM7 11l4-8c1.7 0 2.8 1.3 2.4 3l-.7 3H19a2 2 0 0 1 2 2.3l-1.2 7A2 2 0 0 1 17.8 21H7",
    play: "f:M8 5v14l11-7z",
    speaker: "M4 9h4l5-4v14l-5-4H4zM16.5 8.5a5 5 0 0 1 0 7M19 6a8.5 8.5 0 0 1 0 12",
    bulb: "M9 18h6M10 21h4M12 3a6 6 0 0 0-3.5 10.9c.8.6 1.5 1.5 1.5 2.6V17h4v-.5c0-1.1.7-2 1.5-2.6A6 6 0 0 0 12 3z",
    rocket: "M5 15c-1.5 1.5-2 5-2 5s3.5-.5 5-2M9 15l-3-3c1.5-5 5.5-9 12-9 0 6.5-4 10.5-9 12zM14.5 9.5a1.5 1.5 0 1 0 0-.01",
  };
  // emoji → icon (only in the site's own menus/buttons)
  const E = {
    "🏠": "home", "🏡": "home", "👥": "users", "🫂": "users", "📺": "tv", "🛍️": "bag", "🛍": "bag", "🔔": "bell", "☰": "menu",
    "🎥": "vcam", "📹": "vcam", "🖼️": "image", "🖼": "image", "😊": "smile", "🙂": "smile", "🔍": "search", "🔎": "search",
    "💬": "chat", "🗨️": "chat", "👤": "user", "❤️": "heart", "❤": "heart", "♥️": "heart", "➕": "plus", "⚖️": "scale", "⚖": "scale",
    "📷": "camera", "📸": "camera", "🎁": "gift", "👑": "crown", "🎤": "mic", "🎙️": "mic", "🎙": "mic", "📻": "radio", "🛒": "cart",
    "💼": "case", "📞": "phone", "☎️": "phone", "📱": "phone", "✉️": "mail", "✉": "mail", "📧": "mail", "📩": "mail", "🎵": "music", "🎶": "music", "🎧": "music",
    "📚": "book", "📖": "book", "📕": "book", "⭐": "star", "🌟": "star", "🌐": "globe", "🌍": "globe", "🌎": "globe", "🔴": "live",
    "✨": "sparkle", "👕": "shirt", "📅": "cal", "🗓️": "cal", "⚙️": "gear", "⚙": "gear", "🔒": "lock", "🔐": "lock", "💵": "money", "💰": "money", "💲": "money",
    "🪙": "coin", "📍": "pin", "📌": "pinned", "🎬": "clap", "🏆": "trophy", "⚔️": "swords", "⚔": "swords", "🎮": "game", "🎨": "palette",
    "📈": "chart", "📊": "chart", "📣": "megaphone", "📢": "megaphone", "🧰": "tools", "🛠️": "tools", "🛠": "tools", "🔧": "tools", "🤖": "bot",
    "📡": "satellite", "🔥": "flame", "💎": "diamond", "👁️": "eye", "🔗": "link", "🔞": "adult", "🔮": "crystal", "🤝": "handshake",
    "✝️": "cross", "💾": "save", "📂": "folder", "📁": "folder", "✍️": "pen", "✏️": "pen", "📝": "pen", "✅": "check", "☑️": "check", "🧐": "search", "📄": "doc", "📃": "doc",
    "🖨️": "print", "🖨": "print", "📋": "clip", "🔁": "repeat", "🔄": "repeat", "📨": "send", "📤": "upload", "⬆️": "upload", "📥": "download", "⬇️": "download", "💳": "card",
    "🗑️": "trash", "🗑": "trash", "👍": "thumb", "♥": "heart", "↗": "share", "🔊": "speaker", "💡": "bulb", "🚀": "rocket", "▶️": "play", "🎚️": "sliders", "🎚": "sliders", "🎛️": "sliders", "🎛": "sliders", "🍿": "tv", "💘": "heart", "💕": "heart", "🧾": "board",
  };
  // Places that are the site's own menus and buttons. Members' posts, chats and gifts are never touched.
  const ZONES = [
    ".stats", "#mw-stats", "nav.tabs", ".st.add .top", "[data-st-kind]", "#fb-tabs", "#fb-left", "#fb-top", "#fb-mind .r2", ".fb-story.make", ".appmore .grid", ".gi-hero", "button.btn", "a.btn", "label.btn", "button.act", ".acts", ".tabs button",
    ".section-head", ".lux-hero .btn", ".hero .btn", ".bar", "#authbar", ".svc-grid h3", ".tiles h3", ".tile h3", ".chips", "#fb-notes h3",
    "#v-services .card h3", "#v-legal .card h3", "#v-contact .card h3", ".quick-links", "#ai-panel .hd", ".sheet .grid",
  ].join(",");
  const SKIP = "textarea,input,select,[contenteditable],.post .txt,.post p,.msg,.mx-msg,.mx-in,.cmt,.r-text,.gift,.gp-grid,.qg,.battle,.fx,.emo,.reacts,.story-view,#fb-notes .n,script,style,svg,.gi,[data-no-gi]";
  const KEYS = Object.keys(E).sort((a, b) => b.length - a.length);
  const RX = new RegExp("(" + KEYS.map((k) => k.replace(/[.*+?^${}()|[\]\\]/g, "\\$&")).join("|") + ")\\uFE0F?", "u");

  function svg(name) {
    const parts = (P[name] || "").split("|");
    let inner = "";
    for (const d of parts) inner += d.startsWith("f:") ? `<path d="${d.slice(2)}" fill="url(#gi-g)" stroke="none"/>` : `<path d="${d}"/>`;
    return `<svg class="gi gi-${name}" viewBox="0 0 24 24" aria-hidden="true" focusable="false">${inner}</svg>`;
  }
  function defs() {
    if (D.getElementById("gi-defs")) return;
    const s = D.createElementNS("http://www.w3.org/2000/svg", "svg");
    s.id = "gi-defs"; s.setAttribute("aria-hidden", "true"); s.setAttribute("width", "0"); s.setAttribute("height", "0");
    s.style.cssText = "position:absolute;width:0;height:0;overflow:hidden";
    s.innerHTML = `<defs><linearGradient id="gi-g" x1="0" y1="0" x2="1" y2="1"><stop offset="0" stop-color="#fff4c2"/><stop offset=".35" stop-color="#ffd25e"/><stop offset=".62" stop-color="#d49a2c"/><stop offset="1" stop-color="#ffe58f"/></linearGradient></defs>`;
    D.body.prepend(s);
  }
  window.MW_GOLD = { svg, icons: P };

  function swapText(node) {
    const t = node.nodeValue; if (!t || !RX.test(t)) return;
    const el = node.parentElement; if (!el || el.closest(SKIP)) return;
    const frag = D.createDocumentFragment();
    let rest = t, m;
    while ((m = rest.match(RX))) {
      if (m.index) frag.append(rest.slice(0, m.index));
      const tpl = D.createElement("template"); tpl.innerHTML = svg(E[m[1]]); frag.append(tpl.content);
      rest = rest.slice(m.index + m[0].length);
    }
    if (rest) frag.append(rest);
    node.replaceWith(frag);
  }
  function scan(root) {
    const zones = root.matches && root.matches(ZONES) ? [root] : [];
    if (root.querySelectorAll) zones.push(...root.querySelectorAll(ZONES));
    if (!zones.length && root.closest && root.closest(ZONES)) zones.push(root);
    for (const z of zones) {
      const w = D.createTreeWalker(z, NodeFilter.SHOW_TEXT), list = [];
      while (w.nextNode()) list.push(w.currentNode);
      list.forEach(swapText);
    }
  }

  // gold medallion beside each section title
  const THEME_ICON = { services: "tools", shop: "bag", community: "users", radio: "radio", studio: "sliders", books: "book", predict: "crystal", live: "live", exclusives: "sparkle", jobs: "case", friends: "handshake", fans: "crown", dating: "heart", clips: "clap", videos: "tv", preach: "cross", markets: "chart", legal: "scale", coin: "coin", world: "globe", games: "game", creators: "palette", chat: "chat", ads: "pinned", promote: "megaphone", messages: "mail", liveradio: "satellite", livetv: "tv" };
  function medallions() {
    D.querySelectorAll(".view[data-theme] .section-head h2").forEach((h) => {
      const box = h.parentElement; if (!box || box.querySelector(":scope > .gi-medal")) return;
      const th = h.closest(".view").dataset.theme, ic = THEME_ICON[th]; if (!ic) return;
      const m = D.createElement("span"); m.className = "gi-medal"; m.setAttribute("aria-hidden", "true"); m.innerHTML = svg(ic);
      box.prepend(m); box.classList.add("gi-has-medal");
    });
  }

  // drifting gold dust (behind nothing important: it ignores taps and is very faint)
  function dust() {
    if (matchMedia("(prefers-reduced-motion: reduce)").matches || D.getElementById("gi-dust")) return;
    const c = D.createElement("canvas"); c.id = "gi-dust"; c.setAttribute("aria-hidden", "true");
    D.body.append(c);
    const x = c.getContext("2d"); let w, h, dpr, parts = [], raf = 0, last = 0;
    const size = () => { dpr = Math.min(devicePixelRatio || 1, 2); w = innerWidth; h = innerHeight; c.width = w * dpr; c.height = h * dpr; x.setTransform(dpr, 0, 0, dpr, 0, 0); };
    size(); addEventListener("resize", size, { passive: true });
    const n = w < 600 ? 26 : 48;
    for (let i = 0; i < n; i++) parts.push({ x: Math.random() * w, y: Math.random() * h, r: Math.random() * 1.6 + .4, vy: -(Math.random() * .25 + .06), vx: (Math.random() - .5) * .12, p: Math.random() * 6.28, s: Math.random() * .02 + .008 });
    const frame = (t) => {
      raf = requestAnimationFrame(frame);
      if (t - last < 33) return; last = t; // ~30 fps is plenty
      x.clearRect(0, 0, w, h);
      for (const q of parts) {
        q.x += q.vx; q.y += q.vy; q.p += q.s;
        if (q.y < -6) { q.y = h + 6; q.x = Math.random() * w; } if (q.x < -6) q.x = w + 6; if (q.x > w + 6) q.x = -6;
        const a = .25 + .45 * (.5 + .5 * Math.sin(q.p));
        const g = x.createRadialGradient(q.x, q.y, 0, q.x, q.y, q.r * 4);
        g.addColorStop(0, `rgba(255,236,170,${a})`); g.addColorStop(.35, `rgba(255,200,90,${a * .5})`); g.addColorStop(1, "rgba(255,190,70,0)");
        x.fillStyle = g; x.beginPath(); x.arc(q.x, q.y, q.r * 4, 0, 6.283); x.fill();
      }
    };
    const run = () => { cancelAnimationFrame(raf); if (!D.hidden) raf = requestAnimationFrame(frame); };
    D.addEventListener("visibilitychange", run); run();
  }

  // phones: tuck the Book tab row away while scrolling down, bring it back on any scroll up
  function scrollChrome() {
    let last = scrollY, acc = 0;
    addEventListener("scroll", () => {
      const y = scrollY, d = y - last; last = y;
      if (innerWidth > 760) { H.classList.remove("gi-down"); return; }
      if (y < 140) { acc = 0; H.classList.remove("gi-down"); return; }
      acc = (d > 0) === (acc > 0) ? acc + d : d;
      if (acc > 24) H.classList.add("gi-down"); else if (acc < -12) H.classList.remove("gi-down");
    }, { passive: true });
  }

  function init() {
    if (!H.classList.contains("lux")) H.classList.add("lux");
    defs(); scan(D.body); medallions(); dust(); scrollChrome();
    let pend = new Set(), tm = 0;
    new MutationObserver((ms) => {
      for (const m of ms) for (const n of m.addedNodes) { if (n.nodeType === 1) pend.add(n); else if (n.nodeType === 3 && n.parentElement) pend.add(n.parentElement); }
      if (!tm) tm = setTimeout(() => { tm = 0; const l = [...pend]; pend.clear(); l.forEach((n) => n.isConnected && scan(n)); medallions(); }, 60);
    }).observe(D.body, { childList: true, subtree: true });
  }
  if (D.readyState === "loading") D.addEventListener("DOMContentLoaded", init); else init();
})();
