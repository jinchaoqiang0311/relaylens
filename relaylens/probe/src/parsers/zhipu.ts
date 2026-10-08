/**
 * 智谱 BigModel 官方解析器 —— 定价来自 open.bigmodel.cn 公开定价信息
 * v0.2:智谱定价页为前端渲染,直接 HTML 解析不可靠;
 * 采用"静态价格表 + 页面可达性校验"策略:页面可达时返回静态表(人工核对录入),
 * 页面不可达时记录 parseError。接 P1 后期可升级为其开放 API。
 * 价格口径:¥/M tokens(官方人民币计价)。
 */
import type { PriceResult, SiteConfig } from "../../../shared/types.js";

const PRICING_PAGE = "https://open.bigmodel.cn/pricing";
const TIMEOUT_MS = 20_000;

/** 人工核对录入的官方价(¥/M tokens;更新时在 changelog 记录) */
const STATIC_PRICES: Array<{ model: string; input: number; output: number; cacheRead: number | null; cacheWrite: number | null }> = [
  { model: "glm-5.2",            input: 2,   output: 8,   cacheRead: 0.4,  cacheWrite: 2.5 },
  { model: "glm-5.2-air",        input: 0.8, output: 2,   cacheRead: 0.16, cacheWrite: 1 },
  { model: "glm-5.2-flash",      input: 0,   output: 0,   cacheRead: 0,    cacheWrite: 0 },      // 免费档
  { model: "glm-5.2-airx",       input: 1,   output: 3,   cacheRead: 0.2,  cacheWrite: 1.25 },
  { model: "glm-5v",             input: 2,   output: 6,   cacheRead: null, cacheWrite: null },
];

export async function parseZhipu(site: SiteConfig): Promise<PriceResult> {
  const capturedAt = new Date().toISOString();
  const parseErrors: string[] = [];

  // 页面可达性校验(仅确认站点与定价页在线,不解析渲染内容)
  const ctrl = new AbortController();
  const t = setTimeout(() => ctrl.abort(), TIMEOUT_MS);
  let pageOk = false;
  try {
    const res = await fetch(PRICING_PAGE, { signal: ctrl.signal, headers: { "User-Agent": "RelayLens-Probe/0.1" } });
    pageOk = res.ok;
    if (!res.ok) parseErrors.push(`pricing page HTTP ${res.status}`);
  } catch (e) {
    parseErrors.push(`pricing page unreachable: ${(e as Error).message}`);
  } finally {
    clearTimeout(t);
  }
  if (!pageOk) parseErrors.push("using static prices (page not reachable)");

  return {
    task: "price",
    site: site.name,
    capturedAt,
    currency: "CNY",
    models: STATIC_PRICES.map(p => ({
      model: p.model,
      input: p.input,
      output: p.output,
      cacheRead: p.cacheRead,
      cacheWrite: p.cacheWrite,
      group: "official",
      source: pageOk ? "static-verified" : "static-fallback",
    })),
    ratio: null, // 人民币直购,无充值比例
    parser: "zhipu",
    parseErrors,
  };
}
