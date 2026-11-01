/**
 * ops.ts —— 只读运营看板数据层(C 方案)
 *
 * 定位:后台的「看」这一半。不写入、不鉴权、不做任何编辑动作 —— 编辑仍然走
 * 配置文件 + git + CLI,所有人工改动由 audit.ts 留痕。本模块只回答三个问题:
 *   ① 哪些数据老了 / 哪些站点没在测?(批次新鲜度矩阵)
 *   ② 为什么这个站还没分?(覆盖率 vs 门槛,门槛从 weights.json 取,页面不写死数字)
 *   ③ 现在有什么需要人看一眼?(待复核队列)
 *
 * 产物:
 *   data/ops.json    内部看板(不收录进 sitemap、robots noindex)
 *   data/audit.json  对外公开审计摘要(脱敏:CPS 明文永不入库,只有指纹)
 */
import fs from "node:fs";
import path from "node:path";
import { createHash } from "node:crypto";
import YAML from "yaml";
import { atomicWriteJson, getDb, siteHealth } from "./store.js";
import { assembleMetrics } from "./assemble.js";
import { latestInjection } from "./probes/tokenprobe.js";
import { pendingCount } from "./onboard.js";
import { computeSceneScore, allScenes, weightsVersion } from "./score.js";
import { auditVerify, auditList, type AuditEntry } from "./audit.js";

const PROBE_ROOT = path.resolve(import.meta.dirname, "..");
const WEB_DIR = path.resolve(PROBE_ROOT, "../../relaylens-home");
const DATA_DIR = path.join(WEB_DIR, "data");
const SHARED = path.resolve(PROBE_ROOT, "../shared");

interface Weights {
  version: string;
  confidence: Record<string, number>;
  scenes: Record<string, { label: string; separate?: boolean }>;
  injection_pricing?: { cached_share: number; fresh_share: number; source: string };
}
function loadWeights(): Weights {
  return JSON.parse(fs.readFileSync(path.join(SHARED, "weights.json"), "utf8")) as Weights;
}

function latestSummary(site: string, task?: string): { at: string; id: string; s: any } | null {
  const d = getDb();
  const row = (task
    ? d.prepare(`SELECT id, started_at, summary FROM batches WHERE site=? AND task=? ORDER BY started_at DESC LIMIT 1`).get(site, task)
    : d.prepare(`SELECT id, started_at, summary FROM batches WHERE site=? ORDER BY started_at DESC LIMIT 1`).get(site)) as
    { id: string; started_at: string; summary: string | null } | undefined;
  if (!row) return null;
  let s: any = null;
  try { s = row.summary ? JSON.parse(row.summary) : null; } catch { s = null; }
  return { at: row.started_at, id: row.id, s };
}

/**
 * 按 summary 标记找最近批次。对账与指纹批次历史上都挂在 task='billing' 下
 * (persistReconcile / persistFingerprint 复用了 billing 批次号段),
 * 所以必须按 summary 找,不能按 task 找 —— 否则会把「已测过」误报成「无数据」。
 */
function latestByMarker(site: string, marker: string): { at: string; id: string; s: any } | null {
  const row = getDb().prepare(`SELECT id, started_at, summary FROM batches
                               WHERE site=? AND summary LIKE ? ORDER BY started_at DESC LIMIT 1`)
    .get(site, `%${marker}%`) as { id: string; started_at: string; summary: string | null } | undefined;
  if (!row?.summary) return null;
  try { return { at: row.started_at, id: row.id, s: JSON.parse(row.summary) }; } catch { return null; }
}

const hoursAgo = (iso: string | null) => iso ? (Date.now() - new Date(iso).getTime()) / 3600_000 : Infinity;

/**
 * 该站最近一次 billing 批次里**真的扣到钱**了吗?
 * 不能只看 summary 里有没有 actualCostCents 字段 —— 失败的批次也会写入 `actualCostCents: null`,
 * 用字段存在与否判定会把"账户没钱、0 轮完成"的站误报成"付了钱却没对账"(一次误报了 10 家)。
 */
function reallySpent(site: string): { spent: boolean; cents: number | null } {
  const hit = latestByMarker(site, "actualCostCents");
  const c = hit?.s?.actualCostCents;
  return { spent: typeof c === "number" && c > 0, cents: typeof c === "number" ? c : null };
}

