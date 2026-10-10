/**
 * audit.ts —— 哈希链式追加审计日志
 *
 * 为什么存在:本站卖点是「零返利、算法开源、不因合作改排名」。而运营侧确实存在人工动作
 * (在册站点增删、权重改版、CPS 开关、数据发布)。口头中立无法自证,必须留下带时间戳、
 * 且**改一条就断链**的记录,并对外公开摘要。
 *
 * 设计:
 *   ① 三层落盘同数据湖:JSONL 原始归档(只追加,不可变)→ sqlite 索引 → data/audit.json 公开摘要
 *   ② 链式:hash = sha256(规范化正文 + prevHash)。篡改/删除任意一条,后续全部对不上
 *   ③ 人工动作显式 auditAppend();配置类改动(sites.yaml / weights.json / promo.yaml)由
 *      auditConfigDrift() 自动 diff 补记 —— 不依赖人「记得写日志」
 *   ④ 敏感值(CPS 推广链接)只落 sha256 前 12 位指纹,明文不进日志、不进公开摘要
 *   ⑤ reason 必填:没有理由的改动就是不可审计的改动
 */
import { DatabaseSync } from "node:sqlite";
import { createHash } from "node:crypto";
import fs from "node:fs";
import path from "node:path";
import YAML from "yaml";
import { getDb, STORE_DIR } from "./store.js";

const PROBE_ROOT = path.resolve(import.meta.dirname, "..");
export const AUDIT_RAW_DIR = path.join(STORE_DIR, "audit");

const GENESIS = "0".repeat(64);

// ---------- 数据结构 ----------
export interface AuditEntry {
  seq?: number;
  at: string;
  actor: string;              // human:<name> | probe | agent:qwenwork | system
  action: string;             // site.add / site.disable / weights.bump / promo.enable / data.publish / ...
  target: string;             // aixoras | shared/weights.json | promo:aicost | data/sites.json
  before: unknown;
  after: unknown;
  reason: string;
  evidence: string | null;    // 批次号 / 文件 / commit
  prevHash?: string;
  hash?: string;
}

/** 默认操作者:环境变量 RL_OPERATOR 决定,便于多人运营时区分 */
export function currentActor(): string {
  const op = process.env.RL_OPERATOR?.trim();
  return op ? `human:${op}` : (process.env.RL_ACTOR?.trim() || "probe");
}

// ---------- 规范化哈希(键序无关) ----------
function canonical(v: unknown): string {
  if (v === undefined || v === null) return "null";
  if (typeof v !== "object") return JSON.stringify(v) ?? "null";
  if (Array.isArray(v)) return "[" + v.map(canonical).join(",") + "]";
  const o = v as Record<string, unknown>;
  // undefined 值的键必须跳过 —— 与 JSON.stringify 的序列化语义对齐( undefined 键在落盘时消失),
  // 否则内存计算与 JSONL 回放会对同一记录算出不同哈希(site.declared 的 before 曾因此断链)
  return "{" + Object.keys(o).filter(k => o[k] !== undefined).sort().map(k => JSON.stringify(k) + ":" + canonical(o[k])).join(",") + "}";
}

const sha = (s: string) => createHash("sha256").update(s, "utf8").digest("hex");

/** 敏感值指纹:可核对「是不是同一条链接变了」,但不泄露内容 */
export function secretFingerprint(v: string): string {
  return v ? sha(v).slice(0, 12) : "empty";
}

function bodyForHash(e: AuditEntry) {
  return { at: e.at, actor: e.actor, action: e.action, target: e.target, before: e.before, after: e.after, reason: e.reason, evidence: e.evidence };
}

function entryHash(e: AuditEntry, prevHash: string): string {
  return sha(canonical(bodyForHash(e)) + "|" + prevHash);
}

// ---------- 追加(带并发防分叉) ----------
function rawFile(): string {
  const ym = new Date().toISOString().slice(0, 7).replace("-", "");
  return path.join(AUDIT_RAW_DIR, `audit-${ym}.jsonl`);
}

