/* world view markup — the live section's own inner markup, verbatim (Phase 5). */
export const MARKUP = `
<div class="wrap">
    <div class="section-head">
      <div><p class="eyebrow">Meechie's World 3D</p><h2>Virtual World</h2></div>
      <p class="muted">Dress up your character, pick a room, tap the floor to walk, drag to look around, and talk. Tap ⛶ to go full screen. Everyone in the room sees you move and speak.</p>
    </div>
    <div class="world">
      <div class="card builder">
        <div class="avatar-stage" id="av-stage"></div>
        <div class="ai-me">
          <span class="btn ghost file-btn" id="ai-me-btn">✨ Make my AI look-alike<input type="file" id="ai-selfie" accept="image/*" aria-label="Upload a selfie"></span>
          <button class="btn ghost sm" type="button" id="av-photo-toggle" hidden>Use my photo face</button>
          <p class="muted" id="ai-me-status">Upload a clear, close-up selfie. AI matches your skin tone and hair, and your face can show on your avatar so people know who you are.</p>
        </div>
        <div id="av-opts"></div>
        <div class="field"><label for="av-printtext">Print text (up to 10 letters)</label><input type="text" id="av-printtext" maxlength="10" hidden></div>
        <div style="display:grid;gap:8px"><button class="btn" type="button" id="av-save">Save my look</button><button class="btn ghost" type="button" id="av-share">Share this outfit to the Wardrobe</button></div>
      </div>
      <div>
        <div class="rooms" id="rooms">
          <button class="chip" type="button" data-room="lounge" aria-pressed="true">Gold Lounge</button>
          <button class="chip" type="button" data-room="studio">Studio B</button>
          <button class="chip" type="button" data-room="rooftop">Rooftop</button>
          <button class="chip" type="button" data-room="club">Club Conscientia</button>
        </div>
        <div class="scene" id="scene" role="application" aria-label="Room. Tap the floor to walk there.">
          <div class="prop" id="props" style="inset:0"></div><div class="vig"></div><span class="label" id="room-label">GOLD LOUNGE</span><span class="count" id="room-count">1 here</span>
        </div>
        <div class="emotes" id="emotes"><button class="chip" type="button" data-pose="wave">👋 Wave</button><button class="chip" type="button" data-pose="dance">💃 Dance</button><button class="chip" type="button" data-pose="sit">🪑 Sit</button><button class="chip" type="button" data-pose="stand">🧍 Stand</button></div>
        <form class="say" id="say-form"><input type="text" id="say-text" aria-label="Say something in the room" maxlength="120" placeholder="Say something in the room" autocomplete="off"><button class="btn" type="submit">Say</button></form>
        <div class="roomlog" id="roomlog" aria-live="polite"><span class="sys">Tap the floor to walk. Say something and everyone in the room sees it.</span></div>
        <p class="muted" id="world-status" style="font-size:13px;margin:8px 0 0">Sign in to enter rooms with other people.</p>
      </div>
    </div>
  </div>`;
