/**
 * 探针 A:健康检查 —— 可用率与状态看板的数据源
 * 两个请求:① GET {base}/models ② 最小 chat 请求(max_tokens=1)
 * 判定(与 method.html 一致):
 *   up       = 服务响应 2xx 且响应结构完整(真 OpenAI 兼容)
 *   degraded = 服务在线但被鉴权门拦截(401/403 无 key 时能确认的极限)或响应结构不完整
 *   down     = 连不上 / 超时 / 5xx
 * 注:base_url 已含 /v1 等前缀时按原样拼接。
 */
import tls from "node:tls";
import type { HealthResult, SiteConfig, TlsInfo } from "../../../shared/types.js";

const USER_AGENT = "RelayLens-Probe/0.1 (+https://relaylens.example/about)";
const TIMEOUT_MS = 15_000;

async function fetchWithTimeout(url: string, init: RequestInit = {}): Promise<Response> {
  const ctrl = new AbortController();
  const t = setTimeout(() => ctrl.abort(), TIMEOUT_MS);
  try {
    return await fetch(url, { ...init, signal: ctrl.signal, headers: { "User-Agent": USER_AGENT, ...(init.headers ?? {}) } });
  } finally {
    clearTimeout(t);
  }
}

/** 鉴权门判定:401/403 且错误信息含认证类关键词 = 服务存活 */
function isAuthGate(status: number | null, errorObj: { message?: string; type?: string; code?: string | number } | undefined): boolean {
  if (status !== 401 && status !== 403) return false;
  if (!errorObj) return true; // 401/403 本身已说明服务在线
  const msg = `${errorObj.message ?? ""} ${errorObj.type ?? ""} ${errorObj.code ?? ""}`.toLowerCase();
  return /auth|token|令牌|key|unauthor|permission|invalid|过期|验证/.test(msg) || msg === "";
}

/** 失败分类:timeout(探测超时)/ conn_error(连接失败/5xx 前的异常)——稳定性指标需要区分"慢"和"挂" */
function classifyError(e: unknown): string {
  const msg = (e as Error).message ?? "";
  if (/abort|timeout|timed out/i.test(msg)) return "timeout";
  if (/ENOTFOUND|EAI_AGAIN|getaddrinfo/i.test(msg)) return "dns_error";
  if (/ECONNREFUSED|ECONNRESET|fetch failed|network/i.test(msg)) return "conn_error";
  return "error";
}

// ---------- TLS 证书证据(确定性事实,不参与评分) ----------
const TLS_TIMEOUT_MS = 8_000;

type TlsHandshake = { ok: boolean; cert?: tls.PeerCertificate; errorCode?: string; protocol?: string | null };

/** 一次 TLS 握手:verify=false 用来读证书,verify=true 用来判「系统 CA 是否认」。 */
function tlsHandshake(host: string, port: number, verify: boolean): Promise<TlsHandshake> {
  return new Promise<TlsHandshake>(resolve => {
    let done = false;
    let sock: tls.TLSSocket | null = null;
    const finish = (r: TlsHandshake) => {
      if (done) return;
      done = true;
      try { sock?.destroy(); } catch { /* 已关闭 */ }
      resolve(r);
    };
    try {
      sock = tls.connect({ host, port, servername: host, rejectUnauthorized: verify }, () => {
        const cert = sock?.getPeerCertificate(false);
        finish({ ok: true, cert: cert && Object.keys(cert).length ? cert : undefined, protocol: sock?.getProtocol() ?? null });
      });
      sock.setTimeout(TLS_TIMEOUT_MS, () => finish({ ok: false, errorCode: "TIMEOUT" }));
      sock.on("error", (e: NodeJS.ErrnoException) => finish({ ok: false, errorCode: e.code || e.message || "TLS_ERROR" }));
    } catch (e) {
      finish({ ok: false, errorCode: (e as NodeJS.ErrnoException).code || (e as Error).message });
    }
  });
}

/** 从 subjectaltname("DNS:a.com, DNS:*.b.com") 判断 host 是否被覆盖(支持单层通配) */
export function sanCovers(san: string | undefined, host: string): boolean | null {
  if (!san) return null;
  const names = san.split(",").map(s => s.trim()).filter(s => /^DNS:/i.test(s)).map(s => s.slice(4).toLowerCase());
  const h = host.toLowerCase();
  if (!names.length) return null;
  if (names.includes(h)) return true;
  return names.some(n => n.startsWith("*.") && h.endsWith(n.slice(1)) && h.split(".").length === n.split(".").length);
}

