"use strict";

/* ================= 常量与状态 ================= */
const STORAGE_KEY = "singalong.library.v1";
const SETTINGS_KEY = "singalong.settings.v1";
const LRCLIB = "https://lrclib.net/api";
const MOJIGECI = "https://mojigeci.com/zh-Hans";
const UA = "Mozilla/5.0 (Linux; Android 13; Pixel 7) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/120.0 Mobile Safari/537.36";

const state = {
  mode: "library",          // library | search | stats
  filter: "all",            // all | artist | tag
  searchedFor: "",
  searchStatus: "idle",     // idle | loading | done | error
  results: [],
  resultsSource: "",
  error: "",
  detailId: null,
  lyricsLoading: false,
};

let library = [];
let settings = { source: "auto" };

/* ================= 工具 ================= */
function $(sel, root) { return (root || document).querySelector(sel); }
function $$(sel, root) { return Array.from((root || document).querySelectorAll(sel)); }
function esc(s) {
  return String(s == null ? "" : s).replace(/[&<>"']/g, function (c) {
    return { "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;" }[c];
  });
}
function uid() { return "u" + Date.now().toString(36) + Math.random().toString(36).slice(2, 8); }
function byAddedDesc(a, b) { return b.addedAt - a.addedAt; }
function byTitle(a, b) { return (a.title || "").localeCompare(b.title || "", "zh-Hans-CN"); }
function songKey(s) { return ((s.title || "").trim().toLowerCase()) + "||" + ((s.artist || "").trim().toLowerCase()); }
function getSong(id) { return library.find(function (s) { return s.id === id; }); }
function srcLabel(src) { return src === "lrclib" ? "LRCLIB" : "魔镜歌词"; }

let toastTimer = null;
function toast(msg) {
  const t = $("#toast");
  t.textContent = msg;
  t.classList.add("show");
  clearTimeout(toastTimer);
  toastTimer = setTimeout(function () { t.classList.remove("show"); }, 2400);
}

function htmlToText(html) {
  let s = String(html == null ? "" : html)
    .replace(/<script[\s\S]*?<\/script>/gi, " ")
    .replace(/<style[\s\S]*?<\/style>/gi, " ")
    .replace(/<br\s*\/?>/gi, "\n")
    .replace(/<\/(p|div|li|h[1-6]|tr)>/gi, "\n");
  const div = document.createElement("div");
  div.innerHTML = s;
  return (div.textContent || "").replace(/\u00a0/g, " ").replace(/[ \t]+/g, " ");
}

/* ================= 本地存储 ================= */
function loadLibrary() {
  try {
    const raw = localStorage.getItem(STORAGE_KEY);
    const arr = raw ? JSON.parse(raw) : [];
    library = Array.isArray(arr) ? arr : [];
  } catch (e) { library = []; }
}
function saveLibrary() {
  try { localStorage.setItem(STORAGE_KEY, JSON.stringify(library)); } catch (e) { toast("本地存储失败"); }
}
function loadSettings() {
  try {
    const r = JSON.parse(localStorage.getItem(SETTINGS_KEY));
    if (r && typeof r === "object") settings = Object.assign({ source: "auto" }, r);
  } catch (e) {}
}
function saveSettings() {
  try { localStorage.setItem(SETTINGS_KEY, JSON.stringify(settings)); } catch (e) {}
}

/* ================= 网络层（原生 App / 本地代理 / 直连） ================= */
function isNative() {
  return !!(window.Capacitor && window.Capacitor.isNativePlatform && window.Capacitor.isNativePlatform());
}
function isBehindProxy() {
  const h = location.hostname, p = location.port;
  return (h === "localhost" || h === "127.0.0.1") && (p === "8787" || p === "8765" || p === "3000" || p === "");
}
async function nativeHttp(url, opts) {
  const CapHttp = window.Capacitor.Plugins && window.Capacitor.Plugins.CapacitorHttp;
  if (!CapHttp) throw new Error("CapacitorHttp 不可用");
  const method = (opts.method || "GET").toUpperCase();
  const headers = Object.assign({ "User-Agent": UA, "Accept-Language": "zh-CN,zh;q=0.9,en;q=0.8" }, opts.headers || {});
  let res;
  if (method === "POST") {
    headers["Content-Type"] = opts.contentType || "application/x-www-form-urlencoded";
    res = await CapHttp.post({ url: url, headers: headers, data: opts.body || "" });
  } else {
    res = await CapHttp.get({ url: url, headers: headers, responseType: "text" });
  }
  if (res.status < 200 || res.status >= 300) throw new Error("HTTP " + res.status);
  return typeof res.data === "string" ? res.data : JSON.stringify(res.data);
}
async function webFetch(url, opts) {
  const method = (opts.method || "GET").toUpperCase();
  const headers = Object.assign({}, opts.headers || {});
  const init = { method: method, headers: headers };
  if (method === "POST") {
    headers["Content-Type"] = opts.contentType || "application/x-www-form-urlencoded";
    init.body = opts.body || "";
  }
  const res = await fetch(url, init);
  if (!res.ok) throw new Error("HTTP " + res.status);
  return await res.text();
}
async function fetchText(url, opts) {
  opts = opts || {};
  if (isNative()) return nativeHttp(url, opts);
  if (isBehindProxy()) {
    if ((opts.method || "GET").toUpperCase() === "POST") {
      return webFetch("/proxy", {
        method: "POST",
        contentType: "application/json",
        body: JSON.stringify({ url: url, method: "POST", body: opts.body || "", contentType: opts.contentType || "application/x-www-form-urlencoded" }),
      });
    }
    const p = new URL("/proxy", location.origin);
    p.searchParams.set("url", url);
    return webFetch(p.toString());
  }
  return webFetch(url, opts);
}
/* ================= 歌词源：LRCLIB ================= */
async function lrclibSearch(q) {
  const text = await fetchText(LRCLIB + "/search?q=" + encodeURIComponent(q), { headers: { Accept: "application/json" } });
  const data = JSON.parse(text);
  if (!Array.isArray(data)) return [];
  return data.map(function (it) {
    return {
      id: "lrclib:" + it.id,
      title: it.trackName || "",
      artist: it.artistName || "",
      album: it.albumName || "",
      lyricist: "",
      composer: "",
      source: "LRCLIB",
      lrclibId: it.id,
      instrumental: !!it.instrumental,
      duration: it.duration || 0,
    };
  }).filter(function (s) { return s.title; });
}
async function lrclibLyrics(song) {
  if (!song.lrclibId) throw new Error("缺少 LRCLIB 歌曲 ID");
  const text = await fetchText(LRCLIB + "/get/" + song.lrclibId, { headers: { Accept: "application/json" } });
  const data = JSON.parse(text);
  const synced = data.syncedLyrics || "";
  const plain = data.plainLyrics || "";
  if (synced) return parseLrc(synced);
  if (plain) return plain.split(/\r?\n/).map(function (s) { return s.trim(); }).filter(Boolean);
  throw new Error("这首歌暂无歌词");
}
function parseLrc(lrc) {
  const out = [];
  const re = /\[(\d{1,2}):(\d{1,2})(?:\.(\d{1,3}))?\]\s*(.*)/g;
  let m;
  while ((m = re.exec(lrc))) {
    const t = m[4].trim();
    if (t) out.push(t);
  }
  if (out.length) return out;
  return lrc.split(/\r?\n/).map(function (s) { return s.replace(/^\[[^\]]*\]\s*/, "").trim(); }).filter(Boolean);
}

