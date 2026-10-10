/**
 * DeepSeek 官方解析器 —— 定价来自 api-docs.deepseek.com 定价页
 * 页面结构:MODEL 行(deepseek-flash / deepseek-v4-pro)
 *   PRICING 表:1M INPUT (CACHE HIT) OFF-PEAK/PEAK、CACHE MISS OFF-PEAK/PEAK、OUTPUT
 * 官方为 USD 计价;缓存读 = CACHE HIT(峰谷取 PEAK 保守口径),缓存写 = CACHE MISS 输入价。
 */
import type { PriceResult, SiteConfig } from "../../../shared/types.js";

const PRICING_URL = "https://api-docs.deepseek.com/quick_start/pricing";
const TIMEOUT_MS = 30_000;
const USD_CNY = 7.2; // 汇率占位:接真实汇率源后替换(仅用于展示换算,ratio 字段记录)

interface ParsedPricing {
  cacheHit: { off: number[]; peak: number[] };   // 列 = [flash, v4-pro]
  cacheMiss: { off: number[]; peak: number[] };
  output: { off: number[]; peak: number[] };
  modelNames: string[];
}

function extractTable(html: string): ParsedPricing | null {
  // 提取全部表格行
  const rows = [...html.matchAll(/<tr[^>]*>([\s\S]*?)<\/tr>/g)].map(m => m[1]);
  const cells = rows.map(r =>
    [...r.matchAll(/<t[dh][^>]*>([\s\S]*?)<\/t[dh]>/g)].map(c =>
      c[1].replace(/<[^>]+>/g, " ").replace(/\s+/g, " ").trim()
    )
  );
  // 找 PRICING 行起点
  let start = cells.findIndex(r => r.some(c => /^pricing/i.test(c)));
  if (start < 0) return null;
  // 注意:PRICING 行本身携带第一类的 OFF-PEAK 价格,不可跳过
  const tail = cells.slice(start);
  // 只匹配 $ 前缀价格(避免 "1M INPUT TOKENS" 中的 "1" 被误抓)
  const nums = (s: string) => (s.match(/\$([\d.]+)/) ?? [])[1];

  // 行结构(实测,每类价格占两行,列 = [flash, v4-pro]):
  //   ['PRICING','1M INPUT TOKENS(CACHE HIT)','OFF-PEAK','$off1','$off2']
  //   ['PEAK','$peak1','$peak2']
  //   ['1M INPUT TOKENS(CACHE MISS)','OFF-PEAK',...]
  //   ['PEAK',...]
  //   ['1M OUTPUT TOKENS','OFF-PEAK',...]
  //   ['PEAK',...]
  const takeCat = (): { off: number[]; peak: number[] } => {
    const off = (tail.shift() ?? []).map(nums).filter(Boolean).map(Number);
    const peak = (tail.shift() ?? []).map(nums).filter(Boolean).map(Number);
    return { off, peak };
  };

  const hit = takeCat();
  const miss = takeCat();
  const out = takeCat();
  if (hit.peak.length < 2 || miss.peak.length < 2 || out.peak.length < 2) return null;

  // 模型名:PRICING 前最近的 MODEL 行
  const modelRowIdx = cells.slice(0, start).reduce((acc, r, i) => r.some(c => /^model$/i.test(c)) ? i : acc, -1);
  const modelNames = modelRowIdx >= 0 ? cells[modelRowIdx].slice(1) : [];

  return {
    cacheHit: { off: hit.off, peak: hit.peak },
    cacheMiss: { off: miss.off, peak: miss.peak },
    output: { off: out.off, peak: out.peak },
    modelNames,
  };
}

export async function parseDeepSeek(site: SiteConfig): Promise<PriceResult> {
  const capturedAt = new Date().toISOString();
  const parseErrors: string[] = [];
  let models: Array<PriceResult["models"][number]> = [];

  const ctrl = new AbortController();
  const t = setTimeout(() => ctrl.abort(), TIMEOUT_MS);
  try {
    const res = await fetch(PRICING_URL, { signal: ctrl.signal, headers: { "User-Agent": "RelayLens-Probe/0.1" } });
    if (!res.ok) throw new Error(`pricing page HTTP ${res.status}`);
    const html = await res.text();
    const p = extractTable(html);
    if (!p) throw new Error("pricing table structure changed");

    const variants: Array<{ model: string; idx: number }> = [
      { model: "deepseek-flash", idx: 0 },
      { model: "deepseek-v4-pro", idx: 1 },
    ];
    for (const v of variants) {
      const hitPeak = p.cacheHit.peak[v.idx];
      const missPeak = p.cacheMiss.peak[v.idx];
      const outPeak = p.output.peak[v.idx];
      if ([hitPeak, missPeak, outPeak].some(x => !Number.isFinite(x))) {
        parseErrors.push(`column ${v.idx} pricing incomplete`);
        continue;
      }
      models.push({
        model: v.model,
        input: missPeak,          // 输入价 = cache miss(峰时,保守)
        output: outPeak,
        cacheRead: hitPeak,       // 缓存读 = cache hit(峰时)
        cacheWrite: missPeak,     // 官方未单列缓存写价,按输入价
        group: "official",
        source: "pricing-page",
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
    ratio: { cny: USD_CNY, usd: 1 },
    parser: "deepseek",
    parseErrors,
  };
}
