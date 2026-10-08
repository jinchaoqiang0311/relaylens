/**
 * cli.ts —— 命令行入口
 *
 * 用法:
 *   tsx cli.ts once                     # 全部站点 × 全部任务(P1: health+price)各一轮
 *   tsx cli.ts once --task=health       # 仅健康检查
 *   tsx cli.ts once --site=placeholder-alpha       # 单站
 *   tsx cli.ts once --task=health --site=placeholder-alpha
 *   tsx cli.ts rebuild                  # 仅重建 dist 产物
 *   tsx cli.ts schedule                 # 常驻调度
 *   tsx cli.ts report                   # 查看各站健康概览
 */
import fs from "node:fs";
import path from "node:path";
import YAML from "yaml";
import type { ProbeConfig, TaskName } from "../shared/types.js";
import { runRound, startScheduler, enabledSites } from "./src/scheduler.js";
import { rebuild } from "./src/publisher.js";
import { getDb, siteHealth, batchCount } from "./src/store.js";
import { reconcile, persistReconcile, meteringConsistency, loadEntries } from "./src/reconcile.js";
import { runTokenProbe, persistTokens, latestInjection } from "./src/probes/tokenprobe.js";
import { runFingerprint, persistFingerprint, PROBES, PROBE_BANK_VERSION } from "./src/probes/fingerprint.js";
import { assembleMetrics } from "./src/assemble.js";
import { runPerf, persistPerf, pickModel, listModels } from "./src/probes/perf.js";
import { syncData, referenceSiteNames } from "./src/sync.js";
import { syncOps } from "./src/ops.js";
import { auditConfigDrift, auditAppend, auditPublish, auditVerify, auditList, currentActor } from "./src/audit.js";
import { addDeclaration, transition, promote, listQueue, pendingCount } from "./src/onboard.js";
import { computeSceneScore, allScenes, weightsVersion } from "./src/score.js";

// ---------- 加载 secrets(config/secrets/sites.env → process.env) ----------
function loadSecrets() {
  const file = path.join(import.meta.dirname, "config/secrets/sites.env");
  if (!fs.existsSync(file)) return;
  for (const line of fs.readFileSync(file, "utf8").split(/\r?\n/)) {
    const m = line.match(/^([A-Z0-9_]+)=(.*)$/);
    if (m && !process.env[m[1]]) process.env[m[1]] = m[2].trim();
  }
}

// ---------- 解析配置 ----------
function loadConfig(): ProbeConfig {
  const file = path.join(import.meta.dirname, "config/sites.yaml");
  const cfg = YAML.parse(fs.readFileSync(file, "utf8")) as ProbeConfig;
  return cfg;
}

// ---------- 解析参数 ----------
function parseArgs() {
  const args = { task: undefined as TaskName | undefined, site: undefined as string | undefined, rounds: undefined as number | undefined };
  for (const a of process.argv.slice(2)) {
    const m = a.match(/^--task=(\w+)$/);
    if (m) args.task = m[1] as TaskName;
    const s = a.match(/^--site=(.+)$/);
    if (s) args.site = s[1];
    const r = a.match(/^--rounds=(\d+)$/);
    if (r) args.rounds = Number(r[1]);
  }
  return args;
}

