// 관리자 컨트롤러: 판매 추이 대시보드(PyTorch 분석 결과), 상품/재고 관리, 주문 관리
const express = require('express');
const product = require('../models/product');
const order = require('../models/order');
const user = require('../models/user');
const adminUser = require('../models/adminUser');
const analysis = require('../models/analysis');
const promotion = require('../models/promotion');
const runner = require('../services/analysisRunner');
const { requireAdmin } = require('../middleware/auth');
const { ko } = require('../services/labels');

const router = express.Router();
router.use(requireAdmin);
router.use((req, res, next) => { res.locals.adminNav = req.path.split('/')[1] || 'dashboard'; next(); });

const WEEKDAY_FULL = ['월요일', '화요일', '수요일', '목요일', '금요일', '토요일', '일요일'];

/** 분석 결과에서 관리자용 핵심 인사이트 문장 생성 */
function buildInsights(r) {
  if (!r) return [];
  const out = [];
  const won = (n) => `₩${Math.round(n).toLocaleString('ko-KR')}`;
  if (r.hourly && r.hourly.orders) {
    const h = r.hourly;
    const top = [...h.slots].sort((a, b) => b.orders - a.orders)[0];
    out.push(`주문이 가장 몰리는 시간은 <b>${h.peak_hour}시</b>이며, 하루 중 <b>${top.name}</b>에 전체 주문의 ${Math.round((top.orders / h.orders) * 100)}%가 발생합니다.`);
  }
  const wd = r.weekday.avg_revenue;
  const best = wd.indexOf(Math.max(...wd));
  const worst = wd.indexOf(Math.min(...wd));
  out.push(`요일별로는 <b>${WEEKDAY_FULL[best]}</b> 평균 매출이 가장 높고 ${WEEKDAY_FULL[worst]}보다 ${Math.round((wd[best] / wd[worst] - 1) * 100)}% 많습니다.`);
  const f = r.forecast;
  const chg = (f.next_4w_total / f.last_4w_total - 1) * 100;
  out.push(`PyTorch 모델은 다음 4주 매출을 <b>${won(f.next_4w_total)}</b>로 예측합니다 (최근 4주 대비 ${chg >= 0 ? '+' : ''}${chg.toFixed(1)}%, 검증 오차 MAPE ${f.holdout.mape_pct}%).`);
  const growth = (r.category_growth || []).filter((g) => g.previous > 0);
  if (growth.length) {
    const up = [...growth].sort((a, b) => b.change - a.change)[0];
    const down = [...growth].sort((a, b) => a.change - b.change)[0];
    out.push(`최근 4주 카테고리 중 <b>${ko(up.name)}</b> 매출이 ${up.change >= 0 ? '+' : ''}${up.change}%로 가장 크게 변했고, ${ko(down.name)}은(는) ${down.change}%로 가장 많이 줄었습니다.`);
  }
  const promos = promotion.candidates(r);
  if (promos.length) {
    out.push(`PyTorch 분석이 재고가 많고 판매가 줄어드는 상품 <b>${promos.length}개</b>를 행사 후보로 추천했습니다. <a class="link" href="/admin/promotions">행사 추천 검토하기 →</a>`);
  }
  const share = r.monthly.online_share.filter((v) => v != null);
  if (share.length > 12) {
    out.push(`온라인 매출 비중은 1년 전 ${share[share.length - 13]}%에서 최근 ${share[share.length - 1]}%로 바뀌었습니다.`);
  }
  return out;
}

router.get('/', (req, res) => {
  const result = analysis.readResult();
  const bestSellers = result ? result.best_sellers.map((b) => ({ ...b, product: product.get(b.article_id) })).filter((b) => b.product) : [];
  res.render('admin/dashboard', {
    title: '판매 추이 대시보드',
    result,
    insights: buildInsights(result),
    bestSellers,
    lastRun: analysis.latest(),
    history: analysis.history(),
    platform: order.platformStats(),
    inventory: product.inventorySummary(),
    members: user.count(),
  });
});

// 분석 결과 JSON (차트용)
router.get('/api/trends', (req, res) => {
  const result = analysis.readResult();
  if (!result) return res.status(404).json({ error: '분석 결과가 없습니다. 분석을 실행하세요.' });
  return res.json(result);
});

router.get('/api/analysis/status', (req, res) => {
  res.json(analysis.latest() || null);
});

router.post('/analysis/run', (req, res) => {
  const r = runner.run(req.session.auth.id);
  if (r.started) adminUser.audit(req.session.auth.id, 'analysis.run', `run#${r.runId}`);
  if (req.get('accept') && req.get('accept').includes('application/json')) return res.json(r);
  return res.redirect('/admin');
});