/* ================= 歌词源：魔镜歌词（抓取解析） ================= */
let mojigeciSearchCfg = null;
async function discoverMojigeciSearch() {
  if (mojigeciSearchCfg) return mojigeciSearchCfg;
  const html = await fetchText(MOJIGECI + "/");
  const forms = Array.from(html.matchAll(/<form\b[^>]*>([\s\S]*?)<\/form>/gi));
  for (const fm of forms) {
    const tag = fm[0], inner = fm[1];
    const action = (tag.match(/action=["']([^"']*)["']/i) || [])[1] || "";
    const method = ((tag.match(/method=["']([^"']*)["']/i) || [])[1] || "get").toLowerCase();
    if (!action) continue;
    let param = "";
    const inputs = Array.from(inner.matchAll(/<input\b[^>]*>/gi)).map(function (mm) { return mm[0]; });
    for (const inp of inputs) {
      const type = ((inp.match(/type=["']([^"']*)["']/i) || [])[1] || "text").toLowerCase();
      const name = (inp.match(/name=["']([^"']*)["']/i) || [])[1] || "";
      if (name && (type === "search" || type === "text")) { param = name; if (type === "search") break; }
    }
    if (param) {
      mojigeciSearchCfg = { url: new URL(action, MOJIGECI + "/").href, method: method, param: param };
      return mojigeciSearchCfg;
    }
  }
  mojigeciSearchCfg = { url: MOJIGECI + "/search", method: "get", param: "q" };
  return mojigeciSearchCfg;
}
async function mojigeciSearch(q) {
  const cfg = await discoverMojigeciSearch();
  let html;
  if (cfg.method === "post") {
    html = await fetchText(cfg.url, { method: "POST", body: new URLSearchParams({ [cfg.param]: q }).toString(), contentType: "application/x-www-form-urlencoded" });
  } else {
    const sep = cfg.url.indexOf("?") >= 0 ? "&" : "?";
    html = await fetchText(cfg.url + sep + cfg.param + "=" + encodeURIComponent(q));
  }
  return parseMojigeciSearch(html);
}
function parseMojigeciSearch(html) {
  const out = [];
  const seen = new Set();
  const re = /<a\b[^>]*href=["']([^"']*\/lyrics\/[^"']*)["'][^>]*>([\s\S]*?)<\/a>/gi;
  let m;
  while ((m = re.exec(html))) {
    const href = m[1];
    let slug = "";
    try { slug = decodeURIComponent((href.split("/").filter(Boolean).pop() || "")); } catch (e) { slug = href.split("/").filter(Boolean).pop() || ""; }
    if (!slug || seen.has(slug)) continue;
    seen.add(slug);
    const text = htmlToText(m[2]).replace(/\s+/g, " ").trim();
    let artist = "";
    const parts = text.split(" ").map(function (s) { return s.trim(); }).filter(Boolean);
    if (parts.length >= 2) {
      const head = parts[0];
      if (head === slug || slug.includes(head) || head.includes(slug) || /^[\u4e00-\u9fa5]+$/.test(head)) artist = parts[1];
    }
    artist = artist.replace(/[\d\s]+/g, "").replace(/查看|歌詞|歌词/g, "").trim();
    if (!artist || artist === slug) artist = "未知歌手";
    out.push({
      id: "mojigeci:" + encodeURIComponent(slug),
      title: slug,
      artist: artist,
      album: "", lyricist: "", composer: "",
      source: "魔镜歌词",
      mojigeciUrl: new URL(href, MOJIGECI + "/").href,
    });
  }
  return out;
}
async function mojigeciLyrics(song) {
  let url = song.mojigeciUrl;
  if (!url) url = MOJIGECI + "/lyrics/" + encodeURIComponent(song.title);
  const html = await fetchText(url);
  const res = parseMojigeciLyrics(html, song.title);
  if (!res.lines.length) throw new Error("没有解析到歌词");
  return res;
}
function parseMojigeciLyrics(html, title) {
  const text = htmlToText(html);
  const lines = text.split(/\r?\n/).map(function (l) { return l.trim(); });
  let artist = "";
  const tt = html.match(/<title[^>]*>([\s\S]*?)<\/title>/i);
  if (tt) {
    const t = htmlToText(tt[1]).replace(/\s+/g, " ").trim();
    const cleaned = t.replace(/[-–—]?\s*歌词\s*[-–—]?\s*魔镜歌词网\s*$/i, "").trim();
    const parts = cleaned.split(" ").filter(Boolean);
    if (parts.length >= 2) artist = parts[parts.length - 1];
  }
  const markers = ["歌词内容", "歌詞內容", "原歌词", "原歌詞", "歌词", "歌詞"];
  let start = -1;
  for (let i = 0; i < lines.length; i++) {
    if (markers.indexOf(lines[i]) >= 0) { start = i + 1; break; }
  }
  const window = start >= 0 ? lines.slice(start) : lines;
  const meta = /^(曲|词|作词|作詞|作曲|编曲|編曲|制作人|製作人|制作|製作|演唱|混音|和声|和聲|和音|统筹|統籌|发行|發行|出品|监制|監製|企划|企劃|营销|營銷|推广|推廣|艺人经纪|藝人經紀|发行人|發行人|OP|SP|取样|取樣|中文填词|音乐制作人|音樂製作人|吉他|木吉他|贝斯|貝斯|鼓|键盘|鍵盤|录音|錄音|母带|母帶|导演|導演|MV|监制)/i;
  const junk = /^(分享|下载|下载为图片|下载为文字|打印|图片|圖片|下載|link_copied|查看|搜索|首页|首頁|关于我们|關於我們|联系我们|聯繫我們|隐私政策|隱私政策|服务条款|服務條款|全部歌词|全部歌詞|魔镜歌词网|魔鏡歌詞網|语言|語言|加载中|加載中|关闭|關閉|歌曲标题|歌曲標題|状态|狀態|艺术家|藝術家|歌词内容|歌詞內容|原歌词|原歌詞|热门搜索|熱門搜索|精选歌词|精選歌詞|常见问题|常見問題|版权|版權|©)/i;
  const out = [];
  for (const raw of window) {
    if (!raw) { if (out.length && out[out.length - 1] !== "") out.push(""); continue; }
    if (meta.test(raw) || junk.test(raw)) continue;
    if (raw.length > 80) continue;
    if (title && raw.includes(title) && raw.includes(" - ")) continue;
    if (raw.length < 2) continue;
    out.push(raw);
  }
  const cleaned = [];
  for (const l of out) {
    if (l === "" && (cleaned.length === 0 || cleaned[cleaned.length - 1] === "")) continue;
    cleaned.push(l);
  }
  while (cleaned.length && cleaned[cleaned.length - 1] === "") cleaned.pop();
  return { lines: cleaned, artist: artist };
}
/* ================= 搜索与歌词编排 ================= */
async function search(q) {
  const order = settings.source === "auto" ? ["lrclib", "mojigeci"] : [settings.source];
  let lastErr = null;
  for (const src of order) {
    try {
      const items = src === "lrclib" ? await lrclibSearch(q) : await mojigeciSearch(q);
      if (items && items.length) return { source: srcLabel(src), items: items };
      lastErr = new Error("没有结果");
    } catch (e) { lastErr = e; }
  }
  throw lastErr || new Error("搜索失败");
}
async function loadLyricsForSong(song) {
  let lastErr = null;
  const order = song.lrclibId ? ["lrclib", "mojigeci"] : ["mojigeci", "lrclib"];
  for (const src of order) {
    try {
      let lines;
      if (src === "lrclib") {
        lines = await lrclibLyrics(song);
      } else {
        const res = await mojigeciLyrics(song);
        if (res.artist && (!song.artist || song.artist === "未知歌手")) song.artist = res.artist;
        lines = res.lines;
      }
      if (lines && lines.length) return { lines: lines, source: srcLabel(src) };
      lastErr = new Error("没有歌词");
    } catch (e) { lastErr = e; }
  }
  throw lastErr || new Error("歌词加载失败");
}

