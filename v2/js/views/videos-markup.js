/* videos view markup — the live section's own inner markup, verbatim (Phase 5). */
export const MARKUP = `
<div class="wrap">
    <div class="section-head">
      <div><p class="eyebrow">Watch together</p><h2>Videos</h2></div>
      <p class="muted">Watch music videos, interviews, and more from the community. Share any YouTube or TikTok video by pasting its link.</p>
    </div>
    <div class="card tt-box" style="margin-bottom:18px">
      <div class="tt-head"><div><p class="eyebrow" style="margin:0">Only on Meechie's World</p><h3 style="margin:2px 0 0">Meechie's World Originals</h3></div></div>
      <div class="orig-wrap"><div class="orig-row" data-originals></div></div>
    </div>
    <div class="card tt-box">
      <div class="tt-head"><div><p class="eyebrow" style="margin:0">Latest from Meechie</p><h3 style="margin:2px 0 0">@meechiesworldinc on TikTok</h3></div><a class="btn" href="https://www.tiktok.com/@meechiesworldinc" target="_blank" rel="noopener">Follow on TikTok</a></div>
      <div class="htt-wrap"><div class="htt-grid"><small class="muted">Loading Meechie's TikToks...</small></div></div>
    </div>
    <div class="yt-stage">
      <div class="yt-frame" id="yt-frame"><div class="yt-empty"><svg class="sqc-ico" aria-hidden="true" style="width:56px;height:56px"><use href="#sqc"/></svg><span>Shared videos play here.</span></div></div>
      <div class="yt-now" id="yt-now"></div>
    </div>
    <form class="card yt-form" id="yt-form">
      <h3 style="font-size:20px;margin:0">Share a YouTube or TikTok video</h3>
      <div class="req">
        <div class="field full"><label for="yt-url">YouTube or TikTok link</label><input type="url" id="yt-url" placeholder="https://youtu.be/... or https://www.tiktok.com/@.../video/..." required></div>
        <div class="field"><label for="yt-title">Title</label><input type="text" id="yt-title" maxlength="100" placeholder="e.g. My new music video"></div>
        <div class="field"><label for="yt-note">Note (optional)</label><input type="text" id="yt-note" maxlength="80" placeholder="Out now, tell a friend"></div>
      </div>
      <div class="yt-preview" id="yt-preview" hidden></div>
      <button class="btn" type="submit">Share video</button>
      <small class="muted">Only share videos you made or that are public. Videos play from YouTube or TikTok.</small>
    </form>
    <div class="filters" id="yt-sort" style="justify-content:center;margin-top:24px"><button class="chip" type="button" data-sort="new" aria-pressed="true">Newest</button><button class="chip" type="button" data-sort="top">Most liked</button></div>
    <div class="yt-grid" id="yt-grid"><div class="empty">Loading videos...</div></div>
  </div>`;