/** 测试账户是否处于"没钱/分组停用"状态,用于把探针失败与站点故障区分开。
 *  perf 批次的摘要里不存错误原文(只有成功率),所以还要去 raw 归档里翻样本错误 ——
 *  否则 chatfire 这种"余额不足"会被误报成"站点不可用"。 */
function unfundedReason(site: string): string | null {
  const REASON = /额度不足|余额不足|停用/;
  const scan = (obj: any): string | null => {
    // raw 归档把载荷包在 result 里({batchId,site,task,ok,result:{samples:[...]}}),两边都要看
    const bags = [obj, obj?.result].filter(Boolean);
    for (const b of bags) {
      const texts: string[] = [];
      if (Array.isArray(b?.errors)) texts.push(...b.errors.map(String));
      if (Array.isArray(b?.samples)) texts.push(...b.samples.map((x: any) => String(x?.error ?? "")));
      if (Array.isArray(b?.probes)) texts.push(...b.probes.map((x: any) => String(x?.candidateErr ?? x?.baselineErr ?? "")));
      const hit = texts.find(t => REASON.test(t));
      if (hit) return hit.slice(0, 120);
    }
    return null;
  };
  const rows = getDb().prepare(`SELECT summary, raw_path FROM batches WHERE site=? AND task IN ('perf','billing','fingerprint')
                                ORDER BY started_at DESC LIMIT 4`).all(site) as Array<{ summary: string | null; raw_path: string | null }>;
  for (const r of rows) {
    try {
      const hit = scan(JSON.parse(r.summary ?? "{}"));
      if (hit) return hit;
    } catch { /* 坏摘要跳过 */ }
    if (r.raw_path) {
      try {
        const abs = path.isAbsolute(r.raw_path) ? r.raw_path : path.join(PROBE_ROOT, r.raw_path);
        if (fs.existsSync(abs)) {
          const hit = scan(JSON.parse(fs.readFileSync(abs, "utf8")));
          if (hit) return hit;
        }
      } catch { /* 原始文件读不到就算了,不影响主判定 */ }
    }
  }
  return null;
}

// ---------- 覆盖率(每桶样本数 vs weights.json 门槛) ----------
export interface BucketCov { bucket: string; name: string; samples: number; need: number; ok: boolean }

function bucketCoverage(site: string, w: Weights): BucketCov[] {
  const m = assembleMetrics(site, {});
  const conf = w.confidence;
  const push = (bucket: string, name: string, samples: number, need: number): BucketCov =>
    ({ bucket, name, samples, need, ok: samples >= need });
  return [
    push("BH", "计费诚实", m.BH.entries, conf.min_reconcile_entries ?? 20),
    push("MA", "模型真实", m.MA.similarity === null ? 0 : 1, conf.min_fingerprint_runs ?? 1),
    push("ST", "稳定性", m.ST.checks, conf.min_health_checks ?? 12),
    push("PF", "性能", m.PF.samples, conf.min_ttft_samples ?? 6),
    push("SR", "流式真实", m.SR.samples, 3),
    push("EP", "有效价格", m.EP.models.length, 1),
  ];
}

// ---------- 待复核队列 ----------
export interface Finding { level: "critical" | "warn" | "info"; code: string; site: string; msg: string; evidence: string | null; action: string }