/* ================= 曲库操作 ================= */
function isCollected(s) { return library.some(function (x) { return songKey(x) === songKey(s); }); }
function addSong(raw) {
  if (!raw || !raw.title) return;
  if (isCollected(raw)) { toast("已在曲库中"); render(); return; }
  const song = {
    id: raw.id || uid(),
    title: String(raw.title).trim(),
    artist: (raw.artist && String(raw.artist).trim()) || "未知歌手",
    album: raw.album || "",
    lyricist: raw.lyricist || "",
    composer: raw.composer || "",
    source: raw.source || "手动",
    lrclibId: raw.lrclibId || null,
    mojigeciUrl: raw.mojigeciUrl || null,
    tag: "会唱",
    addedAt: Date.now(),
    lyrics: Array.isArray(raw.lyrics) ? raw.lyrics : [],
    notes: {},
  };
  library.unshift(song);
  saveLibrary();
  toast("已收录「" + song.title + "」");
  render();
}
function toggleTag(id) {
  const s = getSong(id); if (!s) return;
  s.tag = s.tag === "会唱" ? "想学" : "会唱";
  saveLibrary(); render();
}
function removeSong(id) {
  library = library.filter(function (x) { return x.id !== id; });
  saveLibrary(); render();
}
function confirmRemove(id) {
  const s = getSong(id); if (!s) return;
  openConfirm("移除歌曲", "确定从曲库移除「" + s.title + "」吗？", "移除", true, function () {
    removeSong(id);
    toast("已移除「" + s.title + "」");
  });
}
function normalizeImported(raw) {
  return {
    id: raw.id || uid(),
    title: String(raw.title || "").trim(),
    artist: String(raw.artist || "").trim() || "未知歌手",
    album: raw.album || "",
    lyricist: raw.lyricist || "",
    composer: raw.composer || "",
    source: raw.source || "导入",
    lrclibId: raw.lrclibId || null,
    mojigeciUrl: raw.mojigeciUrl || null,
    tag: raw.tag === "想学" ? "想学" : "会唱",
    addedAt: raw.addedAt || Date.now(),
    lyrics: Array.isArray(raw.lyrics) ? raw.lyrics : [],
    notes: raw.notes && typeof raw.notes === "object" ? raw.notes : {},
  };
}
/* ================= 渲染：主视图 ================= */
function render() {
  $("#clearBtn").hidden = !$("#searchInput").value;
  $("#filterRow").hidden = state.mode !== "library";
  $$(".nav-item").forEach(function (b) { b.classList.toggle("active", b.dataset.mode === state.mode); });
  renderMain();
  renderDetail();
}
function setMode(m) {
  state.mode = m;
  $$(".nav-item").forEach(function (b) { b.classList.toggle("active", b.dataset.mode === m); });
}
function renderMain() {
  const main = $("#main");
  if (state.mode === "library") main.innerHTML = renderLibrary();
  else if (state.mode === "search") main.innerHTML = renderSearch();
  else main.innerHTML = renderStats();
  afterRenderMain();
}
function afterRenderMain() {
  if (state.mode === "library") $$(".swipe-row").forEach(attachRowGestures);
}

