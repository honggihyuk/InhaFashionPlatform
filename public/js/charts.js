/* 의존성 없는 SVG 차트 (선, 막대, 히트맵) + 호버 툴팁.
   색: Ledger Brown(실제/기본), Copper(예측/강조) — DESIGN.md 토큰 */
(function (global) {
  var NS = 'http://www.w3.org/2000/svg';
  var C = { brown: '#3b281d', copper: '#e07122', copperSoft: 'rgba(224,113,34,0.18)', grid: '#efebe6', base: '#cfc8c0', paper: '#ffffff' };

  function el(name, attrs, parent) {
    var n = document.createElementNS(NS, name);
    for (var k in attrs) n.setAttribute(k, attrs[k]);
    if (parent) parent.appendChild(n);
    return n;
  }

  function niceTicks(max, count) {
    if (max <= 0) return [0, 1];
    var raw = max / count;
    var mag = Math.pow(10, Math.floor(Math.log10(raw)));
    var step = [1, 2, 2.5, 5, 10].map(function (m) { return m * mag; }).find(function (s) { return s >= raw; });
    var ticks = [];
    for (var v = 0; v <= max + step * 0.001; v += step) ticks.push(v);
    if (ticks[ticks.length - 1] < max) ticks.push(ticks[ticks.length - 1] + step);
    return ticks;
  }

  function compactKRW(v) {
    if (v >= 1e8) return (v / 1e8).toFixed(v >= 1e9 ? 0 : 1).replace(/\.0$/, '') + '억';
    if (v >= 1e4) return Math.round(v / 1e4).toLocaleString('ko-KR') + '만';
    return Math.round(v).toLocaleString('ko-KR');
  }
  function fullKRW(v) { return '₩' + Math.round(v).toLocaleString('ko-KR'); }

  function setup(container, height) {
    container.innerHTML = '';
    var W = Math.max(container.clientWidth, 280);
    var H = height || container.clientHeight || 240;
    var svg = el('svg', { viewBox: '0 0 ' + W + ' ' + H, width: W, height: H, role: 'img' }, container);
    var tip = document.createElement('div');
    tip.className = 'tooltip';
    container.appendChild(tip);
    return { svg: svg, tip: tip, W: W, H: H };
  }

  function showTip(tip, x, y, html) {
    tip.innerHTML = html;
    tip.style.left = x + 'px';
    tip.style.top = y + 'px';
    tip.classList.add('show');
  }
  function hideTip(tip) { tip.classList.remove('show'); }

  function yAxis(svg, ticks, y, m, W, fmt) {
    var g = el('g', { class: 'axis' }, svg);
    ticks.forEach(function (t) {
      el('line', { x1: m.l, x2: W - m.r, y1: y(t), y2: y(t), class: t === 0 ? 'base-line' : 'grid-line' }, g);
      var tx = el('text', { x: m.l - 8, y: y(t) + 3, 'text-anchor': 'end' }, g);
      tx.textContent = fmt(t);
    });
  }

  /**
   * 선 차트
   * opts: { labels: [], series: [{ name, values, color, dash }], band: { lower, upper, from }, height,
   *         format, tickFormat, xTickEvery, ariaLabel }
   */
  function line(container, opts) {
    var s = setup(container, opts.height);
    var m = { t: 12, r: 16, b: 26, l: 52 };
    var n = opts.labels.length;
    var all = [];
    opts.series.forEach(function (se) { se.values.forEach(function (v) { if (v != null) all.push(v); }); });
    if (opts.band) opts.band.upper.forEach(function (v) { if (v != null) all.push(v); });
    var ticks = niceTicks(Math.max.apply(null, all), 4);
    var yMax = ticks[ticks.length - 1];
    var x = function (i) { return m.l + (n === 1 ? 0 : (i / (n - 1)) * (s.W - m.l - m.r)); };
    var y = function (v) { return s.H - m.b - (v / yMax) * (s.H - m.t - m.b); };
    s.svg.setAttribute('aria-label', opts.ariaLabel || '');
    yAxis(s.svg, ticks, y, m, s.W, opts.tickFormat || compactKRW);

    var gx = el('g', { class: 'axis' }, s.svg);
    var every = opts.xTickEvery || Math.ceil(n / 6);
    for (var i = 0; i < n; i += every) {
      var t = el('text', { x: x(i), y: s.H - 8, 'text-anchor': i === 0 ? 'start' : 'middle' }, gx);
      t.textContent = opts.xFormat ? opts.xFormat(opts.labels[i]) : opts.labels[i];
    }

    if (opts.band) {
      var b = opts.band, pts = [];
      for (var j = 0; j < n; j++) if (b.upper[j] != null) pts.push(x(j) + ',' + y(b.upper[j]));
      for (var k = n - 1; k >= 0; k--) if (b.lower[k] != null) pts.push(x(k) + ',' + y(b.lower[k]));
      el('polygon', { points: pts.join(' '), fill: C.copperSoft, stroke: 'none' }, s.svg);
    }

    opts.series.forEach(function (se) {
      var d = '', started = false;
      se.values.forEach(function (v, idx) {
        if (v == null) { started = false; return; }
        d += (started ? 'L' : 'M') + x(idx).toFixed(1) + ' ' + y(v).toFixed(1);
        started = true;
      });
      el('path', { d: d, fill: 'none', stroke: se.color, 'stroke-width': 2, 'stroke-linejoin': 'round', 'stroke-linecap': 'round', 'stroke-dasharray': se.dash ? '5 4' : 'none' }, s.svg);
    });

    // 크로스헤어 + 툴팁
    var cross = el('line', { y1: m.t, y2: s.H - m.b, stroke: C.base, 'stroke-width': 1, opacity: 0 }, s.svg);
    var dots = opts.series.map(function (se) { return el('circle', { r: 4.5, fill: se.color, stroke: C.paper, 'stroke-width': 2, opacity: 0 }, s.svg); });
    var hit = el('rect', { x: m.l, y: m.t, width: s.W - m.l - m.r, height: s.H - m.t - m.b, fill: 'transparent' }, s.svg);
    var fmt = opts.format || fullKRW;
    hit.addEventListener('mousemove', function (e) {
      var r = s.svg.getBoundingClientRect();
      var px = (e.clientX - r.left) * (s.W / r.width);
      var idx = Math.round(((px - m.l) / (s.W - m.l - m.r)) * (n - 1));
      idx = Math.max(0, Math.min(n - 1, idx));
      cross.setAttribute('x1', x(idx)); cross.setAttribute('x2', x(idx)); cross.setAttribute('opacity', 1);
      var rows = [];
      var topY = s.H;
      opts.series.forEach(function (se, si) {
        var v = se.values[idx];
        if (v == null) { dots[si].setAttribute('opacity', 0); return; }
        dots[si].setAttribute('cx', x(idx)); dots[si].setAttribute('cy', y(v)); dots[si].setAttribute('opacity', 1);
        topY = Math.min(topY, y(v));
        rows.push(se.name + ' <b>' + fmt(v) + '</b>');
      });
      if (opts.band && opts.band.upper[idx] != null) rows.push('90% 구간 ' + fmt(opts.band.lower[idx]) + ' ~ ' + fmt(opts.band.upper[idx]));
      var label = opts.tipLabel ? opts.tipLabel(opts.labels[idx]) : opts.labels[idx];
      showTip(s.tip, x(idx) * (r.width / s.W), topY * (r.height / s.H), '<div class="tl">' + label + '</div>' + rows.join('<br>'));
    });
    hit.addEventListener('mouseleave', function () {
      cross.setAttribute('opacity', 0);
      dots.forEach(function (d) { d.setAttribute('opacity', 0); });
      hideTip(s.tip);
    });
  }

  /**
   * 막대 차트
   * opts: { labels, values, highlight: [indexes], height, format, tickFormat, tipLabel, ariaLabel }
   */
  function bars(container, opts) {
    var s = setup(container, opts.height);
    var m = { t: 12, r: 8, b: 26, l: 52 };
    var n = opts.values.length;
    var ticks = niceTicks(Math.max.apply(null, opts.values), 4);
    var yMax = ticks[ticks.length - 1];
    var band = (s.W - m.l - m.r) / n;
    var gap = Math.max(2, band * 0.22);
    var bw = band - gap;
    var y = function (v) { return s.H - m.b - (v / yMax) * (s.H - m.t - m.b); };
    s.svg.setAttribute('aria-label', opts.ariaLabel || '');
    yAxis(s.svg, ticks, y, m, s.W, opts.tickFormat || compactKRW);
    var gx = el('g', { class: 'axis' }, s.svg);
    var every = opts.xTickEvery || 1;
    var fmt = opts.format || fullKRW;
    var hl = opts.highlight || [];
    opts.values.forEach(function (v, i) {
      var bx = m.l + i * band + gap / 2;
      var top = y(v), h = s.H - m.b - top;
      var r = Math.min(4, bw / 2, h);
      // 위쪽만 둥근 막대 (기준선에 붙음)
      var d = 'M' + bx + ' ' + (s.H - m.b) + 'V' + (top + r) + 'Q' + bx + ' ' + top + ' ' + (bx + r) + ' ' + top +
        'H' + (bx + bw - r) + 'Q' + (bx + bw) + ' ' + top + ' ' + (bx + bw) + ' ' + (top + r) + 'V' + (s.H - m.b) + 'Z';
      var color = hl.indexOf(i) >= 0 ? C.copper : C.brown;
      var bar = el('path', { d: d, fill: color }, s.svg);
      if (i % every === 0) {
        var t = el('text', { x: bx + bw / 2, y: s.H - 8, 'text-anchor': 'middle' }, gx);
        t.textContent = opts.labels[i];
      }
      var hit = el('rect', { x: m.l + i * band, y: m.t, width: band, height: s.H - m.t - m.b, fill: 'transparent' }, s.svg);
      hit.addEventListener('mouseenter', function () {
        bar.setAttribute('opacity', 0.82);
        var rr = s.svg.getBoundingClientRect();
        var label = opts.tipLabel ? opts.tipLabel(opts.labels[i], i) : opts.labels[i];
        showTip(s.tip, (bx + bw / 2) * (rr.width / s.W), top * (rr.height / s.H), '<div class="tl">' + label + '</div><b>' + fmt(v) + '</b>');
      });
      hit.addEventListener('mouseleave', function () { bar.setAttribute('opacity', 1); hideTip(s.tip); });
    });
  }

  /** 히트맵 (행: 요일, 열: 시간). 단일 색상(Oat → Copper → Espresso) 순차 스케일 */
  function heatmap(container, opts) {
    var rows = opts.rows, cols = 24, data = opts.values;
    var m = { t: 4, r: 4, b: 22, l: 30 };
    var W = Math.max(container.clientWidth, 280);
    var cell = (W - m.l - m.r) / cols;
    var ch = Math.min(28, Math.max(18, cell * 0.8));
    var H = m.t + rows.length * ch + m.b;
    var s = setup(container, H);
    s.svg.setAttribute('aria-label', opts.ariaLabel || '');
    var max = 0;
    data.forEach(function (r) { r.forEach(function (v) { if (v > max) max = v; }); });
    var stops = [[247, 244, 241], [240, 183, 140], [224, 113, 34], [134, 62, 20], [33, 16, 6]];
    function color(v) {
      var t = max ? v / max : 0;
      var p = t * (stops.length - 1), i = Math.min(Math.floor(p), stops.length - 2), f = p - i;
      var c = stops[i].map(function (a, k) { return Math.round(a + (stops[i + 1][k] - a) * f); });
      return 'rgb(' + c.join(',') + ')';
    }
    var g = el('g', { class: 'axis' }, s.svg);
    rows.forEach(function (name, ri) {
      var t = el('text', { x: m.l - 8, y: m.t + ri * ch + ch / 2 + 3, 'text-anchor': 'end' }, g);
      t.textContent = name;
      for (var c = 0; c < cols; c++) {
        (function (c) {
          var v = data[ri][c];
          var x = m.l + c * cell, y = m.t + ri * ch;
          var rect = el('rect', { x: x + 1, y: y + 1, width: cell - 2, height: ch - 2, rx: 3, fill: color(v) }, s.svg);
          rect.addEventListener('mouseenter', function () {
            rect.setAttribute('stroke', C.brown); rect.setAttribute('stroke-width', 1.5);
            var rr = s.svg.getBoundingClientRect();
            showTip(s.tip, (x + cell / 2) * (rr.width / s.W), y * (rr.height / s.H), '<div class="tl">' + name + '요일 ' + c + '시</div><b>' + v.toLocaleString('ko-KR') + '건</b>');
          });
          rect.addEventListener('mouseleave', function () { rect.removeAttribute('stroke'); hideTip(s.tip); });
        })(c);
      }
    });
    for (var c = 0; c < cols; c += 3) {
      var t = el('text', { x: m.l + c * cell + cell / 2, y: H - 6, 'text-anchor': 'middle' }, g);
      t.textContent = c + '시';
    }
  }

  global.Charts = { line: line, bars: bars, heatmap: heatmap, compactKRW: compactKRW, fullKRW: fullKRW, colors: C };
})(window);
