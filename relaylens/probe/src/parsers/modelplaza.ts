/**
 * model-plaza 面板解析器 —— 白标签 new-api 变体(uuapi / hahacode / fluxionai 实测,2026-10-17)
 *
 * 端点:{origin}/api/v1/model-plaza(部分站)或 {origin}/api/v1/model-plaza/public(fluxionai)。
 * 这三个站没有 new-api 标准 /api/pricing(404),价格只在 SPA 的 model-plaza 数据接口里。
 *
 * 两种载荷形态(按 data.groups[0].models 是否存在自动识别):
 *
 *   A 组内嵌(uuapi / hahacode):groups[].models[].pricing
 *     展示价 = 该组最终价。实测证据:同一模型在倍率 0.2 / 0.4 / 1 的组里展示价完全相同;
 *     若组倍率要在展示价上再乘,0.2 组的到手价会比官方直连还便宜 —— 不成立,故不再乘倍率。
 *     official_pricing = 官方锚价(EP 评分与比价基准);组倍率 = 展示价÷锚价(隐含加价,保证三因子可验算)。
 *
 *   B 扁平价表(fluxionai):data.pricing[](带 group_ids)+ data.groups[].rate_multiplier
 *     经典 new-api 口径:组价 = 基础价 × 组倍率。pricing[] 按 channel 去重(取首条)。
 *
 * 单位:接口价 = USD/token,×1e6 转 USD/M。按次计价(per_request_price)跳过 —— 不进 token 比价。
 * 主口径组:default 优先,无默认组取中位倍率组(与 newapi 解析器同规则,铁律 3)。
 */
import type { PriceResult, SiteConfig } from "../../../shared/types.js";

const TIMEOUT_MS = 30_000;
const UA = "RelayLens-Probe/0.1";
const DEFAULT_RE = /^(default|默认|普通用户|normal)$/i;

function round8(n: number): number {
  return Math.round(n * 1e8) / 1e8;
}
/** USD/token → USD/M */
const perM = (v: unknown): number | null => (typeof v === "number" && isFinite(v) && v > 0 ? round8(v * 1e6) : null);

interface PlazaPricing {
  billing_mode?: string;
  input_price?: number | null;
  output_price?: number | null;
  cache_read_price?: number | null;
  cache_write_price?: number | null;
  per_request_price?: number | null;
  intervals?: Array<{ input_price?: number | null; output_price?: number | null; cache_read_price?: number | null; cache_write_price?: number | null }>;
}
interface PlazaModel {
  name?: string;
  pricing?: PlazaPricing;
  official_pricing?: PlazaPricing | null;
}
interface PlazaGroup {
  id?: number;
  name?: string;
  rate_multiplier?: number;
  models?: PlazaModel[];
}
interface PlazaFlatRow extends PlazaPricing {
  name?: string;
  group_ids?: number[];
  channel_id?: number;
  channel_name?: string;
  /** 部分站(fluxionai)价格字段在行级;部分站(兼容)收在 pricing 下 */
  pricing?: PlazaPricing;
}
interface PlazaPayload {
  code?: number;
  data?: {
    groups?: PlazaGroup[];
    pricing?: PlazaFlatRow[];
  };
}

/** 取价:顶层字段优先,缺项回退第一个 interval(长上下文分档的基础档) */
function priceOf(p: PlazaPricing | undefined | null): { input: number | null; output: number | null; cacheRead: number | null; cacheWrite: number | null } {
  const iv = p?.intervals?.[0];
  return {
    input: perM(p?.input_price) ?? perM(iv?.input_price),
    output: perM(p?.output_price) ?? perM(iv?.output_price),
    cacheRead: perM(p?.cache_read_price) ?? perM(iv?.cache_read_price),
    cacheWrite: perM(p?.cache_write_price) ?? perM(iv?.cache_write_price),
  };
}