function renderLibrary() {
  if (!library.length) {
    return '<div class="empty"><div class="big">🎶</div><p class="t">还没有收录歌曲</p><p class="d">点上方搜索框找一首你会唱的吧</p><button class="load-btn" style="max-width:220px;margin:14px auto 0" data-action="manual" type="button">手动添加歌曲</button></div>';
  }
  const groups = groupSongs();
  let html = "";
  for (const g of groups) {
    if (g.label) html += '<div class="group-head"><span>' + esc(g.label) + '</span><span class="count">' + g.songs.length + ' 首</span></div>';
    html += g.songs.map(songRowHtml).join("");
  }
  return html;
}
function groupSongs() {
  if (state.filter === "artist") {
    const map = new Map();
    for (const s of library) {
      const k = s.artist || "未知歌手";
      if (!map.has(k)) map.set(k, []);
      map.get(k).push(s);
    }
    const keys = Array.from(map.keys()).sort(function (a, b) { return a.localeCompare(b, "zh-Hans-CN"); });
    return keys.map(function (k) { return { label: k, songs: map.get(k).sort(byTitle) }; });
  }
  if (state.filter === "tag") {
    return ["会唱", "想学"].map(function (t) {
      return { label: t, songs: library.filter(function (s) { return s.tag === t; }).sort(byAddedDesc) };
    }).filter(function (g) { return g.songs.length; });
  }
  return [{ label: "", songs: library.slice().sort(byAddedDesc) }];
}
function songRowHtml(s) {
  const badge = s.tag === "会唱"
    ? '<button class="tag-badge tag-can" data-action="toggle-tag" data-id="' + esc(s.id) + '" type="button">会唱</button>'
    : '<button class="tag-badge tag-want" data-action="toggle-tag" data-id="' + esc(s.id) + '" type="button">想学</button>';
  return '<div class="swipe-row" data-id="' + esc(s.id) + '">'
    + '<button class="swipe-delete" data-action="remove" data-id="' + esc(s.id) + '" type="button">移除</button>'
    + '<div class="swipe-content">'
    + '<div class="song-main"><div class="song-title">' + esc(s.title) + '</div><div class="song-sub">' + esc(s.artist) + '</div></div>'
    + badge
    + '</div></div>';
}
function resultRowHtml(r, idx) {
  const collected = isCollected(r);
  const extra = [r.album, r.lyricist, r.composer].filter(Boolean).join(" · ");
  const right = collected
    ? '<span class="added">已收录</span>'
    : '<button class="add-btn" data-action="add" data-idx="' + idx + '" type="button">收录</button>';
  return '<div class="song-row">'
    + '<div class="song-main"><div class="song-title">' + esc(r.title) + '</div>'
    + '<div class="song-sub">' + esc(r.artist) + '</div>'
    + (extra ? '<div class="song-extra">' + esc(extra) + '</div>' : '')
    + '</div>' + right + '</div>';
}
function renderSearch() {
  if (state.searchStatus === "loading") return '<div class="status-box"><div class="spinner"></div><p>正在搜索…</p></div>';
  if (state.searchStatus === "error") {
    return '<div class="error-box">' + esc(state.error) + '<button class="retry-btn" data-action="retry" type="button">重试</button>'
      + '<button class="ghost-btn" style="margin-top:10px" data-action="manual" type="button">手动添加歌曲</button></div>';
  }
  if (state.searchStatus === "done" && !state.results.length) {
    return '<div class="empty"><div class="big">🔍</div><p class="t">没有找到相关歌曲</p><p class="d">换个关键词，或手动添加。</p></div>';
  }
  if (state.results.length) {
    let html = '<div class="source-note">来自 ' + esc(state.resultsSource) + ' · ' + state.results.length + ' 条结果</div>';
    html += state.results.map(function (r, i) { return resultRowHtml(r, i); }).join("");
    return html;
  }
  return '<div class="empty"><div class="big">🎤</div><p class="t">输入关键词，点右上角「搜索」</p><p class="d">搜索到歌曲后，一键收录到曲库。</p></div>';
}
function countBy(fn) {
  const m = new Map();
  for (const s of library) { const k = fn(s); m.set(k, (m.get(k) || 0) + 1); }
  return Array.from(m.entries()).map(function (e) { return { k: e[0], n: e[1] }; }).sort(function (a, b) { return b.n - a.n; });
}
function renderStats() {
  if (!library.length) {
    return '<div class="empty"><div class="big">📊</div><p class="t">还没有数据</p><p class="d">先收录几首歌，这里会显示统计。</p></div>';
  }
  const total = library.length;
  const can = library.filter(function (s) { return s.tag === "会唱"; }).length;
  const want = total - can;
  const byArtist = countBy(function (s) { return s.artist || "未知歌手"; });
  const maxArtist = Math.max.apply(null, [1].concat(byArtist.map(function (x) { return x.n; })));
  const recent = library.slice().sort(byAddedDesc).slice(0, 5);
  let html = '<div class="stat-cards">'
    + '<div class="stat-card blue"><div class="num">' + total + '</div><div class="lbl">总收录</div></div>'
    + '<div class="stat-card green"><div class="num">' + can + '</div><div class="lbl">会唱</div></div>'
    + '<div class="stat-card amber"><div class="num">' + want + '</div><div class="lbl">想学</div></div>'
    + '</div>';
  html += '<div class="section-label">按标签</div>';
  html += [["会唱", can], ["想学", want]].map(function (t) {
    return '<div class="bar-row"><span class="bar-name">' + t[0] + '</span><div class="bar-track"><div class="bar-fill" style="width:' + Math.round(t[1] / Math.max(1, total) * 100) + '%"></div></div><span class="bar-num">' + t[1] + '</span></div>';
  }).join("");
  html += '<div class="section-label">按歌手（Top ' + Math.min(byArtist.length, 15) + '）</div>';
  html += byArtist.slice(0, 15).map(function (x) {
    return '<div class="bar-row"><span class="bar-name">' + esc(x.k) + '</span><div class="bar-track"><div class="bar-fill" style="width:' + Math.round(x.n / maxArtist * 100) + '%"></div></div><span class="bar-num">' + x.n + '</span></div>';
  }).join("");
  html += '<div class="section-label">最近收录</div>';
  html += recent.map(function (s) {
    const badge = s.tag === "会唱" ? "tag-can" : "tag-want";
    return '<div class="song-row"><div class="song-main"><div class="song-title">' + esc(s.title) + '</div><div class="song-sub">' + esc(s.artist) + '</div></div>'
      + '<button class="tag-badge ' + badge + '" data-action="open-detail" data-id="' + esc(s.id) + '" type="button">' + esc(s.tag) + '</button></div>';
  }).join("");
  return html;
}
/* ================= 渲染：详情 ================= */
function openDetail(id) { state.detailId = id; renderDetail(); }
function closeDetail() { state.detailId = null; $("#detailOverlay").hidden = true; }
function renderDetail() {
  const overlay = $("#detailOverlay");
  const s = getSong(state.detailId);
  if (!s) { overlay.hidden = true; return; }
  overlay.hidden = false;
  $("#detailBody").innerHTML = detailHtml(s);
}
function detailHtml(s) {
  const tagBtn = s.tag === "会唱"
    ? '<button class="tag-badge tag-can" data-daction="toggle-tag" type="button">会唱</button>'
    : '<button class="tag-badge tag-want" data-daction="toggle-tag" type="button">想学</button>';
  const pills = [];
  if (s.album) pills.push("专辑：" + s.album);
  if (s.lyricist) pills.push("作词：" + s.lyricist);
  if (s.composer) pills.push("作曲：" + s.composer);
  if (s.source) pills.push("来源：" + s.source);
  if (s.lyricsSource) pills.push("歌词：" + s.lyricsSource);
  if (s.addedAt) pills.push("收录于 " + new Date(s.addedAt).toLocaleDateString("zh-CN"));
  const meta = pills.length ? '<div class="detail-meta">' + pills.map(function (p) { return '<span class="meta-pill">' + esc(p) + '</span>'; }).join("") + '</div>' : "";

  let lyricsHtml = "";
  if (state.lyricsLoading) {
    lyricsHtml = '<div class="status-box"><div class="spinner"></div><p>正在加载歌词…</p></div>';
  } else if (s.lyrics && s.lyrics.length) {
    lyricsHtml = s.lyrics.map(function (line, i) {
      const note = s.notes && s.notes[i];
      return '<div class="lyric-line' + (note ? " has-note" : "") + '" data-line="' + i + '">' + esc(line)
        + (note ? '<div class="lyric-note">📝 ' + esc(note) + '</div>' : '') + '</div>';
    }).join("");
  } else {
    lyricsHtml = '<p class="hint" style="margin-top:0">还没有歌词。</p>'
      + '<button class="load-btn" data-daction="load-lyrics" type="button">从歌词源加载</button>'
      + '<button class="ghost-btn" style="margin-top:10px" data-daction="paste-lyrics" type="button">手动粘贴歌词</button>';
  }

  return '<div class="detail-hero">'
    + '<p class="t">' + esc(s.title) + '</p>'
    + '<p class="a">' + esc(s.artist) + '</p>'
    + '<div style="display:flex;align-items:center;gap:10px">' + tagBtn + '<span class="hint">点标签切换「会唱 / 想学」</span></div>'
    + meta
    + '</div>'
    + '<div class="lyrics-card">'
    + '<div class="lyrics-head"><span class="lh">歌词</span><span class="hint">' + (s.lyrics.length ? "点某一句添加备注" : "") + '</span></div>'
    + lyricsHtml
    + '</div>'
    + '<div style="display:flex;gap:10px;margin-top:14px">'
    + '<button class="ghost-btn" data-daction="edit" type="button">编辑信息</button>'
    + '<button class="ghost-btn" style="color:var(--danger)" data-daction="remove" type="button">移除</button>'
    + '</div>';
}