function findings(site: string, w: Weights, promoConfigured: boolean, injectMeasured: number | null, reference = false): Finding[] {
  const out: Finding[] = [];
  const d = getDb();
  const h = siteHealth(site);
  const health = latestSummary(site, "health");
  const rec = latestSummary(site, "reconcile") ?? latestSummary(site, "billing");

  // 数据新鲜度
  if (!health) out.push({ level: "critical", code: "no_health", site, msg: "从未跑过健康检查", evidence: null, action: "tsx cli.ts once --task=health --site=" + site });
  else if (hoursAgo(health.at) > 72) out.push({ level: "critical", code: "stale_health", site, msg: `健康检查已 ${Math.round(hoursAgo(health.at))} 小时未更新(>72h),对外「近 72 小时可用率」已无数据支撑`, evidence: health.id, action: "检查调度器是否在跑:tsx cli.ts schedule" });
  /** 阈值必须跟着采样节拍走:2026-10-02 起探活是每 5 小时一次,旧的 12h 告警线会让每个站每天都"亮黄灯",
   *  把真问题埋掉。改为 >16h(漏掉两次采样)才提示。 */
  else if (hoursAgo(health.at) > 16) out.push({ level: "warn", code: "aging_health", site, msg: `健康检查 ${hoursAgo(health.at).toFixed(1)} 小时前(>16h,已漏掉一次以上 5 小时节拍)`, evidence: health.id, action: "等下一轮或手动补跑" });

  /** 参照系(官方直连/聚合平台)不是中转审计对象:对账 / 指纹 / perf 规则对它没有语义。
   *  它只需要两个信号 —— 探活是否新鲜、免鉴权可达率是否掉。混进紧急队列会把真告警埋掉(实测 15 条里 13 条是这类假紧急)。 */
  if (reference) {
    const rows = d.prepare(`SELECT summary FROM batches WHERE site=? AND task='health' AND started_at >= datetime('now','-7 day')`).all(site) as Array<{ summary: string | null }>;
    let ok = 0;
    for (const r of rows) { try { if (JSON.parse(r.summary ?? "{}").overall?.ok === true) ok++; } catch { /* 单条损坏不计 */ } }
    const pct = rows.length ? Math.round(ok / rows.length * 1000) / 10 : null;
    if (pct !== null && pct < 95) out.push({ level: "warn", code: "low_reach", site, msg: `参照系 7 日可达率 ${pct}%(免鉴权探活口径,401/403 鉴权门算可达)`, evidence: null, action: "确认端点是否变更;参照系不参与评分,无需标红" });
    return out;
  }

  // 可用率
  if (h.avail7d !== null && h.avail7d < 95) out.push({ level: h.avail7d < 80 ? "critical" : "warn", code: "low_avail", site, msg: `7 天可用率 ${h.avail7d}%(低于 ST 满分线 95%)`, evidence: null, action: h.avail7d < 80 ? "考虑标红复核/下架评估" : "观察,勿手工干预评分" });

  // 对账(挂在 billing 批次下,按 summary 找)
  const recHit = latestByMarker(site, "reconcile");
  const recSum = recHit?.s ?? null;
  if (!recSum) {
    /** 分三种:真付过钱却没对账(真问题)/ 跑过批次但一分没扣(账户没钱)/ 压根没跑过。
     *  之前用"字段存在"当"付过钱",把 10 家余额不足的站全标成紧急,真信号被埋掉。 */
    const { spent } = reallySpent(site);
    const why = unfundedReason(site);
    if (spent) out.push({ level: "critical", code: "no_reconcile", site, msg: "确有消费扣款但无逐笔对账记录 —— BH 桶(权重最高)完全无数据,综合分不可信", evidence: null, action: `导出 ${site} 消费日志到 store/manual-imports/ 后跑 reconcile` });
    else if (why) out.push({ level: "info", code: "unfunded", site, msg: "测试账户无额度,探针全部失败 —— 不是站点不可用,是账号没钱", evidence: null, action: `让站方按入驻约定充值测试额度后再跑;原因:${why}` });
    else out.push({ level: "info", code: "not_paid_yet", site, msg: "尚未做账单级实测(无有效消费批次)—— 新入册监测站的正常状态,不给分是设计使然", evidence: null, action: `确认测试额度后跑:tsx cli.ts billing --site=${site}` });
  }
  else if ((recSum.mismatched ?? 0) > 0) out.push({ level: "critical", code: "mismatch", site, msg: `对账超差 ${recSum.mismatched} 笔(匹配 ${recSum.matched})`, evidence: recHit!.id, action: "逐笔核对偏差方向,>1% 需人工判定是否标红" });
  else if (recSum.unverifiable) out.push({ level: "info", code: "unverifiable", site, msg: `${recSum.unverifiable} 笔无法验证(缺倍率/分组参数),不计入匹配率分母`, evidence: recHit!.id, action: "补价格快照参数后可复算" });

  // 指纹
  const fpHit = latestByMarker(site, "fingerprint");
  const fp = fpHit?.s ?? null;
  if (fp?.verdict === "suspect") out.push({ level: "warn", code: "fp_suspect", site, msg: `模型指纹存疑(${fp.similarity}% 落在 70-85)`, evidence: fpHit!.id, action: "多轮复采取中位,勿据单次下结论" });
  if (fp?.verdict === "fail") out.push({ level: "critical", code: "fp_fail", site, msg: `模型指纹未通过(${fp.similarity}%,<70 疑似掉包)`, evidence: fpHit!.id, action: "立即标红并撰写实测记录" });

  // 超时 / 伪流式
  const perf = latestSummary(site, "perf")?.s ?? null;
  if (perf?.timeoutRate !== null && perf?.timeoutRate !== undefined && perf.timeoutRate > 20) out.push({ level: "warn", code: "high_timeout", site, msg: `超时率 ${perf.timeoutRate}%(ST 桶按 0.3 倍扣减)`, evidence: latestSummary(site, "perf")!.id, action: "扩样本判断是渠道抖动还是常态" });
  if (perf?.successRate !== null && perf?.successRate !== undefined && perf.successRate < 60) {
    /** 成功率低有两种完全不同的原因:账号没钱 vs 站点真的不可用。混为一谈会让人以为我们发现了 6 家故障站。 */
    const why = unfundedReason(site);
    out.push(why
      ? { level: "info", code: "low_success_unfunded", site, msg: `perf 探针成功率仅 ${perf.successRate}%,但原因是测试账户额度不足,不是站点不可用`, evidence: latestSummary(site, "perf")!.id, action: "充值后重跑;在此之前不要把这条当成站点故障对外说" }
      : { level: "critical", code: "low_success", site, msg: `perf 探针成功率仅 ${perf.successRate}%`, evidence: latestSummary(site, "perf")!.id, action: "确认站点是否实际不可用" });
  }
  if (perf?.bufferedRate === 100) out.push({ level: "info", code: "pseudo_stream", site, msg: "伪流式率 100%(SSE 缓冲后一次性下发,编程场景体验受损)", evidence: latestSummary(site, "perf")!.id, action: "已计入 SR 桶,保持展示即可" });

  // 价格异常波动:比较最近两次价格快照的同模型输入价
  const prices = (d.prepare(`SELECT started_at, summary FROM batches WHERE site=? AND task='price' ORDER BY started_at DESC LIMIT 2`).all(site) as Array<{ started_at: string; summary: string | null }>);
  if (prices.length === 2 && prices[0].summary && prices[1].summary) {
    try {
      const now = new Map<string, number>(((JSON.parse(prices[0].summary) as any).models ?? []).map((m: any) => [m.model, m.input]));
      const prevModels: any[] = (JSON.parse(prices[1].summary) as any).models ?? [];
      const jumps: string[] = [];
      for (const pm of prevModels) {
        const nv = now.get(pm.model);
        if (nv && pm.input > 0 && Math.abs(nv - pm.input) / pm.input > 0.1) jumps.push(`${pm.model} ${pm.input}→${nv}`);
      }
      if (jumps.length) out.push({ level: "warn", code: "price_jump", site, msg: `价格波动 >10%:${jumps.slice(0, 3).join(" / ")}${jumps.length > 3 ? ` 等 ${jumps.length} 项` : ""}`, evidence: null, action: "前端已标注涨价,复核是否影响 EP 排名" });
    } catch { /* 快照损坏跳过 */ }
  }

  // 商业与手工参数透明度
  if (!promoConfigured) out.push({ level: "info", code: "no_promo", site, msg: "未配置推广位(前端显示「合作洽谈中」,属预期状态)", evidence: null, action: "无需处理" });
  if (injectMeasured === null) out.push({ level: "warn", code: "inject_untested", site, msg: "注入开销未实测(无 tokens 批次)—— EP 桶按无注入计,会低估号池渠道真实成本", evidence: null, action: `tsx cli.ts tokens --site=${site} 补测后自动生效` });

  // 门槛未达标的桶
  for (const b of bucketCoverage(site, w)) {
    if (!b.ok && b.bucket !== "BH") out.push({ level: "info", code: "cov_" + b.bucket, site, msg: `${b.name}(${b.bucket})样本 ${b.samples}/${b.need} 未达门槛,该桶不计入评分(重归一化)`, evidence: null, action: `补采:${site} 的 ${b.bucket} 样本` });
  }
  return out;
}

