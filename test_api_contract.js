/* API contract test: promises on api.html must match api-worker implementation. */
const fs = require("fs");
let pass = 0, fail = 0;
function ok(c, m) { if (c) { pass++; } else { fail++; console.log("FAIL " + m); } }

const api = fs.readFileSync(__dirname + "/relaylens-home/api.html", "utf8");
const worker = fs.readFileSync(__dirname + "/api-worker/src/worker.js", "utf8");
const schema = fs.readFileSync(__dirname + "/api-worker/schema.sql", "utf8");
const readme = fs.readFileSync(__dirname + "/api-worker/README.md", "utf8");

const promised = ["v1/ranking", "v1/prices", "v1/blacklist", "v1/meta", "v1/batches", "v1/receipts/", "v1/webhooks"];
for (const ep of promised) ok(worker.includes(ep), "worker implements: " + ep);
ok(worker.includes("/register"), "worker implements: POST /register");

/* 账号/评论/认领/收录(2026-10-11 决策:邮箱验证码+GitHub OAuth;先审后发;自由五星) */
for (const ep of ["auth/email/start", "auth/email/verify", "auth/github/start", "auth/github/callback", "auth/me",
  "/reviews", "v1/reviews/", "claim/apply", "claim/verify", "submit/onboarding", "submit/claim", "submit/status", "admin/queue", "decision"]) {
  ok(worker.includes(ep), "worker implements: " + ep);
}
ok(worker.includes("RESEND_API_KEY"), "邮件验证码依赖 Resend(未配置=503 如实提示,不假装发送)");
ok(worker.includes("status='pending'") && worker.includes("先审后发"), "评论先审后发");
ok(worker.includes("stars < 1 || stars > 5") || worker.includes("stars_1_to_5"), "自由五星 1-5 校验");
ok(worker.includes("UNIQUE(site,user_id)") || schema.includes("UNIQUE(site, user_id)"), "一人一站一评");
ok(worker.includes("token_mismatch") && worker.includes("relaylens-claim.txt"), "认领走域名 token 文件验证");
ok(worker.includes("X-Admin-Token") && worker.includes("ADMIN_TOKEN"), "管理端点强制 admin token");
ok(schema.includes("CREATE TABLE IF NOT EXISTS users"), "D1 表: users");
ok(schema.includes("CREATE TABLE IF NOT EXISTS sessions"), "D1 表: sessions");
ok(schema.includes("CREATE TABLE IF NOT EXISTS reviews"), "D1 表: reviews");
ok(schema.includes("CREATE TABLE IF NOT EXISTS submissions"), "D1 表: submissions");
ok(schema.includes("CREATE TABLE IF NOT EXISTS claims"), "D1 表: claims");
ok(fs.existsSync(__dirname + "/api-worker/admin.cjs"), "管理员 CLI 存在");
ok(fs.existsSync(__dirname + "/relaylens-home/assets/auth.js"), "共享登录组件存在");
ok(fs.existsSync(__dirname + "/relaylens-home/auth.html"), "OAuth 回跳落地页存在");
ok(fs.readFileSync(__dirname + "/build-relay.js", "utf8").includes('"auth.html"'), "auth.html 已列入 noindex");

ok(worker.includes("rateLimited(env, \"free:\" + ip, 60)"), "free rate 60/min/IP consistent");
ok(worker.includes("600)"), "pro rate 600/min/key");
ok(worker.includes("7 * 86400e3"), "7-day pro trial matches page promise");
ok(worker.includes("CC BY 4.0"), "license field present");
ok(schema.includes("hash TEXT PRIMARY KEY"), "keys stored hashed only");

ok(api.includes("var RL_API_BASE="), "RL_API_BASE constant exists");
ok(api.includes("注册服务尚未上线"), "honest placeholder message when not deployed");

for (const t of ["batches", "rounds", "keys", "usage", "webhooks", "meta"]) ok(schema.includes("CREATE TABLE IF NOT EXISTS " + t), "D1 table: " + t);

const exporter = fs.readFileSync(__dirname + "/relaylens/probe/scripts/export-api-data.cjs", "utf8");
ok(exporter.includes("readOnly: true"), "exporter opens sqlite read-only");

ok(readme.includes("wrangler d1 create") && readme.includes("wrangler deploy") && readme.includes("export-api-data.cjs"), "README deploy steps complete");

console.log("api_contract: " + pass + " passed, " + fail + " failed");
process.exit(fail ? 1 : 0);