/* ================= 渲染：设置 ================= */
function renderSettings() {
  const src = settings.source;
  const seg = function (val, label) { return '<button class="' + (src === val ? "active" : "") + '" data-source="' + val + '" type="button">' + label + '</button>'; };
  $("#settingsBody").innerHTML =
    '<div class="setting-group">'
    + '<div class="setting-row"><span class="k">歌词来源</span></div>'
    + '<div class="setting-row"><span class="k"></span><div class="seg">' + seg("auto", "自动") + seg("lrclib", "LRCLIB") + seg("mojigeci", "魔镜") + '</div></div>'
    + '<p class="hint">自动：先试 LRCLIB（开放接口、更稳定），失败再试魔镜歌词（中文/港台/日韩更全）。</p>'
    + '</div>'
    + '<div class="setting-group">'
    + '<div class="setting-row"><span class="k">数据备份</span></div>'
    + '<div class="setting-row"><span class="k">导出曲库</span><button class="add-btn" id="exportBtn" type="button">导出</button></div>'
    + '<div class="setting-row"><span class="k">导入曲库</span><button class="add-btn" id="importBtn" type="button">导入</button></div>'
    + '</div>'
    + '<div class="setting-group">'
    + '<div class="setting-row"><span class="k">清空全部数据</span><button class="danger-btn" id="clearAllBtn" type="button">清空</button></div>'
    + '</div>'
    + '<p class="hint">数据只保存在本机（浏览器/App 本地存储），不上传任何服务器。出门前建议先「导出」备份。</p>';
}

