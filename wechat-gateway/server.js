/**
 * 微信(企业微信自建应用)指令网关入口。
 *
 * 使用步骤:
 * 1. 复制 config.example.json 为 config.json,填入企业微信凭据与 allowedUsers(绝不入库);
 * 2. 内网穿透/云服务器获得公网 URL,填到企业微信后台「接收消息」回调,URL 为 /wecom/callback;
 * 3. 启动: node server.js  (常驻: pm2 start server.js --name wechat-gateway);
 * 4. 回调验证 GET 由本服务自动完成(自动解密 echostr 返回)。
 */
const http = require("node:http");
const { loadConfig } = require("./config");
const { WecomCrypto } = require("./wecom-crypto");
const { Wecom } = require("./wecom");
const { Executor } = require("./executor");

const cfg = loadConfig();
if (!cfg.token || !cfg.encodingAesKey || !cfg.corpId) {
  console.error("[wechat-gateway] 缺少企业微信配置: 请准备 config.json(见 config.example.json)或设置 WECOM_* 环境变量");
  process.exit(1);
}

let aesCrypto;
try {
  aesCrypto = new WecomCrypto(cfg.token, cfg.encodingAesKey, cfg.corpId);
} catch (e) {
  console.error("[wechat-gateway] " + e.message);
  process.exit(1);
}

const wecom = new Wecom(cfg);
const executor = new Executor(cfg);
const log = (msg) => console.log(`[${new Date().toISOString()}] ${msg}`);

log(`网关启动: port=${cfg.port} 推送=${wecom.pushEnabled ? "开" : "关(未配置 Secret)"} 白名单=${cfg.allowedUsers.length} 人`);

const XML = {
  encrypt: /<Encrypt>\s*<!\[CDATA\[([\s\S]*?)\]\]>\s*<\/Encrypt>|<Encrypt>([\s\S]*?)<\/Encrypt>/,
  from: /<FromUserName>\s*<!\[CDATA\[([\s\S]*?)\]\]>\s*<\/FromUserName>|<FromUserName>([\s\S]*?)<\/FromUserName>/,
  type: /<MsgType>\s*<!\[CDATA\[([\s\S]*?)\]\]>\s*<\/MsgType>|<MsgType>([\s\S]*?)<\/MsgType>/,
  content: /<Content>\s*<!\[CDATA\[([\s\S]*?)\]\]>\s*<\/Content>|<Content>([\s\S]*?)<\/Content>/,
};
const pick = (xml, re) => {
  const m = re.exec(xml);
  return m ? (m[1] ?? m[2] ?? "").trim() : "";
};

const server = http.createServer((req, res) => {
  const u = new URL(req.url, "http://localhost");
  if (u.pathname === "/healthz") {
    res.end("ok");
    return;
  }
  if (u.pathname !== "/wecom/callback") {
    res.statusCode = 404;
    res.end();
    return;
  }
  const q = u.searchParams;
  const timestamp = q.get("timestamp") || "";
  const nonce = q.get("nonce") || "";
  const msgSignature = q.get("msg_signature") || "";

  if (req.method === "GET") {
    // 企业微信后台「接收消息」URL 验证:验签 -> 解密 echostr -> 原样返回明文
    const echostr = q.get("echostr") || "";
    if (!aesCrypto.verify(msgSignature, timestamp, nonce, echostr)) {
      res.statusCode = 403;
      res.end("bad signature");
      return;
    }
    try {
      res.end(aesCrypto.decrypt(echostr).message);
    } catch (e) {
      res.statusCode = 500;
      res.end("decrypt fail");
    }
    return;
  }

  // POST: 收消息
  let body = "";
  req.on("data", (c) => (body += c));
  req.on("end", async () => {
    try {
      const encrypt = pick(body, XML.encrypt);
      if (!encrypt || !aesCrypto.verify(msgSignature, timestamp, nonce, encrypt)) {
        res.statusCode = 403;
        res.end();
        return;
      }
      const { message, corpId } = aesCrypto.decrypt(encrypt);
      if (corpId !== cfg.corpId) {
        log(`corpId 不匹配: ${corpId.slice(0, 6)}***`);
        res.statusCode = 403;
        res.end();
        return;
      }
      const from = pick(message, XML.from);
      const type = pick(message, XML.type);
      // 5 秒内必须应答:先空应答(企微规范允许),结果全部走主动推送
      res.end("");

      if (!from) return;
      if (type !== "text") {
        await notify(from, "请直接发文本指令,回复「帮助」查看列表");
        return;
      }
      if (!Array.isArray(cfg.allowedUsers) || !cfg.allowedUsers.includes(from)) {
        log(`拒绝未授权用户: ${from.slice(0, 4)}***`);
        await notify(from, "未授权用户,如需开通请联系管理员把你的 userid 加入 allowedUsers");
        return;
      }
      const content = pick(message, XML.content);
      log(`指令(from=${from.slice(0, 4)}***): ${content.slice(0, 40)}`);
      const reply = await executor.handle(from, content, (t) => notify(from, t));
      if (reply) await notify(from, reply);
    } catch (e) {
      log(`处理失败: ${e.message}`);
      try {
        res.end("");
      } catch {
        /* 连接可能已断开 */
      }
    }
  });
});

async function notify(userId, text) {
  if (!wecom.pushEnabled) {
    log(`(未配置 Secret,无法推送) ${String(text).slice(0, 60)}`);
    return;
  }
  try {
    await wecom.sendText(userId, text);
  } catch (e) {
    log(`推送失败: ${e.message}`);
  }
}

server.listen(cfg.port, () => log(`监听中: http://localhost:${cfg.port}/wecom/callback`));
