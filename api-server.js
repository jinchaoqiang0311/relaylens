"use strict";
/* RelayLens API Server (Aliyun edition) - Node port of api-worker.
 * Same routes; D1 replaced by local relaylens.sqlite (same DB as the probe).
 * Env: RL_DB, RL_PORT, ADMIN_TOKEN, RESEND_API_KEY or SMTP_*, GITHUB_CLIENT_ID/SECRET, FRONTEND_ORIGIN */
const http = require("node:http");
const fs = require("node:fs");
const path = require("node:path");
const crypto = require("node:crypto");
const { DatabaseSync } = require("node:sqlite");

const ROOT = __dirname; // 仓库根(api-server.js 所在目录)
const DB_PATH = process.env.RL_DB || path.join(ROOT, "relaylens", "probe", "store", "relaylens.sqlite");
const HOME = path.join(ROOT, "relaylens-home");
const PORT = Number(process.env.RL_PORT || 8787);
const SITE_ORIGIN = process.env.FRONTEND_ORIGIN || "https://aipaihangbang.cn";

const db = new DatabaseSync(DB_PATH);
db.exec("PRAGMA journal_mode=WAL");

const CORS = {
  "Access-Control-Allow-Origin": "*",
  "Access-Control-Allow-Methods": "GET, POST, OPTIONS",
  "Access-Control-Allow-Headers": "Content-Type, Authorization, X-Admin-Token",
};
function json(res, obj, status, extra) {
  res.writeHead(status || 200, Object.assign({ "Content-Type": "application/json; charset=utf-8" }, CORS, extra || {}));
  res.end(JSON.stringify(obj));
}
const sha256hex = (s) => crypto.createHash("sha256").update(s).digest("hex");
const apiKey = () => "rl_" + crypto.randomBytes(24).toString("hex");
const uuid = () => crypto.randomUUID();
const nowIso = () => new Date().toISOString();
/* readJson 定义于下方(后者生效) */

let _mailer = null;
function mailer() {
  if (_mailer !== null) return _mailer;
  if (process.env.RESEND_API_KEY) {
    _mailer = async (to, subject, text) => {
      const r = await fetch("https://api.resend.com/emails", {
        method: "POST",
        headers: { Authorization: "Bearer " + process.env.RESEND_API_KEY, "Content-Type": "application/json" },
        body: JSON.stringify({ from: process.env.MAIL_FROM || "RelayLens <noreply@aipaihangbang.cn>", to: [to], subject, text }),
      });
      if (!r.ok) throw new Error("resend HTTP " + r.status);
    };
  } else if (process.env.SMTP_HOST) {
    const nodemailer = require("nodemailer");
    const t = nodemailer.createTransport({
      host: process.env.SMTP_HOST, port: Number(process.env.SMTP_PORT || 465), secure: true,
      auth: { user: process.env.SMTP_USER, pass: process.env.SMTP_PASS },
    });
    _mailer = async (to, subject, text) => t.sendMail({ from: process.env.MAIL_FROM || "RelayLens <noreply@aipaihangbang.cn>", to, subject, text });
  } else _mailer = false;
  return _mailer;
}

function rateLimited(subject, limit) {
  const minute = nowIso().slice(0, 16);
  const row = db.prepare("SELECT n FROM usage WHERE subject=? AND minute=?").get(subject, minute);
  const n = (row ? row.n : 0) + 1;
  if (row) db.prepare("UPDATE usage SET n=? WHERE subject=? AND minute=?").run(n, subject, minute);
  else db.prepare("INSERT INTO usage(subject, minute, n) VALUES(?,?,?)").run(subject, minute, n);
  return n > limit;
}