function lastHash(d: DatabaseSync): string {
  const row = d.prepare(`SELECT hash FROM audit ORDER BY seq DESC LIMIT 1`).get() as { hash: string } | undefined;
  return row?.hash ?? GENESIS;
}

export function auditAppend(input: {
  actor?: string; action: string; target: string;
  before?: unknown; after?: unknown; reason: string; evidence?: string | null;
  at?: string;
}): AuditEntry {
  // 测试闸门:RL_AUDIT_OFF=1 时完全跳过写入 —— 公开链里绝不能出现测试假站点
  if (process.env.RL_AUDIT_OFF === "1") {
    return { at: input.at ?? new Date().toISOString(), actor: input.actor ?? currentActor(),
      action: input.action, target: input.target, before: input.before ?? null,
      after: input.after ?? null, reason: input.reason.trim(), evidence: input.evidence ?? null,
      prevHash: "test-off", hash: "test-off" };
  }
  if (!input.reason || !input.reason.trim()) {
    throw new Error(`审计拒绝:action=${input.action} 缺少 reason(无记录的改动不可审计)`);
  }
  const d = getDb();
  fs.mkdirSync(AUDIT_RAW_DIR, { recursive: true });
  const e: AuditEntry = {
    at: input.at ?? new Date().toISOString(),
    actor: input.actor ?? currentActor(),
    action: input.action,
    target: input.target,
    before: input.before ?? null,
    after: input.after ?? null,
    reason: input.reason.trim(),
    evidence: input.evidence ?? null,
  };
  // prev_hash 建唯一索引 = 天然追加锁:两个进程同时接同一条尾哈希时,后者必然冲突并重试
  for (let attempt = 0; attempt < 40; attempt++) {
    const prevHash = lastHash(d);
    e.prevHash = prevHash;
    e.hash = entryHash(e, prevHash);
    try {
      d.prepare(`INSERT INTO audit(at, actor, action, target, before, after, reason, evidence, prev_hash, hash)
                 VALUES(?,?,?,?,?,?,?,?,?,?)`)
        .run(e.at, e.actor, e.action, e.target,
             canonical(e.before), canonical(e.after), e.reason, e.evidence, prevHash, e.hash);
    } catch (err) {
      const msg = (err as Error).message || "";
      if (/UNIQUE|CONSTRAINT/i.test(msg)) continue;   // 尾哈希被抢占 → 重新接链
      throw err;
    }
    // DB 成功后才落原始归档(与数据湖「先证据后指标」相反:此处归档是副本,失败可重建)
    try { fs.appendFileSync(rawFile(), JSON.stringify({ ...e, seq: lastSeq(d) }) + "\n", "utf8"); }
    catch { /* 归档副本失败不阻断主链,DB 仍是事实源 */ }
    return e;
  }
  throw new Error("审计写入失败:链尾持续被抢占(并发过高)");
}

function lastSeq(d: DatabaseSync): number {
  const r = d.prepare(`SELECT MAX(seq) s FROM audit`).get() as { s: number | null };
  return r.s ?? 0;
}

// ---------- 链完整性校验 ----------
export interface VerifyResult {
  ok: boolean; total: number; brokenAt: number | null; why: string | null;
  rawCount: number; rawDrift: number; headHash: string; rawHead: string;
}

/** 独立重放 JSONL 归档的链,返回它自己的链头(与 DB 链头互为对照) */
function rawChainHead(): { head: string; count: number } {
  if (!fs.existsSync(AUDIT_RAW_DIR)) return { head: "", count: 0 };
  const entries: AuditEntry[] = [];
  for (const f of fs.readdirSync(AUDIT_RAW_DIR).filter(f => f.endsWith(".jsonl")).sort()) {
    for (const line of fs.readFileSync(path.join(AUDIT_RAW_DIR, f), "utf8").split(/\r?\n/)) {
      if (!line.trim()) continue;
      try { entries.push(JSON.parse(line) as AuditEntry); } catch { return { head: "#corrupt:" + f, count: entries.length }; }
    }
  }
  let prev = GENESIS;
  for (const e of entries) {
    if (e.prevHash !== prev) return { head: "#broken", count: entries.length };
    if (entryHash(e, prev) !== e.hash) return { head: "#tampered", count: entries.length };
    prev = e.hash;
  }
  return { head: prev === GENESIS ? "empty" : prev, count: entries.length };
}

