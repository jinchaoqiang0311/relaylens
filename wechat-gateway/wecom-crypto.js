/**
 * 企业微信回调加解密协议(官方规范),零依赖实现:
 * - 签名: sha1(sort(token, timestamp, nonce, encrypt).join(""))
 * - 密文: AES-256-CBC, key = Base64Decode(EncodingAESKey + "="), IV = key 前 16 字节
 * - 明文结构: 16B随机 + 4B消息长度(大端) + 消息体 + receiveid(corpId)
 */
const crypto = require("node:crypto");

class WecomCrypto {
  constructor(token, encodingAesKey, corpId) {
    this.token = token;
    this.corpId = corpId;
    this.aesKey = Buffer.from(encodingAesKey + "=", "base64");
    if (this.aesKey.length !== 32) {
      throw new Error("EncodingAESKey 非法(应为 43 个字符)");
    }
  }

  signature(...parts) {
    return crypto.createHash("sha1").update(parts.sort().join("")).digest("hex");
  }

  verify(msgSignature, timestamp, nonce, encrypt) {
    return this.signature(this.token, timestamp, nonce, encrypt) === msgSignature;
  }

  decrypt(encryptB64) {
    const decipher = crypto.createDecipheriv("aes-256-cbc", this.aesKey, this.aesKey.subarray(0, 16));
    decipher.setAutoPadding(false);
    const buf = Buffer.concat([
      decipher.update(Buffer.from(encryptB64, "base64")),
      decipher.final(),
    ]);
    const pad = buf[buf.length - 1];
    const payload = buf.subarray(16, buf.length - pad); // 去掉 16B 随机头和 PKCS7 填充
    const len = payload.readUInt32BE(0);
    return {
      message: payload.subarray(4, 4 + len).toString("utf8"),
      corpId: payload.subarray(4 + len).toString("utf8"),
    };
  }

  encrypt(plain) {
    const msg = Buffer.from(plain, "utf8");
    const len = Buffer.alloc(4);
    len.writeUInt32BE(msg.length, 0);
    const raw = Buffer.concat([
      crypto.randomBytes(16),
      len,
      msg,
      Buffer.from(this.corpId, "utf8"),
    ]);
    const pad = 32 - (raw.length % 32); // PKCS7,块长 32
    const padded = Buffer.concat([raw, Buffer.alloc(pad, pad)]);
    const cipher = crypto.createCipheriv("aes-256-cbc", this.aesKey, this.aesKey.subarray(0, 16));
    cipher.setAutoPadding(false);
    return Buffer.concat([cipher.update(padded), cipher.final()]).toString("base64");
  }

  /** 生成被动回复 XML(明文消息自动加密) */
  replyXml(plain, nonce, timestamp) {
    const enc = this.encrypt(plain);
    const sig = this.signature(this.token, timestamp, nonce, enc);
    return `<xml><Encrypt><![CDATA[${enc}]]></Encrypt><MsgSignature><![CDATA[${sig}]]>` +
      `</MsgSignature><TimeStamp>${timestamp}</TimeStamp><Nonce><![CDATA[${nonce}]]></Nonce></xml>`;
  }
}

module.exports = { WecomCrypto };
