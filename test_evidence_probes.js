/**
 * test_evidence_probes.js —— 两项「确定性证据」探针的守门测试(2026-10-23)
 *   A 长上下文标记码:判读纯函数(complete / tail_truncated / compressed / inconclusive)+ 多档汇总
 *   B TLS 证书:结论分级的措辞 + SAN 匹配(含通配)+ **任何分支都不许出现扣分语义**
 *   C 下发链路:detail.html 有两行证据位、sites.json 带 tlsVerdict / contextVerdict 字段
 * 为什么要单测判读:这两项都不进评分,一旦判读写错(把"模型没照做"当成"站方截断"),
 * 就是对站方的误杀 —— 误杀优质服务商是项目红线。
 */
const { execSync } = require("child_process");
const fs = require("fs");
const path = require("path");

let pass = 0, fail = 0;
function ok(c, m) { if (c) { pass++; } else { fail++; console.log("FAIL " + m); } }

// ---------- A/B 纯函数(通过 tsx 直接 import 探针模块) ----------
const probe = `
import { judgeContextCase, judgeContext, buildCanaryDoc, parseReturnedIds, canaryId, canaryPrefix } from "./src/probes/context.js";
import { judgeTls, sanCovers } from "./src/probes/health.js";

let bad = 0;
const t = (cond: any, msg: string) => { if (!cond) { console.log("MISMATCH " + msg); bad++; } };

const BID = "RL-RC-20261023-900";
const { ids } = buildCanaryDoc(4000, BID);
const full = ids.join("\\n");
const head7 = ids.slice(0, 7).join("\\n");
const gap = ids.filter((_, i) => i !== 3).join("\\n");   // 缺第 4 个(中间缺失)

// A1 全部命中 = complete
let c = judgeContextCase(ids, full, BID, { targetChars: 4000, reportedPromptTokens: 1200 });
t(c.verdict === "complete" && c.hitPct === 100 && c.missing.length === 0, "A1 full hit → complete " + JSON.stringify(c));

// A2 末尾连续缺失 = tail_truncated
c = judgeContextCase(ids, head7, BID, { targetChars: 4000, reportedPromptTokens: 900 });
t(c.verdict === "tail_truncated" && c.missing.join(",") === "8,9", "A2 tail suffix missing → tail_truncated " + JSON.stringify(c.missing));

// A3 中间缺失 = compressed
c = judgeContextCase(ids, gap, BID, { targetChars: 4000, reportedPromptTokens: 1200 });
t(c.verdict === "compressed" && c.missing.join(",") === "4", "A3 middle gap → compressed " + JSON.stringify(c.missing));

// A4 一个都没回 / 请求报错 = inconclusive(不许当成截断证据)
c = judgeContextCase(ids, "抱歉,我只能看到部分内容。", BID, { targetChars: 4000, reportedPromptTokens: 10 });
t(c.verdict === "inconclusive", "A4 no ids → inconclusive " + c.verdict);
c = judgeContextCase(ids, "", BID, { targetChars: 4000, reportedPromptTokens: null, error: "TIMEOUT" });
t(c.verdict === "inconclusive", "A5 request error → inconclusive " + c.verdict);

// A6 只认本批次前缀:别的批次编号不能被算作命中
const other = canaryId("RL-RC-20260101-001", 1) + "\\n" + canaryId("RL-RC-20260101-001", 2);
t(parseReturnedIds(other, BID).length === 0, "A6 foreign batch ids ignored");
t(parseReturnedIds(full, BID).length === 9, "A7 own ids parsed");

// A8 多档汇总:一档完整 + 一档尾部截断 → 取最差;maxVerifiedChars 只认完整档
const c8000 = judgeContextCase(ids, full, BID, { targetChars: 8000, reportedPromptTokens: 2000 });
const c32000 = judgeContextCase(ids, head7, BID, { targetChars: 32000, reportedPromptTokens: 9000 });
const agg = judgeContext([c8000, c32000]);
t(agg.verdict === "tail_truncated" && agg.maxVerifiedChars === 8000, "A8 aggregate worst + maxVerifiedChars " + JSON.stringify(agg));

// A9 全部 inconclusive → verdict inconclusive 且 maxVerifiedChars 为 null(未测就是未测)
const agg2 = judgeContext([judgeContextCase(ids, "", BID, { targetChars: 8000, reportedPromptTokens: null, error: "X" })]);
t(agg2.verdict === "inconclusive" && agg2.maxVerifiedChars === null, "A9 all inconclusive → null " + JSON.stringify(agg2));

// A10 文档真的埋了 9 个标记码,且首/尾位置各有
const doc = buildCanaryDoc(4000, BID).text;
t(ids.every(id => doc.includes(id)), "A10 all canaries embedded");
t(doc.indexOf(ids[0]) < doc.length * 0.05 && doc.indexOf(ids[8]) > doc.length * 0.9, "A11 first/last canary at edges");

// ---------- B TLS ----------
const base = { host: "x.example", port: 443, checkedAt: "2026-10-23T00:00:00Z", handshakeOk: true, chainValid: true,
  errorCode: null, sanMatch: true, subject: "x.example", issuer: "R3 / Let's Encrypt",
  notAfter: "2026-12-24T00:00:00Z", daysLeft: 62, protocol: "TLSv1.3" } as any;
t(judgeTls(undefined).level === "none", "B1 missing → none");
t(judgeTls({ skipped: true, reason: "非 https" } as any).level === "info", "B2 skipped → info");
t(judgeTls({ ...base, handshakeOk: false, errorCode: "ECONNRESET" } as any).level === "warn", "B3 handshake fail → warn");
t(judgeTls({ ...base, chainValid: false, errorCode: "DEPTH_ZERO_SELF_SIGNED_CERT" } as any).level === "warn", "B4 self-signed → warn");
t(judgeTls({ ...base, sanMatch: false } as any).level === "warn", "B5 san mismatch → warn");
t(judgeTls({ ...base, daysLeft: 10 } as any).level === "warn", "B6 expiring soon → warn");
t(judgeTls(base).level === "ok" && judgeTls(base).label.includes("62"), "B7 healthy → ok with days left");

// B8 铁律:证书结论的**任何**分支都不许带扣分/评分语义
const allLabels = [judgeTls(undefined), judgeTls({ skipped: true, reason: "非 https" } as any),
  judgeTls({ ...base, handshakeOk: false, errorCode: "X" } as any), judgeTls({ ...base, chainValid: false } as any),
  judgeTls({ ...base, sanMatch: false } as any), judgeTls({ ...base, daysLeft: 3 } as any), judgeTls(base)]
  .map(v => v.label).join(" | ");
t(!/扣分|得分|评分|减分/.test(allLabels), "B8 no scoring semantics in TLS labels: " + allLabels);

// B9 SAN 匹配:精确 / 单层通配 / 不匹配 / 空
t(sanCovers("DNS:a.com, DNS:b.com", "a.com") === true, "B9 exact san");
t(sanCovers("DNS:*.a.com", "api.a.com") === true, "B10 wildcard san");
t(sanCovers("DNS:*.a.com", "x.y.a.com") === false, "B11 wildcard is single-level");
t(sanCovers("DNS:a.com", "b.com") === false, "B12 san mismatch");
t(sanCovers(undefined, "a.com") === null, "B13 no san → null");

console.log(bad ? "BAD:" + bad : "OK");
process.exit(bad ? 1 : 0);
`;
const tmp = path.join(__dirname, "relaylens/probe/.tmp-evidence-test.ts");
fs.writeFileSync(tmp, probe);
try {
  const out = execSync("npx tsx .tmp-evidence-test.ts", { cwd: path.join(__dirname, "relaylens/probe"), encoding: "utf8", stdio: "pipe" });
  ok(out.includes("OK"), "纯函数判读全通过" + (out.includes("OK") ? "" : " · " + out.trim()));
} catch (e) {
  ok(false, "判读测试执行失败: " + ((e.stdout || "") + (e.stderr || e.message)).slice(0, 400));
} finally {
  try { fs.unlinkSync(tmp); } catch { }
}

