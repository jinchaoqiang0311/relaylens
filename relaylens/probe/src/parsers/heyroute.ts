import fs from "node:fs";
import path from "node:path";
import type { PriceResult, SiteConfig } from "../../../shared/types.js";
import { STORE_DIR } from "../store.js";

const IMPORT_DIR = path.join(STORE_DIR, "manual-imports");

interface HRGroup { group: string; ratio?: number; input?: number | null; output?: number | null; cacheRead?: number | null }
interface HRModel {
  model: string;
  input?: number | null; output?: number | null; cacheRead?: number | null;
  listInput?: number | null; listOutput?: number | null; listCacheRead?: number | null;
  group?: string; grpRatio?: number;
  base?: { input?: number | null; output?: number | null; cacheRead?: number | null };
  groups?: HRGroup[]; source?: string;
}
interface HRPayload { scrapedAt?: string; site?: string; note?: string; models?: HRModel[] }

function round8(n: number): number { return Math.round(n * 1e8) / 1e8; }
const num = (v: unknown): number | null => (typeof v === "number" && isFinite(v) && v >= 0 ? v : null);

function latestImport(): { file: string; mtime: Date } | null {
  if (!fs.existsSync(IMPORT_DIR)) return null;
  const files = fs.readdirSync(IMPORT_DIR)
    .filter((f) => f.startsWith("heyroute-prices") && f.endsWith(".json"))
    .map((f) => ({ file: path.join(IMPORT_DIR, f), mtime: fs.statSync(path.join(IMPORT_DIR, f)).mtime }))
    .sort((a, b) => b.mtime.getTime() - a.mtime.getTime());
  return files[0] ?? null;
}

export async function parseHeyRoute(site: SiteConfig): Promise<PriceResult> {
  const parseErrors: string[] = [];
  const models: Array<PriceResult["models"][number]> = [];
  const imp = latestImport();
  if (!imp) {
    return {
      task: "price", site: site.name, capturedAt: new Date().toISOString(),
      currency: "USD", models: [], ratio: null, parser: "heyroute-manual",
      parseErrors: ["no manual import found — login heyroute.ai, open /pricing, scrape to heyroute-prices-*.json then rerun"],
    };
  }
  const body = JSON.parse(fs.readFileSync(imp.file, "utf8")) as HRPayload;
  const capturedAt = imp.mtime.toISOString();
  const rows = body.models ?? [];
  if (!rows.length) throw new Error("heyroute import 无 models");

  for (const m of rows) {
    const name = m.model;
    if (!name) continue;
    const input = num(m.input), output = num(m.output);
    if (input == null || output == null) { parseErrors.push(`价格缺失跳过: ${name}`); continue; }
    const cr = num(m.cacheRead);
    const grp = m.group || "default";
    const grpRatio = typeof m.grpRatio === "number" ? m.grpRatio : 1;
    const listNote = m.listInput != null && m.listOutput != null
      ? ` · list(before promo) in$${m.listInput}/out$${m.listOutput}` : "";
    models.push({
      model: name,
      input: round8(input), output: round8(output),
      cacheRead: cr != null ? round8(cr) : null, cacheWrite: null,
      group: grp, groupKind: "default", grpRatio,
      base: { input: round8(input), output: round8(output), cacheRead: cr != null ? round8(cr) : null },
      groups: (m.groups ?? []).map((g) => ({
        group: g.group, ratio: round8(typeof g.ratio === "number" ? g.ratio : 1),
        input: round8(num(g.input) ?? input), output: round8(num(g.output) ?? output),
        cacheRead: num(g.cacheRead) != null ? round8(num(g.cacheRead) as number) : null,
      })),
      source: `${m.source || "heyroute-pricing-page"}${listNote} · ${path.basename(imp.file)}`,
    });
  }

  return {
    task: "price", site: site.name, capturedAt,
    currency: "USD", models, ratio: null, parser: "heyroute-manual", parseErrors,
  };
}
