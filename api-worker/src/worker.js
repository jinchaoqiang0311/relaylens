/**
 * RelayLens 数据导出 API — Cloudflare Worker + D1
 * 免费端点(无需鉴权): GET /api/v1/ranking | /v1/prices | /v1/blacklist | /v1/meta
 *   数据源 = GitHub Pages 静态 sites.json(与站内页面同源,Worker 只做过滤/瘦身)
 * Pro 端点(Bearer key): /api/v1/batches | /api/v1/receipts/{batchId} | /api/v1/webhooks(管理)
 * 注册: POST /api/register → 发放 key,自带 7 天 Pro 试用(与 api.html 承诺一致)
 * 限速: 免费 60/min/IP;Pro 600/min/key(D1 计数器,按自然分钟窗口)
 * 所有响应含 updated / version / license 字段(CC BY 4.0)。
 */

const SITE_ORIGIN = "https://jinchaoqiang0311.github.io/relaylens"; // 免费端点数据源
const CORS = {
  "Access-Control-Allow-Origin": "*",
  "Access-Control-Allow-Methods": "GET, POST, OPTIONS",
  "Access-Control-Allow-Headers": "Content-Type, Authorization",
};

function json(obj, status = 200, extra = {}) {
  return new Response(JSON.stringify(obj), {
    status,
    headers: { "Content-Type": "application/json; charset=utf-8", ...CORS, ...extra },
  });
}

async function sha256hex(s) {
  const d = await crypto.subtle.digest("SHA-256", new TextEncoder().encode(s));
  return [...new Uint8Array(d)].map(b => b.toString(16).padStart(2, "0")).join("");
}

function apiKey() {
  const b = new Uint8Array(24);
  crypto.getRandomValues(b);
  return "rl_" + [...b].map(x => x.toString(16).padStart(2, "0")).join("");
}

/** 限速:usage 表按 (subject, minute) 计数。超限返回 true */
async function rateLimited(env, subject, limit) {
  const minute = new Date().toISOString().slice(0, 16); // 精确到分钟
  const row = await env.DB.prepare(
    `INSERT INTO usage(subject, minute, n) VALUES(?,?,1)
     ON CONFLICT(subject,minute) DO UPDATE SET n = n + 1 RETURNING n`
  ).bind(subject, minute).first();
  return (row?.n ?? 1) > limit;
}

/** 免费端点:拉静态 sites.json 并按查询参数过滤/瘦身 */
async function freeEndpoint(url, request, env, ctx) {
  const cache = caches.default;
  const ck = new Request(url.toString(), { method: "GET" });
  let payload = await cache.match(ck);
  if (!payload) {
    const r = await fetch(SITE_ORIGIN + "/data/sites.json");
    if (!r.ok) return json({ error: "upstream_unavailable" }, 502);
    payload = new Response(r.body, r);
    payload.headers.set("Cache-Control", "public, max-age=300");
    ctx.waitUntil(cache.put(ck, payload.clone()));
  }
  const data = await payload.json();
  const meta = {
    updated: data.meta?.updated ?? null,
    version: data.meta?.weightsVersion ?? null,
    license: "CC BY 4.0",
  };
  const ep = url.pathname.replace(/\/+$/, "").split("/").pop();
  const qp = url.searchParams;

  if (ep === "meta") return json({ ...meta, sites: data.realSites?.length ?? 0, reference: data.referenceSites?.length ?? 0 });

  if (ep === "ranking") {
    const scene = qp.get("scene") || "all";
    const model = qp.get("model");
    const fields = (qp.get("fields") || "").split(",").map(s => s.trim()).filter(Boolean);
    let rows = (data.realSites ?? []).filter(s => !model || (s.models ?? []).includes(model));
    if (fields.length) rows = rows.map(s => Object.fromEntries(Object.entries(s).filter(([k]) => fields.includes(k))));
    return json({ ...meta, scene, count: rows.length, sites: rows });
  }

  if (ep === "prices") {
    const model = qp.get("model");
    const honestOnly = qp.get("honest_only") === "true";
    let rows = data.compare?.rows ?? data.compare ?? [];
    if (Array.isArray(rows) && model) rows = rows.filter(r => (r.model ?? "").toLowerCase().includes(model.toLowerCase()));
    if (honestOnly) rows = rows.filter(r => (r.dev ?? 99) <= 1);
    return json({ ...meta, count: rows.length, prices: rows });
  }

  if (ep === "blacklist") {
    const state = qp.get("state");
    let rows = data.blacklist ?? [];
    if (state) rows = rows.filter(r => r.state === state);
    return json({ ...meta, count: rows.length, blacklist: rows });
  }

  return json({ error: "not_found" }, 404);
}

/** Pro 端点鉴权 + 配额。返回 {tier} 或错误 Response */
async function authPro(request, env) {
  const m = (request.headers.get("Authorization") || "").match(/^Bearer\s+(.+)$/i);
  if (!m) return { err: json({ error: "missing_bearer_key" }, 401) };
  const hash = await sha256hex(m[1].trim());
  const key = await env.DB.prepare(
    `SELECT hash, tier, trial_until FROM keys WHERE hash = ?`
  ).bind(hash).first();
  if (!key) return { err: json({ error: "invalid_key" }, 401) };
  let tier = key.tier;
  if (tier === "free" && key.trial_until && new Date(key.trial_until) > new Date()) tier = "pro"; // 7天试用窗口
  if (request.method !== "GET" && tier !== "pro") return { err: json({ error: "pro_required" }, 403) };
  return { tier };
}