// ---------- 组装 ----------
export function syncOps(opts: { sites: string[]; inject?: Record<string, number>; reference?: string[] }): { opsFile: string; auditFile: string } {
  const inj = (s: string): number | null => opts.inject?.[s] ?? latestInjection(s);
  const w = loadWeights();
  /** 参照系(官方直连/聚合平台)不参与评分:这是范畴不同,不是"数据不足" —— 混成无分会让人以为再测测就有分 */
  const refSet = new Set(opts.reference ?? []);
  const promoAbs = path.join(PROBE_ROOT, "config/promo.yaml");
  const promo = fs.existsSync(promoAbs)
    ? (((YAML.parse(fs.readFileSync(promoAbs, "utf8")) as any)?.promo ?? {}) as Record<string, { enabled?: boolean }>)
    : {};

  const siteRows = opts.sites.map(name => {
    const m = assembleMetrics(name, { inject: inj(name) ?? undefined });
    const h = siteHealth(name);
    const scores: Record<string, number | null> = {};
    const coverage: Record<string, number> = {};
    for (const scene of allScenes()) {
      const r = computeSceneScore(m, scene);
      scores[scene] = r.score; coverage[scene] = Math.round(r.coverage * 100);
    }
    // 批次新鲜度矩阵。注意 reconcile / fingerprint 与 billing 共用 task 字段,
    // 必须按 summary 标记区分,否则矩阵会出现「明明测过却显示空白」。
    const tasks: Record<string, { at: string; id: string } | null> = {
      health: latestSummary(name, "health"),
      price: latestSummary(name, "price"),
      perf: latestSummary(name, "perf"),
      billing: latestByMarker(name, "actualCostCents"),
      reconcile: latestByMarker(name, "reconcile"),
      fingerprint: latestByMarker(name, "fingerprint"),
    };
    const recSum = tasks.reconcile?.s ?? null;
    const isRef = refSet.has(name);
    return {
      name,
      /** measured = 有 key 有账单可审;reference = 官方/聚合,只作对照 */
      kind: isRef ? "reference" : "measured",
      coverage: bucketCoverage(name, w),
      scores: isRef ? {} : scores, coveragePct: coverage,
      scenesWithoutScore: isRef ? [] : Object.entries(scores).filter(([, v]) => v === null).map(([k]) => w.scenes[k]?.label ?? k),
      metrics: {
        avail7d: h.avail7d, checks: h.checks, dev: m.BH.match, reconcileEntries: m.BH.entries,
        ttftMs: m.PF.ttftMs, timeoutPct: m.ST.timeoutPct, bufferedRate: m.SR.bufferedRate,
        fingerprint: m.MA.similarity, fpBaseline: m.MA.baseline, inject: inj(name),
      },
      audit: {
        verified: recSum ? (recSum.matched ?? 0) + (recSum.mismatched ?? 0) : 0,
        matchPct: recSum && (recSum.matched + recSum.mismatched) > 0 ? Math.round(recSum.matched / (recSum.matched + recSum.mismatched) * 1000) / 10 : null,
      },
      promo: { configured: !!promo[name], enabled: !!promo[name]?.enabled },
      tasks,
      lastBatchAt: latestSummary(name)?.at ?? null,
    };
  });

  const queue: Finding[] = [];
  // 入驻队列:待受理申请 > 0 时提醒(受理动作在 cli onboard,审计链留痕)
  const pend = pendingCount();
  if (pend > 0) queue.push({ level: "warn", code: "onboarding_pending", site: "*",
    msg: `${pend} 份入驻申请待受理(72 小时答复承诺)`, evidence: null,
    action: "tsx cli.ts onboard list → accept/reject --id=… --reason=…" });
  for (const name of opts.sites) queue.push(...findings(name, w, !!promo[name], inj(name), refSet.has(name)));
  const rank = { critical: 0, warn: 1, info: 2 } as const;
  queue.sort((a, b) => rank[a.level] - rank[b.level]);

  const chain = auditVerify();
  if (!chain.ok) {
    queue.unshift({ level: "critical", code: "audit_chain_broken", site: "*", msg: `审计链校验失败:${chain.why}`, evidence: null, action: "立即排查数据库与 JSONL 归档,暂停对外发布" });
  }

  const weightsAbs = path.join(SHARED, "weights.json");
  const out = {
    meta: {
      generatedAt: new Date().toISOString(),
      weightsVersion: weightsVersion(),
      dataLayer: "internal-readonly",
      note: "本文件仅描述运营状态,不含任何编辑能力。人工改动全部记录在 audit 链中。",
    },
    integrity: {
      chainOk: chain.ok, total: chain.total, brokenAt: chain.brokenAt, why: chain.why,
      headHash: chain.headHash, rawHeadHash: chain.rawHead, rawCount: chain.rawCount, rawDrift: chain.rawDrift,
    },
    thresholds: {
      ...w.confidence,
      scoreFloorPct: Math.round((w.confidence.coverage_floor ?? 0.6) * 100),
      weightsFile: shaShort(weightsAbs),
    },
    scenes: Object.entries(w.scenes).map(([k, v]) => ({ key: k, label: v.label, separate: !!v.separate })),
    injectionPricing: w.injection_pricing ?? null,
    sites: siteRows,
    queue,
    counts: {
      sites: siteRows.length,
      critical: queue.filter(f => f.level === "critical").length,
      warn: queue.filter(f => f.level === "warn").length,
      info: queue.filter(f => f.level === "info").length,
    },
  };

  function stripEmojiDeep(v: any): any {
    if (typeof v === "string") return v.replace(/[\u{1F000}-\u{1FAFF}\u{2600}-\u{27BF}\u{2B00}-\u{2BFF}\u{2300}-\u{23FF}\u{FE00}-\u{FE0F}]/gu, "").replace(/[ \t]{2,}/g, " ").replace(/[ \t]+([,;:、，。）)】」])/g, "$1").trim();
    if (Array.isArray(v)) return v.map(stripEmojiDeep);
    if (v && typeof v === "object") { const o: any = {}; for (const k of Object.keys(v)) o[k] = stripEmojiDeep((v as any)[k]); return o; }
    return v;
  }
  fs.mkdirSync(DATA_DIR, { recursive: true });
  const opsFile = path.join(DATA_DIR, "ops.json");
  atomicWriteJson(opsFile, stripEmojiDeep(out), { shrinkGuard: 0.5 });

  // 公开摘要:去掉快照噪声,只留「人对系统做了什么」与「数据何时发布」
  const publicEntries: AuditEntry[] = auditList(200).filter(e => e.action !== "config.snapshot");
  const auditFile = path.join(DATA_DIR, "audit.json");
  /* audit.json 是公开哈希链的投影,只应增长 —— 收缩熔断收最紧(0.2):链条截断/空库重建在此直接拒绝 */
  atomicWriteJson(auditFile, {
    meta: {
      generatedAt: new Date().toISOString(), weightsVersion: weightsVersion(),
      policy: "哈希链式追加日志:每条记录包含前一条的哈希,任意改写或删除都会使链校验失败。",
      verify: "本地校验:tsx cli.ts audit verify(探针仓库开源,任何人可重放)",
    },
    // head 是对外锚:公开发布完整 64 位链头,事后若有人截断重建,与此值比对即可发现
    chain: { ok: chain.ok, total: chain.total, head: chain.headHash },
    entries: publicEntries.map(e => ({
      seq: e.seq, at: e.at, actor: e.actor, action: e.action, target: e.target,
      before: e.before, after: e.after, reason: e.reason, hash: e.hash?.slice(0, 16),
    })),
  }, { shrinkGuard: 0.2 });

  // 注:看板刷新本身不入审计链(纯读操作,无对外状态变化);会改变对外事实的只有
  // sync.ts 里的 data.publish 与配置漂移。避免机器噪声稀释「谁动了数据」这条主线。
  return { opsFile, auditFile };
}

function shaShort(p: string): string {
  if (!fs.existsSync(p)) return "missing";
  return createHash("sha256").update(fs.readFileSync(p, "utf8")).digest("hex").slice(0, 12);
}