// ---------- 主入口 ----------
async function main() {
  loadSecrets();
  const [cmd, ...rest] = process.argv.slice(2);
  const cfg = loadConfig();
  const args = parseArgs();

  switch (cmd) {
    case "once": {
      // 注意:billing 会真实扣费,必须显式 --task=billing,不含在默认任务里
      const tasks: TaskName[] = args.task ? [args.task] : ["health", "price"];
      let sites = enabledSites(cfg);
      if (args.site) {
        sites = sites.filter(s => s.name === args.site);
        if (sites.length === 0) { console.error(`站点未找到或未启用: ${args.site}`); process.exit(1); }
      }
      if (tasks.includes("billing")) {
        const noKey = sites.filter(s => !s.key_env);
        if (noKey.length) console.log(`⚠ 跳过无 key 站点: ${noKey.map(s => s.name).join(", ")}`);
        sites = sites.filter(s => !!s.key_env);
        if (sites.length === 0) { console.error("没有可执行 billing 的站点(需 key_env 配置)"); process.exit(1); }
      }
      for (const t of tasks) {
        await runRound(cfg, t, sites, { rounds: args.rounds });
      }
      break;
    }
    case "rebuild": {
      rebuild(enabledSites(cfg).map(s => s.name));
      console.log("✓ dist 产物已重建");
      break;
    }
    case "schedule": {
      startScheduler(cfg);
      break; // 常驻
    }
    case "tokens": {
      const name = args.site || "aixoras";
      const site = enabledSites(cfg).find(s => s.name === name);
      if (!site) { console.error(`站点未找到: ${name}`); process.exit(1); }
      const model = (process.argv.find(a => a.startsWith("--model=")) || "").split("=")[1] || "gpt-5.6-sol";
      console.log(`\n🔬 token 计量对照实验 · ${name} · ${model}\n`);
      const rows = await runTokenProbe(site, model);
      const est = persistTokens(site.name, model, rows);   // 落库:sync/评分从此读 DB,不再有手工常量
      console.log("  用例            字符数   上报prompt  其中cached   fresh   tokens/字符");
      for (const r of rows) {
        console.log(`  ${r.label.padEnd(15)} ${String(r.chars).padStart(6)} ${String(r.reportedPrompt).padStart(12)} ${String(r.reportedCached).padStart(12)} ${String(r.fresh).padStart(7)} ${r.tokensPerChar === null ? "—" : String(r.tokensPerChar).padStart(10)}${r.error ? "  ⚠ " + r.error : ""}`);
      }
      const uniq = rows.filter(r => r.repeat === 0 && r.reportedPrompt > 0);
      if (uniq.length >= 2) {
        const first = uniq[0].fresh / uniq[0].chars, last = uniq[uniq.length - 1].fresh / uniq[uniq.length - 1].chars;
        console.log(`\n  判读:fresh/字符 从 ${first.toFixed(3)} 到 ${last.toFixed(3)} —— ` +
          (Math.abs(last - first) < first * 0.6 ? "随输入线性变化,计量可信" : "不随输入线性变化,存在注入脚手架或计量失真"));
      }
      console.log(`\n  🧮 注入推导:${est.note}`);
      if (est.inject !== null) {
        const prev = latestInjection(site.name);
        console.log(`     当前生效值:${prev ?? "—"} tok/请求(EP 桶与前端「注入开销」列均读此值;重跑 sync 即更新)`);
      }
      console.log("");
      break;
    }
    case "sync": {
      // 先补记配置漂移(在册站点/权重/推广位有没有被人动过),再生成对外数据
      const drift = auditConfigDrift();
      if (drift) console.log(`\n🧷 审计:检测到配置漂移,已补记 ${drift} 条`);
      // 数据管道:探针真实数据 → 站点 data/sites.json(前端 fetch 源)
      // 注入开销不再传手工常量:assemble/sync 自动读最近一次 tokens 批次(cli tokens 落库)
      const targets = enabledSites(cfg).filter(s => !!s.key_env).map(s => s.name);
      // 参照系:官方直连与聚合平台没有 key、不做账单对账,但有真实健康探测与公开报价,单独下发
      const refs = enabledSites(cfg).filter(s => !s.key_env && referenceSiteNames().includes(s.name)).map(s => s.name);
      const file = syncData(targets, { reference: refs });
      const content = fs.readFileSync(file, "utf8");
      const d = JSON.parse(content);
      // 发布指纹入链:内容没变则自动去重
      const published = auditPublish("data/sites.json", content,
        `${targets.length} 实测站 + ${d.referenceSites?.length ?? 0} 参照系 · 权重 ${d.meta.weightsVersion}`);
      syncOps({ sites: [...targets, ...refs], reference: refs });
      console.log(`\n🔁 数据同步 · ${targets.length} 实测站 + ${d.referenceSites?.length ?? 0} 参照系 → ${path.relative(process.cwd(), file)}${published ? " · 已登记发布指纹" : " · 内容无变化"}`);
      for (const r of d.realSites) {
        console.log(`   ${r.name.padEnd(10)} 综合 ${r.score.all ?? "—"} · 编程 ${r.score.code ?? "—"} · avail ${r.avail ?? "—"}% · fp ${r.fp} · stream ${r.stream ?? "—"}% · inject ${r.inject}`);
      }
      for (const r of d.referenceSites ?? []) {
        console.log(`   ${r.display.padEnd(10)} 参照 ·  avail ${r.avail ?? "—"}%(${r.checks ?? 0} 次探活) · ${r.price ?? "无报价"} [${r.priceSrc ?? "—"}] · 不参与排名`);
      }
      console.log(`   权重版本 ${d.meta.weightsVersion} · 更新 ${d.meta.updated.slice(0, 16).replace("T", " ")}\n`);
      break;
    }
    case "ops": {
      const drift = auditConfigDrift();
      const targets = enabledSites(cfg).filter(s => !!s.key_env).map(s => s.name);
      const refs = enabledSites(cfg).filter(s => !s.key_env && referenceSiteNames().includes(s.name)).map(s => s.name);
      const { opsFile, auditFile } = syncOps({ sites: [...targets, ...refs], reference: refs });
      const o = JSON.parse(fs.readFileSync(opsFile, "utf8"));
      console.log(`\n📟 运营看板数据 · ${o.sites.length} 站 · 审计链 ${o.integrity.chainOk ? "✓ 完整" : "✗ 断裂"}(${o.integrity.total} 条)`);
      console.log(`   待复核:紧急 ${o.counts.critical} · 观察 ${o.counts.warn} · 说明 ${o.counts.info}`);
      for (const f of o.queue.filter((x: any) => x.level !== "info").slice(0, 14)) {
        console.log(`   ${f.level === "critical" ? "🔴" : "🟡"} ${f.site.padEnd(10)} ${f.msg}`);
      }
      console.log(`   → ${path.relative(process.cwd(), opsFile)}\n   → ${path.relative(process.cwd(), auditFile)}\n`);
      if (drift) console.log(`   本轮补记审计 ${drift} 条\n`);
      break;
    }
    case "onboard": {
      const sub = rest[0] || "list";
      const getArg = (k: string) => (process.argv.find(a => a.startsWith(`--${k}=`)) || "").split("=").slice(1).join("=");
      if (sub === "add") {
        const file = getArg("file");
        if (!file || !fs.existsSync(file)) { console.error("用法:onboard add --file=<declaration.json>"); process.exit(1); }
        const r = addDeclaration(JSON.parse(fs.readFileSync(file, "utf8")));
        if (r.errors) { console.error("✗ 校验未通过:\n   - " + r.errors.join("\n   - ")); process.exit(1); }
        console.log(`\n✓ 申请入队 ${r.item!.id} · ${r.item!.site_name}(${r.item!.domain})· 方向 ${r.item!.directions.join("/")} · 分组 ${r.item!.declared_groups.length} 个`);
        console.log(`  下一步:受理 → onboard accept --id=${r.item!.id} --reason="…"\n`);
      } else if (sub === "accept" || sub === "reject") {
        const it = transition(getArg("id"), sub === "accept" ? "accepted" : "rejected", getArg("reason"));
        console.log(`\n✓ ${it!.id} → ${it!.status}${getArg("reason") ? "(理由已入审计链)" : ""}\n`);
      } else if (sub === "promote") {
        const r = promote(getArg("id"));
        console.log(`\n✓ ${r.item.id} → onboarded · sites.yaml ${r.appended ? "已追加(enabled=false)" : "已存在同名条目,跳过追加"}`);
        console.log(`  下一步:人工补 base_url/parser/key_env 并启用 —— 漂移检测将自动记录 site.add\n`);
        console.log(r.yaml);
      } else {
        const st = getArg("status") || undefined;
        const items = listQueue(st);
        console.log(`\n📥 入驻队列(${items.length}${st ? ` · 筛选 ${st}` : ""} · 待受理 ${pendingCount()})\n`);
        for (const i of items) {
          console.log(`  ${i.id}  ${i.status.padEnd(15)} ${i.site_name.padEnd(16)} ${i.domain}`);
          console.log(`        方向 ${i.directions.join("/")} · 分组 ${i.declared_groups.map(g => g.name + "(" + g.tier + ")").join(", ")}`);
        }
        console.log("");
      }
      break;
    }
    case "audit": {
      const sub = rest[0] || "list";
      const limit = Number((process.argv.find(a => a.startsWith("--limit=")) || "--limit=30").split("=")[1]) || 30;
      const fltAction = (process.argv.find(a => a.startsWith("--action=")) || "").split("=")[1];
      const fltTarget = (process.argv.find(a => a.startsWith("--target=")) || "").split("=")[1];
      if (sub === "verify") {
        const v = auditVerify();
        console.log(v.ok
          ? `\n✓ 审计链完整 · ${v.total} 条 · 链头 ${v.headHash.slice(0, 16)} · 原始归档 ${v.rawCount} 条${v.rawDrift ? `(DB 比归档多 ${v.rawDrift} 条,请核查归档目录)` : ""}\n`
          : `\n✗ 审计链异常 · ${v.total} 条 · 首个断点 seq=${v.brokenAt} · ${v.why}\n`);
        process.exit(v.ok ? 0 : 1);
      } else if (sub === "add") {
        const getArg = (k: string) => (process.argv.find(a => a.startsWith(`--${k}=`)) || "").split("=").slice(1).join("=");
        const reason = getArg("reason");
        if (!getArg("action") || !getArg("target") || !reason) {
          console.error("用法:tsx cli.ts audit add --action=<动作> --target=<对象> --reason=<为什么> [--before=..] [--after=..] [--evidence=..]");
          process.exit(1);
        }
        const e = auditAppend({
          actor: getArg("actor") || currentActor(), action: getArg("action"), target: getArg("target"),
          before: getArg("before") || null, after: getArg("after") || null, reason, evidence: getArg("evidence") || null,
        });
        console.log(`\n✓ 已追加审计 #${auditList(1)[0]?.seq} · ${e.action} → ${e.target} · ${e.hash?.slice(0, 16)}\n`);
      } else {
        const rows = auditList(limit, { action: fltAction, target: fltTarget });
        const v = auditVerify();
        console.log(`\n🧷 审计日志(最近 ${rows.length} 条 · 链校验 ${v.ok ? "✓" : "✗"} · 共 ${v.total} 条)\n`);
        for (const e of rows) {
          const bb = e.before && Object.keys(e.before as object).length ? " ·" : "";
          console.log(`  #${String(e.seq).padStart(4)} ${e.at.slice(5, 16).replace("T", " ")} [${e.actor}] ${e.action} → ${e.target}${bb}`);
          console.log(`       ${e.reason}`);
        }
        console.log("");
      }
      break;
    }
    case "perf": {
      const name = args.site || "aixoras";
      const modelArg = process.argv.find(a => a.startsWith("--model="))?.split("=")[1];
      const iters = Number((process.argv.find(a => a.startsWith("--iters=")) || "--iters=8").split("=")[1]) || 8;
      const db = getDb();
      /** --site=all:遍历有 key 的在册站,模型从各自 /v1/models 里挑;12 小时内测过的跳过 */
      const targets = name === "all"
        ? enabledSites(cfg).filter(s => !!s.key_env)
        : [cfg.sites.find(s => s.name === name && s.enabled)].filter(Boolean) as typeof cfg.sites;
      if (!targets.length) { console.error(`站点未找到或未启用: ${name}`); process.exit(1); }
      let done = 0, skipped = 0, failed = 0;
      for (const site of targets) {
        const fresh = db.prepare(`SELECT COUNT(*) c FROM batches WHERE site=? AND task='perf' AND started_at >= datetime('now','-12 hour')`).get(site.name) as { c: number };
        if (name === "all" && fresh.c > 0 && !process.argv.includes("--force")) { console.log(`\n⏭ ${site.name}:12 小时内已测过,跳过(--force 可重跑)`); skipped++; continue; }
        const model = modelArg || await pickModel(site) || "";
        if (!model) { console.log(`\n✗ ${site.name}:拿不到模型清单(key 无效 / 分组无模型 / 端点不通),无法测延迟`); failed++; continue; }
        console.log(`\n⏱️ 短延迟探针(SSE 流式真 TTFT)· ${site.name} · ${model} · ${iters} 次   max_tokens=16 timeout=30s`);
        const res = await runPerf(site, model, { iters });
        persistPerf(res); done++;
        const errs = res.samples.filter(s => !s.ok).slice(0, 3);
        for (const s of errs) console.log(`   ✗ #${s.seq} ${s.failureType}: ${String(s.error).slice(0, 90)}`);
        console.log(`   中位 TTFT ${res.medianTtftMs ?? "—"}ms · P95 ${res.p95TtftMs ?? "—"}ms · 成功 ${res.successRate ?? "—"}% · 超时 ${res.timeoutRate ?? "—"}% · 伪流式 ${res.bufferedRate ?? "—"}% · 吞吐 ${res.medianThroughput ?? "—"} tok/s  (${res.batchId})`);
        res.notes.forEach(n => console.log("   注:" + n));
      }
      console.log(`\n📊 延迟探针汇总:测了 ${done} 站,跳过 ${skipped} 站,失败 ${failed} 站\n`);
      break;
    }
    case "score": {
      const name = args.site || "aixoras";
      // --inject=N 仅作沙盘覆盖;默认读 tokens 批次实测(与 sync/榜单同口径)
      const injectArg = process.argv.find(a => a.startsWith("--inject="));
      const injectOverride = injectArg ? Number(injectArg.split("=")[1]) : undefined;
      const m = assembleMetrics(name, { inject: injectOverride });
      const injectShown = injectOverride !== undefined
        ? `${injectOverride}(沙盘覆盖)`
        : `${latestInjection(name) ?? "未测"}${m.injectSplit ? `(拆分 fresh ${(m.injectSplit.fresh_share * 100).toFixed(0)}%/cached ${(m.injectSplit.cached_share * 100).toFixed(0)}%)` : ""}`;
      console.log(`\n📊 场景评分 · ${name} · 权重版本 ${weightsVersion()}`);
      console.log(`   指标装配: BH对账 ${m.BH.match === null ? "未测" : m.BH.match + "%(" + m.BH.entries + "笔)"} · MA指纹 ${m.MA.similarity === null ? "未测" : m.MA.similarity + "%(" + (m.MA.baseline === "openrouter" ? "官方基线" : "跨站差分") + ")"} · ST可用率 ${m.ST.avail === null ? "未测" : m.ST.avail + "%(" + m.ST.checks + "次/跨" + m.ST.spanMinutes + "分)"} · PF·TTFT ${m.PF.ttftMs === null ? "未测" : m.PF.ttftMs + "ms(" + m.PF.samples + "样本)"} · SR伪流式 ${m.SR.bufferedRate === null ? "未测" : m.SR.bufferedRate + "%"} · EP锚定 ${m.EP.models.length} 模型 · 注入 ${injectShown}\n`);
      console.log("   场景     评分    覆盖率  置信度  构成(BH/MA/ST/PF/EP 权重→值)");
      for (const scene of allScenes()) {
        const r = computeSceneScore(m, scene);
        const cs = Object.entries(r.components).filter(([, c]) => c.weightUsed > 0)
          .map(([k, c]) => `${k}${c.weightUsed}→${c.value === null ? "未测" : Math.round(c.value)}`).join(" ");
        const badge = r.score === null ? "— 数据不足" : `${r.score}${r.lowConfidence ? " ⚠低置信" : ""}`;
        console.log(`   ${scene.padEnd(8)} ${String(badge).padEnd(9)} ${String(Math.round(r.coverage * 100)).padStart(3)}%   ${r.confidence || "—"}    ${cs}`);
      }
      console.log("");
      break;
    }
    case "fingerprint": {
      const candName = args.site || "aixoras";
      const baseArg = (process.argv.find(a => a.startsWith("--baseline=")) || "").split("=")[1];
      const modelArg = (process.argv.find(a => a.startsWith("--model=")) || "").split("=")[1];
      // 号池渠道本身不确定,单次噪声大 → 多轮取中位数
      const runs = Number((process.argv.find(a => a.startsWith("--runs=")) || "--runs=1").split("=")[1]) || 1;
      const keyed = enabledSites(cfg).filter(s => !!s.key_env);
      const targets = candName === "all" ? keyed : keyed.filter(s => s.name === candName);
      if (!targets.length) { console.error(`站点未找到或未启用: ${candName}`); process.exit(1); }
      let fpDone = 0, fpSkip = 0;
      for (const cand of targets) {
        /* 基线:显式指定优先;否则取另一家中转站做跨站差分(aixoras ↔ aicost)。
           官方基线要 OPENROUTER_API_KEY,没有之前一律用跨站差分并把置信度打 ×0.8 折。 */
        const baseName = baseArg || (cand.name === "aixoras" ? "aicost" : "aixoras");
        const base = cfg.sites.find(s => s.name === baseName);
        if (!base) { console.log(`\n✗ ${cand.name}:基线 ${baseName} 不在册`); fpSkip++; continue; }
        let model = modelArg || "";
        if (!model) {
          const [a, b] = await Promise.all([listModels(cand), listModels(base)]);
          const common = a.filter(x => b.includes(x));
          if (!common.length) { console.log(`\n✗ ${cand.name}:与基线 ${baseName} 没有共同模型,跳过`); fpSkip++; continue; }
          model = ["gpt-5.5", "gpt-5.6-sol", "deepseek-v4.1-flash", "claude-sonnet-5"].find(m => common.includes(m)) || common[0];
        }
        console.log(`\n🔍 模型指纹比对 · 被测 ${cand.name}/${model} vs 基线 ${baseName} · 题库 ${PROBE_BANK_VERSION} · ${PROBES.length} 题(4 确定性 + 4 风格)· temperature=0 · ${runs} 轮`);
        const all: any[] = [];
        for (let i = 0; i < runs; i++) {
          if (runs > 1) console.log(`   第 ${i + 1}/${runs} 轮…`);
          const r = await runFingerprint(cand, base, model);
          all.push(r);
          persistFingerprint(r);
        }
        const res = all[all.length - 1];
        fpDone++;
        if (res.similarity === null) { res.notes.forEach(n => console.log("   ⚠ " + n)); continue; }
        const sims = all.map(r => r.similarity).filter((x): x is number => typeof x === "number").sort((a, b) => a - b);
        const median = sims.length ? sims[Math.floor(sims.length / 2)] : null;
        const vtext = ({ pass: "✓ 通过(≥85)", suspect: "~ 存疑(70-85,需复检)", fail: "✗ 未通过(<70,疑似掉包)", unknown: "无法判定" } as Record<string, string>)[res.verdict];
        if (candName === "all") { console.log(`   相似度 ${res.similarity}% · 有效 ${res.validProbes}/${res.probes.length} → ${vtext}`); continue; }
        console.log("\n   探针              类型      相似度   基线答案 / 被测答案");
        for (const p of res.probes) {
          const ans = p.kind === "deterministic" ? `${p.baselineAnswer || "—"} / ${p.candidateAnswer || "—"}` : `${p.baselineLen}字 / ${p.candidateLen}字`;
          const flag = p.baselineErr || p.candidateErr ? "⚠ 错误" : p.sim >= 85 ? "✓" : p.sim >= 60 ? "~" : "✗";
          console.log(`   ${p.id.padEnd(16)} ${p.kind === "deterministic" ? "确定性" : "风格  "}   ${String(p.sim).padStart(4)}%  ${flag}  ${ans}`);
        }
        console.log(`\n   综合相似度 ${res.similarity}%` + (runs > 1 ? ` · ${runs}轮中位数 ${median}% [${sims.join(", ")}]` : "") + ` → ${vtext}`);
        console.log(`   有效样本 ${res.validProbes}/${res.probes.length} · 证据批次 ${res.batchId} 已入库(含原始响应节选)`);
        res.notes.forEach(n => console.log("   注:" + n));
        console.log("");
      }
      if (candName === "all") console.log(`\n📊 指纹比对汇总:测了 ${fpDone} 站,跳过 ${fpSkip} 站\n`);
      break;
    }
    case "reconcile": {
      const targets = args.site ? [args.site] : enabledSites(cfg).filter(s => !!s.key_env).map(s => s.name);
      for (const name of targets) {
        const res = reconcile(name);
        if (!res.total) { console.log(`⚠ ${name}: ${res.notes[0] ?? "无日志"}`); continue; }
        persistReconcile(res);
        const rate = res.matched + res.mismatched > 0
          ? (res.matched / (res.matched + res.mismatched) * 100).toFixed(1) : "—";
        console.log(`\n🧾 ${name} 逐笔对账 · ${res.batchId}`);
        console.log(`   来源: ${path.basename(res.source)}`);
        console.log(`   可验证 ${res.matched + res.mismatched}/${res.total} 笔 · 匹配 ${res.matched} · 超差 ${res.mismatched} · 匹配率 ${rate}% · 最大偏差 ${res.maxAbsDiffPct}%`);
        console.log(`   实扣合计 $${(res.totalActualQuota / 500000).toFixed(5)} · 应扣合计 $${(res.totalExpectedQuota / 500000).toFixed(5)}`);
        const bad = res.rows.filter(r => Math.abs(r.diffPct) > 1).slice(0, 5);
        for (const r of bad) console.log(`   ⚠ ${r.model} in=${r.inTok} cache=${r.cacheTok} out=${r.outTok} 实扣 ${r.actualQuota} 应扣 ${r.expectedQuota} 差 ${r.diffPct}% (${r.mode})`);
        // 计量一致性:同内容请求对的 quota 偏差(BH 30% 分量)
        try {
          const entries = loadEntries(res.source);
          const mc = meteringConsistency(entries);
          console.log(mc.score !== null
            ? `   计量一致性: ${mc.score}分(${mc.pairs} 个同内容对,中位偏差 ${mc.medianDevPct}%)`
            : `   计量一致性: 无法计算(${mc.note})`);
        } catch { /* 一致性计算失败不阻断对账 */ }
        console.log(`   → ${res.batchId} 已入库\n`);
      }
      break;
    }
    case "billing": {
      const d = getDb();
      console.log("\n🧾 RelayLens 付费对账结果(每站最近一次)\n");
      for (const s of enabledSites(cfg)) {
        const row = d.prepare(`SELECT id, started_at, summary FROM batches WHERE site=? AND task='billing' ORDER BY started_at DESC LIMIT 1`)
          .get(s.name) as { id: string; started_at: string; summary: string | null } | undefined;
        if (!row?.summary) { console.log(`  ${s.name.padEnd(20)} 尚无对账批次`); continue; }
        const sm = JSON.parse(row.summary) as { actualCostCents: number | null; expectedCostCents: number | null; deviationPct: number | null; impliedGroupRatio: number | null; usageInflationRatio: number | null; rounds: number; errors: string[] };
        const usd = (c: number | null) => c === null ? "—" : "$" + (c / 100).toFixed(4);
        console.log(`  ${s.name.padEnd(20)} ${row.started_at.slice(5, 16)}  轮次 ${sm.rounds}`);
        console.log(`    实扣 ${usd(sm.actualCostCents)} · 应扣 ${usd(sm.expectedCostCents)} · 偏差 ${sm.deviationPct === null ? "—" : sm.deviationPct + "%"} · 隐含倍率 ${sm.impliedGroupRatio ?? "—"}${sm.usageInflationRatio ? ` · usage虚标 ${sm.usageInflationRatio}×` : ""}`);
        if (sm.errors?.length) console.log(`    ⚠ ${sm.errors.slice(0, 2).join(" | ")}`);
      }
      console.log("");
      break;
    }
    case "report": {
      const d = getDb();
      console.log("\n📊 RelayLens 站点健康概览\n");
      for (const s of enabledSites(cfg)) {
        const h = siteHealth(s.name);
        const b = batchCount(s.name);
        const last = d.prepare(`SELECT summary FROM batches WHERE site=? AND task='health' ORDER BY started_at DESC LIMIT 1`).get(s.name) as { summary: string | null } | undefined;
        let status = "—";
        if (last?.summary) {
          try { status = (JSON.parse(last.summary) as { overall?: { status: string } }).overall?.status ?? "—"; } catch { /* ignore */ }
        }
        console.log(
          `  ${s.name.padEnd(22)} 状态:${status.padEnd(9)} 7d可用率:${h.avail7d === null ? "  —  " : h.avail7d + "%"} 检查:${String(h.checks).padStart(3)}次 批次:${String(b).padStart(3)}`
        );
      }
      const total = (d.prepare("SELECT COUNT(*) c FROM batches").get() as { c: number }).c;
      const evts = (d.prepare("SELECT COUNT(*) c FROM events").get() as { c: number }).c;
      console.log(`\n  累计批次 ${total} · 事件 ${evts}\n`);
      break;
    }
    default: {
      console.log(`RelayLens Probe v0.1

用法:
  tsx cli.ts once [--task=health|price|billing] [--site=<name>] [--rounds=N]   单轮执行
        (billing 会真实扣费,必须显式指定;--rounds 可限制轮次做小额校准)
  tsx cli.ts rebuild       重建 dist 产物
  tsx cli.ts schedule      常驻调度
  tsx cli.ts report        健康概览
  tsx cli.ts sync          前端数据发布(自动补记配置漂移审计)
  tsx cli.ts ops           生成只读运营看板数据(data/ops.json + data/audit.json)
  tsx cli.ts onboard list [--status=x]      查看入驻申请队列
  tsx cli.ts onboard add --file=<payload.json>       入队一份申请(schema v1.0.0)
  tsx cli.ts onboard accept --id=OB-xxx --reason=…   受理(审计链留痕)
  tsx cli.ts onboard reject --id=OB-xxx --reason=…   驳回(理由必填,公示)
  tsx cli.ts onboard promote --id=OB-xxx             映射进 sites.yaml(enabled=false)
  tsx cli.ts audit list [--limit=N] [--action=x] [--target=y]   查看审计日志
  tsx cli.ts audit verify  校验审计链完整性(篡改/删除任意一条即报错,退出码 1)
  tsx cli.ts audit add --action=<动作> --target=<对象> --reason=<为什么>
        (人工登记,例如黑名单录入、标红复核结论)
  tsx cli.ts billing       查看各站最近一次对账结果
  tsx cli.ts reconcile [--site=<name>]   用消费日志逐笔对账(需先导出 store/manual-imports/)`);
      process.exit(cmd ? 1 : 0);
    }
  }
}

void main().catch(e => { console.error("致命错误:", e); process.exit(1); });