/**
 * 采集证书证据。http 站点 / 端口非 443 直接跳过 —— 不是"不通过",是不适用。
 */
export async function inspectTls(baseUrl: string, now: Date = new Date()): Promise<TlsInfo | { skipped: true; reason: string }> {
  let u: URL;
  try { u = new URL(baseUrl); } catch { return { skipped: true, reason: "base_url 解析失败" }; }
  if (u.protocol !== "https:") return { skipped: true, reason: "非 https" };
  const port = Number(u.port || 443);
  const host = u.hostname;
  const checkedAt = now.toISOString();

  const peer = await tlsHandshake(host, port, false);
  if (!peer.ok || !peer.cert) {
    return {
      host, port, checkedAt, handshakeOk: false, chainValid: null,
      errorCode: peer.errorCode ?? "NO_CERT", sanMatch: null,
      subject: null, issuer: null, notAfter: null, daysLeft: null, protocol: peer.protocol ?? null,
    };
  }
  const verified = await tlsHandshake(host, port, true);
  const cert = peer.cert;
  const notAfterDate = cert.valid_to ? new Date(cert.valid_to) : null;
  const daysLeft = notAfterDate && !isNaN(notAfterDate.getTime())
    ? Math.floor((notAfterDate.getTime() - now.getTime()) / 86_400_000) : null;
  const pick = (o: tls.Certificate | undefined) => (o && (o.CN || o.O)) ? [o.CN, o.O].filter(Boolean).join(" / ") : null;
  return {
    host, port, checkedAt,
    handshakeOk: true,
    chainValid: verified.ok,
    errorCode: verified.ok ? null : (verified.errorCode ?? "UNVERIFIED"),
    sanMatch: sanCovers(cert.subjectaltname, host),
    subject: pick(cert.subject),
    issuer: pick(cert.issuer),
    notAfter: notAfterDate ? notAfterDate.toISOString() : null,
    daysLeft,
    protocol: peer.protocol ?? null,
  };
}

export interface TlsVerdict { level: "ok" | "warn" | "info" | "none"; label: string }

/**
 * 证书结论的口径(纯函数,便于单测)。**任何分支都不产出分数或扣分语义**:
 * 证书异常只说明"这条链不完美",不说明"这站不能用"——可用性由健康检查本身判定。
 */
export function judgeTls(t: HealthResult["tls"], daysWarn = 15): TlsVerdict {
  if (!t) return { level: "none", label: "未采集" };
  if ((t as { skipped?: boolean }).skipped) return { level: "info", label: `不适用(${(t as { reason: string }).reason})` };
  const i = t as TlsInfo;
  if (!i.handshakeOk) return { level: "warn", label: `握手失败(${i.errorCode || "未知"})· 不影响接口可调用性结论` };
  if (i.chainValid === false) return { level: "warn", label: `证书链未通过系统 CA(${i.errorCode || "UNVERIFIED"})· 常见于自签或链不全,不代表站点不可用` };
  if (i.sanMatch === false) return { level: "warn", label: "证书域名与接口域名不一致 · 请核对是否走了 CDN/反代" };
  if (i.daysLeft !== null && i.daysLeft <= daysWarn) return { level: "warn", label: `证书 ${i.daysLeft} 天后到期(${i.notAfter?.slice(0, 10)})` };
  return { level: "ok", label: `证书有效${i.daysLeft !== null ? ` · 剩余 ${i.daysLeft} 天` : ""}${i.protocol ? ` · ${i.protocol}` : ""}` };
}

