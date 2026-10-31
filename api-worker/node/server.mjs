/**
 * server.mjs —— api-worker 的 Node 自托管适配层(阿里云部署用)
 *
 * 零依赖:node:http + node:sqlite(Node≥22)+ 全局 undici fetch/Request/Response。
 * worker.js 业务代码零改动直接跑,差异只在运行时垫片:
 *   env.DB     → D1 接口垫片(prepare/bind/first/all/run,底座 node:sqlite)
 *   caches     → 内存版 caches.default(免费端点 5 分钟数据缓存)
 *   ctx        → waitUntil 即发即忘
 *   CF-Connecting-IP → 从 X-Forwarded-For / socket 地址注入(nginx 反代必配 X-Forwarded-For)
 *
 * 运行:  RL_ADMIN_TOKEN/RESEND_API_KEY/... 走环境变量,见下方 env 映射。
 *   node server.mjs                          # 监听 127.0.0.1:8787
 *   PORT=8787 RL_DB_FILE=/var/lib/rl/api.db node server.mjs
 *
 * systemd 常驻:
 *   ExecStart=/usr/bin/node /opt/relaylens/api-worker/node/server.mjs
 *   Environment=ADMIN_TOKEN=... RESEND_API_KEY=... FRONTEND_ORIGIN=https://aipaihangbang.cn/relay
 *
 * nginx(apiBase=https://aipaihangbang.cn/api):
 *   location /api/ {
 *     proxy_pass http://127.0.0.1:8787;      # 不带 URI,保留 /api/ 前缀(worker 路由依赖它)
 *     proxy_set_header Host $host;
 *     proxy_set_header X-Forwarded-Proto $scheme;
 *     proxy_set_header X-Forwarded-For $proxy_add_x_forwarded_for;
 *   }
 * GitHub OAuth 回调 redirect_uri 会落在 <本服务地址>/api/auth/github/callback,
 * 所以本服务必须挂在 /api/ 路径(域名根),不能塞进 /relay/ 子路径。
 */
import http from "node:http";
import fs from "node:fs";
import path from "node:path";
import { DatabaseSync } from "node:sqlite";
import worker from "../src/worker.js";

const PORT = Number(process.env.PORT || 8787);
const HOST = process.env.HOST || "127.0.0.1";
const DB_FILE = process.env.RL_DB_FILE || path.join(import.meta.dirname, "data", "api.db");

// ---- SQLite 底座:schema 幂等初始化 ----
fs.mkdirSync(path.dirname(DB_FILE), { recursive: true });
const db = new DatabaseSync(DB_FILE);
db.exec(fs.readFileSync(path.join(import.meta.dirname, "..", "schema.sql"), "utf8"));

// ---- D1 接口垫片:prepare(sql).bind(...).first()/all()/run() ----
// node:sqlite 对 INSERT/UPDATE 等无行返回语句调 get()/all() 会抛错,按 D1 语义吞掉并给空结果。
const DB = {
  prepare(sql) {
    let bound = [];
    const args = (p) => (p.length ? p : bound);
    return {
      bind(...p) { bound = p; return this; },
      async first(...p) {
        const stmt = db.prepare(sql);
        try { return stmt.get(...args(p)) ?? null; }
        catch {
          try { const rows = stmt.all(...args(p)); return rows[0] ?? null; }
          catch { return null; }
        }
      },
      async all(...p) {
        const stmt = db.prepare(sql);
        try { return { results: stmt.all(...args(p)) }; }
        catch { return { results: [] }; }
      },
      async run(...p) {
        const stmt = db.prepare(sql);
        try {
          const r = stmt.run(...args(p));
          return { meta: { changes: r.changes ?? 0 } };
        } catch {
          // RETURNING 语句等:用 all() 执行,行数近似 changes(admin decision 依赖 changes 判存在)
          try { const rows = stmt.all(...args(p)); return { meta: { changes: rows.length } }; }
          catch { return { meta: { changes: 0 } }; }
        }
      },
    };
  },
};

// ---- caches.default 垫片(内存,按 URL 键;免费端点只缓存 sites.json 一个条目) ----
const cacheStore = new Map();
globalThis.caches = {
  default: {
    async match(req) { return cacheStore.get(req.url); },
    async put(req, res) {
      cacheStore.set(req.url, res);
      if (cacheStore.size > 32) cacheStore.delete(cacheStore.keys().next().value);
    },
  },
};
const ctx = { waitUntil: (p) => { if (p && typeof p.catch === "function") p.catch(() => {}); } };

// ---- env 映射(与 wrangler vars/secrets 同名) ----
const env = {
  DB,
  SITE_ORIGIN: process.env.SITE_ORIGIN || "",
  FRONTEND_ORIGIN: process.env.FRONTEND_ORIGIN || "",
  RESEND_API_KEY: process.env.RESEND_API_KEY || "",
  MAIL_FROM: process.env.MAIL_FROM || "",
  GITHUB_CLIENT_ID: process.env.GITHUB_CLIENT_ID || "",
  GITHUB_CLIENT_SECRET: process.env.GITHUB_CLIENT_SECRET || "",
  ADMIN_TOKEN: process.env.ADMIN_TOKEN || "",
};

// ---- HTTP ↔ Request/Response 适配 ----
const server = http.createServer(async (req, res) => {
  try {
    const proto = String(req.headers["x-forwarded-proto"] || "http").split(",")[0].trim();
    const host = String(req.headers["x-forwarded-host"] || req.headers.host || `${HOST}:${PORT}`).split(",")[0].trim();
    const url = new URL(req.url, `${proto}://${host}`);
    const chunks = [];
    for await (const c of req) chunks.push(c);
    const body = chunks.length ? Buffer.concat(chunks) : undefined;
    const ip = String(req.headers["x-forwarded-for"] || "").split(",")[0].trim() || req.socket.remoteAddress || "?";
    const request = new Request(url, {
      method: req.method,
      headers: { ...req.headers, "cf-connecting-ip": ip },
      body: req.method === "GET" || req.method === "HEAD" ? undefined : body,
      duplex: "half",
    });
    const response = await worker.fetch(request, env, ctx);
    const headers = {};
    response.headers.forEach((v, k) => { headers[k] = v; });
    res.writeHead(response.status, headers);
    res.end(response.body ? Buffer.from(await response.arrayBuffer()) : undefined);
  } catch (e) {
    console.error("[relaylens-api]", req.method, req.url, e);
    if (!res.headersSent) res.writeHead(500, { "Content-Type": "application/json" });
    res.end(JSON.stringify({ error: "internal_error" }));
  }
});

server.listen(PORT, HOST, () => {
  console.log(`🧲 relaylens-api(Node 自托管) http://${HOST}:${PORT}`);
  console.log(`   数据库 ${DB_FILE}`);
  const optional = ["SITE_ORIGIN", "FRONTEND_ORIGIN", "RESEND_API_KEY", "MAIL_FROM", "GITHUB_CLIENT_ID", "GITHUB_CLIENT_SECRET", "ADMIN_TOKEN"];
  const missing = optional.filter(k => !process.env[k]);
  console.log(missing.length
    ? `   未配置(对应端点将返回 503 诚实提示):${missing.join(", ")}`
    : "   全部可选配置已就绪");
});
