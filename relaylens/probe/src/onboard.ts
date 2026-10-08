/**
 * onboard.ts —— 入驻申请队列与「声明 → sites.yaml」映射
 *
 * 流程:表单 payload(schema v1.0.0)→ cli onboard add 入队 → ops 看板提醒
 *       → cli onboard accept/reject(人工裁决,审计链留痕)
 *       → cli onboard promote(校验齐全后映射进 sites.yaml,enabled=false,探针侧再启用)
 *
 * 设计要点:
 *   ① 队列是配置文件(config/onboarding-queue.yaml),不是数据库 —— 与 sites.yaml 同一的
 *      "文本 + git + 审计" 运营模型,审核历史天然可追溯
 *   ② payload 校验在探针侧重做一遍(前端校验只算体验,不算防线)
 *   ③ promote 只生成 sites.yaml 文本并追加,enabled=false —— 真正启用(填 base_url/parser/key)
 *      仍是人工动作,由 sites.yaml 漂移检测自动记入审计链
 */
import fs from "node:fs";
import path from "node:path";
import YAML from "yaml";
import { auditAppend } from "./audit.js";

const PROBE_ROOT = path.resolve(import.meta.dirname, "..");
/**
 * 路径必须在**调用时**读取 env,不能在模块加载时固化 —— ESM import 会被提升到
 * 测试的 process.env 赋值之前,加载时固化会让测试写到真实配置文件
 * (已发生过一次:测试把「测试站 Alpha」追加进了真实 sites.yaml 并破坏 YAML 结构)。
 */
const queueFile = () => process.env.RL_QUEUE_FILE || path.join(PROBE_ROOT, "config/onboarding-queue.yaml");
const sitesFile = () => process.env.RL_SITES_FILE || path.join(PROBE_ROOT, "config/sites.yaml");

const DIRECTIONS = ["text", "image", "video", "audio", "hybrid"];
const TIERS = ["primary", "special"];
const BILLINGS = ["ratio", "tiered", "unknown"];

// ---------- 类型 ----------
export interface DeclaredGroup { name: string; models: string[]; tier: string; billing: string }
export interface Declaration {
  schema: string;
  phase: number;
  status: string;
  submittedAt: string;
  site_name: string;
  domain: string;
  directions: string[];
  declared_groups: DeclaredGroup[];
  contact: { email: string; tg?: string | null };
  accept_quota_rules: boolean;
  notes?: string | null;
}
export interface QueueItem extends Declaration { id: string; history: Array<{ at: string; status: string; actor: string; reason?: string | null }> }

