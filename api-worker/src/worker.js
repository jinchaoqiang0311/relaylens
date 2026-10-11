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

    /* ===== 账号:邮箱验证码 + GitHub OAuth ===== */
    if (ep === "auth/email/start" && request.method === "POST") {
      const ip = request.headers.get("CF-Connecting-IP") || "?";
      if (await rateLimited(env, "mail:" + ip, 3)) return json({ error: "rate_limited" }, 429);
      let email = ""; try { email = String((await request.json())?.email || "").trim().toLowerCase(); } catch {}
      if (!/^[^@\s]+@[^@\s]+\.[^@\s]+$/.test(email)) return json({ error: "invalid_email" }, 400);
      if (!env.RESEND_API_KEY) return json({ error: "email_provider_not_configured", hint: "部署侧 wrangler secret put RESEND_API_KEY(Resend 免费层 3000 封/月)" }, 503);
      const code = String(Math.floor(100000 + Math.random() * 900000));
      const exp = new Date(Date.now() + 10 * 60e3).toISOString();
      await env.DB.prepare(`INSERT OR REPLACE INTO email_codes(email, code, expires_at, attempts) VALUES(?,?,?,0)`)
        .bind(email, code, exp).run();
      const mr = await fetch("https://api.resend.com/emails", {
        method: "POST",
        headers: { Authorization: "Bearer " + env.RESEND_API_KEY, "Content-Type": "application/json" },
        body: JSON.stringify({ from: env.MAIL_FROM || "RelayLens <noreply@relaylens.dev>", to: [email], subject: "RelayLens 登录验证码", text: "验证码:" + code + "\n10 分钟内有效。若非本人操作请忽略。" }),
      });
      if (!mr.ok) return json({ error: "mail_send_failed" }, 502);
      return json({ sent: true, hint: "验证码已发送,10 分钟内有效" });
    }

    if (ep === "auth/email/verify" && request.method === "POST") {
      let email = "", code = "", display = null;
      try { const b = await request.json(); email = String(b?.email || "").trim().toLowerCase(); code = String(b?.code || "").trim(); display = b?.display ?? null; } catch {}
      const row = await env.DB.prepare(`SELECT code, expires_at, attempts FROM email_codes WHERE email=?`).bind(email).first();
      if (!row) return json({ error: "code_not_found" }, 400);
      if (row.attempts >= 5) return json({ error: "too_many_attempts" }, 429);
      if (row.code !== code) {
        await env.DB.prepare(`UPDATE email_codes SET attempts = attempts + 1 WHERE email=?`).bind(email).run();
        return json({ error: "code_mismatch" }, 400);
      }
      if (new Date(row.expires_at) < new Date()) return json({ error: "code_expired" }, 400);
      await env.DB.prepare(`DELETE FROM email_codes WHERE email=?`).bind(email).run();
      const sess = await upsertUserAndSession(env, "email", email, display);
      return json(sess);
    }

    if (ep === "auth/github/start") {
      if (!env.GITHUB_CLIENT_ID) return json({ error: "github_oauth_not_configured" }, 503);
      const redirect = new URL("https://github.com/login/oauth/authorize");
      redirect.searchParams.set("client_id", env.GITHUB_CLIENT_ID);
      redirect.searchParams.set("redirect_uri", new URL("/api/auth/github/callback", url).toString());
      redirect.searchParams.set("scope", "read:user");
      redirect.searchParams.set("state", crypto.randomUUID()); // CSRF 防护:回调须回传
      return new Response(null, { status: 302, headers: { Location: redirect.toString(), ...CORS } });
    }

    if (ep === "auth/github/callback" && request.method === "GET") {
      const code = url.searchParams.get("code"), state = url.searchParams.get("state");
      if (!code || !state) return json({ error: "missing_code" }, 400);
      const tr = await fetch("https://github.com/login/oauth/access_token", {
        method: "POST",
        headers: { "Content-Type": "application/json", Accept: "application/json" },
        body: JSON.stringify({ client_id: env.GITHUB_CLIENT_ID, client_secret: env.GITHUB_CLIENT_SECRET, code, redirect_uri: new URL("/api/auth/github/callback", url).toString() }),
      });
      const tj = await tr.json().catch(() => ({}));
      if (!tj.access_token) return json({ error: "oauth_exchange_failed" }, 401);
      const ur = await fetch("https://api.github.com/user", { headers: { Authorization: "Bearer " + tj.access_token, "User-Agent": "RelayLens-API" } });
      const uj = await ur.json().catch(() => ({}));
      if (!uj.id) return json({ error: "github_profile_failed" }, 401);
      const sess = await upsertUserAndSession(env, "github", String(uj.id), uj.login ?? null);
      // 回跳前端:token 放 fragment(#),不会进服务器日志
      return new Response(null, { status: 302, headers: { Location: (env.FRONTEND_ORIGIN || SITE_ORIGIN) + "/api.html#session=" + sess.token, ...CORS } });
    }

    if (ep === "auth/me" && request.method === "GET") {
      const s = await sessionUser(env, request);
      if (!s) return json({ error: "unauthorized" }, 401);
      return json(s);
    }

    /* ===== 用户评论(自由五星,先审后发) ===== */
    if (ep === "reviews" && request.method === "POST") {
      const s = await sessionUser(env, request);
      if (!s) return json({ error: "login_required" }, 401);
      let body; try { body = await request.json(); } catch { return json({ error: "invalid_json" }, 400); }
      const site = String(body?.site || "").trim();
      const stars = Number(body?.stars);
      const text = String(body?.text || "").trim();
      if (!site) return json({ error: "site_required" }, 400);
      if (!Number.isInteger(stars) || stars < 1 || stars > 5) return json({ error: "stars_1_to_5" }, 400);
      if (text.length < 10) return json({ error: "text_too_short" }, 400);
      if (text.length > 2000) return json({ error: "text_too_long" }, 400);
      // 一人一站一评:已有评论则覆盖更新,并重新进入待审(防刷分;历史版本不留)
      const dup = await env.DB.prepare(`SELECT id FROM reviews WHERE site=? AND user_id=?`).bind(site, s.user_id).first();
      const id = dup?.id ?? crypto.randomUUID();
      await env.DB.prepare(
        `INSERT INTO reviews(id,site,user_id,stars,text,status,created_at)
         VALUES(?,?,?,?,?,'pending',?)
         ON CONFLICT(site,user_id) DO UPDATE SET stars=excluded.stars, text=excluded.text, status='pending', created_at=excluded.created_at, reviewed_at=NULL, reject_reason=NULL`
      ).bind(id, site, s.user_id, stars, text, new Date().toISOString()).run();
      return json({ id, status: "pending", note: "先审后发:审核通过后公开显示" }, 201);
    }

    if (ep.startsWith("v1/reviews/") && request.method === "GET") {
      const site = decodeURIComponent(ep.split("/")[2] || "");
      const rows = await env.DB.prepare(
        `SELECT r.stars, r.text, r.created_at, COALESCE(u.display,'匿名用户') display, r.station_reply, r.replied_at
         FROM reviews r LEFT JOIN users u ON u.id=r.user_id
         WHERE r.site=? AND r.status='published' ORDER BY r.created_at DESC LIMIT 100`
      ).bind(site).all();
      const list = rows.results ?? [];
      const avg = list.length ? Math.round(list.reduce((s, x) => s + x.stars, 0) / list.length * 10) / 10 : null;
      return json({ version: await dataVersion(env), license: "CC BY 4.0", count: list.length, avg_stars: avg, note: "用户主观评分,与本站实测评分分开呈现,不参与综合分", reviews: list });
    }

    /* ===== 站点认领(域名 token 验证) ===== */
    if (ep === "claim/apply" && request.method === "POST") {
      const s = await sessionUser(env, request);
      if (!s) return json({ error: "login_required" }, 401);
      let body; try { body = await request.json(); } catch { return json({ error: "invalid_json" }, 400); }
      const site = String(body?.site || body?.domain || "").trim(), domain = String(body?.domain || "").trim().replace(/^https?:\/\//, "").replace(/\/.*$/, "");
      if (!site || !domain || !/^[a-z0-9.-]+\.[a-z]{2,}$/i.test(domain)) return json({ error: "site_and_domain_required" }, 400);
      const existing = await env.DB.prepare(`SELECT id, status FROM claims WHERE site=? AND user_id=?`).bind(site, s.user_id).first();
      if (existing && existing.status === "verified") return json({ error: "already_claimed" }, 409);
      const id = existing?.id ?? crypto.randomUUID();
      const token = "rl-claim-" + [...crypto.getRandomValues(new Uint8Array(16))].map(x => x.toString(16).padStart(2, "0")).join("");
      await env.DB.prepare(
        `INSERT INTO claims(id,site,user_id,domain,token,status,created_at) VALUES(?,?,?,?,?,'pending',?)
         ON CONFLICT(id) DO UPDATE SET token=excluded.token, domain=excluded.domain, status='pending'`
      ).bind(id, site, s.user_id, domain, token, new Date().toISOString()).run();
      return json({
        id, token,
        verify_url: "https://" + domain + "/.well-known/relaylens-claim.txt",
        instruction: `在 https://${domain}/.well-known/relaylens-claim.txt 放置内容(纯文本,仅此 token):${token}\n放好后调用 /api/claim/verify?id=${id} 自动验证;管理员复核通过后获得站方身份`,
      }, 201);
    }

    if (ep === "claim/verify" && request.method === "GET") {
      const id = url.searchParams.get("id");
      const row = await env.DB.prepare(`SELECT id, site, domain, token, status, user_id FROM claims WHERE id=?`).bind(id || "").first();
      if (!row) return json({ error: "not_found" }, 404);
      if (row.status === "verified") return json({ status: "verified" });
      let content = "";
      try {
        const fr = await fetch("https://" + row.domain + "/.well-known/relaylens-claim.txt", { signal: AbortSignal.timeout(10_000) });
        content = (await fr.text()).trim();
      } catch { return json({ error: "fetch_failed", hint: "无法读取验证文件,确认已上传且可公网访问" }, 400); }
      if (content !== row.token) return json({ error: "token_mismatch", hint: "文件内容须与 token 完全一致" }, 400);
      await env.DB.prepare(`UPDATE claims SET status='verified', verified_at=? WHERE id=?`).bind(new Date().toISOString(), id).run();
      return json({ status: "verified", note: "域名验证通过,待管理员复核后生效站方身份" });
    }

    /* ===== 收录申请(对接 probe onboard 管线) ===== */
    if (ep === "submit/onboarding" && request.method === "POST") {
      const ip = request.headers.get("CF-Connecting-IP") || "?";
      if (await rateLimited(env, "submit:" + ip, 3)) return json({ error: "rate_limited" }, 429);
      let payload; try { payload = await request.json(); } catch { return json({ error: "invalid_json" }, 400); }
      // onboarding.schema.json v1.0.0 实际结构:site_name + domain(顶层),phase/status/submittedAt 由页面组装
      if (!payload?.site_name || !payload?.domain) return json({ error: "site_name_and_domain_required", schema: "onboarding.schema.json v1.0.0" }, 400);
      const id = crypto.randomUUID();
      await env.DB.prepare(`INSERT INTO submissions(id, kind, payload, status, created_at) VALUES(?, 'onboarding', ?, 'pending', ?)`)
        .bind(id, JSON.stringify(payload), new Date().toISOString()).run();
      return json({ id, status: "pending", note: "72 小时内答复;审核进度可凭此 id 查询" }, 201);
    }

    /* 认领申请匿名通道:入队后管理员人工核验并发放验证 token(与登录用户 /claim/apply 自动验证并行) */
    if (ep === "submit/claim" && request.method === "POST") {
      const ip = request.headers.get("CF-Connecting-IP") || "?";
      if (await rateLimited(env, "submit:" + ip, 3)) return json({ error: "rate_limited" }, 429);
      let payload; try { payload = await request.json(); } catch { return json({ error: "invalid_json" }, 400); }
      if (!payload?.domain) return json({ error: "domain_required" }, 400);
      const id = crypto.randomUUID();
      await env.DB.prepare(`INSERT INTO submissions(id, kind, payload, status, created_at) VALUES(?, 'claim', ?, 'pending', ?)`)
        .bind(id, JSON.stringify(payload), new Date().toISOString()).run();
      return json({ id, status: "pending", note: "管理员核验后将通过页面预留邮箱联系并发放验证 token" }, 201);
    }

    if (ep === "submit/status" && request.method === "GET") {
      const id = url.searchParams.get("id");
      const row = await env.DB.prepare(`SELECT id, kind, status, created_at, decided_at, decision_reason FROM submissions WHERE id=?`).bind(id || "").first();
      if (!row) return json({ error: "not_found" }, 404);
      return json(row);
    }

    /* ===== 管理员审核(X-Admin-Token;CLI api-admin.cjs 调用) ===== */
    if (ep.startsWith("admin/")) {
      if (!env.ADMIN_TOKEN || request.headers.get("X-Admin-Token") !== env.ADMIN_TOKEN)
        return json({ error: "admin_only" }, 403);
      if (ep === "admin/queue" && request.method === "GET") {
        const type = url.searchParams.get("type") || "reviews", st = url.searchParams.get("status") || "pending";
        const table = { reviews: "reviews", submissions: "submissions", claims: "claims" }[type];
        if (!table) return json({ error: "invalid_type" }, 400);
        const rows = await env.DB.prepare(`SELECT * FROM ${table} WHERE status=? ORDER BY created_at DESC LIMIT 200`).bind(st).all();
        return json({ type, status: st, count: (rows.results ?? []).length, items: rows.results ?? [] });
      }
      const dec = ep.match(/^admin\/(reviews|submissions|claims)\/([^/]+)\/decision$/);
      if (dec && request.method === "POST") {
        const table = dec[1], id = dec[2];
        let body; try { body = await request.json(); } catch { return json({ error: "invalid_json" }, 400); }
        const approve = !!body?.approve, reason = String(body?.reason || "").slice(0, 300) || null;
        const now = new Date().toISOString();
        const status = approve ? (table === "reviews" ? "published" : table === "claims" ? "verified" : "accepted") : "rejected";
        const col = table === "submissions" ? "decided_at" : "reviewed_at";
        const r = await env.DB.prepare(
          `UPDATE ${table} SET status=?, ${col}=?, reject_reason=COALESCE(?,reject_reason) WHERE id=?`
        ).bind(status, now, reason, id).run();
        if (!r.meta.changes) return json({ error: "not_found" }, 404);
        return json({ id, status, reason });
      }
    }

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

/** 会话:随机 token,库内明文(会话可撤销,与 key 的哈希策略不同层) */
async function upsertUserAndSession(env, provider, identity, display) {
  let u = await env.DB.prepare(`SELECT id FROM users WHERE provider=? AND identity=?`).bind(provider, identity).first();
  const uid = u?.id ?? crypto.randomUUID();
  if (!u) await env.DB.prepare(`INSERT INTO users(id, provider, identity, display, created_at) VALUES(?,?,?,?,?)`)
    .bind(uid, provider, identity, display, new Date().toISOString()).run();
  else if (display) await env.DB.prepare(`UPDATE users SET display=? WHERE id=?`).bind(display, uid).run();
  const token = [...crypto.getRandomValues(new Uint8Array(24))].map(x => x.toString(16).padStart(2, "0")).join("");
  const exp = new Date(Date.now() + 30 * 86400e3).toISOString();
  await env.DB.prepare(`INSERT INTO sessions(token, user_id, created_at, expires_at) VALUES(?,?,?,?)`)
    .bind(token, uid, new Date().toISOString(), exp).run();
  return { token, expires_at: exp, user: { id: uid, provider, display } };
}

/** Bearer 会话解析(过期即无效) */
async function sessionUser(env, request) {
  const m = (request.headers.get("Authorization") || "").match(/^Bearer\s+(.+)$/i);
  if (!m) return null;
  const row = await env.DB.prepare(
    `SELECT s.user_id, s.expires_at, u.provider, u.display FROM sessions s JOIN users u ON u.id=s.user_id WHERE s.token=?`
  ).bind(m[1].trim()).first();
  if (!row) return null;
  if (new Date(row.expires_at) < new Date()) return null;
  return { user_id: row.user_id, provider: row.provider, display: row.display };
}
