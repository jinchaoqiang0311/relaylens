/**
 * scheduler.ts —— 任务编排(调度器骨架)
 * 铁律:单站失败不传染;先 raw 后 metrics;任务收尾统一 rebuild。
 * v0.1 用 node-cron;`schedule` 命令常驻,`once` 单次执行。
 */
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
export async function runTask(site: SiteConfig, task: TaskName, cfg: ProbeConfig, opts: { rounds?: number } = {}): Promise<boolean> {
  // ---- billing 自带 batchId 与逐轮落库,单独处理 ----
  if (task === "billing") {
    const startedAt = new Date().toISOString();
    try {
      const res = await withTimeout(runBilling(site, cfg, opts), TIMEOUT_DEFAULT.billing, `billing:${site.name}`) as BillingResult;
      const batch: Batch = { batchId: res.batchId, site: site.name, task, startedAt, ok: res.errors.length === 0, result: res };
      const rawPath = saveRaw(batch);
      persistBilling(site.name, res, rawPath);
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
  for (const site of list) {
    await runTask(site, task, cfg, opts);
  }
  // rebuild 始终基于全部在册站点(单站重跑不得覆盖其他站点的 dist 数据)
  rebuild(enabledSites(cfg).map(s => s.name));
  console.log(`▸ ${task} round 完成,dist 已重建`);
}

/** 常驻调度 */
export function startScheduler(cfg: ProbeConfig) {
  console.log("🧲 调度器启动(P1:health + price;billing 待 P2)");
  cron.schedule(cfg.schedules.health, () => { void runRound(cfg, "health"); });
  cron.schedule(cfg.schedules.price, () => { void runRound(cfg, "price"); });
  // P2:cron.schedule(cfg.schedules.billing, () => runRound(cfg, "billing", pickRotating(2)));
}
