#!/usr/bin/env node
/**
 * deploy.mjs —— RelayLens 部署脚本(演进#4:把 DEPLOY.md 的手工步骤自动化)
 *
 * 用法:
 *   node deploy/deploy.mjs --dry-run                     # 预检 + 打印清单与将执行的命令(不落盘不上传)
 *   node deploy/deploy.mjs --to=local:<目录>              # 复制到本地目录(宝塔面板用户:按清单手动上传)
 *   node deploy/deploy.mjs --to=ssh:<user>@<host>:<路径>  # tar 流 over ssh 上传(需本机 ssh 已授权该主机)
 *   可选:--skip-build(跳过构建)/ --port=N(ssh 端口,默认 22)/ --key=<私钥路径>(scp -i)
 *
 * 语义(与 DEPLOY.md 一致):
 *   ① 构建:node build-relay.js(内部已是临时目录 + 换名的原子发布)
 *   ② 上传清单:dist-relay 全部文件,排除 DEPLOY.md / robots-snippet.txt(后者合并进主站根 robots)
 *   ③ 预检拦截:占位域名、内部资产泄漏(ops.html / data/ops.json 不得进包)、必需文件缺失
 *   ④ 校验:local 模式比对文件数与字节数;ssh 模式打印建议的 curl 校验命令
 */
import fs from "node:fs";
import path from "node:path";
import { spawnSync } from "node:child_process";
import { fileURLToPath } from "node:url";

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const DIST = path.join(ROOT, "dist-relay");
const EXCLUDE = new Set(["DEPLOY.md", "robots-snippet.txt"]);
const MUST_HAVE = [
  "index.html", "detail.html", "data/sites.json", "data/audit.json",
  "assets/rl-common.js", "llms.txt", "robots.txt", "sitemap.xml", "robots-snippet.txt", "DEPLOY.md",
];
const INTERNAL_LEAK = ["ops.html", "data/ops.json"];

const args = process.argv.slice(2);
const opt = { to: null, skipBuild: false, dryRun: false, port: 22, key: null };
for (const a of args) {
  if (a.startsWith("--to=")) opt.to = a.slice(5);
  else if (a === "--skip-build") opt.skipBuild = true;
  else if (a === "--dry-run") opt.dryRun = true;
  else if (a.startsWith("--port=")) opt.port = a.slice(7);
  else if (a.startsWith("--key=")) opt.key = a.slice(6);
}

let step = 0;
const say = m => console.log(`[${++step}] ${m}`);

/* ---------- ① 预检(源仓库层面) ---------- */
const cfg = JSON.parse(fs.readFileSync(path.join(ROOT, "site.config.json"), "utf8"));
const problems = [];
if (/YOUR-DOMAIN/.test(cfg.base)) problems.push("site.config.json 的 base 仍是占位域名,部署前请先修改");
if (!cfg.icp) problems.push("site.config.json 缺 icp(备案号),生产部署必须填写");
if (!/aipaihangbang\.cn/.test(cfg.base) && !/--to=local/.test(opt.to || "")) {
  console.log(`  ℹ base = ${cfg.base}(非默认主站,确认是有意的)`);
}
say(`预检 site.config.json:base=${cfg.base}${problems.length ? " · 问题:" + problems.join(";") : " ✓"}`);

/* ---------- ② 构建(默认执行;构建脚本自带原子发布) ---------- */
if (!opt.skipBuild) {
  say("构建 node build-relay.js …");
  const r = spawnSync("node", ["build-relay.js"], { cwd: ROOT, stdio: "inherit", shell: process.platform === "win32" });
  if (r.status !== 0) { console.error(`构建失败(exit ${r.status})——发布终止,dist 未被替换`); process.exit(1); }
} else say("跳过构建(--skip-build)");

/* ---------- ③ 清单与预检(dist 层面) ---------- */
if (!fs.existsSync(DIST)) { console.error("dist-relay/ 不存在,构建失败?"); process.exit(1); }
const walk = (dir, base) => fs.readdirSync(dir, { withFileTypes: true }).flatMap(e => {
  const rel = base ? base + "/" + e.name : e.name;
  return e.isDirectory() ? walk(path.join(dir, e.name), rel) : [{ rel, file: path.join(dir, e.name), size: fs.statSync(path.join(dir, e.name)).size }];
});
const all = walk(DIST, "");
const manifest = all.filter(f => !EXCLUDE.has(f.rel));
say(`清单:${all.length} 个产物,上传 ${manifest.length} 个(排除 ${[...EXCLUDE].join(" / ")})`);