/**
 * 校验做三件事,缺一不可:
 *   ① DB 链:逐条重算哈希 + prev_hash 指向 → 抓「改写正文」与「中间插入/删除」
 *   ② 归档条数 == DB 条数 → 抓「只删 DB 不动归档」
 *   ③ DB 链头 == 归档链头 → 抓「截断攻击」:纯哈希链下删掉最后一条是查不出的
 *      (没有后继就没有断点),所以必须有第二份独立副本对账。
 */
export function auditVerify(): VerifyResult {
  const d = getDb();
  const rows = d.prepare(`SELECT seq, at, actor, action, target, before, after, reason, evidence, prev_hash, hash
                          FROM audit ORDER BY seq ASC`).all() as Array<{
    seq: number; at: string; actor: string; action: string; target: string;
    before: string | null; after: string | null; reason: string; evidence: string | null;
    prev_hash: string; hash: string;
  }>;
  let prev = GENESIS;
  for (const r of rows) {
    let before: unknown = null, after: unknown = null;
    try { before = r.before ? JSON.parse(r.before) : null; } catch { before = r.before; }
    try { after = r.after ? JSON.parse(r.after) : null; } catch { after = r.after; }
    const e: AuditEntry = { at: r.at, actor: r.actor, action: r.action, target: r.target, before, after, reason: r.reason, evidence: r.evidence };
    if (r.prev_hash !== prev) {
      return { ok: false, total: rows.length, brokenAt: r.seq, why: `第 ${r.seq} 条 prev_hash 不指向前一条(记录被删除或插入)`, rawCount: 0, rawDrift: 0, headHash: prev, rawHead: "" };
    }
    if (entryHash(e, prev) !== r.hash) {
      return { ok: false, total: rows.length, brokenAt: r.seq, why: `第 ${r.seq} 条正文与哈希不符(字段被篡改)`, rawCount: 0, rawDrift: 0, headHash: prev, rawHead: "" };
    }
    prev = r.hash;
  }
  const raw = rawChainHead();
  const headHash = prev;
  if (raw.count !== rows.length) {
    return { ok: false, total: rows.length, brokenAt: null, why: `DB ${rows.length} 条与原始归档 ${raw.count} 条不符(有记录被单边删除)`, rawCount: raw.count, rawDrift: rows.length - raw.count, headHash, rawHead: raw.head };
  }
  if (raw.head.startsWith("#")) {
    return { ok: false, total: rows.length, brokenAt: null, why: `原始归档链自身异常(${raw.head})`, rawCount: raw.count, rawDrift: 0, headHash, rawHead: raw.head };
  }
  if (raw.head !== "empty" && raw.head !== headHash) {
    return { ok: false, total: rows.length, brokenAt: null, why: "DB 链头与归档链头不一致(疑似截断:删掉了最近的记录)", rawCount: raw.count, rawDrift: 0, headHash, rawHead: raw.head };
  }
  return { ok: true, total: rows.length, brokenAt: null, why: null, rawCount: raw.count, rawDrift: 0, headHash, rawHead: raw.head };
}

export function auditList(limit = 50, filter: { action?: string; target?: string } = {}): AuditEntry[] {
  const d = getDb();
  const where: string[] = [];
  const args: Array<string | number> = [];
  if (filter.action) { where.push("action = ?"); args.push(filter.action); }
  if (filter.target) { where.push("target = ?"); args.push(filter.target); }
  args.push(limit);
  const rows = d.prepare(`SELECT seq, at, actor, action, target, before, after, reason, evidence, prev_hash, hash
                          FROM audit ${where.length ? "WHERE " + where.join(" AND ") : ""}
                          ORDER BY seq DESC LIMIT ?`).all(...args) as Array<Record<string, string | number | null>>;
  return rows.map(r => ({
    seq: Number(r.seq), at: String(r.at), actor: String(r.actor), action: String(r.action), target: String(r.target),
    before: parseCol(r.before), after: parseCol(r.after), reason: String(r.reason ?? ""),
    evidence: r.evidence === null ? null : String(r.evidence),
    prevHash: String(r.prev_hash), hash: String(r.hash),
  }));
}

