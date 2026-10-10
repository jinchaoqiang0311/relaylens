/**
 * 网关配置加载器。
 * 真实凭据放 config.json(已被 .gitignore 排除,绝不入库——对应项目铁律 14);
 * 环境变量 WECOM_TOKEN / WECOM_ENCODINGAESKEY / WECOM_CORPID / WECOM_CORPSECRET 可逐项覆盖。
 */
const fs = require("node:fs");
const path = require("node:path");

const GATEWAY_DIR = __dirname;
const REPO_ROOT = path.resolve(GATEWAY_DIR, "..");
const CONFIG_FILE = path.join(GATEWAY_DIR, "config.json");

function loadConfig() {
  let fileCfg = {};
  if (fs.existsSync(CONFIG_FILE)) {
    try {
      fileCfg = JSON.parse(fs.readFileSync(CONFIG_FILE, "utf8"));
    } catch (e) {
      throw new Error(`config.json 解析失败: ${e.message}`);
    }
  }
  const env = process.env;
  const cfg = {
    port: 8787,
    /** 企业微信后台「接收消息」页配置的 Token / EncodingAESKey(43位) */
    token: "",
    encodingAesKey: "",
    /** 我的企业 -> 企业信息 -> 企业ID */
    corpId: "",
    /** 自建应用的 AgentId 与 Secret(Secret 只用于主动推送,可留空降级为纯被动) */
    agentId: 0,
    corpSecret: "",
    /** 允许使用指令的企业微信成员 userid 白名单;为空数组时拒绝所有指令 */
    allowedUsers: [],
    /** status/site/meta 指令只读此文件,不触发任何采集 */
    sitesJson: path.join(REPO_ROOT, "relaylens-home", "data", "sites.json"),
    /** 本地探针 CLI(task 指令入口);cwd 指向 probe 目录 */
    probe: {
      cwd: path.join(REPO_ROOT, "relaylens", "probe"),
      cmd: "npx tsx cli.ts",
      timeoutMin: 30,
    },
    /**
     * CodeBuddy CLI headless(cb 指令)。默认关闭;
     * 启用前请按官方 CLI 文档核实非交互参数(docs: https://www.codebuddy.ai/docs/zh/cli)。
     */
    codebuddy: { enabled: false, cmd: "codebuddy", args: ["-p"], timeoutMin: 10 },
    ...fileCfg,
  };
  // 环境变量最终覆盖(优先级最高)
  const envMap = {
    WECOM_TOKEN: "token",
    WECOM_ENCODINGAESKEY: "encodingAesKey",
    WECOM_CORPID: "corpId",
    WECOM_CORPSECRET: "corpSecret",
    WECOM_AGENTID: "agentId",
  };
  for (const [k, v] of Object.entries(envMap)) {
    if (env[k]) cfg[v] = v === "agentId" ? Number(env[k]) : env[k];
  }
  return cfg;
}

module.exports = { loadConfig, GATEWAY_DIR };
