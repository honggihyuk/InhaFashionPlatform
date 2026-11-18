// 관리자 컨트롤러: 판매 추이 대시보드, 상품 검색(Elasticsearch)·재고 관리, 행사, 주문, 작업 기록, 후처리 모니터
//
// 관리자 작업은 "MySQL 변경 + outbox 이벤트" 만 트랜잭션으로 처리하고 바로 응답합니다.
// 감사 로그(MongoDB), 검색 색인(Elasticsearch), 이용자 알림(MongoDB), PyTorch 분석 실행은
// RabbitMQ 후처리 워커가 맡습니다.
const express = require('express');
const db = require('../db/mysql');
const outbox = require('../messaging/outbox');
const product = require('../models/product');
const order = require('../models/order');
const user = require('../models/user');
const adminUser = require('../models/adminUser');
const analysis = require('../models/analysis');
const promotion = require('../models/promotion');
const jobs = require('../models/jobs');
const search = require('../search/products');
const { requireAdmin } = require('../middleware/auth');
const { ko } = require('../services/labels');

const router = express.Router();
router.use(requireAdmin);
router.use((req, res, next) => { res.locals.adminNav = req.path.split('/')[1] || 'dashboard'; next(); });

const WEEKDAY_FULL = ['월요일', '화요일', '수요일', '목요일', '금요일', '토요일', '일요일'];
const actor = (req) => adminUser.actorOf(req.session);

/** 분석 결과에서 관리자용 핵심 인사이트 문장 생성 */
function buildInsights(r, promos) {
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
  if (promos.length) {
    out.push(`PyTorch 분석이 재고가 많고 판매가 줄어드는 상품 <b>${promos.length}개</b>를 행사 후보로 추천했습니다. <a class="link" href="/admin/promotions">행사 추천 검토하기 →</a>`);
  }
  const share = r.monthly.online_share.filter((v) => v != null);
  if (share.length > 12) {
    out.push(`온라인 매출 비중은 1년 전 ${share[share.length - 13]}%에서 최근 ${share[share.length - 1]}%로 바뀌었습니다.`);
  }
  return out;
}

router.get('/', async (req, res) => {
  const result = await analysis.readResult();
  const [bestSellers, promos, lastRun, history, platform, inventory, members] = await Promise.all([
    result ? Promise.all(result.best_sellers.map(async (b) => ({ ...b, product: await product.get(b.article_id) })))
      .then((rows) => rows.filter((b) => b.product)) : [],
    promotion.candidates(result),
    analysis.latest(),
    analysis.history(),
    order.platformStats(),
    product.inventorySummary(),
    user.count(),
  ]);
  res.render('admin/dashboard', {
    title: '판매 추이 대시보드', result, insights: buildInsights(result, promos), bestSellers,
    lastRun, history, platform, inventory, members,
  });
});

// 분석 결과 JSON (차트용)
router.get('/api/trends', async (req, res) => {
  const result = await analysis.readResult();
  if (!result) return res.status(404).json({ error: '분석 결과가 없습니다. 분석을 실행하세요.' });
  return res.json(result);
});

router.get('/api/analysis/status', async (req, res) => {
  res.json((await analysis.latest()) || null);
});

// 분석 실행 요청 → outbox(analysis.requested) → RabbitMQ analysis-runner 워커가 PyTorch 실행
router.post('/analysis/run', async (req, res) => {
  const r = await analysis.request(actor(req));
  if (req.get('accept') && req.get('accept').includes('application/json')) return res.json(r);
  return res.redirect('/admin');
});

// ---- 상품 검색(Elasticsearch) / 재고 관리 ----
function productFilters(q) {
  return {
    q: (q.q || '').trim(), index: q.index || '', group: q.group || '', colour: q.colour || '',
    stock: ['sold_out', 'low', 'ok'].includes(q.stock) ? q.stock : '',
    active: q.active === '1' || q.active === '0' ? q.active : '',
    sale: q.sale === '1' ? '1' : '',
    minPrice: Number(q.minPrice) > 0 ? String(Number(q.minPrice)) : '',
    maxPrice: Number(q.maxPrice) > 0 ? String(Number(q.maxPrice)) : '',
    sort: q.sort || '', page: Math.max(Number(q.page) || 1, 1), limit: 30,
  };
}

