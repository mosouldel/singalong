"use strict";

/* ================= 常量与状态 ================= */
const STORAGE_KEY = "singalong.library.v1";
const SETTINGS_KEY = "singalong.settings.v1";
const REQUESTS_KEY = "singalong.requests.v1";
const LRCLIB = "https://lrclib.net/api";
const MOJIGECI = "https://mojigeci.com/zh-Hans";
const MOJIM = "https://mojim.org";
const NETEASE = "https://music.163.com";
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
  orderQuery: "",
};

let library = [];
let requests = [];
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
function srcLabel(src) {
  if (src === "lrclib") return "LRCLIB";
  if (src === "netease") return "网易云";
  if (src === "mojim") return "Mojim";
  return "魔镜歌词";
}

let toastTimer = null;
function hideToast() {
  const t = $("#toast");
  t.classList.remove("show");
  t.innerHTML = "";
}
function toast(msg) {
  const t = $("#toast");
  t.innerHTML = "";
  t.textContent = msg;
  t.classList.add("show");
  clearTimeout(toastTimer);
  toastTimer = setTimeout(hideToast, 2400);
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
  if (settings.source === "mojigeci") settings.source = "auto";
}
function saveSettings() {
  try { localStorage.setItem(SETTINGS_KEY, JSON.stringify(settings)); } catch (e) {}
}
function loadRequests() {
  try {
    const raw = localStorage.getItem(REQUESTS_KEY);
    const arr = raw ? JSON.parse(raw) : [];
    requests = Array.isArray(arr) ? arr : [];
  } catch (e) { requests = []; }
}
function saveRequests() {
  try { localStorage.setItem(REQUESTS_KEY, JSON.stringify(requests)); } catch (e) { toast("本地存储失败"); }
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
  const CapHttp = getNativePlugin("CapacitorHttp") || (window.Capacitor.Plugins && window.Capacitor.Plugins.CapacitorHttp);
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
  if (isNative()) {
    if (url.indexOf(LRCLIB) === 0 || url.indexOf(MOJIGECI) === 0) {
      // LRCLIB is CORS-enabled; try the WebView browser network stack first on mobile.
      // For mojigeci, also try WebView first, then fall back to the native HTTP bridge.
      try { return await webFetch(url, opts); }
      catch (e) { return await nativeHttp(url, opts); }
    }
    return nativeHttp(url, opts);
  }
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
    return webFetch(p.toString(), opts);
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
  const qq = encodeURIComponent(q);
  const fetchers = [];
  try {
    const cfg = await discoverMojigeciSearch();
    if (cfg.method === "post") {
      fetchers.push(function () {
        return fetchText(cfg.url, { method: "POST", body: new URLSearchParams({ [cfg.param]: q }).toString(), contentType: "application/x-www-form-urlencoded" });
      });
    } else {
      const sep = cfg.url.indexOf("?") >= 0 ? "&" : "?";
      fetchers.push(function () { return fetchText(cfg.url + sep + cfg.param + "=" + qq); });
    }
  } catch (e) {}
  if (String(MOJIGECI + "/search").indexOf("/zh-Hans/search") >= 0) {
    fetchers.push(function () { return fetchText("https://mojigeci.com/search?q=" + qq); });
  }
  fetchers.push(function () { return fetchText(MOJIGECI + "/artist/" + qq); });
  fetchers.push(function () { return fetchText(MOJIGECI + "/lyrics/" + qq); });
  const out = [];
  const seen = new Set();
  let lastErr = null;
  for (const getHtml of fetchers) {
    try {
      const html = await getHtml();
      for (const it of parseMojigeciSearch(html, q)) {
        const key = it.mojigeciUrl || it.id;
        if (seen.has(key)) continue;
        seen.add(key);
        out.push(it);
      }
    } catch (e) { lastErr = e; }
    if (out.length >= 40) break;
  }
  if (!out.length && lastErr) throw lastErr;
  return out;
}
function parseMojigeciSearch(html, mustContain) {
  if (mustContain && htmlToText(html).indexOf(mustContain) < 0) return [];
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
/* ================= 歌词源：Mojim（mojim.org，需 VPN） ================= */
function mojimArray(data) {
  if (Array.isArray(data)) return data;
  if (data && typeof data === "object") {
    for (const k of ["results", "data", "items", "songs", "tracks", "list"]) {
      if (Array.isArray(data[k])) return data[k];
    }
  }
  return [];
}
function mojimPick(obj, keys) {
  for (const k of keys) {
    if (obj && obj[k] != null && obj[k] !== "") return obj[k];
  }
  return "";
}
function extractLyricsLines(data) {
  const o = (data && typeof data === "object") ? data : {};
  const synced = mojimPick(o, ["syncedLyrics", "lrc"]);
  if (synced) { const l = parseLrc(String(synced)); if (l.length) return l; }
  const plain = mojimPick(o, ["plainLyrics", "lyrics", "lyric", "content", "text"]);
  if (typeof plain === "string") {
    const lines = String(plain).split(/\r?\n/).map(function (s) { return s.trim(); }).filter(Boolean);
    if (lines.length) return lines;
  }
  for (const k of ["lines", "lyricsLines"]) {
    if (Array.isArray(o[k]) && o[k].length) return o[k].map(function (s) { return String(s).trim(); }).filter(Boolean);
  }
  return [];
}
async function mojimSearch(q) {
  const url = MOJIM + "/api/v1/search?q=" + encodeURIComponent(q) + "&limit=30";
  const text = await fetchText(url, { headers: { Accept: "application/json" } });
  let data;
  try { data = JSON.parse(text); } catch (e) { data = []; }
  const arr = mojimArray(data);
  return arr.map(function (it) {
    const id = mojimPick(it, ["id", "song_id", "sid", "track_id", "trackId"]);
    const title = mojimPick(it, ["title", "name", "song_name", "track_name", "trackName", "song", "song_title"]);
    return {
      id: "mojim:" + (id || encodeURIComponent(title)),
      title: title,
      artist: mojimPick(it, ["artist", "artist_name", "artistName", "singer", "singer_name", "performers"]),
      album: mojimPick(it, ["album", "album_name", "albumName"]),
      lyricist: "", composer: "",
      source: "Mojim",
      mojimId: id,
    };
  }).filter(function (s) { return s.title; });
}
async function mojimLyrics(song) {
  let id = song.mojimId;
  if (!id) {
    const q = ((song.title || "") + " " + (song.artist || "未知歌手")).trim();
    const items = await mojimSearch(q);
    let hit = items.find(function (i) { return i.title === song.title || (song.title && i.title && (song.title.indexOf(i.title) >= 0 || i.title.indexOf(song.title) >= 0)); });
    if (!hit) hit = items[0];
    if (hit && hit.mojimId) id = hit.mojimId;
  }
  if (!id) throw new Error("Mojim 未找到该歌曲");
  const candidates = [MOJIM + "/api/v1/song/" + id, MOJIM + "/api/v1/lyrics/" + id, MOJIM + "/api/v1/get/" + id];
  let lastErr = null;
  for (const u of candidates) {
    try {
      const text = await fetchText(u, { headers: { Accept: "application/json" } });
      const data = JSON.parse(text);
      const lines = extractLyricsLines(data);
      if (lines.length) return { lines: lines, artist: "" };
    } catch (e) { lastErr = e; }
  }
  throw lastErr || new Error("Mojim 没有解析到歌词");
}

/* ================= 歌词源：网易云音乐 ================= */
function neteaseSongArray(data) {
  if (data && data.result && Array.isArray(data.result.songs)) return data.result.songs;
  return [];
}
async function neteaseSearch(q) {
  const url = NETEASE + "/api/search/get/web?csrf_token=hlpretag=&hlposttag=&s=" + encodeURIComponent(q) + "&type=1&offset=0&total=true&limit=30";
  const text = await fetchText(url, { headers: { Accept: "application/json", Referer: NETEASE + "/search/", "User-Agent": UA } });
  let data;
  try { data = JSON.parse(text); } catch (e) { return []; }
  return neteaseSongArray(data).map(function (it) {
    const artists = Array.isArray(it.artists) ? it.artists.map(function (a) { return a && a.name; }).filter(Boolean) : [];
    return {
      id: "netease:" + it.id,
      title: it.name || "",
      artist: artists.join("/") || "未知歌手",
      album: (it.album && it.album.name) || "",
      lyricist: "", composer: "",
      source: "网易云",
      neteaseId: it.id,
      duration: Math.round((it.duration || 0) / 1000) || 0,
    };
  }).filter(function (s) { return s.title; });
}
async function neteaseLyrics(song) {
  let id = song.neteaseId;
  if (!id) {
    const q = ((song.title || "") + " " + (song.artist || "未知歌手")).trim();
    const items = await neteaseSearch(q);
    let hit = items.find(function (i) { return i.title === song.title || (song.title && i.title && (song.title.indexOf(i.title) >= 0 || i.title.indexOf(song.title) >= 0)); });
    if (!hit) hit = items[0];
    if (hit && hit.neteaseId) id = hit.neteaseId;
  }
  if (!id) throw new Error("网易云未找到该歌曲");
  const url = NETEASE + "/api/song/lyric?id=" + encodeURIComponent(id) + "&lv=1&kv=1&tv=-1";
  const text = await fetchText(url, { headers: { Accept: "application/json", Referer: NETEASE + "/song?id=" + encodeURIComponent(id), "User-Agent": UA } });
  let data;
  try { data = JSON.parse(text); } catch (e) { data = {}; }
  const raw = (data.lrc && data.lrc.lyric) || (data.tlyric && data.tlyric.lyric) || "";
  const lines = parseLrc(raw);
  if (lines.length) return { lines: lines, artist: "" };
  throw new Error("网易云没有解析到歌词");
}

/* ================= 搜索与歌词编排 ================= */
async function search(q) {
  const sources = settings.source === "auto" ? ["lrclib", "netease", "mojim"] : [settings.source];
  let lastErr = null;
  let sawEmpty = false;
  for (const src of sources) {
    try {
      const items = await searchBySource(src, q);
      if (items && items.length) return { source: srcLabel(src), items: items };
      sawEmpty = true;
      lastErr = new Error("没有结果");
    } catch (e) { if (!sawEmpty) lastErr = e; }
  }
  throw lastErr || new Error("搜索失败");
}
async function searchBySource(src, q) {
  if (src === "lrclib") return lrclibSearch(q);
  if (src === "netease") return neteaseSearch(q);
  if (src === "mojim") return mojimSearch(q);
  if (src === "mojigeci") return mojigeciSearch(q);
  return [];
}
async function loadMoreResults() {
  const q = state.searchedFor;
  if (!q) return;
  toast("正在从网易云音乐补充…");
  try {
    const items = await neteaseSearch(q);
    const seen = new Set(state.results.map(function (r) { return songKey(r); }));
    let added = 0;
    for (const it of items) {
      const key = songKey(it);
      if (seen.has(key)) continue;
      seen.add(key);
      state.results.push(it);
      added++;
    }
    if (added) state.resultsSource = state.resultsSource + " + 网易云";
    render();
    toast(added ? "网易云补充了 " + added + " 条结果" : "网易云没有补充到新结果");
  } catch (e) {
    toast("网易云补充失败：" + (e && e.message ? e.message : e));
  }
}
async function loadLyricsForSong(song) {
  let lastErr = null;
  const order = ["lrclib", "netease", "mojim"].filter(function (src) {
    if (src === "lrclib" && !song.lrclibId) return false;
    return true;
  });
  for (const src of order) {
    try {
      const lines = await loadLyricsBySource(src, song);
      if (lines && lines.length) return { lines: lines, source: srcLabel(src) };
      lastErr = new Error("没有歌词");
    } catch (e) { lastErr = e; }
  }
  throw lastErr || new Error("歌词加载失败");
}
async function loadLyricsBySource(src, song) {
  if (src === "lrclib") return lrclibLyrics(song);
  if (src === "netease") return neteaseLyrics(song);
  if (src === "mojim") {
    const res = await mojimLyrics(song);
    if (res.artist && (!song.artist || song.artist === "未知歌手")) song.artist = res.artist;
    return res.lines;
  }
  if (src === "mojigeci") {
    const res = await mojigeciLyrics(song);
    if (res.artist && (!song.artist || song.artist === "未知歌手")) song.artist = res.artist;
    return res.lines;
  }
  throw new Error("未知歌词来源");
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
    mojimId: raw.mojimId || null,
    neteaseId: raw.neteaseId || null,
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
    mojimId: raw.mojimId || null,
    neteaseId: raw.neteaseId || null,
    tag: raw.tag === "想学" ? "想学" : "会唱",
    addedAt: raw.addedAt || Date.now(),
    lyrics: Array.isArray(raw.lyrics) ? raw.lyrics : [],
    notes: raw.notes && typeof raw.notes === "object" ? raw.notes : {},
  };
}
/* ================= 点歌（点歌记录） ================= */
function pad2(n) { return (n < 10 ? "0" : "") + n; }
function dateKeyOf(d) { return d.getFullYear() + "-" + pad2(d.getMonth() + 1) + "-" + pad2(d.getDate()); }
function todayKey() { return dateKeyOf(new Date()); }
function fmtDateKey(k) {
  const parts = String(k).split("-");
  if (parts.length !== 3) return String(k);
  return parts[0] + "年" + Number(parts[1]) + "月" + Number(parts[2]) + "日";
}
function fmtTime(ts) {
  const d = new Date(ts);
  return pad2(d.getHours()) + ":" + pad2(d.getMinutes());
}
function todayCount(key) {
  const tk = todayKey();
  return requests.filter(function (r) { return r.key === key && r.dateKey === tk; }).length;
}
function isOrderedToday(key) { return todayCount(key) > 0; }
function makeRequest(song) {
  const d = new Date();
  return {
    id: uid(),
    key: songKey(song),
    title: song.title,
    artist: song.artist || "未知歌手",
    dateKey: dateKeyOf(d),
    createdAt: d.getTime(),
  };
}
function orderSong(song) {
  if (!song) return;
  requests.push(makeRequest(song));
  saveRequests();
  render();
  toast("已点歌「" + song.title + "」");
}
function orderSongById(id) {
  const s = getSong(id); if (!s) return;
  orderSong(s);
}
function openEditCountModal(songId) {
  const s = getSong(songId); if (!s) return;
  const n = todayCount(songKey(s));
  $("#modalCard").innerHTML =
    '<h3>编辑今日点歌次数</h3>'
    + '<p class="ml">' + esc(s.title) + ' · ' + esc(s.artist) + '</p>'
    + '<div class="form"><label>今日点歌次数</label><input id="ecInput" type="number" min="0" max="99" inputmode="numeric" value="' + n + '"></div>'
    + '<div class="modal-actions"><button class="btn-cancel" id="ecCancel" type="button">取消</button>'
    + '<button class="btn-primary" id="ecSave" type="button">保存</button></div>';
  showModal();
  $("#ecCancel").onclick = closeModal;
  $("#ecSave").onclick = function () {
    let target = parseInt($("#ecInput").value, 10);
    if (isNaN(target)) target = 0;
    target = Math.max(0, Math.min(99, target));
    closeModal();
    editTodayCount(s, target);
  };
}
function editTodayCount(song, target) {
  const key = songKey(song);
  const tk = todayKey();
  const todayRecs = requests.filter(function (r) { return r.key === key && r.dateKey === tk; });
  const current = todayRecs.length;
  if (target === current) return;
  if (target > current) {
    for (let i = 0; i < target - current; i++) requests.push(makeRequest(song));
  } else {
    const sorted = todayRecs.slice().sort(function (a, b) { return b.createdAt - a.createdAt; });
    const removeIds = new Set(sorted.slice(0, current - target).map(function (r) { return r.id; }));
    requests = requests.filter(function (r) { return !removeIds.has(r.id); });
  }
  saveRequests();
  render();
  toast("今日点歌次数已设为 " + target);
}
let skipConfirmSession = false;
function openConfirmWithSkip(title, msg, okText, danger, onOk) {
  if (skipConfirmSession) { onOk && onOk(); return; }
  $("#modalCard").innerHTML =
    '<h3>' + esc(title) + '</h3>'
    + '<p class="ml">' + esc(msg) + '</p>'
    + '<label class="check-row"><input type="checkbox" id="cfSkip"><span>本次打开 App 不再提醒</span></label>'
    + '<div class="modal-actions"><button class="btn-cancel" id="cfCancel" type="button">取消</button>'
    + '<button class="' + (danger ? "btn-danger" : "btn-primary") + '" id="cfOk" type="button">' + esc(okText) + '</button></div>';
  showModal();
  $("#cfCancel").onclick = closeModal;
  $("#cfOk").onclick = function () {
    const skip = $("#cfSkip") && $("#cfSkip").checked;
    closeModal();
    if (skip) skipConfirmSession = true;
    onOk && onOk();
  };
}
function eligibleRandomSongs() {
  return library.filter(function (s) { return !isOrderedToday(songKey(s)); });
}
let randomCandidate = null;
function pickRandom() {
  const eligible = eligibleRandomSongs();
  if (!eligible.length) { closeModal(); toast("今天能点的歌都点过啦"); return; }
  randomCandidate = eligible[Math.floor(Math.random() * eligible.length)];
  $("#modalCard").innerHTML =
    '<h3>随机点歌</h3>'
    + '<p class="ml">今天还没点过，就唱这首吧：</p>'
    + '<div class="rand-song"><div class="t">' + esc(randomCandidate.title) + '</div><div class="a">' + esc(randomCandidate.artist) + '</div></div>'
    + '<div class="modal-actions"><button class="btn-cancel" id="randAgain" type="button">重新随机</button>'
    + '<button class="btn-primary" id="randOk" type="button">点这首</button></div>';
  showModal();
  $("#randAgain").onclick = pickRandom;
  $("#randOk").onclick = function () { const s = randomCandidate; closeModal(); orderSong(s); };
}
function openRandomOrder() {
  if (!library.length) { toast("曲库还是空的，先去收录几首歌"); return; }
  if (!eligibleRandomSongs().length) { toast("今天能点的歌都点过啦"); return; }
  pickRandom();
}
function orderHistoryGroups() {
  const tk = todayKey();
  const past = requests.filter(function (r) { return r.dateKey !== tk; });
  const map = new Map();
  for (const r of past) {
    if (!map.has(r.dateKey)) map.set(r.dateKey, []);
    map.get(r.dateKey).push(r);
  }
  const keys = Array.from(map.keys()).sort().reverse();
  return keys.map(function (k) {
    return { dateKey: k, records: map.get(k).sort(function (a, b) { return b.createdAt - a.createdAt; }) };
  });
}
function openOrderHistory() {
  renderOrderHistory();
  $("#orderHistoryOverlay").hidden = false;
}
function renderOrderHistory() {
  const groups = orderHistoryGroups();
  if (!groups.length) {
    $("#orderHistoryBody").innerHTML = '<div class="empty"><div class="big">🕘</div><p class="t">还没有历史点歌</p><p class="d">点过的歌会按日期汇总在这里。</p></div>';
    return;
  }
  let html = '<p class="hint" style="margin:0 0 10px">仅显示今天以前的点歌记录。</p>';
  for (const g of groups) {
    html += '<div class="hist-group">'
      + '<div class="hist-head"><span>' + esc(fmtDateKey(g.dateKey)) + ' · ' + g.records.length + ' 条</span>'
      + '<button class="hist-del" data-action="order-history-remove-day" data-date="' + esc(g.dateKey) + '" type="button">删除当日</button></div>'
      + g.records.map(function (r) {
          return '<div class="hist-row">'
            + '<div class="song-main"><div class="song-title">' + esc(r.title) + '</div><div class="song-sub">' + esc(r.artist) + ' · ' + fmtTime(r.createdAt) + '</div></div>'
            + '<button class="hist-del" data-action="order-history-remove" data-id="' + esc(r.id) + '" type="button">删除</button>'
            + '</div>';
        }).join("")
      + '</div>';
  }
  $("#orderHistoryBody").innerHTML = html;
}
function confirmRemoveRequest(id) {
  const r = requests.find(function (x) { return x.id === id; });
  if (!r) return;
  openConfirmWithSkip("删除点歌记录", "确定删除「" + r.title + " · " + r.artist + "」这条点歌记录吗？", "删除", true, function () {
    requests = requests.filter(function (x) { return x.id !== id; });
    saveRequests(); renderOrderHistory(); render();
  });
}
function confirmRemoveRequestDay(dateKey) {
  const n = requests.filter(function (x) { return x.dateKey === dateKey; }).length;
  openConfirmWithSkip("删除当日点歌", "确定删除 " + fmtDateKey(dateKey) + " 的全部 " + n + " 条点歌记录吗？", "删除", true, function () {
    requests = requests.filter(function (x) { return x.dateKey !== dateKey; });
    saveRequests(); renderOrderHistory(); render();
  });
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
  else if (state.mode === "order") main.innerHTML = renderOrder();
  else main.innerHTML = renderStats();
  afterRenderMain();
}
function afterRenderMain() {
  if (state.mode === "library") $$(".swipe-row").forEach(attachRowGestures);
  if (state.mode === "order") {
    const inp = $("#orderSearchInput");
    if (inp) inp.addEventListener("input", function () {
      state.orderQuery = this.value;
      const listEl = $("#orderList");
      if (listEl) listEl.innerHTML = orderListHtml();
    });
  }
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
    if (state.resultsSource === "LRCLIB" && state.results.length >= 20) {
      html += '<div class="more-row"><button class="load-btn" data-action="more-results" type="button">LRCLIB 最多返回 20 条，点这里用网易云补充更多</button></div>';
    }
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
  if (!library.length && !requests.length) {
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
  const sung = sungCountList();
  html += '<div class="section-label">唱过次数（累计点歌 ' + requests.length + ' 次）</div>';
  if (!sung.length) {
    html += '<p class="hint" style="margin:0 4px 12px">还没有点歌记录，去「点歌」页签点一首吧。</p>';
  } else {
    const maxSung = Math.max.apply(null, sung.map(function (x) { return x.n; }));
    html += sung.slice(0, 15).map(function (x) {
      return '<div class="bar-row"><span class="bar-name">' + esc(x.title) + '</span><div class="bar-track"><div class="bar-fill" style="width:' + Math.round(x.n / Math.max(1, maxSung) * 100) + '%"></div></div><span class="bar-num">' + x.n + '</span></div>';
    }).join("");
  }
  html += '<div class="section-label">最近收录</div>';
  html += recent.map(function (s) {
    const badge = s.tag === "会唱" ? "tag-can" : "tag-want";
    return '<div class="song-row"><div class="song-main"><div class="song-title">' + esc(s.title) + '</div><div class="song-sub">' + esc(s.artist) + '</div></div>'
      + '<button class="tag-badge ' + badge + '" data-action="open-detail" data-id="' + esc(s.id) + '" type="button">' + esc(s.tag) + '</button></div>';
  }).join("");
  return html;
}
function renderOrder() {
  return '<div class="order-toolbar">'
    + '<button class="order-btn primary" data-action="random-order" type="button">🎲 随机点歌</button>'
    + '<button class="order-btn" data-action="open-order-history" type="button">🕘 点歌历史</button>'
    + '</div>'
    + '<div class="order-search"><input id="orderSearchInput" type="search" placeholder="搜已收录的歌" autocomplete="off" value="' + esc(state.orderQuery || "") + '"></div>'
    + '<div id="orderList">' + orderListHtml() + '</div>';
}
function orderListHtml() {
  const q = (state.orderQuery || "").trim().toLowerCase();
  let list = library.slice().sort(byAddedDesc);
  if (q) list = list.filter(function (s) { return (s.title || "").toLowerCase().indexOf(q) >= 0 || (s.artist || "").toLowerCase().indexOf(q) >= 0; });
  if (!library.length) return '<div class="empty"><div class="big">🎤</div><p class="t">曲库还是空的</p><p class="d">先去「我的曲库」收录几首歌吧</p></div>';
  if (!list.length) return '<div class="empty"><div class="big">🔍</div><p class="t">没找到已收录的歌</p><p class="d">换个关键词试试</p></div>';
  return list.map(orderRowHtml).join("");
}
function orderRowHtml(s) {
  const n = todayCount(songKey(s));
  const hint = n ? '<div class="today-count"><span class="today-hint">今日已点 ' + n + ' 次</span><button class="edit-count" data-action="edit-count" data-id="' + esc(s.id) + '" type="button">编辑次数</button></div>' : '';
  return '<div class="song-row">'
    + '<div class="song-main"><div class="song-title">' + esc(s.title) + '</div><div class="song-sub">' + esc(s.artist) + '</div>' + hint + '</div>'
    + '<button class="add-btn" data-action="order" data-id="' + esc(s.id) + '" type="button">点歌</button>'
    + '</div>';
}
function sungCountList() {
  const m = new Map();
  for (const r of requests) {
    if (!m.has(r.key)) m.set(r.key, { title: r.title, artist: r.artist, n: 0 });
    m.get(r.key).n++;
  }
  return Array.from(m.values()).sort(function (a, b) { return b.n - a.n; });
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
    + '<div class="setting-row"><span class="k"></span><div class="seg">' + seg("auto", "自动") + seg("lrclib", "LRCLIB") + seg("netease", "网易云") + seg("mojim", "Mojim") + '</div></div>'
    + '<p class="hint">自动：先试 LRCLIB（最稳），再试网易云（模糊搜索、港乐较全），最后试 Mojim（需开 VPN）。</p>'
    + '</div>'
    + '<div class="setting-group">'
    + '<div class="setting-row"><span class="k">数据备份</span></div>'
    + '<div class="setting-row"><span class="k">导出备份</span><button class="add-btn" id="exportBtn" type="button">导出</button></div>'
    + '<div class="setting-row"><span class="k">导入备份</span><button class="add-btn" id="importBtn" type="button">导入</button></div>'
    + '</div>'
    + '<div class="setting-group">'
    + '<div class="setting-row"><span class="k">清空全部数据</span><button class="danger-btn" id="clearAllBtn" type="button">清空</button></div>'
    + '</div>'
    + '<p class="hint">数据只保存在本机（浏览器/App 本地存储），不上传任何服务器。出门前建议先「导出」备份。</p>'
    + '<div class="signature">作者：Song</div>';
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
function getNativePlugin(name) {
  try {
    if (window.Capacitor && window.Capacitor.Plugins && window.Capacitor.Plugins[name]) return window.Capacitor.Plugins[name];
  } catch (e) {}
  try {
    if (window.Capacitor && window.Capacitor.registerPlugin) return window.Capacitor.registerPlugin(name);
  } catch (e) {}
  return null;
}
function exportPayload() {
  return JSON.stringify({ app: "singalong", version: 2, exportedAt: new Date().toISOString(), songs: library, requests: requests }, null, 2);
}
function downloadBlob(name, payload) {
  const blob = new Blob([payload], { type: "application/json" });
  const a = document.createElement("a");
  a.href = URL.createObjectURL(blob);
  a.download = name;
  document.body.appendChild(a); a.click(); a.remove();
  setTimeout(function () { URL.revokeObjectURL(a.href); }, 1500);
}
async function exportData() {
  const name = "singalong-backup-" + new Date().toISOString().slice(0, 10) + ".json";
  const payload = exportPayload();
  if (isNative()) {
    try {
      await shareFile(name, payload);
      return;
    } catch (e) {}
    const Filesystem = getNativePlugin("Filesystem");
    const Share = getNativePlugin("Share");
    if (Filesystem && Share) {
      try {
        const res = await Filesystem.writeFile({ path: name, data: payload, directory: "CACHE", encoding: "UTF8", recursive: true });
        await Share.share({ title: "我会唱 数据备份", text: "Singalong 曲库备份", url: res.uri, dialogTitle: "导出曲库" });
        return;
      } catch (e) {
        toast("导出失败：" + (e && e.message ? e.message : e));
        return;
      }
    }
    toast("导出失败：系统分享不可用");
    return;
  }
  downloadBlob(name, payload);
  toast("已导出");
}
function shareFile(name, payload) {
  return new Promise(function (resolve, reject) {
    if (!navigator.share) { reject(new Error("无系统分享")); return; }
    try {
      const file = new File([payload], name, { type: "application/json" });
      const data = { title: "我会唱 数据备份", text: "Singalong 曲库备份", files: [file] };
      if (navigator.canShare && !navigator.canShare(data)) { reject(new Error("系统不支持分享文件")); return; }
      navigator.share(data).then(function () { resolve(true); }, reject);
    } catch (e) { reject(e); }
  });
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
      let addedRequests = 0;
      if (Array.isArray(data.requests)) {
        const have = new Set(requests.map(function (r) { return r.id; }));
        for (const raw of data.requests) {
          if (!raw) continue;
          const id = raw.id || uid();
          if (have.has(id)) continue;
          have.add(id);
          requests.push({
            id: id,
            key: raw.key || (((raw.title || "") + "||" + (raw.artist || "")).toLowerCase()),
            title: raw.title || "",
            artist: raw.artist || "未知歌手",
            dateKey: raw.dateKey || (raw.createdAt ? dateKeyOf(new Date(raw.createdAt)) : todayKey()),
            createdAt: raw.createdAt || Date.now(),
          });
          addedRequests++;
        }
      }
      saveLibrary(); saveRequests(); render();
      toast("导入完成：新增 " + added + " 首，恢复 " + addedRequests + " 条点歌记录");
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
    const ord = e.target.closest("[data-action='order']");
    if (ord) { orderSongById(ord.dataset.id); return; }
    const ec = e.target.closest("[data-action='edit-count']");
    if (ec) { openEditCountModal(ec.dataset.id); return; }
    const rnd = e.target.closest("[data-action='random-order']");
    if (rnd) { openRandomOrder(); return; }
    const oh = e.target.closest("[data-action='open-order-history']");
    if (oh) { openOrderHistory(); return; }
    const more = e.target.closest("[data-action='more-results']");
    if (more) { loadMoreResults(); return; }
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

  $("#orderHistoryBack").addEventListener("click", function () { $("#orderHistoryOverlay").hidden = true; });
  $("#orderHistoryBody").addEventListener("click", function (e) {
    const rm = e.target.closest("[data-action='order-history-remove']");
    if (rm) { confirmRemoveRequest(rm.dataset.id); return; }
    const rmd = e.target.closest("[data-action='order-history-remove-day']");
    if (rmd) { confirmRemoveRequestDay(rmd.dataset.date); return; }
  });
  $("#modalBackdrop").addEventListener("click", function (e) { if (e.target === $("#modalBackdrop")) closeModal(); });
}

/* ================= 初始化 ================= */
function init() {
  loadLibrary();
  loadRequests();
  loadSettings();
  const fileInput = document.createElement("input");
  fileInput.type = "file"; fileInput.accept = "application/json,.json"; fileInput.id = "importFile"; fileInput.hidden = true;
  fileInput.addEventListener("change", function (e) { const f = e.target.files[0]; if (f) importData(f); e.target.value = ""; });
  document.body.appendChild(fileInput);
  bindEvents();
  render();
}
init();