// ---- 상품/재고 관리 ----
router.get('/products', (req, res) => {
  const filters = { q: (req.query.q || '').trim(), group: req.query.group || '', index: req.query.index || '',
    sort: req.query.sort || 'popular', page: req.query.page || 1, limit: 30, includeInactive: true };
  res.render('admin/products', { title: '상품 관리', filters, result: product.list(filters), facets: product.facets(), inventory: product.inventorySummary() });
});

router.post('/products/:id', (req, res) => {
  const before = product.get(req.params.id);
  if (!before) return res.status(404).render('error', { title: '없는 상품', message: '상품을 찾을 수 없습니다.' });
  const next = {
    price_krw: Math.max(0, Math.round(Number(req.body.price_krw) || 0)),
    stock: Math.max(0, Math.round(Number(req.body.stock) || 0)),
    is_active: req.body.is_active === '1',
  };
  product.update(before.article_id, next);
  adminUser.audit(req.session.auth.id, 'product.update', before.article_id,
    { price_krw: [before.price_krw, next.price_krw], stock: [before.stock, next.stock], is_active: [before.is_active, next.is_active ? 1 : 0] });
  req.session.flash = { type: 'ok', text: `${before.prod_name} (${before.article_id}) 정보가 저장되었습니다.` };
  res.redirect(req.get('referer') && req.get('referer').includes('/admin/products') ? req.get('referer') : '/admin/products');
});

// ---- 주문 관리 ----
router.get('/orders', (req, res) => {
  const status = order.STATUS_LABEL[req.query.status] ? req.query.status : '';
  res.render('admin/orders', { title: '주문 관리', status, list: order.adminList({ status, page: Number(req.query.page) || 1 }), labels: order.STATUS_LABEL });
});

router.post('/orders/:id/status', (req, res) => {
  try {
    const o = order.adminUpdateStatus(Number(req.params.id), req.body.status);
    adminUser.audit(req.session.auth.id, 'order.status', o.order_no, { from: o.status, to: req.body.status });
    req.session.flash = { type: 'ok', text: `${o.order_no} 상태를 ${order.STATUS_LABEL[req.body.status]}(으)로 변경했습니다.` };
  } catch (err) {
    if (!(err instanceof order.OrderError)) throw err;
    req.session.flash = { type: 'error', text: err.message };
  }
  res.redirect(req.get('referer') || '/admin/orders');
});

// ---- 행사(할인) 상품: PyTorch 추천 → 관리자 승인 → 이용자 화면 노출 ----
router.get('/promotions', (req, res) => {
  const result = analysis.readResult();
  res.render('admin/promotions', {
    title: '행사 상품',
    result,
    candidates: promotion.candidates(result),
    active: promotion.active(),
    minPct: promotion.MIN_PCT,
    maxPct: promotion.MAX_PCT,
  });
});

router.post('/promotions', (req, res) => {
  try {
    const r = promotion.approve({
      articleId: String(req.body.article_id || ''), discountPct: req.body.discount_pct,
      reason: req.body.reason, score: req.body.score, adminId: req.session.auth.id,
    });
    adminUser.audit(req.session.auth.id, r.before ? 'promotion.update' : 'promotion.approve', r.after.article_id, {
      discount_pct: r.before ? [r.before.discount_pct, r.after.discount_pct] : r.after.discount_pct,
      price_krw: r.price_krw, sale_price_krw: r.sale_price_krw, score: r.after.score, reason: r.after.reason,
    });
    req.session.flash = { type: 'ok', text: `${r.after.article_id} 상품을 ${r.after.discount_pct}% 행사로 ${r.before ? '변경' : '등록'}했습니다. 이용자 화면에 ${r.sale_price_krw.toLocaleString('ko-KR')}원으로 표시됩니다.` };
  } catch (err) {
    if (!(err instanceof promotion.PromotionError)) throw err;
    req.session.flash = { type: 'error', text: err.message };
  }
  res.redirect('/admin/promotions');
});

router.post('/promotions/:id/end', (req, res) => {
  try {
    const ended = promotion.end(req.params.id);
    adminUser.audit(req.session.auth.id, 'promotion.end', ended.article_id, { discount_pct: ended.discount_pct });
    req.session.flash = { type: 'ok', text: `${ended.article_id} 상품의 행사를 종료했습니다. 이제 정가로 판매됩니다.` };
  } catch (err) {
    if (!(err instanceof promotion.PromotionError)) throw err;
    req.session.flash = { type: 'error', text: err.message };
  }
  res.redirect('/admin/promotions');
});

router.get('/audit', (req, res) => {
  res.render('admin/audit', { title: '작업 기록', logs: adminUser.recentAudit(100) });
});

module.exports = router;
