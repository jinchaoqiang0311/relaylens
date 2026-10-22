/* 比价矩阵(2026-10-21 改版):不再铺「模型 × 站点」的站点列,改为每模型一行、只展示该模型的
 * 最低价站点,并摊开三因子(官方价 × 倍率 × 充值比例)与实测可用率。
 * 数据:sites.json compare.tabs(每模型×每站多渠道价)+ realSites(充值比例 commerce.ratioNum / 可用率 avail)。
 * 口径:金额一律为人民币到手价 ¥/M = 额度价 × 站方声明充值比例;站方价格页直接公示人民币单价的站
 * (heyroute,src=CNY)以页面价为准、不乘比例。官方价按 meta.fx 汇率换算成人民币仅作对照,不改判定价。
 * 诚实边界:站方未公布缓存写价的,列里写「—」,不按读价推算。 */
(function () {
  var MODELS = [], SITES = [], BY_SITE = {}, FX = 7.1, q = "", sortDir = 1;

  function esc(s) { return String(s == null ? "" : s).replace(/[\u{1F000}-\u{1FAFF}\u{2600}-\u{27BF}\u{2B00}-\u{2BFF}\u{2300}-\u{23FF}\u{FE00}-\u{FE0F}]\uFE0F?[ \t]?/gu, "").replace(/&/g, "&amp;").replace(/</g, "&lt;").replace(/>/g, "&gt;"); }
  function natSort(a, b) { return String(b).localeCompare(String(a), undefined, { numeric: true }); }
  /* 金额格式:越小保留越多位,避免 0.0015 被压成 0.00 */
  function money(v) {
    if (v == null) return "—";
    if (v === 0) return "0";
    if (v < 0.01) return String(Math.round(v * 1e4) / 1e4);
    if (v < 1) return String(Math.round(v * 1e3) / 1e3);
    return String(Math.round(v * 100) / 100);
  }
  function rowCur(r) { return (r && r.src === "CNY") ? "CNY" : "USD"; }

  /** 到手价:优先用服务端算好的 eff*;缺失时按源货币现场折算,折不出来就返回 null(显示「比例未声明」),绝不猜 1:1 */
  function hand(r, effVal, quota) {
    if (effVal != null) return Math.round(effVal * 1e4) / 1e4;
    if (quota == null) return null;
    if (rowCur(r) === "CNY") return Math.round(quota * 1e4) / 1e4;
    if (r.ratio != null) return Math.round(quota * r.ratio * 1e4) / 1e4;
    return null;
  }
  /** 充值比例文案:CNY 公示价站不适用比例,如实说明 */
  function ratioText(r, site) {
    if (rowCur(r) === "CNY") return "人民币公示价";
    var c = site && site.commerce;
    var n = c && c.ratioNum != null ? c.ratioNum : r.ratio;
    if (n == null) return "未声明";
    var t = Math.round(n * 1000) / 1000;
    return "¥" + t + "/$ (" + t + "¥=1$)";
  }

  window.renderMatrix = function (payload) {
    var c = payload && payload.compare;
    if (!c || !c.tabs || !c.tabs.length) return;
    MODELS = c.tabs;
    SITES = (payload && payload.realSites) || [];
    BY_SITE = {};
    SITES.forEach(function (s) { BY_SITE[s.name] = s; });
    FX = (payload && payload.meta && payload.meta.fx && payload.meta.fx.usdCny) || 7.1;
    render();
  };

  function filteredModels() {
    return MODELS.filter(function (m) {
      return !q || (m.name + " " + m.key + " " + (m.family || "")).toLowerCase().indexOf(q) > -1;
    });
  }

  /** 每个模型挑出到手价最低的一家;全部折不出人民币价时退回额度价最低者并标记「比例未声明」 */
  function buildRow(m) {
    var best = null;
    m.rows.forEach(function (r) {
      var v = hand(r, r.effIn, r.inP);
      if (v == null) return;
      if (!best || v < best.v) best = { r: r, v: v };
    });
    if (!best) {
      m.rows.forEach(function (r) {
        if (r.inP == null) return;
        if (!best || r.inP < best.v) best = { r: r, v: r.inP };
      });
      if (best) best.undeclared = true;
    }
    return best ? { m: m, r: best.r, v: best.v, undeclared: !!best.undeclared } : null;
  }

  function pctCell(priceCny, offCny, offCur) {
    if (priceCny == null || !offCny) return '<span class="pm-dash">—</span>';
    var pct = Math.round((priceCny / offCny) * 1000) / 10;
    var cls = pct <= 50 ? "pm-pct ok" : pct <= 100 ? "pm-pct" : "pm-pct warn";
    var tip = "到手 ¥" + money(priceCny) + "/M ÷ 官方 ¥" + money(offCny) + "/M = " + pct + "%" +
      (offCur === "CNY" ? "(官方价=千问AI平台人民币标价,不换算汇率)" : "(官方价按 ¥" + FX + "/$ 换算,仅作对照)");
    return '<span class="' + cls + '" title="' + esc(tip) + '">' + pct + "%</span>";
  }

  function availCell(site) {
    if (!site || site.avail == null) return '<span class="pm-dash">—</span>';
    var v = site.avail, cls = v >= 99 ? "pm-avail ok" : v >= 95 ? "pm-avail" : "pm-avail warn";
    return '<span class="' + cls + '" title="7 日可用率(我们实测 ' + (site.checks || 0) + ' 次探测)">' + v + "%</span>";
  }

  function render() {
    var table = document.getElementById("mxTable");
    if (!table) return;
    var models = filteredModels();
    var rows = models.map(buildRow).filter(function (x) { return x; });

    var cnt = document.getElementById("mxCount");
    if (cnt) cnt.textContent = rows.length + " 个模型有报价" + (q ? "(已筛选)" : "");

    /* 按模型族分组:族顺序按 payload 出现顺序,族内按输入价排序 */
    var fams = [], byFam = {};
    rows.forEach(function (x) {
      var f = x.m.family || "其他";
      if (!byFam[f]) { byFam[f] = []; fams.push(f); }
      byFam[f].push(x);
    });
    fams.forEach(function (f) {
      byFam[f].sort(function (a, b) { return (a.v - b.v) * sortDir || natSort(a.m.name, b.m.name); });
    });

    var arrow = sortDir === 1 ? " ▲" : " ▼";
    var h = '<thead><tr>' +
      '<th class="pm-l" rowspan="2">模型</th>' +
      '<th class="pm-l" rowspan="2">最低价站点</th>' +
      '<th class="pm-l" rowspan="2">充值比例</th>' +
      '<th class="pm-l" rowspan="2">分组</th>' +
      '<th rowspan="2">倍率</th>' +
      '<th colspan="2" class="pm-grp">Token 价格(¥/M)</th>' +
      '<th colspan="2" class="pm-grp">缓存价格(¥/M)</th>' +
      '<th colspan="2" class="pm-grp">官方价格(¥/M)</th>' +
      '<th rowspan="2">对比官方价</th>' +
      '<th rowspan="2">可用率</th>' +
      '</tr><tr>' +
      '<th class="pm-sort" data-sort="in" title="点一下切换升/降序">输入' + arrow + '</th>' +
      '<th>输出</th><th>读取</th><th>写入</th>' +
      '<th>输入</th><th>输出</th>' +
      '</tr></thead><tbody>';

    if (!rows.length) {
      h += '<tr><td colspan="13" style="padding:22px;color:var(--faint)">没有匹配的模型</td></tr>';
    }

    fams.forEach(function (f) {
      h += '<tr class="pm-fam"><td colspan="13">' + esc(f) + "</td></tr>";
      byFam[f].forEach(function (x) {
        var m = x.m, r = x.r, site = BY_SITE[r.site] || {};
        var offCur = (m.officialCur || "USD");
        var offIn = (m.official && m.official.in != null) ? (offCur === "CNY" ? m.official.in : Math.round(m.official.in * FX * 100) / 100) : null;
        var offOut = (m.official && m.official.out != null) ? (offCur === "CNY" ? m.official.out : Math.round(m.official.out * FX * 100) / 100) : null;
        var out = hand(r, r.effOut, r.outP);
        var cr = hand(r, r.effCr, r.cacheP);

        var priceCell = x.undeclared
          ? '<span class="pm-undec" title="该站未声明充值比例,只能给额度价 ' + esc(r.inP) + '/M,不折算人民币到手价">' + money(r.inP) + " 额度</span>"
          : '<b class="pm-in">' + money(x.v) + "</b>";

        var tip =
          "到手价 = 额度价 " + money(r.inP) + " × 充值比例 " + (r.ratio != null ? r.ratio : "—") +
          (rowCur(r) === "CNY" ? "(站方人民币公示价,不乘比例)" : "") +
          " · 分组「" + esc(r.group || "—") + "」倍率 ×" + (r.grpRatio != null ? r.grpRatio : "—") +
          (r.special ? "\n另有特价组「" + esc(r.special.group) + "」" : "") +
          (site.checks ? "\n该站实测 " + site.checks + " 次探测" : "");

        h += '<tr class="pm-row" title="' + esc(tip) + '">' +
          '<td class="pm-l"><a class="pm-name" href="price.html?model=' + encodeURIComponent(m.key) + '">' + esc(m.name) + "</a>" +
            '<div class="pm-sub">' + esc(m.family || "") + (offIn != null ? " · 官方 ¥" + money(offIn) + "/M" + (offCur === "CNY" ? " · 锚:千问AI" : "") : "") + "</div></td>" +
          '<td class="pm-l"><a class="pm-site" href="detail.html?site=' + encodeURIComponent(r.site) + '">' + esc(r.site) + "</a>" +
            (r.real === false ? '<span class="pm-demo">示例</span>' : "") + "</td>" +
          '<td class="pm-l pm-ratio">' + esc(ratioText(r, site)) + "</td>" +
          '<td class="pm-l pm-gname">' + esc(r.group || "—") + "</td>" +
          "<td>" + (r.grpRatio != null ? '<span class="pm-mult">' + r.grpRatio + "x</span>" : '<span class="pm-dash">—</span>') + "</td>" +
          "<td>" + priceCell + "</td>" +
          "<td>" + money(out) + "</td>" +
          '<td class="pm-cache">' + money(cr) + "</td>" +
          '<td><span class="pm-dash" title="站方未公布缓存写入单价,不按读价推算">—</span></td>' +
          '<td class="pm-off">' + (offIn == null ? '<span class="pm-dash">—</span>' : "<i title=\"" + esc(offCur === "CNY" ? "官方价(千问AI平台人民币标价,不换算汇率)" : "官方锚(OpenRouter 美元价 ×¥" + FX + " 折算)") + "\">" + money(offIn) + "</i>") + "</td>" +
          '<td class="pm-off">' + (offOut == null ? '<span class="pm-dash">—</span>' : "<i title=\"" + esc(offCur === "CNY" ? "官方价(千问AI平台人民币标价,不换算汇率)" : "官方锚(OpenRouter 美元价 ×¥" + FX + " 折算)") + "\">" + money(offOut) + "</i>") + "</td>" +
          "<td>" + pctCell(x.v, offIn, offCur) + "</td>" +
          "<td>" + availCell(site) + "</td>" +
          "</tr>";
      });
    });
    h += "</tbody>";
    table.innerHTML = h;

    var sortTh = table.querySelector('th[data-sort="in"]');
    if (sortTh) sortTh.onclick = function () { sortDir = -sortDir; render(); };
  }

  /* 搜索(2026-10-21:布局改为「每模型一行 + 最低价站点」,不再有站点列,到手价开关随之下线) */
  function bind() {
    var mx = document.getElementById("matrixView");
    if (!mx) return;
    var si = document.getElementById("mxSearch");
    if (si) si.addEventListener("input", function () { q = this.value.trim().toLowerCase(); render(); });
  }
  if (document.readyState === "loading") document.addEventListener("DOMContentLoaded", bind);
  else bind();
})();