export async function runHealth(site: SiteConfig): Promise<HealthResult> {
  const startedAt = new Date().toISOString();
  // base_url 规范化:已含 /v1、/api/v1、/api/paas/v4 等版本段的按原样用;
  // 裸 origin 的(如 https://aixoras.com)补 /v1(OpenAI 兼容约定)。
  let base = site.base_url.replace(/\/+$/, "").replace(/\/models$/, "");
  if (!/\/v\d+(\/|$)/.test(base) && !/\/api(\/|$)/.test(base)) base = `${base}/v1`;
  const modelsUrl = `${base}/models`;
  // 配置了 key_env 时携带鉴权头(真实中转站需要)
  const apiKey = site.key_env ? process.env[site.key_env] : undefined;
  const authHeaders = apiKey ? { Authorization: `Bearer ${apiKey}` } : {};

  // ---- ① models 列表 ----
  const modelsCheck = await (async () => {
    const t0 = Date.now();
    try {
      const res = await fetchWithTimeout(modelsUrl, { headers: authHeaders });
      const latencyMs = Date.now() - t0;
      let modelCount: number | null = null;
      let modelIds: string[] | undefined;
      let authGate = false;
      let errObj: { message?: string; type?: string } | undefined;
      try {
        const body = (await res.json()) as { data?: Array<{ id?: string }> };
        if (Array.isArray(body.data)) {
          modelCount = body.data.length;
          modelIds = body.data.map(m => m.id).filter((x): x is string => !!x);
        }
        errObj = body.error;
      } catch { /* 非 JSON 不影响存活判定 */ }
      if (modelCount === null && isAuthGate(res.status, errObj)) authGate = true;
      // ok 语义:2xx 正常返回,或 401/403 鉴权门(服务在线)
      return { ok: res.ok || authGate, httpStatus: res.status, latencyMs, modelCount, modelIds, authGate };
    } catch (e) {
      return { ok: false, httpStatus: null, latencyMs: Date.now() - t0, modelCount: null, authGate: false, error: `[${classifyError(e)}] ${(e as Error).message}` };
    }
  })();

  // ---- ② 最小 chat 请求 ----
  // 带 key 时用站内真实模型(models 列表第一个;探针专属模型名在 new-api 系站会 model_not_found)
  const probeModel = modelsCheck.modelIds?.[0] ?? "relaylens-healthcheck";
  const chatCheck = await (async () => {
    const t0 = Date.now();
    try {
      const res = await fetchWithTimeout(`${base}/chat/completions`, {
        method: "POST",
        headers: { "Content-Type": "application/json", ...authHeaders },
        body: JSON.stringify({
          model: probeModel,
          messages: [{ role: "user", content: "ping" }],
          max_tokens: 1,
          stream: false,
        }),
      });
      const ttftMs = Date.now() - t0;
      let complete = false;
      let authGate = false;
      let modelMissing = false;
      try {
        const body = (await res.json()) as { choices?: unknown[]; error?: { message?: string; type?: string; code?: string } };
        complete = Array.isArray(body.choices) && body.choices.length > 0 && !body.error;
        if (!complete && isAuthGate(res.status, body.error)) authGate = true;
        // 200 + model_not_found:服务在线但探针模型不可用(不完整 → degraded)
        if (body.error && /model_not_found|no available channel|invalid model/i.test(`${body.error.code ?? ""} ${body.error.message ?? ""}`)) modelMissing = true;
      } catch { /* body 解析失败 → 不完整 */ }
      // ok 语义:2xx 且无 model_not_found 错误,或鉴权门
      return { ok: (res.ok && !modelMissing) || authGate, httpStatus: res.status, ttftMs, complete, authGate };
    } catch (e) {
      return { ok: false, httpStatus: null, ttftMs: Date.now() - t0, complete: false, authGate: false, error: `[${classifyError(e)}] ${(e as Error).message}` };
    }
  })();

  // ---- 综合判定 ----
  const served = modelsCheck.ok || chatCheck.ok;                       // 服务响应(含鉴权门)
  const fullyCompatible = (modelsCheck.ok && (modelsCheck.modelCount !== null || chatCheck.complete));
  const anyHttpOk = [modelsCheck.httpStatus, chatCheck.httpStatus].some(s => s !== null && s >= 200 && s < 500);
  const status: HealthResult["overall"]["status"] =
    fullyCompatible ? "up" : (served || anyHttpOk) ? "degraded" : "down";

  // ---- ③ TLS 证书证据(确定性事实,不进评分;失败也不影响上面的可用性判定)----
  let tlsInfo: HealthResult["tls"];
  try {
    tlsInfo = await inspectTls(site.base_url);
  } catch (e) {
    tlsInfo = { skipped: true, reason: `采集异常: ${(e as Error).message}` };
  }

  return {
    task: "health",
    site: site.name,
    startedAt,
    modelsCheck,
    chatCheck,
    overall: { ok: served, status },
    tls: tlsInfo,
  };
}
