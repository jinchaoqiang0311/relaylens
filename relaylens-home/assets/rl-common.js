/* rl-common.js —— RelayLens 全站共享工具(演进#3:消灭跨页复制漂移)
 * 提供两件被证明会漂移的东西:
 *   RL.esc          —— 规范 HTML 转义(全 5 类字符 + null 安全;历史上 9 个页面曾有 9 种强弱不一的实现)
 *   RL.payIcons(t)  —— 支付方式关键词 → 品牌 logo 标记(顺序固定;未命中关键词原样保留)
 * 兼容出口:window.esc / window.payIconsHTML,内联脚本零改动可直接用。
 * 加载顺序:必须在本文件之后才能引用(建议置于每页主内联脚本之前)。
 */
var RL = (function () {
  function esc(s) {
    return String(s == null ? "" : s).replace(/[&<>"']/g, function (c) {
      return { "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;" }[c];
    });
  }

  /* 顺序即展示顺序:支付宝 → 银行卡 → 对公 → PayPal → USDT → 微信 */
  var PAY_RULES = [
    ["alipay", "支付宝", /支付宝|alipay/i],
    ["bankcard", "银行卡", /银行|bank/i],
    ["corporate", "对公转账", /对公|公户/i],
    ["paypal", "PayPal", /paypal|贝宝/i],
    ["usdt", "USDT", /usdt|泰达|加密|虚拟币/i],
    ["wechatpay", "微信支付", /微信|wechat/i],
  ];

  /**
   * payIcons(text) → { html, rest, any }
   *   html: 命中关键词的 <img class="pay-icon"> 串(未命中关键词的剩余文本原样保留)
   *   rest: 剩余文本(如「卡密」——无对应 logo 的支付方式按文本诚实展示)
   *   any:  是否有任何支付信息(html 或 rest 非空)
   */
  function payIcons(text) {
    var t = String(text || ""), icons = [], rest = t;
    PAY_RULES.forEach(function (r) {
      if (r[2].test(t)) {
        icons.push('<img class="pay-icon" src="assets/pay/' + r[0] + '.svg" alt="' + r[1] + '" title="' + r[1] + '">');
        rest = rest.replace(r[2], "");
      }
    });
    rest = rest.replace(/[\/,、|]+/g, " ").trim();
    return { html: icons.join("") + (rest ? (icons.length ? " " : "") + esc(rest) : ""), any: icons.length > 0 || !!rest };
  }

  return { esc: esc, payIcons: payIcons, PAY_RULES: PAY_RULES };
})();

/* 挂载:浏览器挂 window;vm 测试沙箱挂其全局(测试提取页面脚本单独运行时同样可用) */
var g = (typeof globalThis !== "undefined") ? globalThis : this;
g.RL = RL;
g.esc = RL.esc;
g.payIconsHTML = function (t) { return RL.payIcons(t).html; };
if (typeof window !== "undefined" && window !== g) {
  window.RL = g.RL;
  window.esc = g.esc;
  window.payIconsHTML = g.payIconsHTML;
}