function parseCol(v: string | number | null): unknown {
  if (v === null || v === undefined) return null;
  try { return JSON.parse(String(v)); } catch { return String(v); }
}

// ---------- 配置漂移自动补记 ----------
interface FileState { hash: string; entries?: number; state?: unknown }

function fileHash(p: string): string {
  if (!fs.existsSync(p)) return "missing";
  return sha(fs.readFileSync(p, "utf8"));
}

function lastSnapshot(target: string): FileState | null {
  return lastEntry("config.snapshot", target);
}

function lastEntry(action: string, target: string): FileState | null {
  const rows = auditList(1, { action, target });
  if (!rows.length) return null;
  const a = rows[0].after as FileState | null;
  return a && typeof a === "object" ? a : null;
}

/**
 * 三类配置的漂移检测。在 sync/once 之前调用,把「谁改了在册站点/权重/推广位」
 * 自动落成审计条目,而不是指望人手写日志。
 */
export function auditConfigDrift(): number {
  const files: Array<{ target: string; abs: string; reduce: (p: unknown) => unknown; diff: (prev: unknown, next: unknown) => Array<Omit<AuditEntry, "at">> }> = [
    { target: "probe/config/sites.yaml", abs: path.join(PROBE_ROOT, "config/sites.yaml"), reduce: reduceSites, diff: diffSites },
    { target: "shared/weights.json", abs: path.join(PROBE_ROOT, "../shared/weights.json"), reduce: reduceWeights, diff: diffWeights },
    { target: "probe/config/promo.yaml", abs: path.join(PROBE_ROOT, "config/promo.yaml"), reduce: reducePromo, diff: diffPromo },
  ];
  let n = 0;
  for (const f of files) {
    const prev = lastSnapshot(f.target);
    const hash = fileHash(f.abs);
    if (prev && prev.hash === hash) continue;   // 无变化
    const state = f.reduce(readPayload(f.abs));
    // 首次登记只落指纹,不逐条补记 —— 否则会把「建站时就存在的配置」伪造成「此刻发生的变更」
    const changes = prev && prev.state !== undefined ? f.diff(prev.state, state) : [];
    for (const c of changes) { auditAppend(c); n++; }
    // 快照存「脱敏后的状态」而非原文:下一次才能真做 diff,同时 CPS 链接明文永不进链
    auditAppend({
      action: "config.snapshot", target: f.target,
      before: prev ? { hash: prev.hash } : null,
      after: { hash, entries: countEntries(state), state },
      reason: prev?.hash ? `配置内容变更,记录新指纹与脱敏状态以便日后复现差异` : `首次登记配置指纹`,
      evidence: null,
    });
    n++;
  }
  return n;
}

function countEntries(state: unknown): number {
  if (!state || typeof state !== "object") return 0;
  return Object.keys(state).length;
}

function readPayload(abs: string): unknown {
  if (!fs.existsSync(abs)) return null;
  const txt = fs.readFileSync(abs, "utf8");
  try { return abs.endsWith(".json") ? JSON.parse(txt) : YAML.parse(txt); } catch { return { _unparseable: sha(txt).slice(0, 12) }; }
}

// ---------- 脱敏归约:入链的是「可比对的状态」,不是配置原文 ----------
// 为什么要归约:sites.yaml 里有 key_env 名,promo.yaml 里有 CPS 明文链接。
// 审计链会导出成 data/audit.json 对外公开,所以只留可比对的指纹与布尔量。

type SiteState = Record<string, { enabled: boolean; parser: string | null; base_url: string | null; hasKey: boolean; directions: string[] | null; declared: string[] | null; commerce: string | null }>;
type PromoState = Record<string, { enabled: boolean; urlHash: string; couponHash: string }>;
type WeightsState = { version: string | null; scenes: Record<string, Record<string, number | string>>; confidence: Record<string, unknown> };