// ---------- C 下发链路 ----------
const detail = fs.readFileSync(path.join(__dirname, "relaylens-home/detail.html"), "utf8");
ok(/id="tlsInfo"/.test(detail) && /id="ctxInfo"/.test(detail), "detail 有两行证据位(tlsInfo / ctxInfo)");
ok(/paint\("tlsInfo"[\s\S]{0,200}paint\("ctxInfo"/.test(detail), "detail 由后端 verdict 渲染措辞(不自己判)");
ok(/未采集/.test(detail) && /长上下文完整性/.test(detail), "detail 静态默认是「未采集/未测」而不是「通过」");
ok(!/id="tlsInfo"[^>]*>通过/.test(detail), "detail 不预填「通过」");

const sites = JSON.parse(fs.readFileSync(path.join(__dirname, "relaylens-home/data/sites.json"), "utf8"));
const real = sites.realSites || [];
ok(real.length > 0 && real.every(r => "tlsVerdict" in r), "sites.json 每个实测站都有 tlsVerdict 字段");
ok(real.every(r => "contextVerdict" in r), "sites.json 每个实测站都有 contextVerdict 字段");
ok(real.every(r => !r.tlsVerdict || !/扣分|得分|评分/.test(r.tlsVerdict.label)), "下发的证书措辞不含评分语义");
ok(!!(sites.meta && sites.meta.scenes && sites.meta.metricLabels), "sites.json meta 带场景权重与指标名(tabNote 同源渲染用)");

console.log(`evidence_probes: ${pass} passed, ${fail} failed`);
process.exit(fail ? 1 : 0);
