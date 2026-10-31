/* PF 分模型类别探针测试:
   1) modelCategory 判定(经 tsx 真实 import,不复制正则防漂移)
   2) 推理档批次与主 PF 数据物理隔离(task=perf_reasoning)的结构守卫 */
const { execSync } = require("child_process");
const fs = require("fs");
let pass = 0, fail = 0;
function ok(c, m) { if (c) { pass++; } else { fail++; console.log("FAIL " + m); } }

/* 1) modelCategory:在 probe 目录下用 tsx 执行真实函数 */
const cases = [
  ["gpt-5.5", "normal"], ["gpt-4o-mini", "normal"], ["claude-sonnet-5-5", "normal"],
  ["glm-4.5", "normal"], ["qwen3-235b", "normal"], ["deepseek-chat", "normal"],
  ["gemini-2.5-flash", "normal"], ["doubao-1-5-turbo", "normal"],
  ["deepseek-r1", "reasoning"], ["o3-mini", "reasoning"], ["o1-preview", "reasoning"],
  ["qwq-32b", "reasoning"], ["qwen3-235b-thinking", "reasoning"], ["hunyuan-t1", "reasoning"],
  ["glm-z1", "normal"], // z1 不在词表,按普通档(宁缺毋错:分类只影响采样选择,不影响评分)
];
const probe = `import { modelCategory } from "./src/parsers/models.js";
const cases = ${JSON.stringify(cases)};
let bad = 0;
for (const [m, want] of cases) { const got = modelCategory(m); if (got !== want) { console.log("MISMATCH " + m + " want=" + want + " got=" + got); bad++; } }
console.log(bad ? "BAD:" + bad : "OK"); process.exit(bad ? 1 : 0);`;
fs.writeFileSync(__dirname + "/relaylens/probe/.tmp-cat-test.ts", probe);
try {
  const out = execSync("npx tsx .tmp-cat-test.ts", { cwd: __dirname + "/relaylens/probe", encoding: "utf8", stdio: "pipe" });
  ok(out.includes("OK"), "modelCategory 全部判定正确(" + out.trim().split("\n")[0] + ")");
} catch (e) {
  ok(false, "modelCategory 判定失败: " + (e.stdout || e.message));
} finally {
  try { fs.unlinkSync(__dirname + "/relaylens/probe/.tmp-cat-test.ts"); } catch {}
}

/* 2) 物理隔离守卫:推理档走独立 task,主评分查询不可能读到它 */
const perf = fs.readFileSync(__dirname + "/relaylens/probe/src/probes/perf.ts", "utf8");
ok(perf.includes('"perf_reasoning"'), "persistPerf 对推理档写 task=perf_reasoning");
ok(perf.includes('category: res.category ?? "normal"'), "批次 summary 带类别标签");
ok(/opts: \{[^}]*category\?/.test(perf.replace(/\n/g, " ")), "runPerf 支持 category 参数");

const asm = fs.readFileSync(__dirname + "/relaylens/probe/src/assemble.ts", "utf8");
ok(!asm.includes("perf_reasoning"), "assemble(PF/超时/流式)不读 perf_reasoning");
ok(asm.includes("task='perf'"), "assemble 主查询仍限定 task='perf'(等值匹配,不吃 perf_reasoning)");

const sync = fs.readFileSync(__dirname + "/relaylens/probe/src/sync.ts", "utf8");
ok(sync.includes("task='perf_reasoning'"), "sync 单独读取 perf_reasoning 透出推理档 TTFT");
ok(sync.includes("ttftReasoningMs"), "payload 含 ttftReasoningMs 字段");

const cli = fs.readFileSync(__dirname + "/relaylens/probe/cli.ts", "utf8");
ok(cli.includes("pickReasoningModel"), "cli perf 已接推理档加测");
ok(cli.includes('category: "reasoning"'), "加测调用显式声明 reasoning 类别");

console.log(`pf_category: ${pass} passed, ${fail} failed`);
process.exit(fail ? 1 : 0);