interface SiteRow { name: string; enabled?: boolean; parser?: string; base_url?: string; key_env?: string }

function reduceSites(p: unknown): SiteState {
  const out: SiteState = {};
  const sites = (p as { sites?: SiteRow[] })?.sites;
  if (Array.isArray(sites)) {
    for (const s of sites) {
      if (!s?.name) continue;
      const dg = (s as any).declared_groups as Array<{ name: string; tier: string }> | undefined;
      const cm = (s as any).commerce as Record<string, unknown> | undefined;
      out[s.name] = {
        enabled: !!s.enabled, parser: s.parser ?? null, base_url: s.base_url ?? null, hasKey: !!s.key_env,
        directions: Array.isArray((s as any).directions) ? (s as any).directions : null,
        declared: dg ? dg.map((g: any) => g.name + ":" + g.tier) : null,
        // 商业信息只存脱敏后的可比对摘要(值本身不涉密,但按同一口径统一进链)
        commerce: cm ? JSON.stringify([cm.pay_methods ?? null, cm.recharge_ratio ?? null, cm.min_top_up ?? null,
          cm.invoice ?? null, cm.refund ?? null, cm.source ?? "declared", cm.verified ?? null]) : null,
      };
    }
  }
  return out;
}

function reducePromo(p: unknown): PromoState {
  const out: PromoState = {};
  const promo = (p as { promo?: Record<string, { enabled?: boolean; url?: string; coupon?: string }> })?.promo;
  if (promo) for (const [k, v] of Object.entries(promo)) {
    out[k] = { enabled: !!(v?.enabled), urlHash: secretFingerprint(v?.url ?? ""), couponHash: secretFingerprint(v?.coupon ?? "") };
  }
  return out;
}

function reduceWeights(p: unknown): WeightsState {
  const o = (p ?? {}) as { version?: string; scenes?: Record<string, Record<string, unknown>>; confidence?: Record<string, unknown> };
  const scenes: WeightsState["scenes"] = {};
  for (const [k, v] of Object.entries(o.scenes ?? {})) {
    scenes[k] = Object.fromEntries(Object.entries(v ?? {}).filter(([kk, vv]) => !["note"].includes(kk) && (typeof vv === "number" || typeof vv === "string" || typeof vv === "boolean")).map(([kk, vv]) => [kk, vv as number]));
  }
  const confidence: Record<string, unknown> = {};
  for (const [k, v] of Object.entries(o.confidence ?? {})) if (typeof v === "number") confidence[k] = v;
  return { version: o.version ?? null, scenes, confidence };
}

// ---------- diff ----------

