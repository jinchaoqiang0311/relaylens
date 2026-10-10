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