/**
 * scheduler.ts —— 任务编排(调度器骨架)
 * 铁律:单站失败不传染;先 raw 后 metrics;任务收尾统一 rebuild。
 * v0.1 用 node-cron;`schedule` 命令常驻,`once` 单次执行。
 */
import fs from "node:fs";
import path from "node:path";
import cron from "node-cron";
import { runHealth } from "./probes/health.js";
import { runPrice } from "./probes/price.js";
import { runBilling, persistBilling, type BillingResult } from "./probes/billing.js";
import type { ProbeConfig, SiteConfig, TaskName, Batch } from "../../shared/types.js";
import { nextBatchId, saveRaw, recordBatch, logEvent } from "./store.js";
import { rebuild } from "./publisher.js";

export function enabledSites(cfg: ProbeConfig): SiteConfig[] {
  return cfg.sites.filter(s => s.enabled);
}

const TIMEOUT_DEFAULT: Record<TaskName, number> = { health: 60_000, price: 300_000, billing: 900_000 };

function withTimeout<T>(p: Promise<T>, ms: number, label: string): Promise<T> {
  return Promise.race([
    p,
    new Promise<T>((_, rej) => setTimeout(() => rej(new Error(`timeout(${label}, ${ms}ms)`)), ms)),
  ]);
}

/** 执行单站单任务:归档 → 入库 → 事件判定 */
export async function runTask(site: SiteConfig, task: TaskName, cfg: ProbeConfig, opts: { rounds?: number; collect?: (r: BillingResult) => void } = {}): Promise<boolean> {
  // ---- billing 自带 batchId 与逐轮落库,单独处理 ----
  if (task === "billing") {
    const startedAt = new Date().toISOString();
    try {
      const res = await withTimeout(runBilling(site, cfg, opts), TIMEOUT_DEFAULT.billing, `billing:${site.name}`) as BillingResult;
      const batch: Batch = { batchId: res.batchId, site: site.name, task, startedAt, ok: res.errors.length === 0, result: res };
      const rawPath = saveRaw(batch);
      persistBilling(site.name, res, rawPath);
      opts.collect?.(res);
      const dev = res.deviationPct;
      const infl = res.usageInflationRatio;
      console.log(`  ${res.errors.length === 0 ? "✓" : "⚠"} [billing] ${site.name} (${res.batchId}) ` +
        `轮次 ${res.rounds.length} · 实扣 ${res.actualCostCents === null ? "—" : "$" + (res.actualCostCents / 100).toFixed(4)} · ` +
        `应扣 ${res.expectedCostCents === null ? "—" : "$" + (res.expectedCostCents / 100).toFixed(4)} · ` +
        `偏差 ${dev === null ? "—" : dev + "%"} · 隐含倍率 ${res.impliedGroupRatio ?? "—"}` +
        (infl !== null ? ` · usage虚标 ${infl}×` : ""));
      if (dev !== null && Math.abs(dev) > cfg.thresholds.dev_warn) {
        logEvent(site.name, "billing_deviation", { batchId: res.batchId, deviationPct: dev, impliedGroupRatio: res.impliedGroupRatio });
      }
      if (infl !== null && infl > 3) {
        logEvent(site.name, "usage_inflation", { batchId: res.batchId, ratio: infl });
      }
      if (res.errors.length) res.errors.slice(0, 3).forEach(e => console.log(`      ↳ ${e}`));
      return res.errors.length === 0;
    } catch (e) {
      logEvent(site.name, "task_failed", { task, err: (e as Error).message });
      console.log(`  ✗ [billing] ${site.name} — ${(e as Error).message}`);
      return false;
    }
  }

  const batchId = nextBatchId();
  const startedAt = new Date().toISOString();
  try {
    const probe = task === "health" ? runHealth(site) : runPrice(site);
    const result = await withTimeout(probe as Promise<unknown>, TIMEOUT_DEFAULT[task], `${task}:${site.name}`);
    const batch: Batch = { batchId, site: site.name, task, startedAt, ok: true, result };

    // 先 raw 后 metrics
    const rawPath = saveRaw(batch);
    recordBatch(batch, rawPath, result as Record<string, unknown>);

    // 健康检查的事件判定(up→down = outage;down→up = recovered)
    if (task === "health") {
      const overall = (result as { overall: { status: string } }).overall;
      if (overall.status === "down") logEvent(site.name, "outage", { batchId, probe: "health" });
      else if (overall.status === "degraded") logEvent(site.name, "degraded", { batchId, detail: (result as { chatCheck: { httpStatus: number | null; complete: boolean } }).chatCheck });
    }
    // 价格任务:解析错误留痕
    if (task === "price") {
      const pe = (result as { parseErrors?: string[] }).parseErrors ?? [];
      if (pe.length) logEvent(site.name, "price_parse_issues", { batchId, count: pe.length, sample: pe.slice(0, 3) });
    }
    console.log(`  ✓ [${task}] ${site.name} (${batchId})`);
    return true;
  } catch (e) {
    const err = (e as Error).message;
    const batch: Batch = { batchId, site: site.name, task, startedAt, ok: false, result: { error: err } };
    try {
      const rawPath = saveRaw(batch);
      recordBatch(batch, rawPath, { error: err });
    } catch { /* 归档失败只打日志 */ }
    logEvent(site.name, "task_failed", { task, batchId, err });
    console.log(`  ✗ [${task}] ${site.name} — ${err} (${batchId})`);
    return false;
  }
}