function diffSites(prev: unknown, next: unknown): Array<Omit<AuditEntry, "at">> {
  const actor = currentActor();
  const a = (prev ?? {}) as SiteState, b = (next ?? {}) as SiteState;
  const out: Array<Omit<AuditEntry, "at">> = [];
  const mk = (action: string, target: string, before: unknown, after: unknown, reason: string) =>
    ({ actor, action, target, before, after, reason, evidence: null });
  for (const [name, s] of Object.entries(b)) {
    const o = a[name];
    if (!o) {
      out.push(mk("site.add", name, null, s, `新增在册站点 ${name}(付费实测能力以 hasKey 布尔记录,不记录密钥或环境变量名)`));
      continue;
    }
    if (o.enabled !== s.enabled) {
      out.push(mk(s.enabled ? "site.enable" : "site.disable", name, { enabled: o.enabled }, { enabled: s.enabled },
        `站点 ${name} ${s.enabled ? "恢复检测" : "暂停检测"} —— 暂停会被前端标注为「无近期实测」,影响排名,故必须留痕`));
    }
    if (o.parser !== s.parser) {
      out.push(mk("site.parser", name, { parser: o.parser }, { parser: s.parser }, `站点 ${name} 价格解析器切换,解析口径变化需可追溯`));
    }
    if (o.base_url !== s.base_url) {
      out.push(mk("site.base_url", name, { base_url: o.base_url }, { base_url: s.base_url }, `站点 ${name} 接入端点变化`));
    }
    if (o.hasKey !== s.hasKey) {
      out.push(mk("site.key_env", name, { hasKey: o.hasKey }, { hasKey: s.hasKey }, `站点 ${name} 付费实测能力${s.hasKey ? "开通" : "关闭"}`));
    }
    // 声明变更(方向/分组)同样留痕 —— 这决定检测矩阵,是「声明-检测-验证」的锚点
    const da = JSON.stringify([o.directions, o.declared]), db = JSON.stringify([s.directions, s.declared]);
    if (da !== db) {
      out.push(mk("site.declared", name, { directions: o.directions, groups: o.declared }, { directions: s.directions, groups: s.declared },
        `站点 ${name} 声明变更(主攻方向/分组)—— 检测矩阵将按新声明定制`));
    }
    // 商业信息(支付方式/充值比例/发票/退款)变更 —— 这些字段没有任何探测路径能验证,改一次就是一次对外承诺的变动,必须留痕
    const ca = o.commerce ?? null, cb = s.commerce ?? null;
    if (ca !== cb) {
      out.push(mk("site.commerce", name, { commerce: ca }, { commerce: cb },
        `站点 ${name} 商业信息变更(榜单站名下方支付方式 logo 与详情页商业栏随之变化;来源标注决定它被读作「站方声明」还是「人工核实」)`));
    }
  }
  for (const name of Object.keys(a)) {
    if (!b[name]) out.push(mk("site.remove", name, { removed: true }, null, `站点 ${name} 从在册列表移除 —— 移除会使其历史数据不再进入榜单,须留原因`));
  }
  return out;
}

function diffWeights(prev: unknown, next: unknown): Array<Omit<AuditEntry, "at">> {
  const actor = currentActor();
  const a = (prev ?? {}) as WeightsState, b = (next ?? {}) as WeightsState;
  const out: Array<Omit<AuditEntry, "at">> = [];
  const mk = (action: string, target: string, before: unknown, after: unknown, reason: string) =>
    ({ actor, action, target, before, after, reason, evidence: null });
  if (a.version && b.version && a.version !== b.version) {
    out.push(mk("weights.bump", "shared/weights.json", { version: a.version }, { version: b.version },
      `评分权重升版 ${a.version} → ${b.version}:全部历史评分口径变化,旧批次数据需重算才能同榜比较`));
  }
  // 逐场景权重数字差异 —— 这才是「给谁涨了分」的直接证据
  for (const scene of Array.from(new Set([...Object.keys(a.scenes ?? {}), ...Object.keys(b.scenes ?? {})]))) {
    const sa = a.scenes?.[scene], sb = b.scenes?.[scene];
    if (!sa || !sb) continue;
    const keys = Array.from(new Set([...Object.keys(sa), ...Object.keys(sb)])).filter(k => !["label", "separate"].includes(k));
    const changed = keys.filter(k => (sa[k] ?? null) !== (sb[k] ?? null));
    if (changed.length) {
      out.push(mk("weights.scene", `scene:${scene}`,
        Object.fromEntries(changed.map(k => [k, sa[k] ?? null])),
        Object.fromEntries(changed.map(k => [k, sb[k] ?? null])),
        `场景「${sb.label ?? scene}」权重调整(${changed.map(k => `${k}:${sa[k] ?? 0}→${sb[k] ?? 0}`).join(" ")})`));
    }
  }
  const ca = a.confidence ?? {}, cb = b.confidence ?? {};
  const ckeys = Array.from(new Set([...Object.keys(ca), ...Object.keys(cb)])).filter(k => ca[k] !== cb[k]);
  if (ckeys.length) {
    out.push(mk("weights.threshold", "confidence",
      Object.fromEntries(ckeys.map(k => [k, ca[k] ?? null])), Object.fromEntries(ckeys.map(k => [k, cb[k] ?? null])),
      `数据门槛调整(${ckeys.map(k => `${k}:${ca[k] ?? "∅"}→${cb[k] ?? "∅"}`).join(" ")})—— 门槛决定谁有资格出分,属高敏感变更`));
  }
  return out;
}