/** Elasticsearch 가 응답하지 않으면 MySQL LIKE 검색으로 대체 (관리 업무가 멈추지 않도록) */
async function searchProducts(filters) {
  try {
    const r = await search.search(filters);
    r.items = r.items.map((p) => ({ ...p, image: product.imageUrl(p.article_id) }));
    return r;
  } catch (err) {
    const sort = { popular: 'popular', new: 'new', price_asc: 'price_asc', price_desc: 'price_desc' }[filters.sort] || 'popular';
    const [r, f] = await Promise.all([
      product.list({ ...filters, sort, sale: filters.sale === '1', includeInactive: true }),
      product.facets(),
    ]);
    return { ...r, engine: 'mysql', fallbackReason: err.message, sort, facets: { ...f, stock: {}, on_sale: null } };
  }
}

router.get('/products', async (req, res) => {
  const filters = productFilters(req.query);
  const [result, inventory] = await Promise.all([searchProducts(filters), product.inventorySummary()]);
  const qs = (patch) => {
    const p = new URLSearchParams();
    Object.entries({ ...filters, limit: undefined, page: 1, ...patch }).forEach(([k, v]) => { if (v && !(k === 'page' && v === 1)) p.set(k, v); });
    const s = p.toString();
    return s ? `/admin/products?${s}` : '/admin/products';
  };
  res.render('admin/products', { title: '상품 관리', filters, result, facets: result.facets, inventory, qs });
});

router.post('/products/:id', async (req, res) => {
  const before = await product.get(req.params.id);
  if (!before) return res.status(404).render('error', { title: '없는 상품', message: '상품을 찾을 수 없습니다.' });
  const next = {
    price_krw: Math.max(0, Math.round(Number(req.body.price_krw) || 0)),
    stock: Math.max(0, Math.round(Number(req.body.stock) || 0)),
    is_active: req.body.is_active === '1',
  };
  // 한 트랜잭션: 상품 수정 + product.updated 이벤트. 감사 로그·검색 색인은 후처리
  await db.transaction(async (tx) => {
    await product.update(tx, before.article_id, next);
    await outbox.enqueue(tx, 'admin', 'product.updated', {
      article_ids: [before.article_id], target: before.article_id,
      detail: { price_krw: [before.price_krw, next.price_krw], stock: [before.stock, next.stock], is_active: [before.is_active, next.is_active ? 1 : 0] },
    }, actor(req));
  });
  req.session.flash = { type: 'ok', text: `${before.prod_name} (${before.article_id}) 정보가 저장되었습니다. 검색 결과에는 잠시 후 반영됩니다.` };
  const ref = req.get('referer');
  res.redirect(ref && ref.includes('/admin/products') ? ref : '/admin/products');
});

// ---- 주문 관리 ----
router.get('/orders', async (req, res) => {
  const status = order.STATUS_LABEL[req.query.status] ? req.query.status : '';
  res.render('admin/orders', { title: '주문 관리', status, list: await order.adminList({ status, page: Number(req.query.page) || 1 }), labels: order.STATUS_LABEL });
});

router.post('/orders/:id/status', async (req, res) => {
  try {
    const o = await order.adminUpdateStatus(Number(req.params.id), req.body.status, actor(req));
    req.session.flash = { type: 'ok', text: `${o.order_no} 상태를 ${order.STATUS_LABEL[req.body.status]}(으)로 변경했습니다.` };
  } catch (err) {
    if (!(err instanceof order.OrderError)) throw err;
    req.session.flash = { type: 'error', text: err.message };
  }
  res.redirect(req.get('referer') || '/admin/orders');
});

