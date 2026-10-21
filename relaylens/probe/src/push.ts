/**
 * push.ts —— 企微告警推送(经 wechat-gateway /push 转发)
 * 门控:RL_WECOM_PUSH_URL + RL_WECOM_PUSH_TOKEN 未配置时安静跳过(推送是增益,不是依赖);
 * 防轰炸:同一 code+site 的 critical 告警 24h 内只推一次(state 存 store/push-state.json);
 * 失败绝不影响探针任务本身:所有异常吞掉只打日志。
 */
import fs from "node:fs";
import path from "node:path";

const STATE_FILE = path.join(import.meta.dirname, "..", "store", "push-state.json");
const DEDUP_WINDOW_MS = 24 * 3600e3;

export function loadPushState(): Record<string, string> {
  try { return JSON.parse(fs.readFileSync(STATE_FILE, "utf8")) as Record<string, string>; }
  catch { return {}; }
}
export function savePushState(s: Record<string, string>): void {
  fs.writeFileSync(STATE_FILE, JSON.stringify(s, null, 1));
}

export interface OpsFindingLike { level: string; code: string; site: string; msg: string; action: string }

/** 只推 critical,且同键 24h 内不重复 */
export function shouldPush(state: Record<string, string>, f: OpsFindingLike, now = Date.now()): boolean {
  if (f.level !== "critical") return false;
  const last = state[f.code + "@" + f.site] ? Date.parse(state[f.code + "@" + f.site]) : 0;
  return now - last >= DEDUP_WINDOW_MS;
}

/** 低层文本推送:billing 轮摘要等自定义消息;未配置网关返回 false,失败吞掉只打日志 */
export async function pushWeComText(text: string): Promise<boolean> {
  const url = process.env.RL_WECOM_PUSH_URL;
  const token = process.env.RL_WECOM_PUSH_TOKEN;
  if (!url || !token) return false;
  const ctrl = new AbortController();
  const timer = setTimeout(() => ctrl.abort(), 10_000);
  try {
    const r = await fetch(url, {
      method: "POST",
      headers: { "Content-Type": "application/json", "X-Push-Token": token },
      body: JSON.stringify({ text }),
      signal: ctrl.signal,
    });
    return r.ok;
  } catch (e) {
    console.log(`  (企微推送失败,不影响任务:${(e as Error).message})`);
    return false;
  } finally { clearTimeout(timer); }
}

/** 读 ops.json 的 queue,推 critical;返回推送条数(skipped=true=未配置网关) */
export async function pushCriticalAlerts(opsFile: string): Promise<{ pushed: number; skipped: boolean }> {
  const url = process.env.RL_WECOM_PUSH_URL;
  const token = process.env.RL_WECOM_PUSH_TOKEN;
  if (!url || !token) return { pushed: 0, skipped: true };

  const queue = (JSON.parse(fs.readFileSync(opsFile, "utf8")) as { queue?: OpsFindingLike[] }).queue ?? [];
  const state = loadPushState();
  const now = Date.now();
  const hits = queue.filter(f => shouldPush(state, f, now));
  if (!hits.length) return { pushed: 0, skipped: false };

  const text = `🚨 RelayLens 紧急告警(${hits.length} 条)\n` +
    hits.slice(0, 10).map(f => `· [${f.site}] ${f.msg}\n  → ${f.action}`).join("\n") +
    (hits.length > 10 ? `\n…另有 ${hits.length - 10} 条,见 ops.html` : "");

  const ctrl = new AbortController();
  const timer = setTimeout(() => ctrl.abort(), 10_000);
  try {
    const r = await fetch(url, {
      method: "POST",
      headers: { "Content-Type": "application/json", "X-Push-Token": token },
      body: JSON.stringify({ text }),
      signal: ctrl.signal,
    });
    if (!r.ok) throw new Error(`HTTP ${r.status}`);
    for (const f of hits) state[f.code + "@" + f.site] = new Date(now).toISOString();
    savePushState(state);
    return { pushed: hits.length, skipped: false };
  } catch (e) {
    console.log(`  (企微推送失败,不影响任务:${(e as Error).message})`);
    return { pushed: 0, skipped: false };
  } finally { clearTimeout(timer); }
}
