/* 我会唱 - 本地预览服务器（开发用，可选） */
const http = require("http");
const https = require("https");
const fs = require("fs");
const path = require("path");
const { URL } = require("url");

const PORT = process.env.PORT || 8787;
const ROOT = path.resolve(path.join(__dirname, "www")) + path.sep;

const MIME = {
  ".html": "text/html; charset=utf-8",
  ".css": "text/css; charset=utf-8",
  ".js": "text/javascript; charset=utf-8",
  ".json": "application/json; charset=utf-8",
  ".webmanifest": "application/manifest+json; charset=utf-8",
  ".svg": "image/svg+xml",
  ".png": "image/png",
  ".ico": "image/x-icon",
};

async function readBody(req) {
  const chunks = [];
  for await (const c of req) chunks.push(c);
  return Buffer.concat(chunks).toString("utf8");
}

function rawRequest(target, method, headers, body, redirectCount) {
  return new Promise(function (resolve, reject) {
    let u;
    try { u = new URL(target); } catch (e) { reject(e); return; }
    const lib = u.protocol === "https:" ? https : http;
    const req = lib.request({
      protocol: u.protocol,
      hostname: u.hostname,
      port: u.port || (u.protocol === "https:" ? 443 : 80),
      path: u.pathname + u.search,
      method: method,
      headers: headers,
      family: 4,
    }, function (upstream) {
      const chunks = [];
      upstream.on("data", function (c) { chunks.push(c); });
      upstream.on("end", function () {
        const status = upstream.statusCode || 502;
        const location = upstream.headers.location;
        if (status >= 300 && status < 400 && location && (redirectCount || 0) < 5) {
          try {
            resolve(rawRequest(new URL(location, u).href, "GET", headers, "", (redirectCount || 0) + 1));
          } catch (e) { reject(e); }
          return;
        }
        resolve({ status: status, headers: upstream.headers, text: Buffer.concat(chunks).toString("utf8") });
      });
    });
    req.on("error", reject);
    if (body) req.write(body);
    req.end();
  });
}

async function handleProxy(req, res, reqUrl) {
  let target, method = "GET", body = "";
  if (req.method === "POST") {
    let raw = await readBody(req);
    let data = {};
    try { data = raw ? JSON.parse(raw) : {}; } catch (e) {}
    target = data.url; method = (data.method || "GET").toUpperCase(); body = data.body || "";
  } else {
    target = reqUrl.searchParams.get("url");
  }
  if (!target) { res.writeHead(400, { "Content-Type": "text/plain; charset=utf-8" }); res.end("missing url"); return; }
  const headers = {
    "User-Agent": "Mozilla/5.0 (Linux; Android 13; Pixel 7) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/120.0 Mobile Safari/537.36",
    "Accept-Language": "zh-CN,zh;q=0.9,en;q=0.8",
    "Accept": "*/*",
    "Accept-Encoding": "identity",
  };
  if (target.indexOf("music.163.com") >= 0) {
    headers["Referer"] = "https://music.163.com/";
    headers["Cookie"] = "appver=1.5.2";
  }
  if (method === "POST") headers["Content-Type"] = "application/x-www-form-urlencoded";
  const upstream = await rawRequest(target, method, headers, method === "POST" ? body : "", 0);
  res.writeHead(upstream.status, {
    "Content-Type": (upstream.headers["content-type"] || "text/plain; charset=utf-8"),
    "Access-Control-Allow-Origin": "*",
  });
  res.end(upstream.text);
}

function serveStatic(pathname, res) {
  let p = pathname === "/" ? "/index.html" : pathname;
  let file;
  try { file = path.resolve(path.join(ROOT, decodeURIComponent(p))); } catch (e) { res.writeHead(400); res.end("bad request"); return; }
  if (!file.startsWith(ROOT)) { res.writeHead(403); res.end("forbidden"); return; }
  fs.readFile(file, function (err, data) {
    if (err) { res.writeHead(404, { "Content-Type": "text/plain; charset=utf-8" }); res.end("Not found"); return; }
    const ext = path.extname(file).toLowerCase();
    res.writeHead(200, { "Content-Type": MIME[ext] || "application/octet-stream" });
    res.end(data);
  });
}

const server = http.createServer(function (req, res) {
  let reqUrl;
  try { reqUrl = new URL(req.url, "http://localhost"); } catch (e) { res.writeHead(400); res.end("bad request"); return; }
  if (reqUrl.pathname === "/proxy") { handleProxy(req, res, reqUrl).catch(function (e) { res.writeHead(502, { "Content-Type": "text/plain; charset=utf-8" }); res.end("Proxy error: " + e.message + (e.code ? " (" + e.code + ")" : "")); }); return; }
  serveStatic(reqUrl.pathname, res);
});

server.listen(PORT, function () {
  console.log("我会唱 本地预览已启动： http://localhost:" + PORT);
  console.log("手机同一 Wi-Fi 下访问： http://<本机局域网IP>:" + PORT);
});
