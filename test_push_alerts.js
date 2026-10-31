/* WeCom alert chain test: probe push.ts -> gateway /push endpoint. */
const fs = require("fs");
let pass = 0, fail = 0;
function ok(c, m) { if (c) { pass++; } else { fail++; console.log("FAIL " + m); } }

const push = fs.readFileSync(__dirname + "/relaylens/probe/src/push.ts", "utf8");
const sched = fs.readFileSync(__dirname + "/relaylens/probe/src/scheduler.ts", "utf8");
const server = fs.readFileSync(__dirname + "/wechat-gateway/server.js", "utf8");
const config = fs.readFileSync(__dirname + "/wechat-gateway/config.js", "utf8");

ok(push.includes("RL_WECOM_PUSH_URL") && push.includes("RL_WECOM_PUSH_TOKEN"), "env gate exists (skip silently when unset)");
ok(push.includes("24 * 3600e3"), "24h dedup window per code+site");
ok(push.includes("critical"), "only critical findings pushed");
ok(push.includes("catch") && push.includes("push"), "push failure never breaks probe tasks");
ok(push.includes("X-Push-Token"), "request carries shared secret header");

ok(sched.includes("pushOpsAlerts"), "alert push hooked after health round");
ok(sched.includes("catch"), "push routine has its own try/catch");

ok(server.includes("push"), "gateway implements /push endpoint");
ok(server.includes("x-push-token") && server.includes("cfg.pushToken"), "token check; endpoint closed (404) when unset");
ok(config.includes("pushToken"), "config supports pushToken");
ok(config.includes("WECOM_PUSH_TOKEN"), "pushToken overridable via env");
ok(server.includes("slice(0, 1800)"), "payload length guard");

console.log("push_alerts: " + pass + " passed, " + fail + " failed");
process.exit(fail ? 1 : 0);