for (const m of MUST_HAVE) {
  /* 必需性查 dist 全集(snippet/DEPLOY 生成但不上传);排除只作用于上传清单 */
  if (!all.some(f => f.rel === m)) problems.push(`dist 缺必需文件:${m}`);
}
for (const leak of INTERNAL_LEAK) {
  if (manifest.some(f => f.rel === leak)) problems.push(`内部资产泄漏进对外包:${leak}(运营数据不得公开)`);
}
const llms = manifest.find(f => f.rel === "llms.txt");
if (!llms || !fs.readFileSync(llms.file, "utf8").includes("RelayLens")) problems.push("llms.txt 缺失或内容异常");
if (problems.length) { console.error("预检未通过:\n  - " + problems.join("\n  - ")); process.exit(1); }
console.log(`  必需文件 ${MUST_HAVE.length}/${MUST_HAVE.length} ✓ · 内部资产泄漏检查 ✓ · 总字节 ${manifest.reduce((s, f) => s + f.size, 0)}`);

/* ---------- ④ 传输 ---------- */
if (!opt.to || opt.dryRun) {
  console.log(`[--dry-run] 将上传 ${manifest.length} 个文件:`);
  manifest.forEach(f => console.log(`  ${f.rel}  (${f.size}B)`));
  if (opt.to && opt.to.startsWith("ssh:")) {
    const [, target] = opt.to.split(":");
    console.log(`将执行:tar -C dist-relay -czf - ${[...EXCLUDE].map(f => "--exclude=" + f).join(" ")} . | ssh -p ${opt.port} ${opt.key ? "-i " + opt.key + " " : ""}${target} "mkdir -p <路径> && tar -xzf - -C <路径>"`);
  }
  console.log("dry-run 结束,未落盘未上传。");
  process.exit(0);
}

if (opt.to.startsWith("local:")) {
  const dest = path.resolve(opt.to.slice(6));
  fs.mkdirSync(dest, { recursive: true });
  let n = 0, bytes = 0;
  for (const f of manifest) {
    const to = path.join(dest, f.rel);
    fs.mkdirSync(path.dirname(to), { recursive: true });
    fs.copyFileSync(f.file, to);
    n++; bytes += f.size;
  }
  console.log(`[${++step}] local 复制完成:${n} 个文件(${bytes} 字节)→ ${dest}`);
  const copied = walk(dest, "");
  const missing = manifest.filter(f => !copied.some(c => c.rel === f.rel && c.size === f.size));
  console.log(missing.length ? `✗ 校验失败:缺失/不一致 ${missing.length} 个` : `✓ 校验通过:目标与清单完全一致(${copied.length} 个文件)`);
  process.exit(missing.length ? 1 : 0);
}

if (opt.to.startsWith("ssh:")) {
  const rest = opt.to.slice(4);
  const at = rest.lastIndexOf(":");
  const target = rest.slice(0, at), remotePath = rest.slice(at + 1);
  const keyArg = opt.key ? `-i ${opt.key} ` : "";
  const excludes = [...EXCLUDE].map(f => "--exclude=" + f).join(" ");
  const cmd = `tar -C dist-relay -czf - ${excludes} . | ssh -p ${opt.port} ${keyArg}${target} "mkdir -p '${remotePath}' && tar -xzf - -C '${remotePath}'"`;
  console.log(`[${++step}] 上传(tar over ssh)…\n  ${cmd}`);
  const r = spawnSync("bash", ["-c", cmd], { stdio: "inherit", shell: process.platform === "win32" });
  if (r.status !== 0) { console.error(`上传失败(exit ${r.status})`); process.exit(1); }
  console.log(`[${++step}] 完成。建议校验(任意可联网环境):
  curl -s ${cfg.base}/llms.txt | head -3
  curl -s -o /dev/null -w "%{http_code}" ${cfg.base}/data/sites.json
  curl -s -o /dev/null -w "%{http_code}" ${cfg.base}/data/details/aixoras.json`);
  process.exit(0);
}

console.error("未知的 --to(支持 local:<目录> / ssh:<user>@<host>:<路径>)"); process.exit(1);
