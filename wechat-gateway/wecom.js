/**
 * 企业微信服务端 API 客户端:access_token 缓存 + 自建应用消息主动推送。
 * Secret 不打日志、不回显(铁律 14)。
 */
const https = require("node:https");

function request(method, pathname, body) {
  return new Promise((resolve, reject) => {
    const data = body ? JSON.stringify(body) : null;
    const req = https.request(
      {
        hostname: "qyapi.weixin.qq.com",
        path: pathname,
        method,
        headers: data
          ? { "Content-Type": "application/json", "Content-Length": Buffer.byteLength(data) }
          : {},
        timeout: 15000,
      },
      (res) => {
        let out = "";
        res.on("data", (c) => (out += c));
        res.on("end", () => {
          try {
            resolve(JSON.parse(out));
          } catch {
            reject(new Error(`企微 API 响应非 JSON: ${out.slice(0, 200)}`));
          }
        });
      }
    );
    req.on("error", reject);
    req.on("timeout", () => req.destroy(new Error("企微 API 请求超时")));
    if (data) req.write(data);
    req.end();
  });
}

class Wecom {
  constructor(cfg) {
    this.agentId = cfg.agentId;
    this.corpId = cfg.corpId;
    this.corpSecret = cfg.corpSecret;
    this._token = null;
    this._expireAt = 0;
  }

  get pushEnabled() {
    return Boolean(this.corpSecret && this.agentId);
  }

  async token() {
    if (this._token && Date.now() < this._expireAt) return this._token;
    const r = await request(
      "GET",
      `/cgi-bin/gettoken?corpid=${encodeURIComponent(this.corpId)}&corpsecret=${encodeURIComponent(this.corpSecret)}`
    );
    if (r.errcode !== 0) throw new Error(`获取 access_token 失败: errcode=${r.errcode} errmsg=${r.errmsg}`);
    this._token = r.access_token;
    this._expireAt = Date.now() + (r.expires_in - 120) * 1000;
    return this._token;
  }

  /** 推送文本消息给指定成员;超长自动截断(微信单条上限 2048 字节) */
  async sendText(userId, text) {
    if (!this.pushEnabled) throw new Error("未配置 corpSecret/agentId,无法主动推送");
    const t = await this.token();
    const r = await request("POST", `/cgi-bin/message/send?access_token=${t}`, {
      touser: userId,
      msgtype: "text",
      agentid: this.agentId,
      text: { content: String(text).slice(0, 1800) },
    });
    if (r.errcode !== 0) throw new Error(`推送失败: errcode=${r.errcode} errmsg=${r.errmsg}`);
    return r;
  }
}

module.exports = { Wecom };