export default {
  async fetch(request, env, ctx) {
    if (request.method === "OPTIONS") return new Response(null, { status: 204, headers: CORS });
    const url = new URL(request.url);
    const p = url.pathname.replace(/\/+$/, "");

    /* 注册(自助,免后端账号体系):POST /api/register {email?} */
    if (p.endsWith("/register") && request.method === "POST") {
      if (await rateLimited(env, "reg:" + (request.headers.get("CF-Connecting-IP") || "?"), 5))
        return json({ error: "rate_limited_register" }, 429);
      let email = null;
      try { email = (await request.json())?.email ?? null; } catch { /* 空体允许 */ }
      const key = apiKey();
      const trial = new Date(Date.now() + 7 * 86400e3).toISOString();
      await env.DB.prepare(
        `INSERT INTO keys(hash, tier, trial_until, email, created_at) VALUES(?,?,?,?,?)`
      ).bind(await sha256hex(key), "free", trial, email, new Date().toISOString()).run();
      return json({
        key,                       // 仅此一次明文返回,库里只存 SHA-256
        tier: "free",
        pro_trial_until: trial,
        note: "试用期内可访问 Pro 端点;请妥善保存,丢失需重新注册",
      });
    }

    if (!p.includes("/api/")) return json({ error: "not_found" }, 404);
    const ep = p.split("/api/")[1];

    /* 免费端点 */
    if (["v1/ranking", "v1/prices", "v1/blacklist", "v1/meta"].includes(ep)) {
      const ip = request.headers.get("CF-Connecting-IP") || "?";
      if (await rateLimited(env, "free:" + ip, 60)) return json({ error: "rate_limited", limit: "60/min" }, 429);
      return freeEndpoint(url, request, env, ctx);
    }

    /* Pro 端点 */
    const auth = await authPro(request, env);
    if (auth.err) return auth.err;
    if (await rateLimited(env, "pro:" + auth.tier + ":" + (request.headers.get("Authorization") || "").slice(-8), 600))
      return json({ error: "rate_limited", limit: "600/min" }, 429);

    if (ep === "v1/batches" && request.method === "GET") {
      const site = url.searchParams.get("site");
      if (!site) return json({ error: "site_required" }, 400);
      const since = url.searchParams.get("since");
      const until = url.searchParams.get("until");
      const rounds = url.searchParams.get("rounds") === "true";
      const cond = ["site = ?"], args = [site];
      if (since) { cond.push("started_at >= ?"); args.push(since); }
      if (until) { cond.push("started_at <= ?"); args.push(until); }
      const rows = await env.DB.prepare(
        `SELECT id, task, started_at, ok, summary FROM batches WHERE ${cond.join(" AND ")}
         ORDER BY started_at DESC LIMIT 500`
      ).bind(...args).all();
      let out = rows.results ?? [];
      if (rounds && out.length) {
        const ids = out.map(b => b.id);
        const ph = ids.map(() => "?").join(",");
        const rr = await env.DB.prepare(
          `SELECT batch_id, seq, model, in_tok, cached_tok, out_tok, should_cost, actual_cost, ttft_ms
           FROM rounds WHERE batch_id IN (${ph}) ORDER BY batch_id, seq`
        ).bind(...ids).all();
        const byBatch = {};
        for (const r of rr.results ?? []) (byBatch[r.batch_id] ??= []).push(r);
        out = out.map(b => ({ ...b, rounds: byBatch[b.id] ?? [] }));
      }
      return json({ updated: null, version: await dataVersion(env), license: "CC BY 4.0", count: out.length, batches: out });
    }

    if (ep.startsWith("v1/receipts/") && request.method === "GET") {
      const batchId = decodeURIComponent(ep.split("/")[2] || "");
      const b = await env.DB.prepare(`SELECT id, site, task, started_at, ok, summary FROM batches WHERE id = ?`)
        .bind(batchId).first();
      if (!b) return json({ error: "not_found" }, 404);
      const rr = await env.DB.prepare(
        `SELECT seq, model, in_tok, cached_tok, out_tok, should_cost, actual_cost, ttft_ms
         FROM rounds WHERE batch_id = ? ORDER BY seq`
      ).bind(batchId).all();
      return json({ version: await dataVersion(env), license: "CC BY 4.0", receipt: { ...b, rounds: rr.results ?? [] } });
    }

    /* webhooks v1:登记 + 列表(触发在发布脚本里做,Worker 只存) */
    if (ep === "v1/webhooks") {
      if (request.method === "GET") {
        const rows = await env.DB.prepare(`SELECT id, url, topics, created_at FROM webhooks ORDER BY created_at DESC LIMIT 100`).all();
        return json({ version: await dataVersion(env), license: "CC BY 4.0", webhooks: rows.results ?? [] });
      }
      if (request.method === "POST") {
        if (auth.tier !== "pro") return json({ error: "pro_required" }, 403);
        let body; try { body = await request.json(); } catch { return json({ error: "invalid_json" }, 400); }
        if (!body?.url || !/^https:\/\//.test(body.url)) return json({ error: "https_url_required" }, 400);
        const id = crypto.randomUUID();
        await env.DB.prepare(`INSERT INTO webhooks(id, url, topics, created_at) VALUES(?,?,?,?)`)
          .bind(id, body.url, JSON.stringify(body.topics ?? ["sites.updated"]), new Date().toISOString()).run();
        return json({ id, note: "数据发布时会 POST 变更摘要到该 URL" }, 201);
      }
    }

    return json({ error: "not_found" }, 404);
  },
};

async function dataVersion(env) {
  const row = await env.DB.prepare(`SELECT v FROM meta WHERE k='data'`).first();
  try { return JSON.parse(row.v).version ?? null; } catch { return null; }
}
