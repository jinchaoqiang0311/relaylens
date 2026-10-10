/**
 * OpenRouter 解析器 —— 定价内嵌于 /api/v1/models 响应(免鉴权)
 * pricing 单位:USD / token → 换算为 USD / M tokens
 */
import type { PriceResult, SiteConfig } from "../../../shared/types.js";

const MODELS_URL = "https://openrouter.ai/api/v1/models";
const TIMEOUT_MS = 30_000;
/** 只采集关注的模型(官方锚基准;2026-10-03 换代:对齐 17 个主力模型)。前缀匹配,故含日期/预览后缀变体也能命中 */
const WATCHED = [
  "openai/gpt-5.6-sol", "openai/gpt-5.6-terra", "openai/gpt-6-astra", "openai/gpt-6-sol", "openai/gpt-6.1-sol",
  "anthropic/claude-sonnet-5.5", "anthropic/claude-opus-5.5", "anthropic/claude-fable-5.1", "anthropic/claude-sonnet-5",
  "google/gemini-3.1-pro", "google/gemini-3.7-flash", "google/gemini-3.5-flash",
  "x-ai/grok-4.7", "deepseek/deepseek-v4-pro", "deepseek/deepseek-v4.1-flash", "moonshotai/kimi-k3", "z-ai/glm-5.3",
];

interface ORModel {
  id: string;
  pricing?: Record<string, string>;
}

/** token 价 → M token 价 */
function perM(v: string | undefined): number | null {
  if (v === undefined || v === null || v === "") return null;
  const n = Number(v);
  if (!Number.isFinite(n)) return null;
  return Math.round(n * 1_000_000 * 1e8) / 1e8; // /M,保留8位小数
}

export async function parseOpenRouter(site: SiteConfig): Promise<PriceResult> {
  const capturedAt = new Date().toISOString();
  const parseErrors: string[] = [];
  const ctrl = new AbortController();
  const t = setTimeout(() => ctrl.abort(), TIMEOUT_MS);
  let models: Array<PriceResult["models"][number]> = [];

  try {
    const res = await fetch(MODELS_URL, {
      signal: ctrl.signal,
      headers: { "User-Agent": "RelayLens-Probe/0.1" },
    });
    if (!res.ok) throw new Error(`models API HTTP ${res.status}`);
    const body = (await res.json()) as { data?: ORModel[] };
    const all = body.data ?? [];

    for (const wanted of WATCHED) {
      // 允许前缀匹配(如 anthropic/claude-opus-5 可能带日期后缀)
      const m = all.find(x => x.id === wanted) ?? all.find(x => x.id.startsWith(wanted));
      if (!m) { parseErrors.push(`model not found: ${wanted}`); continue; }
      const p = m.pricing ?? {};
      const input = perM(p.prompt);
      const output = perM(p.completion);
      if (input === null || output === null) { parseErrors.push(`pricing missing: ${m.id}`); continue; }
      models.push({
        model: m.id,
        input,
        output,
        cacheRead: perM(p.input_cache_read),
        cacheWrite: perM(p.input_cache_write),
        group: "default",
        source: "models-api",
      });
    }
  } finally {
    clearTimeout(t);
  }

  return {
    task: "price",
    site: site.name,
    capturedAt,
    currency: "USD",
    models,
    ratio: null, // OpenRouter 直接美元计价
    parser: "openrouter",
    parseErrors,
  };
}
