/* 관리자 대시보드: /admin/api/trends 의 PyTorch 분석 결과를 차트로 그림 */
(function () {
  var data = null;
  var hourMetric = 'orders';
  var C = Charts.colors;

  function topIndexes(values, k) {
    return values.map(function (v, i) { return [v, i]; }).sort(function (a, b) { return b[0] - a[0]; }).slice(0, k).map(function (p) { return p[1]; });
  }
  function md(d) { var p = d.split('-'); return +p[1] + '/' + +p[2]; }
  function ym(d) { var p = d.split('-'); return p[0].slice(2) + '.' + p[1]; }

  function render() {
    if (!data) return;
    var h = data.hourly;
    var hours = Array.from({ length: 24 }, function (_, i) { return String(i); });

    if (h && h.orders) {
      var vals = hourMetric === 'orders' ? h.avg_orders_per_hour : h.avg_revenue_per_hour;
      Charts.bars(document.getElementById('chart-hourly'), {
        labels: hours, values: vals, highlight: topIndexes(vals, 3), height: 260, xTickEvery: 2,
        format: hourMetric === 'orders' ? function (v) { return '하루 평균 ' + v.toFixed(1) + '건'; } : function (v) { return '하루 평균 ' + Charts.fullKRW(v); },
        tickFormat: hourMetric === 'orders' ? function (v) { return v.toFixed(v < 2 ? 1 : 0); } : Charts.compactKRW,
        tipLabel: function (l) { return l + ':00 – ' + l + ':59'; },
        ariaLabel: '시간대별 하루 평균 ' + (hourMetric === 'orders' ? '주문 수' : '매출'),
      });
      Charts.heatmap(document.getElementById('chart-heatmap'), {
        rows: h.heatmap.weekdays, values: h.heatmap.counts, ariaLabel: '요일과 시간대별 주문 수 히트맵',
      });
    }

    // 일별 매출 + 예측
    var f = data.forecast;
    var hist = 120;
    var dDates = data.daily.dates.slice(-hist);
    var labels = dDates.concat(f.dates);
    var actual = data.daily.revenue.slice(-hist).concat(f.dates.map(function () { return null; }));
    var pred = dDates.map(function (_, i) { return i === dDates.length - 1 ? data.daily.revenue[data.daily.revenue.length - 1] : null; }).concat(f.predicted);
    var lower = dDates.map(function () { return null; }).concat(f.lower);
    var upper = dDates.map(function () { return null; }).concat(f.upper);
    Charts.line(document.getElementById('chart-forecast'), {
      labels: labels, height: 300, xFormat: md, xTickEvery: 21,
      series: [{ name: '실제', values: actual, color: C.brown }, { name: '예측', values: pred, color: C.copper, dash: true }],
      band: { lower: lower, upper: upper }, ariaLabel: '최근 120일 일매출과 다음 28일 예측',
    });

    Charts.line(document.getElementById('chart-weekly'), {
      labels: data.weekly.weeks, height: 240, xFormat: ym, xTickEvery: 17,
      tipLabel: function (w) { return w + ' 주'; },
      series: [{ name: '주 매출', values: data.weekly.revenue, color: C.brown }], ariaLabel: '주별 매출 추이',
    });

    var wd = data.weekday.avg_revenue;
    Charts.bars(document.getElementById('chart-weekday'), {
      labels: data.weekday.labels, values: wd, highlight: topIndexes(wd, 1), height: 240,
      tipLabel: function (l) { return l + '요일 평균'; }, ariaLabel: '요일별 평균 매출',
    });

    Charts.bars(document.getElementById('chart-monthly'), {
      labels: data.monthly.months.map(ym), values: data.monthly.revenue, height: 240,
      xTickEvery: 3, highlight: topIndexes(data.monthly.revenue, 1), ariaLabel: '월별 매출',
    });

    Charts.line(document.getElementById('chart-channel'), {
      labels: data.monthly.months, height: 240, xFormat: ym, xTickEvery: 4,
      tickFormat: function (v) { return v + '%'; }, format: function (v) { return v + '%'; },
      series: [{ name: '온라인 비중', values: data.monthly.online_share, color: C.brown }], ariaLabel: '월별 온라인 매출 비중',
    });
  }

  document.querySelectorAll('[data-hour-metric]').forEach(function (btn) {
    btn.addEventListener('click', function () {
      hourMetric = btn.getAttribute('data-hour-metric');
      document.querySelectorAll('[data-hour-metric]').forEach(function (b) { b.classList.toggle('is-active', b === btn); });
      document.querySelector('[data-hour-label]').textContent = hourMetric === 'orders' ? '주문 수' : '매출';
      render();
    });
  });

  var timer;
  window.addEventListener('resize', function () { clearTimeout(timer); timer = setTimeout(render, 150); });

  fetch('/admin/api/trends').then(function (r) { return r.json(); }).then(function (json) { data = json; render(); });
})();
