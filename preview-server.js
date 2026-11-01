#!/usr/bin/env node
/**
 * preview-server.js —— 本地预览一体化服务(替代 `python -m http.server 5173 -d relaylens-home`)
 *
 * 把静态站与比价看板挂到同一个 5173 源下,消除"其它页 5173、比价页 8899"的端口割裂:
 *   /              → relaylens-home/ 静态文件
 *   /price/…       → 反代 127.0.0.1:8899/…(模型比价看板,RelayLens 的「模型比价」页)
 *   /api/…         → 反代 127.0.0.1:8899/api/…(看板数据接口)
 *
 * 用法:
 *   1. 先启动看板   python relay_scraper.py serve --port 8899
 *      (建议带 RELAY_HOME_URL=http://127.0.0.1:5173/index.html 和 RELAY_SELF_URL=/price/,
 *       这样看板页内导航的站内链接与本页链接都在 5173 源下)
 *   2. node preview-server.js
 *   3. 打开 http://127.0.0.1:5173/
 *
 * 生产环境不需要本文件:nginx 反代 /price/ → 127.0.0.1:8899 即可,形态与本服务一致。
 */
const http = require("http");
const fs = require("fs");
const path = require("path");

const PORT = Number(process.env.PREVIEW_PORT || 5173);
const ROOT = path.join(__dirname, "relaylens-home");
const DASH = { host: "127.0.0.1", port: Number(process.env.DASHBOARD_PORT || 8899) };
const MIME = {
  ".html": "text/html; charset=utf-8", ".css": "text/css; charset=utf-8",
  ".js": "text/javascript; charset=utf-8", ".mjs": "text/javascript; charset=utf-8",
  ".json": "application/json; charset=utf-8", ".svg": "image/svg+xml",
  ".png": "image/png", ".jpg": "image/jpeg", ".webp": "image/webp",
  ".ico": "image/x-icon", ".txt": "text/plain; charset=utf-8", ".xml": "application/xml",
};

function proxy(req, res) {
  /* 看板令牌门(可选):本进程环境变量 RL_DASH_TOKEN 设置时,自动给反代请求注入
     X-RL-Token 头 —— 与看板侧 relay_scraper.py 的令牌门配对;不设置则行为不变 */
  const headers = { ...req.headers, host: `${DASH.host}:${DASH.port}` };
  if (process.env.RL_DASH_TOKEN) headers["X-RL-Token"] = process.env.RL_DASH_TOKEN;
  const up = http.request(
    { host: DASH.host, port: DASH.port, path: req.url, method: req.method, headers },
    (r) => { res.writeHead(r.statusCode || 502, r.headers); r.pipe(res); }
  );
  /* 页面间快速切换会掐断在途请求(如 388KB 的 /api/summary),流错误必须吞掉,
     否则 unhandled 'error' 直接击穿进程 —— 曾致切几次页后预览服务整个挂掉 */
  req.on("error", () => {});
  res.on("error", () => {});
  up.on("error", (e) => {
    console.error("[proxy]", req.url, "-", e.message);
    if (res.headersSent) { res.destroy(); return; }
    res.writeHead(502, { "Content-Type": "text/html; charset=utf-8" });
    res.end('<p style="font-family:sans-serif">比价看板未启动或无响应。请在看板项目目录运行:'
      + '<code>python relay_scraper.py serve --port ' + DASH.port + "</code></p>");
  });
  req.pipe(up);
}

const server = http.createServer((req, res) => {
  req.on("error", () => {});
  res.on("error", () => {});
  let u;
  try { u = new URL(req.url, "http://localhost"); } catch { res.writeHead(400); res.end(); return; }
  let p;
  try { p = decodeURIComponent(u.pathname); } catch { p = u.pathname; }

  /* 旧路径迁移(2026-10-28 比价外迁):老缓存/老书签/老外链里的 price.html、compare.html
     301 到 /price/,不再落 404(浏览器根本不会把 #锚点 发上来,query 已保留) */
  if (p === "/price.html" || p === "/compare.html" || p === "/compare") {
    res.writeHead(301, { Location: "/price/" + (u.search || "") });
    res.end();
    return;
  }

  /* 比价看板挂载点:/price/… → 看板根;/api/… → 看板接口(其余路径不动) */
  if (p === "/price" || p.startsWith("/price/") || p.startsWith("/api/")) {
    req.url = p.startsWith("/api/") ? req.url : (req.url.replace(/^\/price/, "") || "/");
    proxy(req, res);
    return;
  }

  /* 静态文件(限定在 relaylens-home 内,防目录穿越) */
  let file = path.normalize(path.join(ROOT, p === "/" ? "index.html" : p));
  if (!file.startsWith(ROOT)) { res.writeHead(403); res.end("403"); return; }
  fs.stat(file, (err, st) => {
    if (!err && st.isDirectory()) file = path.join(file, "index.html");
    fs.readFile(file, (err2, buf) => {
      if (err2) { res.writeHead(404, { "Content-Type": "text/plain; charset=utf-8" }); res.end("404 Not Found"); return; }
      /* HTML 一律 no-cache:防止浏览器拿旧版页面(旧导航指向已删除的 price.html)继续点出 404 */
      res.writeHead(200, { "Content-Type": MIME[path.extname(file).toLowerCase()] || "application/octet-stream",
        "Cache-Control": path.extname(file).toLowerCase() === ".html" ? "no-cache" : "public, max-age=3600" });
      res.end(buf);
    });
  });
});

server.on("clientError", (err, socket) => {
  if (socket.writable) socket.end("HTTP/1.1 400 Bad Request\r\n\r\n");
});
/* 开发服务器要命硬:任何漏网异常只记日志,不许把进程带走 */
process.on("uncaughtException", (e) => console.error("[uncaught]", e && e.message));
process.on("unhandledRejection", (e) => console.error("[rejection]", e && (e.message || e)));

server.listen(PORT, "127.0.0.1", () => {
  console.log(`preview: http://127.0.0.1:${PORT}/  (静态站)  |  /price/ → 比价看板 ${DASH.host}:${DASH.port}`);
});
