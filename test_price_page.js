/* price.html 单模型价格页测试:单视图(按站聚合)/口径/入口/链接。 */
const fs = require("fs");
let pass = 0, fail = 0;
function ok(c, m) { if (c) { pass++; } else { fail++; console.log("FAIL " + m); } }

const page = fs.readFileSync(__dirname + "/relaylens-home/price.html", "utf8");
const matrix = fs.readFileSync(__dirname + "/relaylens-home/assets/compare-matrix.js", "utf8");

ok(page.includes("data/sites.json"), "直读 sites.json(静态无后端)");
ok(page.includes("按站聚合") && !page.includes("按渠道"), "只保留按站聚合单视图(按渠道已下线)");
ok(!page.includes("renderChannel") && !page.includes("vBtnChannel"), "按渠道视图代码已清除");
ok(page.includes("特价组(最低倍率组)"), "主表按特价组(最低倍率组)计价");
ok(matrix.includes('price.html?model=') && !matrix.includes("view=channel"), "矩阵跳转不带已下线视图参数");
ok(page.includes("低价档") && page.includes("加价档"), "档位标签规则存在");
ok(page.includes("0.4") && page.includes("1.2"), "档位阈值 0.4/1.2");
ok(page.includes("wolfai ¥2=1$") && page.includes("jiuqingyun ¥1=10$"), "比例口径说明含特殊站");
ok(/siteUrl\(name\)/.test(page) && page.includes("detail.html?site="), "详情链接");
ok(matrix.includes("price.html?model="), "compare 矩阵点模型跳 price 页");
ok(!/chip-demo/.test(page), "无旧文字章残留");
try { new Function(page.slice(page.indexOf("<script>") + 8, page.lastIndexOf("</script>"))); ok(true, "内联脚本语法合法"); }
catch (e) { ok(false, "语法错误: " + e.message); }

console.log("price_page: " + pass + " passed, " + fail + " failed");
process.exit(fail ? 1 : 0);