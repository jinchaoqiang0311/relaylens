/**
 * uptoken 解析器(2026-10-17 手动导入模式)
 *
 * uptoken 的价格数据只在登录态可见:SPA(Aether 面板)通过
 *   POST /api/auth/refresh(头 x-client-device-id:<localStorage.aether_client_device_id>)
 *   → 换 access_token → GET /api/users/me/available-models?limit=1000(带 Bearer + 设备头)
 * 拿数据。探针无登录态,与 aicost 同解法:用户在已登录浏览器执行导出脚本落盘
 * store/manual-imports/uptoken-pricing-*.json(README-export.md 有脚本),解析器读最新文件。
 *
 * 载荷形态:{models:[{name, is_active, default_price_per_request,
 *   default_tiered_pricing:{tiers:[{up_to, input_price_per_1m, output_price_per_1m,
 *   cache_creation_price_per_1m, cache_read_price_per_1m}]}}], total}
 * 单位即 USD/1M token,无需换算;分档取**第一档**(up_to 最小的基础档,与 newapi tiered_expr 同口径);
 * 按次计价(default_price_per_request 非空且无 tiers)跳过 —— 不进 token 比价。
 * 该载荷是账号登录态可见价(个人套餐口径),无分组概念:单组 personal-account,倍率 1。
 */
import fs from "node:fs";
import path from "node:path";
import type { PriceResult, SiteConfig } from "../../../shared/types.js";
import { STORE_DIR } from "../store.js";

const IMPORT_DIR = path.join(STORE_DIR, "manual-imports");

interface UptokenTier {
  up_to: number | null;
  input_price_per_1m?: number | null;
  output_price_per_1m?: number | null;
  cache_creation_price_per_1m?: number | null;
  cache_read_price_per_1m?: number | null;
}
interface UptokenModel {
  name?: string;
  display_name?: string;
  is_active?: boolean;
  default_price_per_request?: number | null;
  default_tiered_pricing?: { tiers?: UptokenTier[] } | null;
}
interface UptokenPayload {
  models?: UptokenModel[];
  total?: number;
}

function round8(n: number): number {
  return Math.round(n * 1e8) / 1e8;
}
const num = (v: unknown): number | null => (typeof v === "number" && isFinite(v) && v >= 0 ? v : null);

function latestImport(): { file: string; mtime: Date } | null {
  if (!fs.existsSync(IMPORT_DIR)) return null;
  const files = fs.readdirSync(IMPORT_DIR)
    .filter(f => f.startsWith("uptoken-pricing") && f.endsWith(".json"))
    .map(f => ({ file: path.join(IMPORT_DIR, f), mtime: fs.statSync(path.join(IMPORT_DIR, f)).mtime }))
    .sort((a, b) => b.mtime.getTime() - a.mtime.getTime());
  return files[0] ?? null;
}

export async function parseUptoken(site: SiteConfig): Promise<PriceResult> {
  const parseErrors: string[] = [];
  const models: Array<PriceResult["models"][number]> = [];
  const imp = latestImport();
  if (!imp) {
    return {
      task: "price", site: site.name, capturedAt: new Date().toISOString(),
      currency: "USD", models: [], ratio: null, parser: "uptoken-manual",
      parseErrors: ["no manual import found — 登录 uptoken 后在浏览器 Console 执行导出脚本(见 store/manual-imports/README-export.md)落盘 uptoken-pricing-*.json,再重跑"],
    };
  }
  const body = JSON.parse(fs.readFileSync(imp.file, "utf8")) as UptokenPayload;
  const capturedAt = imp.mtime.toISOString();
  const rows = body.models ?? [];
  if (!rows.length) throw new Error("uptoken import 无 models");

  for (const m of rows) {
    const name = m.name;
    if (!name) continue;
    if (m.is_active === false) { parseErrors.push(`未激活跳过: ${name}`); continue; }
    const tiers = m.default_tiered_pricing?.tiers ?? [];
    if (!tiers.length) {
      if (m.default_price_per_request != null) parseErrors.push(`按次计价跳过: ${name}`);
      else parseErrors.push(`无 token 计价跳过: ${name}`);
      continue;
    }
    const t0 = tiers[0];   // 第一档 = 基础档(up_to 最小),长上下文高档不混入
    const input = num(t0.input_price_per_1m);
    const output = num(t0.output_price_per_1m);
    if (input == null || output == null) { parseErrors.push(`价格字段缺失跳过: ${name}`); continue; }
    models.push({
      model: name,
      input: round8(input), output: round8(output),
      cacheRead: num(t0.cache_read_price_per_1m) != null ? round8(num(t0.cache_read_price_per_1m) as number) : null,
      cacheWrite: num(t0.cache_creation_price_per_1m) != null ? round8(num(t0.cache_creation_price_per_1m) as number) : null,
      group: "personal-account", groupKind: "default", grpRatio: 1,
      base: { input: round8(input), output: round8(output), cacheRead: num(t0.cache_read_price_per_1m) != null ? round8(num(t0.cache_read_price_per_1m) as number) : null },
      groups: [{ group: "personal-account", ratio: 1, input: round8(input), output: round8(output), cacheRead: num(t0.cache_read_price_per_1m) != null ? round8(num(t0.cache_read_price_per_1m) as number) : null }],
      source: `uptoken-manual-import(${path.basename(imp.file)}·登录态账号价)`,
    });
  }

  return {
    task: "price", site: site.name, capturedAt,
    currency: "USD", models, ratio: null, parser: "uptoken-manual", parseErrors,
  };
}