/** 推广位变动:最容易被质疑「是不是给钱就上首页」,所以必须留痕且明文不外泄 */
function diffPromo(prev: unknown, next: unknown): Array<Omit<AuditEntry, "at">> {
  const actor = currentActor();
  const a = (prev ?? {}) as PromoState, b = (next ?? {}) as PromoState;
  const out: Array<Omit<AuditEntry, "at">> = [];
  const mk = (action: string, target: string, before: unknown, after: unknown, reason: string) =>
    ({ actor, action, target, before, after, reason, evidence: null });
  for (const [name, p] of Object.entries(b)) {
    const o = a[name];
    if (!o) {
      out.push(mk("promo.add", `promo:${name}`, null, { enabled: p.enabled, urlHash: p.urlHash },
        `登记 ${name} 推广位配置(链接与券码仅存指纹,明文不入库、不进公开摘要)`));
      continue;
    }
    if (o.enabled !== p.enabled) {
      out.push(mk(p.enabled ? "promo.enable" : "promo.disable", `promo:${name}`, { enabled: o.enabled }, { enabled: p.enabled },
        `${name} CPS 推广位${p.enabled ? "开启" : "关闭"}。声明:推广位只影响按钮与优惠券展示,实测指标与排名不受影响`));
    }
    if (o.urlHash !== p.urlHash) {
      out.push(mk("promo.url", `promo:${name}`, { urlHash: o.urlHash }, { urlHash: p.urlHash },
        `${name} 推广链接更换(仅记录前后指纹,明文不入库)`));
    }
  }
  for (const name of Object.keys(a)) if (!b[name]) out.push(mk("promo.remove", `promo:${name}`, { removed: true }, null, `${name} 推广位配置删除`));
  return out;
}

/**
 * 发布指纹:对外数据变了要留痕,便于回答「9月29日那天榜单为什么变了」。
 * 只比语义内容 —— meta.updated 这类时间戳每次都变,若纳入哈希则每轮 sync 都会
 * 产出一条「数据已发布」的噪声记录,把真正值得看的变化淹没。
 */
export function auditPublish(file: string, content: string, note: string) {
  let semantic = content;
  try {
    const o = JSON.parse(content) as Record<string, unknown>;
    if (o && typeof o === "object") {
      const m = o.meta as Record<string, unknown> | undefined;
      if (m) for (const k of ["updated", "generatedAt", "checkedAt", "syncedAt"]) delete m[k];
      semantic = canonical(o);
    }
  } catch { /* 非 JSON 产物按原文比 */ }
  const prev = lastEntry("data.publish", file);
  const hash = sha(semantic);
  if (prev && prev.hash === hash) return false;
  auditAppend({
    actor: currentActor(), action: "data.publish", target: file,
    before: prev ? { hash: prev.hash } : null, after: { hash, note },
    reason: `前端数据发生变化并重新发布:${note}`, evidence: null,
  });
  return true;
}

// ---------- 建表(挂在 store 的 migrate 之外,避免循环依赖) ----------
let ensured = false;
export function ensureAuditTable(d: DatabaseSync = getDb()) {
  if (ensured) return;
  d.exec(`CREATE TABLE IF NOT EXISTS audit(
    seq INTEGER PRIMARY KEY AUTOINCREMENT,
    at TEXT NOT NULL, actor TEXT NOT NULL, action TEXT NOT NULL, target TEXT NOT NULL,
    before TEXT, after TEXT, reason TEXT NOT NULL, evidence TEXT,
    prev_hash TEXT NOT NULL, hash TEXT NOT NULL
  )`);
  d.exec(`CREATE UNIQUE INDEX IF NOT EXISTS ux_audit_prev ON audit(prev_hash)`);
  d.exec(`CREATE INDEX IF NOT EXISTS idx_audit_target ON audit(target, seq)`);
  ensured = true;
}
ensureAuditTable();