function upsertUserAndSession(provider, identity, display) {
  let u = db.prepare("SELECT id FROM users WHERE provider=? AND identity=?").get(provider, identity);
  const uid = u ? u.id : uuid();
  if (!u) db.prepare("INSERT INTO users(id, provider, identity, display, created_at) VALUES(?,?,?,?,?)")
    .run(uid, provider, identity, display, nowIso());
  else if (display) db.prepare("UPDATE users SET display=? WHERE id=?").run(display, uid);
  const token = crypto.randomBytes(24).toString("hex");
  const exp = new Date(Date.now() + 30 * 86400e3).toISOString();
  db.prepare("INSERT INTO sessions(token, user_id, created_at, expires_at) VALUES(?,?,?,?)").run(token, uid, nowIso(), exp);
  return { token, expires_at: exp, user: { id: uid, provider, display } };
}
function sessionUser(req) {
  const m = (req.headers.authorization || "").match(/^Bearer\s+(.+)$/i);
  if (!m) return null;
  const row = db.prepare(
    "SELECT s.user_id, s.expires_at, u.provider, u.display FROM sessions s JOIN users u ON u.id=s.user_id WHERE s.token=?"
  ).get(m[1].trim());
  if (!row || new Date(row.expires_at) < new Date()) return null;
  return { user_id: row.user_id, provider: row.provider, display: row.display };
}

function sitesData() { return JSON.parse(fs.readFileSync(path.join(HOME, "data", "sites.json"), "utf8")); }
function dataVersion() {
  try { return JSON.parse(fs.readFileSync(path.join(ROOT, "shared", "weights.json"), "utf8")).version; } catch (e) { return null; }
}
function META() {
  const d = sitesData();
  return { updated: (d.meta && d.meta.updated) || null, version: (d.meta && d.meta.weightsVersion) || dataVersion(), license: "CC BY 4.0" };
}
function freeEndpoint(url, res) {
  const d = sitesData();
  const ep = url.pathname.replace(/\/+$/, "").split("/").pop();
  const qp = url.searchParams;
  if (ep === "meta") return json(res, Object.assign(META(), { sites: (d.realSites || []).length, reference: (d.referenceSites || []).length }));
  if (ep === "ranking") {
    const scene = qp.get("scene") || "all";
    const model = qp.get("model");
    const fields = (qp.get("fields") || "").split(",").map(function(s){return s.trim()}).filter(Boolean);
    let rows = (d.realSites || []).filter(function(s){ return !model || (s.models || []).includes(model); });
    if (fields.length) rows = rows.map(function(s){ return Object.fromEntries(Object.entries(s).filter(function(k){ return fields.includes(k[0]); })); });
    return json(res, Object.assign(META(), { scene, count: rows.length, sites: rows }));
  }
  if (ep === "prices") {
    const model = qp.get("model");
    const honestOnly = qp.get("honest_only") === "true";
    let rows = (d.compare && d.compare.rows) || d.compare || [];
    if (Array.isArray(rows) && model) rows = rows.filter(function(r){ return String(r.model || "").toLowerCase().includes(model.toLowerCase()); });
    if (honestOnly) rows = rows.filter(function(r){ return (r.dev == null ? 99 : r.dev) <= 1; });
    return json(res, Object.assign(META(), { count: rows.length, prices: rows }));
  }
  if (ep === "blacklist") {
    const state = qp.get("state");
    let rows = d.blacklist || [];
    if (state) rows = rows.filter(function(r){ return r.state === state; });
    return json(res, Object.assign(META(), { count: rows.length, blacklist: rows }));
  }
  return json(res, { error: "not_found" }, 404);
}

function proAuth(req) {
  const m = (req.headers.authorization || "").match(/^Bearer\s+(.+)$/i);
  if (!m) return { err: { status: 401, body: { error: "missing_bearer_key" } } };
  const key = db.prepare("SELECT hash, tier, trial_until FROM keys WHERE hash=?").get(sha256hex(m[1].trim()));
  if (!key) return { err: { status: 401, body: { error: "invalid_key" } } };
  let tier = key.tier;
  if (tier === "free" && key.trial_until && new Date(key.trial_until) > new Date()) tier = "pro";
  return { tier };
}
/* ---- request body reader ---- */
function readJson(req) {
  return new Promise(function (resolve, reject) {
    let b = "";
    req.on("data", function (c) { b += c; if (b.length > 1e6) { reject(new Error("body_too_large")); req.destroy(); } });
    req.on("end", function () { try { resolve(b ? JSON.parse(b) : {}); } catch (e) { reject(new Error("invalid_json")); } });
    req.on("error", reject);
  });
}

