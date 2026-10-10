/**
 * 探针 A:健康检查 —— 可用率与状态看板的数据源
 * 两个请求:① GET {base}/models ② 最小 chat 请求(max_tokens=1)
 * 判定(与 method.html 一致):
 *   up       = 服务响应 2xx 且响应结构完整(真 OpenAI 兼容)
 *   degraded = 服务在线但被鉴权门拦截(401/403 无 key 时能确认的极限)或响应结构不完整
 *   down     = 连不上 / 超时 / 5xx
 * 注:base_url 已含 /v1 等前缀时按原样拼接。
 */
import type { HealthResult, SiteConfig } from "../../../shared/types.js";

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

  return {
    task: "health",
    site: site.name,
    startedAt,
    modelsCheck,
    chatCheck,
    overall: { ok: served, status },
  };
}