/* ================= 模态框 ================= */
function showModal() { $("#modalBackdrop").hidden = false; }
function closeModal() { $("#modalBackdrop").hidden = true; }
function openConfirm(title, msg, okText, danger, onOk) {
  $("#modalCard").innerHTML =
    '<h3>' + esc(title) + '</h3>'
    + '<p class="ml">' + esc(msg) + '</p>'
    + '<div class="modal-actions"><button class="btn-cancel" id="cfCancel" type="button">取消</button>'
    + '<button class="' + (danger ? "btn-danger" : "btn-primary") + '" id="cfOk" type="button">' + esc(okText) + '</button></div>';
  showModal();
  $("#cfCancel").onclick = closeModal;
  $("#cfOk").onclick = function () { closeModal(); onOk && onOk(); };
}
function openNoteModal(songId, index) {
  const s = getSong(songId); if (!s) return;
  const line = (s.lyrics && s.lyrics[index]) || "";
  const note = (s.notes && s.notes[index]) || "";
  $("#modalCard").innerHTML =
    '<h3>给这句加个备注</h3>'
    + '<p class="ml lyric">' + esc(line) + '</p>'
    + '<div class="form"><textarea id="noteInput" placeholder="例如：这句总忘词 / 副歌前换气…">' + esc(note) + '</textarea></div>'
    + '<div class="modal-actions"><button class="btn-cancel" id="noteCancel" type="button">取消</button>'
    + '<button class="btn-primary" id="noteSave" type="button">保存</button></div>';
  showModal();
  $("#noteCancel").onclick = closeModal;
  $("#noteSave").onclick = function () {
    const val = $("#noteInput").value.trim();
    s.notes = s.notes || {};
    if (val) s.notes[index] = val; else delete s.notes[index];
    saveLibrary(); closeModal(); renderDetail();
  };
}
function openEditModal(songId) {
  const s = getSong(songId); if (!s) return;
  $("#modalCard").innerHTML =
    '<h3>编辑歌曲信息</h3>'
    + '<div class="form">'
    + '<label>歌名 *</label><input id="eTitle" type="text" value="' + esc(s.title) + '">'
    + '<label>歌手</label><input id="eArtist" type="text" value="' + esc(s.artist) + '">'
    + '<label>专辑</label><input id="eAlbum" type="text" value="' + esc(s.album || "") + '">'
    + '<label>作词</label><input id="eLyricist" type="text" value="' + esc(s.lyricist || "") + '">'
    + '<label>作曲</label><input id="eComposer" type="text" value="' + esc(s.composer || "") + '">'
    + '</div>'
    + '<div class="modal-actions"><button class="btn-cancel" id="eCancel" type="button">取消</button>'
    + '<button class="btn-primary" id="eSave" type="button">保存</button></div>';
  showModal();
  $("#eCancel").onclick = closeModal;
  $("#eSave").onclick = function () {
    const title = $("#eTitle").value.trim();
    if (!title) { toast("请填写歌名"); return; }
    s.title = title;
    s.artist = $("#eArtist").value.trim() || "未知歌手";
    s.album = $("#eAlbum").value.trim();
    s.lyricist = $("#eLyricist").value.trim();
    s.composer = $("#eComposer").value.trim();
    saveLibrary(); closeModal(); renderDetail(); render();
  };
}
function openManualModal() {
  $("#modalCard").innerHTML =
    '<h3>手动收录歌曲</h3>'
    + '<p class="ml">联网搜不到时，也可以手动添加。</p>'
    + '<div class="form">'
    + '<label>歌名 *</label><input id="mTitle" type="text" placeholder="必填">'
    + '<label>歌手</label><input id="mArtist" type="text" placeholder="可留空">'
    + '<label>专辑</label><input id="mAlbum" type="text" placeholder="可选">'
    + '<label>歌词（可选，每行一句）</label><textarea id="mLyrics" placeholder="把歌词粘贴到这里，一行一句"></textarea>'
    + '</div>'
    + '<div class="modal-actions"><button class="btn-cancel" id="mCancel" type="button">取消</button>'
    + '<button class="btn-primary" id="mSave" type="button">收录</button></div>';
  showModal();
  $("#mCancel").onclick = closeModal;
  $("#mSave").onclick = function () {
    const title = $("#mTitle").value.trim();
    if (!title) { toast("请填写歌名"); return; }
    const lyrics = $("#mLyrics").value.split(/\r?\n/).map(function (x) { return x.trim(); }).filter(Boolean);
    addSong({ title: title, artist: $("#mArtist").value.trim(), album: $("#mAlbum").value.trim(), source: "手动", lyrics: lyrics });
    closeModal();
  };
}
function openPasteModal(songId) {
  const s = getSong(songId); if (!s) return;
  $("#modalCard").innerHTML =
    '<h3>粘贴歌词</h3>'
    + '<p class="ml">一行一句，空行会自动忽略。</p>'
    + '<div class="form"><textarea id="pasteInput">' + esc((s.lyrics || []).join("\n")) + '</textarea></div>'
    + '<div class="modal-actions"><button class="btn-cancel" id="pCancel" type="button">取消</button>'
    + '<button class="btn-primary" id="pSave" type="button">保存</button></div>';
  showModal();
  $("#pCancel").onclick = closeModal;
  $("#pSave").onclick = function () {
    s.lyrics = $("#pasteInput").value.split(/\r?\n/).map(function (x) { return x.trim(); }).filter(Boolean);
    s.lyricsSource = "手动";
    saveLibrary(); closeModal(); renderDetail(); toast("歌词已保存");
  };
}
/* ================= 手势：左滑 + 长按移除 ================= */
function attachRowGestures(row) {
  const content = row.querySelector(".swipe-content");
  if (!content || content.__gesture) return;
  content.__gesture = true;
  let startX = 0, startY = 0, dragging = false, open = false, moved = false, longFired = false, longTimer = null;

  content.addEventListener("pointerdown", function (e) {
    if (e.target.closest(".tag-badge")) return;
    startX = e.clientX; startY = e.clientY; dragging = false; moved = false; longFired = false;
    longTimer = setTimeout(function () { longFired = true; confirmRemove(row.dataset.id); }, 600);
    try { content.setPointerCapture(e.pointerId); } catch (err) {}
  });
  content.addEventListener("pointermove", function (e) {
    if (!startX) return;
    const dx = e.clientX - startX, dy = e.clientY - startY;
    if (!moved && (Math.abs(dx) > 8 || Math.abs(dy) > 8)) { moved = true; clearTimeout(longTimer); }
    if (Math.abs(dx) > Math.abs(dy) && Math.abs(dx) > 8) dragging = true;
    if (dragging) {
      e.preventDefault();
      const base = open ? -82 : 0;
      let off = base + dx;
      off = Math.max(-82, Math.min(0, off));
      content.style.transform = "translateX(" + off + "px)";
    }
  });
  function end(e) {
    if (longTimer) { clearTimeout(longTimer); longTimer = null; }
    if (dragging) {
      const dx = e.clientX - startX;
      open = dx < -40;
      row.classList.toggle("is-open", open);
      content.style.transform = open ? "translateX(-82px)" : "";
    }
    dragging = false; startX = 0;
  }
  content.addEventListener("pointerup", end);
  content.addEventListener("pointercancel", end);
  content.addEventListener("click", function (e) {
    if (longFired) { longFired = false; e.preventDefault(); return; }
    if (e.target.closest(".tag-badge, .swipe-delete")) return;
    if (row.classList.contains("is-open")) { row.classList.remove("is-open"); content.style.transform = ""; return; }
    openDetail(row.dataset.id);
  });
}