/** 一轮任务:遍历站点,单站失败继续 */
export async function runRound(cfg: ProbeConfig, task: TaskName, sites?: SiteConfig[], opts: { rounds?: number } = {}): Promise<void> {
  const list = sites ?? enabledSites(cfg);
  console.log(`▸ ${task} round 开始 · ${list.length} 站 · ${new Date().toLocaleTimeString()}`);
  const billing: BillingResult[] = [];
  for (const site of list) {
    await runTask(site, task, cfg, task === "billing" ? { ...opts, collect: r => billing.push(r) } : opts);
  }
  // rebuild 始终基于全部在册站点(单站重跑不得覆盖其他站点的 dist 数据)
  rebuild(enabledSites(cfg).map(s => s.name));
  console.log(`▸ ${task} round 完成,dist 已重建`);
  // 健康轮收尾:刷新 ops.json 并把新增 critical 告警推送到企微(未配置网关时安静跳过)
  // billing 轮同样刷新:对账超差(mismatch)等 critical 发现要能推出去
  if (task === "health" || task === "billing") await pushOpsAlerts(cfg);
  if (task === "billing" && billing.length) await pushBillingRound(cfg, billing);
}

/** ops 告警推送:失败只打日志,绝不影响调度循环 */
async function pushOpsAlerts(cfg: ProbeConfig): Promise<void> {
  try {
    const { syncOps } = await import("./ops.js");
    const { referenceSiteNames } = await import("./sync.js");
    const { pushCriticalAlerts } = await import("./push.js");
    const targets = enabledSites(cfg).filter(s => !!s.key_env).map(s => s.name);
    const refs = enabledSites(cfg).filter(s => !s.key_env && referenceSiteNames().includes(s.name)).map(s => s.name);
    const { opsFile } = syncOps({ sites: targets, reference: refs });
    const r = await pushCriticalAlerts(opsFile);
    if (r.pushed) console.log(`  📲 已推送 ${r.pushed} 条紧急告警到企微`);
  } catch (e) {
    console.log(`  (ops 告警推送跳过:${(e as Error).message})`);
  }
}

/** billing 轮转选站:只在有 key 的站里轮;指针持久化到 store/billing-rotate.json,调度重启不重头开始 */
function pickRotating(cfg: ProbeConfig, n: number): SiteConfig[] {
  const eligible = enabledSites(cfg).filter(s => !!s.key_env);
  if (eligible.length === 0) return [];
  const file = path.join(import.meta.dirname, "..", "store", "billing-rotate.json");
  let idx = 0;
  try { idx = ((JSON.parse(fs.readFileSync(file, "utf8")) as { idx?: number }).idx ?? 0) % eligible.length; } catch { /* 无记录从 0 开始 */ }
  const picked = Array.from({ length: Math.min(n, eligible.length) }, (_, i) => eligible[(idx + i) % eligible.length]);
  try { fs.writeFileSync(file, JSON.stringify({ idx: (idx + picked.length) % eligible.length, at: new Date().toISOString() })); } catch { /* 写失败只影响下次起点 */ }
  return picked;
}

