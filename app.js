/* Stats Calc — all statistics are computed locally. */
(function () {
  "use strict";
  var $ = S3.$, $$ = S3.$$;
  var KEY = "stats.v1";

  // ---------- parsing ----------
  function normDigits(s) {
    return s.replace(/[٠-٩]/g, function (d) { return d.charCodeAt(0) - 0x660; }).replace(/[۰-۹]/g, function (d) { return d.charCodeAt(0) - 0x6F0; })
      .replace(/٫/g, ".").replace(/٬/g, ",").replace(/[−–]/g, "-");
  }
  function parse(text, commas) {
    var s = normDigits(String(text || ""));
    if (commas === "thou") s = s.replace(/(\d),(?=\d{3}(?!\d))/g, "$1");
    else if (commas === "dec") s = s.replace(/(\d),(\d)/g, "$1.$2");
    var toks = s.split(commas === "sep" ? /[\s,;|]+/ : /[\s;|]+/).filter(Boolean), vals = [], skipped = [];
    toks.forEach(function (t) {
      var c = t.replace(/^["'(]+|["')]+$/g, "");
      if (/^[+-]?(\d+\.?\d*|\.\d+)(e[+-]?\d+)?%?$/i.test(c)) { var v = parseFloat(c); if (isFinite(v)) vals.push(v); else skipped.push(t); }
      else skipped.push(t);
    });
    return { vals: vals, skipped: skipped };
  }

  // ---------- statistics ----------
  function sorted(a) { return a.slice().sort(function (x, y) { return x - y; }); }
  function sum(a) { var s = 0, c = 0; a.forEach(function (v) { var y = v - c, t = s + y; c = (t - s) - y; s = t; }); return s; } // Kahan
  function medianOf(s) { var n = s.length; if (!n) return NaN; return n % 2 ? s[(n - 1) / 2] : (s[n / 2 - 1] + s[n / 2]) / 2; }
  function quantile(s, p, method) {
    var n = s.length;
    if (!n) return NaN;
    if (method === "tukey") { // median of the lower / upper half, excluding the median when n is odd
      var half = Math.floor(n / 2), lo = s.slice(0, half), hi = s.slice(n - half);
      if (n === 1) return s[0];
      return p === 0.25 ? medianOf(lo) : p === 0.75 ? medianOf(hi) : medianOf(s);
    }
    var h = method === "exc" ? (n + 1) * p - 1 : (n - 1) * p;
    if (h <= 0) return s[0];
    if (h >= n - 1) return s[n - 1];
    var f = Math.floor(h);
    return s[f] + (h - f) * (s[f + 1] - s[f]);
  }
  function analyze(vals, method) {
    var n = vals.length;
    if (!n) return null;
    var s = sorted(vals), total = sum(vals), mean = total / n;
    var ss = sum(vals.map(function (v) { return (v - mean) * (v - mean); }));
    var counts = new Map(); vals.forEach(function (v) { counts.set(v, (counts.get(v) || 0) + 1); });
    var maxc = 0; counts.forEach(function (c) { if (c > maxc) maxc = c; });
    var modes = maxc > 1 ? Array.from(counts).filter(function (e) { return e[1] === maxc; }).map(function (e) { return e[0]; }).sort(function (a, b) { return a - b; }) : [];
    var q1 = quantile(s, 0.25, method), q3 = quantile(s, 0.75, method), iqr = q3 - q1;
    var lf = q1 - 1.5 * iqr, uf = q3 + 1.5 * iqr;
    var sv = n > 1 ? ss / (n - 1) : NaN, pv = ss / n, sd = Math.sqrt(sv);
    var inside = s.filter(function (v) { return v >= lf && v <= uf; });
    return {
      n: n, sum: total, mean: mean, median: medianOf(s), modes: modes, modeCount: maxc, min: s[0], max: s[n - 1], range: s[n - 1] - s[0],
      sampleVar: sv, popVar: pv, sampleSD: sd, popSD: Math.sqrt(pv), se: n > 1 ? sd / Math.sqrt(n) : NaN, cv: mean !== 0 && n > 1 ? sd / Math.abs(mean) * 100 : NaN,
      q1: q1, q3: q3, iqr: iqr, lowerFence: lf, upperFence: uf,
      outliers: s.filter(function (v) { return v < lf || v > uf; }), whiskerLo: inside.length ? inside[0] : s[0], whiskerHi: inside.length ? inside[inside.length - 1] : s[n - 1],
      sorted: s, counts: counts
    };
  }
  function zscores(vals, a) { return vals.map(function (v) { return a.sampleSD > 0 ? (v - a.mean) / a.sampleSD : NaN; }); }

  // Bins: whole-number friendly widths, Sturges' count as the target.
  function niceNum(x) { var p = Math.pow(10, Math.floor(Math.log10(x))), f = x / p; return (f <= 1 ? 1 : f <= 2 ? 2 : f <= 2.5 ? 2.5 : f <= 5 ? 5 : 10) * p; }
  function bins(a) {
    if (a.range === 0) return [{ lo: a.min, hi: a.min, c: a.n }];
    var k = Math.ceil(Math.log2(a.n)) + 1, w = niceNum(a.range / k), start = Math.floor(a.min / w) * w, out = [];
    for (var lo = start; lo <= a.max + w * 1e-9; lo += w) out.push({ lo: +lo.toPrecision(12), hi: +(lo + w).toPrecision(12), c: 0 });
    a.sorted.forEach(function (v) { var i = Math.min(out.length - 1, Math.floor((v - start) / w + 1e-9)); out[i].c++; });
    while (out.length > 1 && out[out.length - 1].c === 0) out.pop();
    return out;
  }
  function freqRows(a) {
    if (a.counts.size <= 20) {
      var cum = 0;
      return Array.from(a.counts).sort(function (x, y) { return x[0] - y[0]; }).map(function (e) { cum += e[1]; return { label: fmt(e[0]), c: e[1], cum: cum }; });
    }
    var c2 = 0;
    return bins(a).map(function (b, i, arr) { c2 += b.c; return { label: fmt(b.lo) + " – " + (i === arr.length - 1 ? fmt(b.hi) : "< " + fmt(b.hi)), c: b.c, cum: c2 }; });
  }

  // ---------- formatting ----------
  var nf = new Intl.NumberFormat(undefined, { maximumFractionDigits: 6 });
  function fmt(v) {
    if (v === undefined || v === null || (typeof v === "number" && isNaN(v))) return "—";
    if (!isFinite(v)) return v > 0 ? "∞" : "−∞";
    var a = Math.abs(v);
    if (a !== 0 && (a >= 1e12 || a < 1e-6)) return v.toExponential(4);
    return nf.format(+v.toPrecision(10));
  }
  function plainNum(v) { return isFinite(v) ? String(+v.toPrecision(12)) : ""; }

  // ---------- rendering ----------
  var state = { a: null, vals: [] };
  var METHOD = { inc: "inclusive (Excel QUARTILE.INC, R type 7)", exc: "exclusive (Excel QUARTILE.EXC, R type 6)", tukey: "median of halves (TI)" };
  function stat(label, v) { return '<div class="stat"><b>' + S3.esc(v) + "</b><span>" + S3.esc(label) + "</span></div>"; }
  function rows(a, method) {
    return [
      ["Count (n)", fmt(a.n)], ["Sum", fmt(a.sum)], ["Mean", fmt(a.mean)], ["Median", fmt(a.median)],
      ["Mode", a.modes.length ? a.modes.slice(0, 8).map(fmt).join(", ") + (a.modes.length > 8 ? " …" : "") + " (×" + a.modeCount + ")" : "none (all values unique)"],
      ["Minimum", fmt(a.min)], ["Maximum", fmt(a.max)], ["Range", fmt(a.range)],
      ["Sample variance (s²)", fmt(a.sampleVar)], ["Sample SD (s)", fmt(a.sampleSD)],
      ["Population variance (σ²)", fmt(a.popVar)], ["Population SD (σ)", fmt(a.popSD)],
      ["Standard error of the mean", fmt(a.se)], ["Coefficient of variation", isFinite(a.cv) ? fmt(a.cv) + "%" : "—"],
      ["Q1", fmt(a.q1)], ["Q3", fmt(a.q3)], ["IQR", fmt(a.iqr)], ["Quartile method", METHOD[method]],
      ["Outlier fences (1.5 × IQR)", fmt(a.lowerFence) + " and " + fmt(a.upperFence)],
      ["Outliers", a.outliers.length ? a.outliers.slice(0, 12).map(fmt).join(", ") + (a.outliers.length > 12 ? " … (" + a.outliers.length + ")" : "") : "none"]
    ];
  }
  function render() {
    var text = $("#input").value, commas = $("#commas").value, method = $("#qmethod").value;
    S3.store(KEY, { text: text.length < 200000 ? text : "", commas: commas, method: method });
    var p = parse(text, commas), a = analyze(p.vals, method);
    state.a = a; state.vals = p.vals; state.method = method;
    var info = $("#parseInfo");
    info.textContent = p.vals.length ? p.vals.length.toLocaleString() + " number" + (p.vals.length === 1 ? "" : "s") + " read" +
      (p.skipped.length ? "; skipped " + p.skipped.length + ": " + p.skipped.slice(0, 5).join(" ") + (p.skipped.length > 5 ? " …" : "") : ".") : "";
    if (!a) {
      $("#stats").innerHTML = ""; $("#kv").innerHTML = '<tr><td class="empty"><b>No numbers yet</b>Paste or type numbers separated by commas, spaces or new lines.</td></tr>';
      $("#freq").innerHTML = ""; $("#z").innerHTML = ""; $("#binInfo").textContent = "";
      drawHist(); drawBox(); return;
    }
    $("#stats").innerHTML = stat("mean", fmt(a.mean)) + stat("median", fmt(a.median)) + stat("sample SD", fmt(a.sampleSD)) + stat("population SD", fmt(a.popSD));
    var kv = $("#kv"); kv.textContent = "";
    rows(a, method).forEach(function (r) { kv.appendChild(S3.h("tr", {}, [S3.h("th", { text: r[0] }), S3.h("td", { "class": "num", text: r[1] })])); });

    var fr = freqRows(a), ft = $("#freq"); ft.textContent = "";
    ft.appendChild(S3.h("thead", {}, [S3.h("tr", {}, ["Value", "Freq.", "Relative", "Cumulative"].map(function (h, i) { return S3.h("th", { "class": i ? "num" : "", text: h }); }))]));
    var tb = S3.h("tbody");
    fr.forEach(function (r) { tb.appendChild(S3.h("tr", {}, [S3.h("td", { text: r.label }), S3.h("td", { "class": "num", text: String(r.c) }), S3.h("td", { "class": "num", text: (r.c / a.n * 100).toFixed(1) + "%" }), S3.h("td", { "class": "num", text: String(r.cum) })])); });
    ft.appendChild(tb);

    var zs = zscores(p.vals, a), zt = $("#z"); zt.textContent = "";
    zt.appendChild(S3.h("thead", {}, [S3.h("tr", {}, ["#", "Value", "z", ""].map(function (h, i) { return S3.h("th", { "class": i && i < 3 ? "num" : "", text: h }); }))]));
    var zb = S3.h("tbody"), lim = Math.min(p.vals.length, 1000);
    for (var i = 0; i < lim; i++) {
      var v = p.vals[i], out = v < a.lowerFence || v > a.upperFence;
      zb.appendChild(S3.h("tr", { "class": out ? "st-out" : "" }, [S3.h("td", { "class": "faint", text: String(i + 1) }), S3.h("td", { "class": "num", text: fmt(v) }),
        S3.h("td", { "class": "num", text: isFinite(zs[i]) ? zs[i].toFixed(3) : "—" }), S3.h("td", {}, out ? [S3.h("span", { "class": "chip warn", text: "outlier" })] : [])]));
    }
    if (p.vals.length > lim) zb.appendChild(S3.h("tr", {}, [S3.h("td", { colspan: "4", "class": "faint", text: "Showing the first 1,000 of " + p.vals.length.toLocaleString() + ". The CSV has them all." })]));
    zt.appendChild(zb);
    drawHist(); drawBox();
  }

  // ---------- charts ----------
  function css(n) { return getComputedStyle(document.documentElement).getPropertyValue(n).trim(); }
  function setup(cv) {
    var W = cv.clientWidth, H = cv.clientHeight, dpr = window.devicePixelRatio || 1;
    cv.width = Math.round(W * dpr); cv.height = Math.round(H * dpr);
    var g = cv.getContext("2d"); g.setTransform(dpr, 0, 0, dpr, 0, 0); g.clearRect(0, 0, W, H);
    g.font = "11px " + getComputedStyle(document.body).fontFamily;
    return { g: g, W: W, H: H };
  }
  function drawHist() {
    var c = setup($("#hist")), g = c.g, a = state.a;
    if (!a || !c.W) return;
    var bs = bins(a), maxc = Math.max.apply(null, bs.map(function (b) { return b.c; }));
    $("#binInfo").textContent = bs.length + " bin" + (bs.length === 1 ? "" : "s") + (bs.length > 1 ? ", width " + fmt(bs[0].hi - bs[0].lo) : "");
    var pl = 34, pr = 10, pt = 10, pb = 24, cw = c.W - pl - pr, ch = c.H - pt - pb;
    var top = Math.max(1, Math.ceil(maxc / 4) * 4);
    g.strokeStyle = css("--line"); g.fillStyle = css("--text-3"); g.lineWidth = 1; g.textBaseline = "middle"; g.textAlign = "right";
    for (var t = 0; t <= 4; t++) { var y = pt + ch - ch * t / 4; g.beginPath(); g.moveTo(pl, Math.round(y) + .5); g.lineTo(c.W - pr, Math.round(y) + .5); g.stroke(); g.fillText(String(Math.round(top * t / 4)), pl - 6, y); }
    var bw = cw / bs.length, every = Math.ceil(bs.length / Math.max(1, Math.floor(cw / 56)));
    g.fillStyle = css("--accent");
    bs.forEach(function (b, i) { var h = b.c / top * ch; g.globalAlpha = 0.85; g.fillRect(pl + i * bw + 1, pt + ch - h, Math.max(1, bw - 2), h); });
    g.globalAlpha = 1; g.fillStyle = css("--text-3"); g.textAlign = "center"; g.textBaseline = "top";
    bs.forEach(function (b, i) { if (i % every === 0) g.fillText(fmt(b.lo), pl + i * bw, pt + ch + 6); });
    if (bs.length > 1 && bs.length % every === 0) g.fillText(fmt(bs[bs.length - 1].hi), pl + cw, pt + ch + 6);
    else if (bs.length === 1) g.fillText(fmt(bs[0].lo), pl + cw / 2, pt + ch + 6);
  }
  function drawBox() {
    var c = setup($("#box")), g = c.g, a = state.a;
    if (!a || !c.W) return;
    var lo = a.min, hi = a.max, pad = (hi - lo) * 0.06 || Math.abs(lo) * 0.1 || 1;
    lo -= pad; hi += pad;
    var pl = 16, pr = 16, X = function (v) { return pl + (v - lo) / (hi - lo) * (c.W - pl - pr); };
    var mid = c.H / 2 - 8, bh = Math.min(56, c.H * 0.4);
    var acc = css("--accent"), t2 = css("--text-2"), t3 = css("--text-3");
    // axis ticks
    g.strokeStyle = css("--line"); g.fillStyle = t3; g.textAlign = "center"; g.textBaseline = "top"; g.lineWidth = 1;
    var span = hi - lo, step = Math.pow(10, Math.floor(Math.log10(span / 5))), m = span / 5 / step; step *= m >= 5 ? 5 : m >= 2 ? 2 : 1;
    for (var v = Math.ceil(lo / step) * step; v <= hi; v += step) { var x = Math.round(X(v)) + .5; g.beginPath(); g.moveTo(x, 8); g.lineTo(x, c.H - 22); g.stroke(); g.fillText(fmt(+v.toPrecision(10)), x, c.H - 16); }
    // whiskers
    g.strokeStyle = t2; g.lineWidth = 1.5;
    g.beginPath(); g.moveTo(X(a.whiskerLo), mid); g.lineTo(X(a.q1), mid); g.moveTo(X(a.q3), mid); g.lineTo(X(a.whiskerHi), mid);
    g.moveTo(X(a.whiskerLo), mid - bh / 4); g.lineTo(X(a.whiskerLo), mid + bh / 4); g.moveTo(X(a.whiskerHi), mid - bh / 4); g.lineTo(X(a.whiskerHi), mid + bh / 4); g.stroke();
    // box + median + mean
    g.fillStyle = css("--accent-soft"); g.fillRect(X(a.q1), mid - bh / 2, Math.max(1, X(a.q3) - X(a.q1)), bh);
    g.strokeStyle = acc; g.lineWidth = 2; g.strokeRect(X(a.q1), mid - bh / 2, Math.max(1, X(a.q3) - X(a.q1)), bh);
    g.beginPath(); g.moveTo(X(a.median), mid - bh / 2); g.lineTo(X(a.median), mid + bh / 2); g.stroke();
    g.fillStyle = css("--coffee"); g.beginPath(); g.moveTo(X(a.mean), mid - 5); g.lineTo(X(a.mean) + 5, mid); g.lineTo(X(a.mean), mid + 5); g.lineTo(X(a.mean) - 5, mid); g.closePath(); g.fill();
    // outliers
    g.strokeStyle = css("--danger"); g.lineWidth = 1.5;
    a.outliers.forEach(function (o) { g.beginPath(); g.arc(X(o), mid, 4, 0, Math.PI * 2); g.stroke(); });
    g.fillStyle = t3; g.textBaseline = "bottom"; g.textAlign = "left";
    g.fillText("◆ mean   ▮ median   ○ outlier", pl, mid - bh / 2 - 6);
  }

  // ---------- summary / exports ----------
  function summary() {
    var a = state.a;
    return rows(a, state.method).map(function (r) { return r[0] + ": " + r[1]; }).join("\n");
  }
  function csvFreq() {
    var a = state.a, fr = freqRows(a);
    return "value,frequency,relative,cumulative\n" + fr.map(function (r) { return '"' + r.label + '",' + r.c + "," + (r.c / a.n).toFixed(6) + "," + r.cum; }).join("\n") + "\n";
  }
  function csvZ() {
    var a = state.a, zs = zscores(state.vals, a);
    return "index,value,z,outlier\n" + state.vals.map(function (v, i) { return (i + 1) + "," + plainNum(v) + "," + (isFinite(zs[i]) ? zs[i].toFixed(6) : "") + "," + (v < a.lowerFence || v > a.upperFence ? "yes" : ""); }).join("\n") + "\n";
  }

  // ---------- wiring ----------
  var saved = S3.store(KEY) || {};
  $("#input").value = saved.text || "";
  $("#commas").value = ["sep", "thou", "dec"].indexOf(saved.commas) >= 0 ? saved.commas : "sep";
  $("#qmethod").value = ["inc", "exc", "tukey"].indexOf(saved.method) >= 0 ? saved.method : "inc";
  $("#input").addEventListener("input", S3.debounce(render, 200));
  $("#commas").addEventListener("change", render);
  $("#qmethod").addEventListener("change", render);
  $("#clear").addEventListener("click", function () { $("#input").value = ""; render(); $("#input").focus(); });
  var SAMPLE = "72, 85, 90, 66, 78, 88, 95, 70, 82, 79, 91, 60, 84, 77, 89, 73, 98, 81, 69, 86, 75, 92, 80, 83, 41";
  $("#sample").addEventListener("click", function () { $("#input").value = SAMPLE; render(); });
  $("#open input").addEventListener("change", function (e) {
    var f = e.target.files[0]; if (!f) return; e.target.value = "";
    S3.readFile(f, "text").then(function (t) { $("#input").value = t; render(); S3.done(); });
  });
  $("#copy").addEventListener("click", function () { if (!state.a) return S3.toast("Add some numbers first", "error"); S3.copy(summary()); S3.done(); });
  $("#freqCsv").addEventListener("click", function () { if (!state.a) return S3.toast("Add some numbers first", "error"); S3.download(csvFreq(), "frequency.csv", "text/csv"); S3.done(); });
  $("#zCsv").addEventListener("click", function () { if (!state.a) return S3.toast("Add some numbers first", "error"); S3.download(csvZ(), "z-scores.csv", "text/csv"); S3.done(); });
  if (window.ResizeObserver) { var ro = new ResizeObserver(S3.debounce(function () { drawHist(); drawBox(); }, 60)); ro.observe($("#hist")); ro.observe($("#box")); }
  new MutationObserver(function () { drawHist(); drawBox(); }).observe(document.documentElement, { attributes: true, attributeFilter: ["data-theme"] });
  render();

  window.S3_DEMO = function () { $("#input").value = SAMPLE; $("#qmethod").value = "inc"; render(); };

  // ---------- self-test: known answers ----------
  window.S3_SELFTEST = function () {
    var f = [];
    function ok(n, c) { if (!c) f.push(n); }
    function near(x, y, e) { return Math.abs(x - y) < (e || 1e-9); }
    var d = [2, 4, 4, 4, 5, 5, 7, 9], a = analyze(d, "inc");
    ok("mean 5", a.mean === 5);
    ok("population SD 2", near(a.popSD, 2));
    ok("sample SD 2.138", near(a.sampleSD, Math.sqrt(32 / 7)) && a.sampleSD.toFixed(3) === "2.138");
    ok("variances", near(a.popVar, 4) && near(a.sampleVar, 32 / 7));
    ok("median 4.5", a.median === 4.5);
    ok("mode 4", a.modes.length === 1 && a.modes[0] === 4 && a.modeCount === 3);
    ok("min max range", a.min === 2 && a.max === 9 && a.range === 7 && a.sum === 40 && a.n === 8);
    ok("Q inclusive", a.q1 === 4 && a.q3 === 5.5);
    var e = analyze(d, "exc"); ok("Q exclusive", e.q1 === 4 && e.q3 === 6.5);
    var t = analyze(d, "tukey"); ok("Q halves", t.q1 === 4 && t.q3 === 6);
    var t7 = analyze([1, 2, 3, 4, 5, 6, 7], "tukey"); ok("Q halves odd", t7.q1 === 2 && t7.q3 === 6);
    var i7 = analyze([1, 2, 3, 4, 5, 6, 7], "inc"); ok("Q inc odd", i7.q1 === 2.5 && i7.q3 === 5.5);
    var o = analyze([1, 2, 3, 4, 100], "inc"); ok("outlier 100", o.outliers.length === 1 && o.outliers[0] === 100 && o.whiskerHi === 4);
    ok("no mode", analyze([1, 2, 3], "inc").modes.length === 0);
    ok("bimodal", analyze([1, 1, 2, 2, 3], "inc").modes.join() === "1,2");
    ok("z", zscores([2, 4, 4, 4, 5, 5, 7, 9], a)[7].toFixed(4) === (4 / Math.sqrt(32 / 7)).toFixed(4));
    ok("parse mixed separators", parse("1, 2; 3\n4\t5 | 6", "sep").vals.join() === "1,2,3,4,5,6");
    ok("parse thousands", parse("1,234 5,678.5\n12", "thou").vals.join() === "1234,5678.5,12");
    ok("parse decimal comma", parse("1,5 2,25;3", "dec").vals.join() === "1.5,2.25,3");
    ok("parse arabic", parse("١٫٥ ٢", "sep").vals.join() === "1.5,2");
    var hd = parse("Score\n10\n-2.5\n1e3\nn/a", "sep"); ok("parse skips headers", hd.vals.join() === "10,-2.5,1000" && hd.skipped.length === 2);
    var big = analyze([1e9 + 4, 1e9 + 7, 1e9 + 13, 1e9 + 16], "inc"); ok("stable variance", near(big.popVar, 22.5, 1e-6));
    var b = bins(analyze([1, 2, 2, 3, 3, 3, 4, 4, 5, 10], "inc")); ok("bins cover all", b.reduce(function (s, x) { return s + x.c; }, 0) === 10);
    return f.length ? f : true;
  };
})();