// ---------- 校验(探针侧复核,前端校验不算防线) ----------
export function validateDeclaration(p: any): { ok: true } | { ok: false; errors: string[] } {
  const e: string[] = [];
  const push = (m: string) => e.push(m);
  if (!p || typeof p !== "object") return { ok: false, errors: ["payload 不是对象"] };
  if (!/^relaylens-onboarding\//.test(String(p.schema ?? ""))) push("schema 标记不是 relaylens-onboarding/*");
  if (!p.site_name || String(p.site_name).length > 40) push("site_name 缺失或超长");
  if (!/^https?:\/\/[^\s/]+\.[^\s/]+/.test(String(p.domain ?? ""))) push("domain 缺失或格式错误");
  if (!Array.isArray(p.directions) || !p.directions.length || p.directions.some((d: any) => !DIRECTIONS.includes(d))) push("directions 缺失或含未知方向");
  if (!Array.isArray(p.declared_groups) || !p.declared_groups.length) push("declared_groups 至少一个主力分组");
  else for (const g of p.declared_groups) {
    if (!g.name) push("分组缺 name");
    if (!Array.isArray(g.models) || !g.models.length) push(`分组「${g.name ?? "?"}」缺模型列表`);
    if (!TIERS.includes(g.tier)) push(`分组「${g.name ?? "?"}」tier 非法`);
    if (!BILLINGS.includes(g.billing)) push(`分组「${g.name ?? "?"}」billing 非法`);
  }
  if (!/^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(String(p.contact?.email ?? ""))) push("contact.email 缺失或格式错误");
  if (p.accept_quota_rules !== true) push("未确认测试额度规则");
  return e.length ? { ok: false, errors: e } : { ok: true };
}

// ---------- 队列读写 ----------
interface QueueFile { version: string; items: QueueItem[] }

function loadQueue(): QueueFile {
  if (!fs.existsSync(queueFile())) return { version: "1.0.0", items: [] };
  try {
    const q = YAML.parse(fs.readFileSync(queueFile(), "utf8")) as QueueFile;
    return { version: q.version ?? "1.0.0", items: q.items ?? [] };
  } catch { return { version: "1.0.0", items: [] }; }
}

function saveQueue(q: QueueFile) {
  fs.writeFileSync(queueFile(), YAML.stringify(q, { lineWidth: 0 }), "utf8");
}

/** 队列内是否有同域名申请(防重复提交) */
function findSameDomain(items: QueueItem[], domain: string): QueueItem | undefined {
  const host = domain.replace(/^https?:\/\//, "").replace(/\/+$/, "").toLowerCase();
  return items.find(i => i.domain.replace(/^https?:\/\//, "").toLowerCase().includes(host));
}

// ---------- 动作 ----------
export function addDeclaration(p: any): { item?: QueueItem; errors?: string[] } {
  const v = validateDeclaration(p);
  if (!v.ok) return { errors: v.errors };
  const q = loadQueue();
  const dup = findSameDomain(q.items, p.domain);
  if (dup) return { errors: [`域名 ${p.domain} 已有在途申请(${dup.id},状态 ${dup.status}),请勿重复提交`] };
  const item: QueueItem = {
    ...p,
    id: "OB-" + new Date().toISOString().slice(0, 10).replace(/-/g, "") + "-" + String(q.items.length + 1).padStart(3, "0"),
    history: [{ at: new Date().toISOString(), status: "applied", actor: process.env.RL_OPERATOR ?? "form" }],
  };
  q.items.push(item);
  saveQueue(q);
  auditAppend({
    actor: "form", action: "declaration.received", target: "onboarding:" + item.id,
    after: { site_name: item.site_name, domain: item.domain, directions: item.directions, groups: item.declared_groups.length },
    reason: `收到入驻申请:${item.site_name}(${item.domain}),主攻 ${item.directions.join("/")}`, evidence: null,
  });
  return { item };
}

export function transition(id: string, to: "accepted" | "rejected", reason: string): QueueItem | null {
  if (!reason || !reason.trim()) throw new Error("受理/驳回必须附理由(写入审计链并对外公示)");
  const q = loadQueue();
  const item = q.items.find(i => i.id === id);
  if (!item) throw new Error("申请不存在:" + id);
  const allowed = { accepted: ["applied"], rejected: ["applied", "awaiting_quota"] }[to];
  if (!allowed.includes(item.status)) throw new Error(`状态机不允许 ${item.status} → ${to}`);
  item.status = to;
  item.history.push({ at: new Date().toISOString(), status: to, actor: process.env.RL_OPERATOR ?? "cli", reason: reason.trim() });
  saveQueue(q);
  auditAppend({
    action: to === "accepted" ? "declaration.accept" : "declaration.reject", target: "onboarding:" + id,
    before: { status: allowed[0] }, after: { status: to },
    reason: `${id}(${item.site_name}):${reason.trim()}`, evidence: null,
  });
  return item;
}

/** 生成 sites.yaml 条目文本(不直接写文件 —— 追加动作由调用方完成,启用仍是人工步骤) */
export function toSitesYaml(item: QueueItem): string {
  const name = item.site_name.replace(/[\r\n"“”]/g, "");
  const groups = item.declared_groups.map(g => `        - { name: "${g.name.replace(/"/g, "")}", models: [${g.models.map(m => `"${m}"`).join(", ")}], tier: ${g.tier}, billing: ${g.billing} }`).join("\n");
  return `  # ---- 入驻转入(来自 ${item.id},状态机见 shared/onboarding.schema.json) ----
  - name: "${name}"
    base_url: "${item.domain}"                # TODO(阶段二):替换为真实 API 端点
    enabled: false                            # 阶段二补齐 parser/key 后再启用
    tags: ["relay", "onboarding"]
    directions: [${item.directions.map(d => `"${d}"`).join(", ")}]
    declared_groups:
${groups}
    contact_email: "${item.contact.email}"
    notes: "入驻申请 ${item.id} · ${item.notes ?? ""}"
`;
}

/** 受理通过且阶段二齐备后:映射进 sites.yaml(enabled=false,启用仍人工)。幂等:重复执行只报告,不重复追加 */
export function promote(id: string): { item: QueueItem; yaml: string; appended: boolean } {
  const q = loadQueue();
  const item = q.items.find(i => i.id === id);
  if (!item) throw new Error("申请不存在:" + id);
  if (item.status === "onboarded") {
    return { item, yaml: toSitesYaml(item), appended: false };   // 幂等重放
  }
  if (item.status !== "accepted") throw new Error(`仅 accepted 状态可转正(当前 ${item.status})`);
  const v = validateDeclaration(item);
  if (!v.ok) throw new Error("声明校验失败:" + v.errors.join(";"));
  const yamlText = toSitesYaml(item);
  const existing = fs.existsSync(sitesFile()) ? fs.readFileSync(sitesFile(), "utf8") : "";
  let appended = false;
  if (!existing.includes(`"${item.site_name}"`)) {
    fs.appendFileSync(sitesFile(), "\n" + yamlText, "utf8");
    appended = true;
  }
  item.status = "onboarded";
  item.history.push({ at: new Date().toISOString(), status: "onboarded", actor: process.env.RL_OPERATOR ?? "cli", reason: "映射进 sites.yaml(enabled=false)" });
  saveQueue(q);
  auditAppend({
    action: "declaration.promote", target: "onboarding:" + id,
    after: { status: "onboarded", sites_yaml: appended ? "appended" : "already-present" },
    reason: `${id}(${item.site_name})映射进 sites.yaml,enabled=false —— 启用与 key 配置为下一步人工动作,漂移检测将自动记录 site.add`, evidence: null,
  });
  return { item, yaml: yamlText, appended };
}

export function listQueue(status?: string): QueueItem[] {
  const q = loadQueue();
  return status ? q.items.filter(i => i.status === status) : q.items;
}

export function pendingCount(): number {
  return loadQueue().items.filter(i => i.status === "applied").length;
}