/** billing 轮收尾:轮结果摘要推企微(未配置网关安静跳过);偏差/虚标异常行加 ⚠ */
async function pushBillingRound(cfg: ProbeConfig, results: BillingResult[]): Promise<void> {
  try {
    const { pushWeComText } = await import("./push.js");
    const warn = cfg.thresholds.dev_warn;
    const usd = (c: number | null) => c === null ? "—" : "$" + (c / 100).toFixed(4);
    const lines = results.map(r => {
      const flags: string[] = [];
      if (r.deviationPct !== null && Math.abs(r.deviationPct) > warn) flags.push(`偏差${r.deviationPct}%`);
      if (r.usageInflationRatio !== null && r.usageInflationRatio > 3) flags.push(`虚标${r.usageInflationRatio}×`);
      if (r.errors.length) flags.push(`${r.errors.length} 错误`);
      return `${flags.length ? "⚠" : "✓"} ${r.site}(${r.batchId}) 实扣${usd(r.actualCostCents)} 应扣${usd(r.expectedCostCents)}` +
        ` 偏差${r.deviationPct ?? "—"}% 倍率${r.impliedGroupRatio ?? "—"}${flags.length ? " · " + flags.join(",") : ""}`;
    });
    const ok = results.filter(r => r.errors.length === 0).length;
    const sent = await pushWeComText(`💰 billing 对账轮 ${new Date().toLocaleString()} · ${ok}/${results.length} 站正常\n${lines.join("\n")}`);
    if (sent) console.log("  📲 billing 轮摘要已推送企微");
  } catch (e) {
    console.log(`  (billing 摘要推送跳过:${(e as Error).message})`);
  }
}

/** 常驻调度 */
export function startScheduler(cfg: ProbeConfig) {
  console.log("🧲 调度器启动:health + price 常驻" + (cfg.schedules.billing ? " · billing 自动对账已启用" : ""));
  cron.schedule(cfg.schedules.health, () => { void runRound(cfg, "health"); });
  cron.schedule(cfg.schedules.price, () => { void runRound(cfg, "price"); });
  // billing 自动对账(P2 已接通,2026-10-15 用户授权):有 key 的站轮转抽样,每轮 2 站,
  // 真实扣费为分/厘级;与 perf 双窗口同一兼容策略 —— 未配置 schedules.billing 时不启用。
  if (cfg.schedules.billing) {
    cron.schedule(cfg.schedules.billing, () => { void runRound(cfg, "billing", pickRotating(cfg, 2)); });
    console.log("⏱️ billing 自动对账已启用:" + cfg.schedules.billing + "(每轮轮转 2 站)");
  }
  // perf 双窗口(2026-10-10.1 口径,用户已拍板):忙时/闲时各一轮,PF 取两桶较差值。
  // 有余额的站才产生实际费用(厘级/天);未配置窗口时不启用(兼容旧配置)。
  if (cfg.schedules.perf_work && cfg.schedules.perf_off) {
    cron.schedule(cfg.schedules.perf_work, () => { void runPerfRound(cfg); });
    cron.schedule(cfg.schedules.perf_off, () => { void runPerfRound(cfg); });
    console.log("⏱️ perf 双窗口已启用:" + cfg.schedules.perf_work + "(忙) / " + cfg.schedules.perf_off + "(闲)");
  }
}

/** perf 轮:全站主模型 8 次 + 推理档加测(与 cli perf 同一套探针;单站失败不传染) */
async function runPerfRound(cfg: ProbeConfig): Promise<void> {
  const { runPerf, persistPerf, pickModel, pickReasoningModel } = await import("./probes/perf.js");
  const targets = enabledSites(cfg).filter(s => !!s.key_env);
  console.log(`▸ perf round 开始 · ${targets.length} 站 · ${new Date().toLocaleTimeString()}`);
  let done = 0;
  for (const site of targets) {
    try {
      const model = await pickModel(site);
      if (!model) { console.log(`  ✗ [perf] ${site.name} — 拿不到模型清单`); continue; }
      const res = await runPerf(site, model, { iters: 8 });
      persistPerf(res);
      done++;
      console.log(`  ✓ [perf] ${site.name} (${res.batchId}) 中位 ${res.medianTtftMs ?? "—"}ms · 成功 ${res.successRate ?? "—"}%`);
      const rmodel = await pickReasoningModel(site, model);
      if (rmodel) {
        const rres = await runPerf(site, rmodel, { iters: 6, category: "reasoning" });
        persistPerf(rres);
      }
    } catch (e) {
      logEvent(site.name, "task_failed", { task: "perf", err: (e as Error).message });
      console.log(`  ✗ [perf] ${site.name} — ${(e as Error).message}`);
    }
  }
  console.log(`▸ perf round 完成 · ${done}/${targets.length} 站`);
}