/* ================= 搜索动作 ================= */
async function doSearch() {
  const q = $("#searchInput").value.trim();
  if (!q) return;
  state.mode = "search";
  state.searchedFor = q;
  state.searchStatus = "loading"; state.results = []; state.resultsSource = ""; state.error = "";
  render();
  try {
    const r = await search(q);
    state.results = r.items; state.resultsSource = r.source; state.searchStatus = "done";
  } catch (e) {
    let msg = e && e.message ? e.message : String(e);
    if (!isNative() && !isBehindProxy()) msg += "（提示：直接打开文件无法跨域搜索，请运行 node server.js 后访问 http://localhost:8787）";
    state.error = "搜索失败：" + msg;
    state.searchStatus = "error";
  }
  render();
}
async function onLoadLyrics() {
  const s = getSong(state.detailId); if (!s) return;
  state.lyricsLoading = true; renderDetail();
  try {
    const r = await loadLyricsForSong(s);
    s.lyrics = r.lines; s.lyricsSource = r.source;
    saveLibrary();
    state.lyricsLoading = false; renderDetail();
    toast("已加载 " + r.lines.length + " 行歌词");
  } catch (e) {
    state.lyricsLoading = false; renderDetail();
    toast("加载失败：" + (e && e.message ? e.message : e));
  }
}

