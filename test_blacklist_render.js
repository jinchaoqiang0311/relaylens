/* 举报表单渲染测试:blacklist.html 的 GitHub Issue 通道
   覆盖:表单结构、入口接线、URL 编码、旧占位清除、内联脚本语法守卫 */
const fs = require("fs");
const html = fs.readFileSync(__dirname + "/relaylens-home/blacklist.html", "utf8");
let pass = 0, fail = 0;
function ok(c, m) { if (c) { pass++; } else { fail++; console.log("FAIL " + m); } }

/* 1) 表单结构 */
ok(html.includes('id="reportMask"'), "举报弹窗容器存在");
ok(html.includes('id="rfSite"') && html.includes('id="rfType"') && html.includes('id="rfDesc"'), "核心字段(站点/类型/描述)存在");
ok(html.includes('id="rfErr" hidden'), "错误提示区默认隐藏");
ok(html.includes('aria-modal="true"'), "弹窗带 aria-modal 可访问性标注");

/* 2) Issue 通道与安全编码 */
ok(html.includes('RL_ISSUE_URL="https://github.com/jinchaoqiang0311/relaylens/issues/new"'), "Issue 通道指向本仓库");
ok(html.includes("encodeURIComponent(title)") && html.includes("encodeURIComponent(L.join(\"\\n\"))"), "title/body 均经 URL 编码(防注入与乱码)");
ok(html.includes("请勿在内容中包含 API Key"), "敏感信息警示文案存在");

/* 3) 入口接线 */
ok(!html.includes("举报表单即将上线"), "旧占位 toast 已全部移除");
const calls = (html.match(/openReport\(/g) || []).length;
ok(calls >= 4, "openReport 接线 ≥4 处(定义+主入口+补充举报+申诉入口), 实际 " + calls);
ok(html.includes("\\'站方申诉\\'"), "站方申诉入口预设类型");
ok(!html.includes('<a href="#">联系方式</a>'), "页脚联系方式不再是空链接");

/* 4) 校验逻辑 */
ok(html.includes("desc.length<20"), "描述最短 20 字的校验存在");
ok(html.includes("if(!site){rfErr"), "站点名必填校验存在");

/* 5) 内联脚本语法守卫(编译不执行) */
const scripts = [...html.matchAll(/<script>([\s\S]*?)<\/script>/g)].map(m => m[1]).join("\n");
try { new Function(scripts); ok(true, "内联脚本语法合法"); }
catch (e) { ok(false, "内联脚本语法错误: " + e.message); }

/* 6) HTML 结构守卫:引号配平(一个漏引号曾让全站表格错位) */
const btnAttrs = [...html.matchAll(/onclick="([^"]*)"/g)].map(m => m[1]);
ok(btnAttrs.every(a => (a.split("'").length - 1) % 2 === 0), "onclick 属性内单引号配平");

console.log(`blacklist 举报表单: ${pass} passed, ${fail} failed`);
process.exit(fail ? 1 : 0);