/** 主口径组:default 优先 → 中位倍率组(绝不取最低组当主价,铁律 3) */
function pickHead<T extends { group: string; ratio: number }>(all: T[]): { head: T; groupKind: "default" | "median" } {
  const def = all.find(x => DEFAULT_RE.test(x.group));
  if (def) return { head: def, groupKind: "default" };
  const sorted = [...all].sort((a, b) => a.ratio - b.ratio);
  return { head: sorted[Math.floor(sorted.length / 2)], groupKind: "median" };
}

export async function parseModelPlaza(site: SiteConfig): Promise<PriceResult> {
  const capturedAt = new Date().toISOString();
  const parseErrors: string[] = [];
  const origin = site.base_url.replace(/\/+$/, "").replace(/\/v1$/, "");

  const ctrl = new AbortController();
  const t = setTimeout(() => ctrl.abort(), TIMEOUT_MS);
  let payload: PlazaPayload | null = null;
  try {
    let res: Response | null = null;
    for (const p of ["/api/v1/model-plaza", "/api/v1/model-plaza/public"]) {
      const r = await fetch(origin + p, { signal: ctrl.signal, headers: { "User-Agent": UA } });
      if (r.ok) { res = r; break; }
    }
    if (!res) throw new Error("model-plaza 端点不可达(两个候选路径均非 200)");
    payload = (await res.json()) as PlazaPayload;
    if (payload.code !== 0 && payload.code !== undefined) {
      throw new Error(`model-plaza 返回 code=${payload.code}(非成功态)`);
    }
  } finally {
    clearTimeout(t);
  }

  const data = payload?.data;
  const groups = data?.groups ?? [];
  if (!groups.length) throw new Error("model-plaza groups 为空");

  const models: Array<PriceResult["models"][number]> = [];
  /* 形态识别:只要有任一组内嵌了非空 models 就是 A 型;groups 带空 models 数组的站(fluxionai)
     必须落到 B 型,不能因 "models 键存在" 误判 —— 误判会静默解析出 0 个模型。 */
  const variantA = groups.some(g => Array.isArray(g.models) && (g.models?.length ?? 0) > 0);
  const flatList = data?.pricing ?? [];
  if (!variantA && !flatList.length) throw new Error("model-plaza 既无组内嵌 models 也无扁平 pricing 表");

  if (variantA) {
    /* ---------- A 组内嵌:展示价即最终价,official_pricing 作锚 ---------- */
    /* A 型组倍率口径(2026-10-17 定):声明的 rate_multiplier 不随展示价缩放(实测同模型跨
       0.2/0.4/1 倍率组展示价完全相同),拿它当倍率会让「官方价×倍率=额度价」验算不成立
       (铁律 1 要求三因子可验算)。故倍率取**隐含加价 = 该组展示价 ÷ 官方锚价**;
       官方锚缺失时倍率记 1、base 退回展示价自身。 */
    const raw = new Map<string, Array<{ group: string; declared: number; input: number | null; output: number | null; cacheRead: number | null; cacheWrite: number | null }>>();
    const official = new Map<string, { input: number | null; output: number | null; cacheRead: number | null }>();
    for (const g of groups) {
      const gname = g.name || `group-${g.id ?? "?"}`;
      const declared = typeof g.rate_multiplier === "number" && g.rate_multiplier > 0 ? g.rate_multiplier : 1;
      for (const m of g.models ?? []) {
        const name = m.name;
        if (!name) continue;
        const p = m.pricing;
        if (p?.billing_mode && p.billing_mode !== "token") { parseErrors.push(`非 token 计价跳过: ${name}`); continue; }
        if (p?.per_request_price != null) { parseErrors.push(`按次计价跳过: ${name}`); continue; }
        const pr = priceOf(p);
        if (pr.input == null) continue;   // 无有效价,宁缺毋错
        if (!raw.has(name)) raw.set(name, []);
        raw.get(name)!.push({ group: gname, declared, input: pr.input, output: pr.output, cacheRead: pr.cacheRead, cacheWrite: pr.cacheWrite });
        if (m.official_pricing && !official.has(name)) {
          const o = priceOf(m.official_pricing);
          if (o.input != null) official.set(name, { input: o.input, output: o.output, cacheRead: o.cacheRead });
        }
      }
    }
    const implied = (v: number | null, b: number | null): number => (v != null && b != null && b > 0 ? round8(v / b) : 1);
    for (const [name, all] of raw) {
      const { head, groupKind } = pickHead(all.map(x => ({ group: x.group, ratio: x.declared })));
      const headRow = all.find(x => x.group === head.group)!;
      const anchor = official.get(name);
      const base = anchor
        ? { input: anchor.input as number, output: (anchor.output ?? anchor.input) as number, cacheRead: anchor.cacheRead }
        : { input: headRow.input as number, output: (headRow.output ?? headRow.input) as number, cacheRead: headRow.cacheRead };
      models.push({
        model: name,
        input: headRow.input as number, output: (headRow.output ?? headRow.input) as number, cacheRead: headRow.cacheRead, cacheWrite: headRow.cacheWrite,
        group: headRow.group, groupKind,
        grpRatio: implied(headRow.input, anchor?.input ?? null),
        base,
        groups: all.map(x => ({
          group: x.group,
          ratio: implied(x.input, anchor?.input ?? null),
          input: x.input as number, output: (x.output ?? x.input) as number, cacheRead: x.cacheRead,
        })),
        source: "model-plaza-api(A型:展示价=最终价,倍率=展示价÷官方锚价,声明倍率不缩放已核实)",
      });
    }
  } else {
    /* ---------- B 扁平价表:组价 = 基础价 × 组倍率 ---------- */
    const list = flatList;
    const gmap = new Map<number, { name: string; ratio: number }>();
    for (const g of groups) if (typeof g.id === "number") gmap.set(g.id, { name: g.name || `group-${g.id}`, ratio: typeof g.rate_multiplier === "number" && g.rate_multiplier > 0 ? g.rate_multiplier : 1 });
    const seen = new Set<string>();
    for (const row of list) {
      const name = row.name;
      if (!name) continue;
      const p: PlazaPricing = row.pricing ?? row;   // 行级直摆(fluxionai)或收在 pricing 下,两种都认
      if (p?.billing_mode && p.billing_mode !== "token") { parseErrors.push(`非 token 计价跳过: ${name}`); continue; }
      if (p?.per_request_price != null) { parseErrors.push(`按次计价跳过: ${name}`); continue; }
      if (seen.has(name)) continue;   // 多渠道重复行:取首条(渠道是上游路由,不影响组倍率计价)
      seen.add(name);
      const base = priceOf(p);
      if (base.input == null) continue;
      const gs = (row.group_ids ?? []).map(id => gmap.get(id)).filter(Boolean) as Array<{ name: string; ratio: number }>;
      if (!gs.length) { parseErrors.push(`无可用分组: ${name}`); continue; }
      const all = gs.map(g => ({
        group: g.name, ratio: g.ratio,
        input: round8((base.input as number) * g.ratio),
        output: round8((base.output ?? base.input as number) * g.ratio),
        cacheRead: base.cacheRead != null ? round8(base.cacheRead * g.ratio) : null,
      }));
      const { head, groupKind } = pickHead(all);
      models.push({
        model: name,
        input: head.input, output: head.output, cacheRead: head.cacheRead, cacheWrite: base.cacheWrite != null ? round8(base.cacheWrite * head.ratio) : null,
        group: head.group, groupKind, grpRatio: head.ratio,
        base: { input: base.input as number, output: base.output as number, cacheRead: base.cacheRead },
        groups: all,
        source: "model-plaza-api(组价=基础价×组倍率)",
      });
    }
  }

  if (!models.length) throw new Error(`model-plaza 解析出 0 个有效模型(parseErrors ${parseErrors.length} 条)`);

  return {
    task: "price",
    site: site.name,
    capturedAt,
    currency: "USD",
    models,
    ratio: null,
    parser: "modelplaza",
    parseErrors,
  };
}