const server = http.createServer(async function (req, res) {
  if (req.method === "OPTIONS") { res.writeHead(204, CORS); return res.end(); }
  try {
    const url = new URL(req.url, "http://127.0.0.1");
    const p = url.pathname.replace(/\/+$/, "");

    if (p.endsWith("/register") && req.method === "POST") {
      const ip = req.socket.remoteAddress || "?";
      if (rateLimited("reg:" + ip, 5)) return json(res, { error: "rate_limited_register" }, 429);
      const body = await readJson(req);
      const key = apiKey();
      const trial = new Date(Date.now() + 7 * 86400e3).toISOString();
      db.prepare("INSERT INTO keys(hash, tier, trial_until, email, created_at) VALUES(?,?,?,?,?)")
        .run(sha256hex(key), "free", trial, body.email || null, nowIso());
      return json(res, { key: key, tier: "free", pro_trial_until: trial, note: "试用期内可访问 Pro 端点;请妥善保存,丢失需重新注册" }, 201);
    }

    if (!p.startsWith("/api/")) return json(res, { error: "not_found" }, 404);
    const ep = p.slice(5).replace(/\/+$/, "");

    const FREE = ["v1/ranking", "v1/prices", "v1/blacklist", "v1/meta"];
    if (FREE.includes(ep)) {
      const ip = req.socket.remoteAddress || "?";
      if (rateLimited("free:" + ip, 60)) return json(res, { error: "rate_limited", limit: "60/min" }, 429);
      return freeEndpoint(url, res);
    }

    if (ep === "auth/email/start" && req.method === "POST") {
      const ip = req.socket.remoteAddress || "?";
      if (rateLimited("mail:" + ip, 3)) return json(res, { error: "rate_limited" }, 429);
      const body = await readJson(req);
      const email = String(body.email || "").trim().toLowerCase();
      if (!/^[^@\s]+@[^@\s]+\.[^@\s]+$/.test(email)) return json(res, { error: "invalid_email" }, 400);
      const send = mailer();
      if (!send) return json(res, { error: "email_provider_not_configured", hint: "服务端需配置 SMTP_* 或 RESEND_API_KEY" }, 503);
      const code = String(Math.floor(100000 + Math.random() * 900000));
      db.prepare("INSERT OR REPLACE INTO email_codes(email, code, expires_at, attempts) VALUES(?,?,?,0)")
        .run(email, code, new Date(Date.now() + 10 * 60e3).toISOString());
      await send(email, "RelayLens 登录验证码", "验证码:" + code + "\n10 分钟内有效。若非本人操作请忽略。");
      return json(res, { sent: true, hint: "验证码已发送,10 分钟内有效" });
    }

    if (ep === "auth/email/verify" && req.method === "POST") {
      const body = await readJson(req);
      const email = String(body.email || "").trim().toLowerCase();
      const code = String(body.code || "").trim();
      const row = db.prepare("SELECT code, expires_at, attempts FROM email_codes WHERE email=?").get(email);
      if (!row) return json(res, { error: "code_not_found" }, 400);
      if (row.attempts >= 5) return json(res, { error: "too_many_attempts" }, 429);
      if (row.code !== code) {
        db.prepare("UPDATE email_codes SET attempts = attempts + 1 WHERE email=?").run(email);
        return json(res, { error: "code_mismatch" }, 400);
      }
      if (new Date(row.expires_at) < new Date()) return json(res, { error: "code_expired" }, 400);
      db.prepare("DELETE FROM email_codes WHERE email=?").run(email);
      return json(res, upsertUserAndSession("email", email, body.display || null));
    }

    if (ep === "auth/github/start") {
      if (!process.env.GITHUB_CLIENT_ID) return json(res, { error: "github_oauth_not_configured" }, 503);
      const redirect = new URL("https://github.com/login/oauth/authorize");
      redirect.searchParams.set("client_id", process.env.GITHUB_CLIENT_ID);
      redirect.searchParams.set("redirect_uri", SITE_ORIGIN + "/api/auth/github/callback");
      redirect.searchParams.set("scope", "read:user");
      redirect.searchParams.set("state", uuid());
      res.writeHead(302, Object.assign({ Location: redirect.toString() }, CORS));
      return res.end();
    }

    if (ep === "auth/github/callback") {
      const code = url.searchParams.get("code");
      if (!code) return json(res, { error: "missing_code" }, 400);
      const tr = await fetch("https://github.com/login/oauth/access_token", {
        method: "POST", headers: { "Content-Type": "application/json", Accept: "application/json" },
        body: JSON.stringify({ client_id: process.env.GITHUB_CLIENT_ID, client_secret: process.env.GITHUB_CLIENT_SECRET, code: code, redirect_uri: SITE_ORIGIN + "/api/auth/github/callback" }),
      });
      const tj = await tr.json().catch(function(){ return {}; });
      if (!tj.access_token) return json(res, { error: "oauth_exchange_failed" }, 401);
      const ur = await fetch("https://api.github.com/user", { headers: { Authorization: "Bearer " + tj.access_token, "User-Agent": "RelayLens-API" } });
      const uj = await ur.json().catch(function(){ return {}; });
      if (!uj.id) return json(res, { error: "github_profile_failed" }, 401);
      const sess = upsertUserAndSession("github", String(uj.id), uj.login || null);
      res.writeHead(302, Object.assign({ Location: SITE_ORIGIN + "/relay/auth.html#session=" + sess.token }, CORS));
      return res.end();
    }

    if (ep === "auth/me") {
      const s = sessionUser(req);
      if (!s) return json(res, { error: "unauthorized" }, 401);
      return json(res, s);
    }

    if (ep === "reviews" && req.method === "POST") {
      const s = sessionUser(req);
      if (!s) return json(res, { error: "login_required" }, 401);
      const body = await readJson(req);
      const site = String(body.site || "").trim();
      const stars = Number(body.stars);
      const text = String(body.text || "").trim();
      if (!site) return json(res, { error: "site_required" }, 400);
      if (!Number.isInteger(stars) || stars < 1 || stars > 5) return json(res, { error: "stars_1_to_5" }, 400);
      if (text.length < 10) return json(res, { error: "text_too_short" }, 400);
      if (text.length > 2000) return json(res, { error: "text_too_long" }, 400);
      const dup = db.prepare("SELECT id FROM reviews WHERE site=? AND user_id=?").get(site, s.user_id);
      const id = dup ? dup.id : uuid();
      db.prepare(
        "INSERT INTO reviews(id,site,user_id,stars,text,status,created_at) VALUES(?,?,?,?,?,'pending',?)" +
        " ON CONFLICT(site,user_id) DO UPDATE SET stars=excluded.stars, text=excluded.text, status='pending', created_at=excluded.created_at, reviewed_at=NULL, reject_reason=NULL"
      ).run(id, site, s.user_id, stars, text, nowIso());
      return json(res, { id: id, status: "pending", note: "先审后发:审核通过后公开显示" }, 201);
    }

    if (ep.indexOf("v1/reviews/") === 0) {
      const site = decodeURIComponent(ep.slice("v1/reviews/".length));
      const list = db.prepare(
        "SELECT r.stars, r.text, r.created_at, COALESCE(u.display,'匿名用户') display, r.station_reply, r.replied_at" +
        " FROM reviews r LEFT JOIN users u ON u.id=r.user_id WHERE r.site=? AND r.status='published' ORDER BY r.created_at DESC LIMIT 100"
      ).all(site);
      const avg = list.length ? Math.round(list.reduce(function(s, x){ return s + x.stars; }, 0) / list.length * 10) / 10 : null;
      return json(res, { version: dataVersion(), license: "CC BY 4.0", count: list.length, avg_stars: avg, note: "用户主观评分,与本站实测评分分开呈现,不参与综合分", reviews: list });
    }

    if (ep === "claim/apply" && req.method === "POST") {
      const s = sessionUser(req);
      if (!s) return json(res, { error: "login_required" }, 401);
      const body = await readJson(req);
      const site = String(body.site || body.domain || "").trim();
      const domain = String(body.domain || "").trim().replace(/^https?:\/\//, "").replace(/\/.*$/, "");
      if (!site || !/^[a-z0-9.-]+\.[a-z]{2,}$/i.test(domain)) return json(res, { error: "site_and_domain_required" }, 400);
      const existing = db.prepare("SELECT id, status FROM claims WHERE site=? AND user_id=?").get(site, s.user_id);
      if (existing && existing.status === "verified") return json(res, { error: "already_claimed" }, 409);
      const id = existing ? existing.id : uuid();
      const token = "rl-claim-" + crypto.randomBytes(16).toString("hex");
      db.prepare("INSERT INTO claims(id,site,user_id,domain,token,status,created_at) VALUES(?,?,?,?,?,'pending',?)" +
        " ON CONFLICT(id) DO UPDATE SET token=excluded.token, domain=excluded.domain, status='pending'")
        .run(id, site, s.user_id, domain, token, nowIso());
      return json(res, { id: id, token: token, verify_url: "https://" + domain + "/.well-known/relaylens-claim.txt",
        instruction: "在域名根放置 /.well-known/relaylens-claim.txt(内容仅此 token),然后访问 /api/claim/verify?id=" + id }, 201);
    }

    if (ep === "claim/verify") {
      const id = url.searchParams.get("id") || "";
      const row = db.prepare("SELECT id, domain, token, status FROM claims WHERE id=?").get(id);
      if (!row) return json(res, { error: "not_found" }, 404);
      if (row.status === "verified") return json(res, { status: "verified" });
      let content = "";
      try {
        const fr = await fetch("https://" + row.domain + "/.well-known/relaylens-claim.txt", { signal: AbortSignal.timeout(10000) });
        content = (await fr.text()).trim();
      } catch (e) { return json(res, { error: "fetch_failed", hint: "无法读取验证文件" }, 400); }
      if (content !== row.token) return json(res, { error: "token_mismatch", hint: "文件内容须与 token 完全一致" }, 400);
      db.prepare("UPDATE claims SET status='verified', verified_at=? WHERE id=?").run(nowIso(), id);
      return json(res, { status: "verified", note: "域名验证通过,待管理员复核后生效" });
    }

    if (ep === "submit/onboarding" && req.method === "POST") {
      const ip = req.socket.remoteAddress || "?";
      if (rateLimited("submit:" + ip, 3)) return json(res, { error: "rate_limited" }, 429);
      const payload = await readJson(req);
      if (!payload.site_name || !payload.domain) return json(res, { error: "site_name_and_domain_required", schema: "onboarding.schema.json v1.0.0" }, 400);
      const id = uuid();
      db.prepare("INSERT INTO submissions(id, kind, payload, status, created_at) VALUES(?, 'onboarding', ?, 'pending', ?)")
        .run(id, JSON.stringify(payload), nowIso());
      return json(res, { id: id, status: "pending", note: "72 小时内答复;凭 id 查进度" }, 201);
    }

    if (ep === "submit/claim" && req.method === "POST") {
      const ip = req.socket.remoteAddress || "?";
      if (rateLimited("submit:" + ip, 3)) return json(res, { error: "rate_limited" }, 429);
      const payload = await readJson(req);
      if (!payload.domain) return json(res, { error: "domain_required" }, 400);
      const id = uuid();
      db.prepare("INSERT INTO submissions(id, kind, payload, status, created_at) VALUES(?, 'claim', ?, 'pending', ?)")
        .run(id, JSON.stringify(payload), nowIso());
      return json(res, { id: id, status: "pending", note: "管理员核验后将通过预留邮箱联系并发放验证 token" }, 201);
    }

    if (ep === "submit/status") {
      const row = db.prepare("SELECT id, kind, status, created_at, decided_at, decision_reason FROM submissions WHERE id=?").get(url.searchParams.get("id") || "");
      if (!row) return json(res, { error: "not_found" }, 404);
      return json(res, row);
    }

    if (ep.indexOf("admin/") === 0) {
      if (!process.env.ADMIN_TOKEN || req.headers["x-admin-token"] !== process.env.ADMIN_TOKEN)
        return json(res, { error: "admin_only" }, 403);
      if (ep === "admin/queue") {
        const type = url.searchParams.get("type") || "reviews";
        const st = url.searchParams.get("status") || "pending";
        const table = { reviews: "reviews", submissions: "submissions", claims: "claims" }[type];
        if (!table) return json(res, { error: "invalid_type" }, 400);
        const rows = db.prepare("SELECT * FROM " + table + " WHERE status=? ORDER BY created_at DESC LIMIT 200").all(st);
        return json(res, { type: type, status: st, count: rows.length, items: rows });
      }
      const dec = ep.match(/^admin\/(reviews|submissions|claims)\/([^/]+)\/decision$/);
      if (dec) {
        const body = await readJson(req);
        const approve = !!body.approve;
        const reason = String(body.reason || "").slice(0, 300) || null;
        const table = dec[1], id = dec[2];
        const status = approve ? (table === "reviews" ? "published" : table === "claims" ? "verified" : "accepted") : "rejected";
        const col = table === "submissions" ? "decided_at" : "reviewed_at";
        const r = db.prepare("UPDATE " + table + " SET status=?, " + col + "=?, reject_reason=COALESCE(?,reject_reason) WHERE id=?")
          .run(status, nowIso(), reason, id);
        if (!r.changes) return json(res, { error: "not_found" }, 404);
        return json(res, { id: id, status: status, reason: reason });
      }
    }

    const auth = proAuth(req);
    if (ep === "v1/batches") {
      if (auth.err) return json(res, auth.err.body, auth.err.status);
      const site = url.searchParams.get("site");
      if (!site) return json(res, { error: "site_required" }, 400);
      const since = url.searchParams.get("since"), until = url.searchParams.get("until");
      const rounds = url.searchParams.get("rounds") === "true";
      const cond = ["site=?"], args = [site];
      if (since) { cond.push("started_at>=?"); args.push(since); }
      if (until) { cond.push("started_at<=?"); args.push(until); }
      let out = db.prepare("SELECT id, task, started_at, ok, summary FROM batches WHERE " + cond.join(" AND ") + " ORDER BY started_at DESC LIMIT 500").all.apply(null, args);
      if (rounds && out.length) {
        const ids = out.map(function(b){ return b.id; });
        const ph = ids.map(function(){ return "?"; }).join(",");
        const rr = db.prepare("SELECT batch_id, seq, model, in_tok, cached_tok, out_tok, should_cost, actual_cost, ttft_ms FROM rounds WHERE batch_id IN (" + ph + ") ORDER BY batch_id, seq").all.apply(null, ids);
        const byBatch = {};
        rr.forEach(function(r){ (byBatch[r.batch_id] = byBatch[r.batch_id] || []).push(r); });
        out = out.map(function(b){ return Object.assign({}, b, { rounds: byBatch[b.id] || [] }); });
      }
      return json(res, { updated: META().updated, version: dataVersion(), license: "CC BY 4.0", count: out.length, batches: out });
    }
    if (ep.indexOf("v1/receipts/") === 0) {
      if (auth.err) return json(res, auth.err.body, auth.err.status);
      const batchId = decodeURIComponent(ep.slice("v1/receipts/".length));
      const b = db.prepare("SELECT id, site, task, started_at, ok, summary FROM batches WHERE id=?").get(batchId);
      if (!b) return json(res, { error: "not_found" }, 404);
      const rr = db.prepare("SELECT seq, model, in_tok, cached_tok, out_tok, should_cost, actual_cost, ttft_ms FROM rounds WHERE batch_id=? ORDER BY seq").all(batchId);
      return json(res, { version: dataVersion(), license: "CC BY 4.0", receipt: Object.assign({}, b, { rounds: rr }) });
    }

    return json(res, { error: "not_found" }, 404);
  } catch (e) {
    console.error("[" + nowIso() + "] error:", e.message);
    try { json(res, { error: "internal_error" }, 500); } catch (e2) {}
  }
});

server.listen(PORT, "127.0.0.1", function () {
  console.log("[" + nowIso() + "] RelayLens API listening on 127.0.0.1:" + PORT + " (db: " + DB_PATH + ")");
});