/* ================= 数据导入导出 ================= */
function exportData() {
  const blob = new Blob([JSON.stringify({ app: "singalong", version: 1, exportedAt: new Date().toISOString(), songs: library }, null, 2)], { type: "application/json" });
  const a = document.createElement("a");
  a.href = URL.createObjectURL(blob);
  a.download = "singalong-backup-" + new Date().toISOString().slice(0, 10) + ".json";
  document.body.appendChild(a); a.click(); a.remove();
  setTimeout(function () { URL.revokeObjectURL(a.href); }, 1500);
}
function importData(file) {
  const reader = new FileReader();
  reader.onload = function () {
    try {
      const data = JSON.parse(reader.result);
      const arr = Array.isArray(data) ? data : (data.songs || []);
      if (!Array.isArray(arr)) throw new Error("格式不正确");
      let added = 0;
      for (const raw of arr) {
        if (raw && raw.title && !library.some(function (x) { return songKey(x) === songKey(raw); })) {
          library.push(normalizeImported(raw)); added++;
        }
      }
      saveLibrary(); render();
      toast("导入完成，新增 " + added + " 首");
    } catch (e) { toast("导入失败：" + (e && e.message ? e.message : e)); }
  };
  reader.readAsText(file);
}

/* ================= 事件绑定 ================= */
function bindEvents() {
  const input = $("#searchInput");
  input.addEventListener("input", function () {
    $("#clearBtn").hidden = !input.value;
    const q = input.value.trim();
    if (!q) { setMode("library"); render(); return; }
    if (state.mode !== "search") state.mode = "search";
    if (q !== state.searchedFor) { state.searchStatus = "idle"; state.results = []; state.resultsSource = ""; }
    render();
  });
  input.addEventListener("keydown", function (e) { if (e.key === "Enter") doSearch(); });
  $("#searchBtn").addEventListener("click", doSearch);
  $("#clearBtn").addEventListener("click", function () {
    input.value = ""; $("#clearBtn").hidden = true; setMode("library"); render();
  });

  $("#filterRow").addEventListener("click", function (e) {
    const chip = e.target.closest(".chip"); if (!chip) return;
    state.filter = chip.dataset.filter;
    $$(".chip").forEach(function (c) { c.classList.toggle("active", c === chip); });
    render();
  });

  $$(".nav-item").forEach(function (b) {
    b.addEventListener("click", function () {
      setMode(b.dataset.mode);
      if (b.dataset.mode === "library") { input.value = ""; $("#clearBtn").hidden = true; }
      render();
    });
  });

  $("#main").addEventListener("click", function (e) {
    const add = e.target.closest("[data-action='add']");
    if (add) { const r = state.results[+add.dataset.idx]; if (r) addSong(r); return; }
    const tag = e.target.closest("[data-action='toggle-tag']");
    if (tag) { toggleTag(tag.dataset.id); return; }
    const del = e.target.closest("[data-action='remove']");
    if (del) { confirmRemove(del.dataset.id); return; }
    const retry = e.target.closest("[data-action='retry']");
    if (retry) { doSearch(); return; }
    const manual = e.target.closest("[data-action='manual']");
    if (manual) { openManualModal(); return; }
    const od = e.target.closest("[data-action='open-detail']");
    if (od) { openDetail(od.dataset.id); return; }
  });

  $("#detailBack").addEventListener("click", closeDetail);
  $("#detailBody").addEventListener("click", function (e) {
    const line = e.target.closest(".lyric-line");
    if (line) { openNoteModal(state.detailId, +line.dataset.line); return; }
    if (e.target.closest("[data-daction='toggle-tag']")) { toggleTag(state.detailId); return; }
    if (e.target.closest("[data-daction='load-lyrics']")) { onLoadLyrics(); return; }
    if (e.target.closest("[data-daction='paste-lyrics']")) { openPasteModal(state.detailId); return; }
    if (e.target.closest("[data-daction='edit']")) { openEditModal(state.detailId); return; }
    if (e.target.closest("[data-daction='remove']")) { const id = state.detailId; closeDetail(); confirmRemove(id); return; }
  });

  $("#settingsBtn").addEventListener("click", function () { renderSettings(); $("#settingsOverlay").hidden = false; });
  $("#settingsBack").addEventListener("click", function () { $("#settingsOverlay").hidden = true; });
  $("#settingsBody").addEventListener("click", function (e) {
    const seg = e.target.closest("[data-source]");
    if (seg) { settings.source = seg.dataset.source; saveSettings(); renderSettings(); return; }
    if (e.target.closest("#exportBtn")) { exportData(); return; }
    if (e.target.closest("#importBtn")) { $("#importFile").click(); return; }
    if (e.target.closest("#clearAllBtn")) {
      openConfirm("清空曲库", "确定删除全部已收录歌曲和备注吗？此操作不可恢复。", "清空", true, function () { library = []; saveLibrary(); render(); });
      return;
    }
  });

  $("#modalBackdrop").addEventListener("click", function (e) { if (e.target === $("#modalBackdrop")) closeModal(); });
}

/* ================= 初始化 ================= */
function init() {
  loadLibrary();
  loadSettings();
  const fileInput = document.createElement("input");
  fileInput.type = "file"; fileInput.accept = "application/json,.json"; fileInput.id = "importFile"; fileInput.hidden = true;
  fileInput.addEventListener("change", function (e) { const f = e.target.files[0]; if (f) importData(f); e.target.value = ""; });
  document.body.appendChild(fileInput);
  bindEvents();
  render();
}
init();