// ---- 행사(할인) 상품: PyTorch 추천 → 관리자 승인 → 이용자 화면 노출 ----
router.get('/promotions', async (req, res) => {
  const result = await analysis.readResult();
  const [candidates, active] = await Promise.all([promotion.candidates(result), promotion.active()]);
  res.render('admin/promotions', {
    title: '행사 상품', result, candidates, active, minPct: promotion.MIN_PCT, maxPct: promotion.MAX_PCT,
  });
});

router.post('/promotions', async (req, res) => {
  try {
    const r = await promotion.approve({
      articleId: String(req.body.article_id || ''), discountPct: req.body.discount_pct,
      reason: req.body.reason, score: req.body.score, actor: actor(req),
    });
    req.session.flash = { type: 'ok', text: `${r.after.article_id} 상품을 ${r.after.discount_pct}% 행사로 ${r.before ? '변경' : '등록'}했습니다. 이용자 화면에 ${r.sale_price_krw.toLocaleString('ko-KR')}원으로 표시됩니다.` };
  } catch (err) {
    if (!(err instanceof promotion.PromotionError)) throw err;
    req.session.flash = { type: 'error', text: err.message };
  }
  res.redirect('/admin/promotions');
});

router.post('/promotions/:id/end', async (req, res) => {
  try {
    const ended = await promotion.end(req.params.id, actor(req));
    req.session.flash = { type: 'ok', text: `${ended.article_id} 상품의 행사를 종료했습니다. 이제 정가로 판매됩니다.` };
  } catch (err) {
    if (!(err instanceof promotion.PromotionError)) throw err;
    req.session.flash = { type: 'error', text: err.message };
  }
  res.redirect('/admin/promotions');
});

// ---- 작업 기록 (MongoDB audit_log) ----
router.get('/audit', async (req, res) => {
  let logs = [];
  let error = null;
  try { logs = await adminUser.recentAudit(100); } catch (err) { error = err.message; }
  res.render('admin/audit', { title: '작업 기록', logs, error });
});

// ---- 후처리 작업 모니터: outbox, 큐, 실패 메시지 재처리 ----
router.get('/jobs', async (req, res) => {
  const status = ['FAILED', 'REQUEUED', 'RESOLVED'].includes(req.query.status) ? req.query.status : 'FAILED';
  const [overview, failed, es] = await Promise.all([
    jobs.overview(),
    jobs.failed({ status }).catch(() => []),
    search.health(),
  ]);
  res.render('admin/jobs', { title: '후처리 작업', overview, failed, status, es });
});

router.post('/jobs/replay', async (req, res) => {
  const ids = [].concat(req.body.id || []).map(String).filter(Boolean);
  try {
    const n = await jobs.replay(ids, actor(req));
    req.session.flash = { type: 'ok', text: `실패 메시지 ${n}건을 다시 처리하도록 보냈습니다.` };
  } catch (err) {
    if (!(err instanceof jobs.JobError)) throw err;
    req.session.flash = { type: 'error', text: err.message };
  }
  res.redirect('/admin/jobs');
});

router.post('/jobs/replay-all', async (req, res) => {
  try {
    const all = await jobs.failed({ status: 'FAILED', limit: 500 });
    const n = await jobs.replay(all.map((d) => d._id), actor(req));
    req.session.flash = { type: 'ok', text: `실패 메시지 ${n}건을 모두 다시 처리하도록 보냈습니다.` };
  } catch (err) {
    if (!(err instanceof jobs.JobError)) throw err;
    req.session.flash = { type: 'error', text: err.message };
  }
  res.redirect('/admin/jobs');
});

router.post('/jobs/reindex', async (req, res) => {
  try {
    const n = await search.reindexAll();
    req.session.flash = { type: 'ok', text: `Elasticsearch 상품 인덱스를 다시 만들었습니다. (${n.toLocaleString('ko-KR')}건)` };
  } catch (err) {
    req.session.flash = { type: 'error', text: `재색인 실패: ${err.message}` };
  }
  res.redirect('/admin/jobs');
});

module.exports = router;
