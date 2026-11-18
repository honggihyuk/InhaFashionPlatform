// 행사 상품: PyTorch 추천(MongoDB 분석 결과의 promotions) → 관리자 승인 → 이용자 화면 노출 → 장바구니/주문에 할인가 적용
const { test, describe, before, after, beforeEach } = require('node:test');
const assert = require('node:assert/strict');
const fs = require('fs');
const path = require('path');
const {
  setup, cleanup, startServer, startWorker, waitFor, Client, ACCOUNTS, ARTICLES, db, S, mongo, config,
} = require('./helpers/setup');

const analysis = require('../models/analysis');
const promotion = require('../models/promotion');
const product = require('../models/product');
const cart = require('../models/cart');
const order = require('../models/order');

const TEE = ARTICLES.tee.article_id; // 정가 12,900
const SNEAKER = ARTICLES.sneaker.article_id; // 정가 59,000
const SAMPLE = JSON.parse(fs.readFileSync(path.join(__dirname, 'fixtures', 'sales_trends.sample.json'), 'utf8'));

/** PyTorch 분석 결과(MongoDB)를 테스트 상품 기준 추천으로 만들어 둠 */
async function writeAnalysis(promotions) {
  await clearAnalysis();
  await analysis.saveResult({ ...SAMPLE, promotions }, null);
}
const clearAnalysis = async () => (await mongo.col('analysis_results')).deleteMany({});
const ACTOR = () => ({ type: 'admin', id: ACCOUNTS.admin.id, name: ACCOUNTS.admin.name });
const setProduct = (id, col, v) => db.exec(`UPDATE ${S.catalog}.products SET ${col} = ? WHERE article_id = ?`, [v, id]);
const candidate = (a, extra = {}) => ({
  article_id: a.article_id, prod_name: a.prod_name, product_group: a.product_group_name, stock: a.stock, price_krw: a.price_krw,
  weekly_units: [6, 5, 4, 3, 2, 1, 0, 0], recent_4w_units: 3, prev_4w_units: 18, change_pct: -83.3, weeks_of_cover: 26.7,
  trend_pct_per_week: -30.5, score: 0.82, suggested_discount_pct: 30, reasons: ['재고 27주분', '최근 4주 판매 -83%'], ...extra,
});
/** 이 테스트에서 생긴 가장 최근 감사 로그 (audit-writer 후처리가 끝날 때까지 기다림) */
let testStartedAt = new Date();
const lastAudit = (action) => waitFor(async () => (await mongo.col('audit_log'))
  .find({ action, created_at: { $gte: testStartedAt } }).sort({ created_at: -1, _id: -1 }).limit(1).next(),
{ message: `감사 로그 ${action}` });

let server; let admin; let user; let anon; let worker;
before(async () => {
  await setup();
  worker = await startWorker();
  server = await startServer();
  admin = new Client(server.base);
  user = new Client(server.base);
  anon = new Client(server.base);
  await admin.login(ACCOUNTS.admin, 'admin');
  await user.login(ACCOUNTS.user);
});
after(async () => { await server.close(); await worker.stop(); await cleanup(); });
beforeEach(async () => {
  testStartedAt = new Date();
  await db.exec(`DELETE FROM ${S.catalog}.promotions`);
  await cart.clear(db, ACCOUNTS.user.id);
  await db.exec(`UPDATE ${S.catalog}.products SET stock = ?, is_active = 1 WHERE article_id = ?`, [ARTICLES.tee.stock, TEE]);
  await writeAnalysis([candidate(ARTICLES.tee), candidate(ARTICLES.sneaker, { score: 0.55, suggested_discount_pct: 20 })]);
});

describe('할인가 계산', () => {
  test('100원 단위 반올림', async () => {
    assert.equal(promotion.salePrice(12900, 20), 10300); // 10,320
    assert.equal(promotion.salePrice(59000, 30), 41300);
    assert.equal(promotion.salePrice(19900, 15), 16900); // 16,915
  });

  test('SQL 계산과 JS 계산이 같음', async () => {
    for (const pct of [5, 10, 15, 20, 25, 30, 33, 50, 70]) {
      await promotion.approve({ articleId: TEE, discountPct: pct, actor: ACTOR() });
      assert.equal((await product.get(TEE)).final_price_krw, promotion.salePrice(12900, pct), `${pct}%`);
    }
  });

  test('할인율은 5~70% 정수만', async () => {
    for (const bad of [0, 4, 71, 100, -10, 12.5, 'abc', '']) {
      assert.throws(() => promotion.parsePct(bad), promotion.PromotionError, String(bad));
    }
    assert.equal(promotion.parsePct('25'), 25);
  });
});

describe('관리자: 추천 검토', () => {
  test('행사 상품 화면에 PyTorch 추천 후보와 추천 할인율·할인가가 보임', async () => {
    const res = await admin.get('/admin/promotions');
    assert.equal(res.status, 200);
    assert.match(res.text, /행사 추천 상품/);
    assert.match(res.text, new RegExp(`name="article_id" value="${TEE}"`));
    assert.match(res.text, /재고 27주분 · 최근 4주 판매 -83%/);
    assert.match(res.text, /추천 30% 적용 시 ₩9,000/); // 12,900 × 0.7 = 9,030 → 9,000
  });

  test('대시보드 인사이트에 행사 추천 개수와 검토 링크', async () => {
    const res = await admin.get('/admin');
    assert.match(res.text, /행사 후보로 추천했습니다/);
    assert.match(res.text, /href="\/admin\/promotions"/);
  });

  test('승인 전에는 이용자 화면에 행사로 보이지 않음 (추천 ≠ 노출)', async () => {
    assert.equal((await product.list({ sale: true })).total, 0);
    const sale = await anon.get('/products?sale=1');
    assert.match(sale.text, /조건에 맞는 상품이 없습니다/);
    const detail = await anon.get(`/products/${TEE}`);
    assert.doesNotMatch(detail.text, /행사 상품 · SALE/);
  });

  test('분석 결과가 없으면 안내 문구', async () => {
    await clearAnalysis();
    const res = await admin.get('/admin/promotions');
    assert.equal(res.status, 200);
    assert.match(res.text, /아직 분석 결과가 없습니다/);
  });

  test('예전 분석 결과(promotions 없음)여도 화면이 열림', async () => {
    const { promotions, ...old } = SAMPLE; // eslint-disable-line no-unused-vars
    await clearAnalysis();
    await analysis.saveResult(old, null);
    const res = await admin.get('/admin/promotions');
    assert.equal(res.status, 200);
    assert.match(res.text, /PyTorch 분석을 다시 실행하면/);
  });

  test('품절·판매 중지·없는 상품·이미 행사 중인 상품은 후보에서 제외', async () => {
    await writeAnalysis([
      candidate(ARTICLES.tee), candidate(ARTICLES.retired), candidate({ ...ARTICLES.kidsDress }), candidate({ ...ARTICLES.tee, article_id: '9999999999' }),
    ]);
    await setProduct(ARTICLES.kidsDress.article_id, 'stock', 0);
    await promotion.approve({ articleId: TEE, discountPct: 10, actor: ACTOR() });
    try {
      assert.deepEqual(await promotion.candidates(await analysis.readResult()), []);
    } finally {
      await setProduct(ARTICLES.kidsDress.article_id, 'stock', ARTICLES.kidsDress.stock);
    }
  });

  test('후보에는 분석 시점이 아니라 현재 가격·재고가 붙음', async () => {
    await writeAnalysis([candidate(ARTICLES.tee, { price_krw: 1, stock: 999 })]);
    const [c] = await promotion.candidates(await analysis.readResult());
    assert.equal(c.price_krw, 12900);
    assert.equal(c.stock, ARTICLES.tee.stock);
  });
});

describe('관리자: 승인 → 이용자 화면 노출', () => {
  async function approve(form) {
    await admin.get('/admin/promotions');
    return admin.post('/admin/promotions', form);
  }

  test('승인하면 promotions 에 저장되고 작업 기록이 남음', async () => {
    const res = await approve({ article_id: TEE, discount_pct: '30', reason: '재고 27주분 · 최근 4주 판매 -83%', score: '0.82' });
    assert.equal(res.status, 302);
    assert.equal(res.location, '/admin/promotions');
    const row = (await promotion.get(TEE));
    assert.equal(row.discount_pct, 30);
    assert.equal(row.score, 0.82);
    assert.equal(row.approved_by, ACCOUNTS.admin.id);
    const log = await lastAudit('promotion.approve');
    assert.equal(log.target, TEE);
    assert.equal(log.admin_name, ACCOUNTS.admin.name);
    assert.deepEqual(log.detail, { discount_pct: 30, price_krw: 12900, sale_price_krw: 9000, score: 0.82, reason: '재고 27주분 · 최근 4주 판매 -83%' });
    const page = await admin.get('/admin/promotions');
    assert.match(page.text, /9,000원으로 표시됩니다/);
    assert.match(page.text, /진행 중인 행사 <span class="soft num">1/);
    assert.doesNotMatch(page.text, new RegExp(`id="pct-${TEE}"`), '승인한 상품은 추천 목록에서 빠짐');
  });

  test('관리자가 추천 할인율을 바꿔서 승인할 수 있음', async () => {
    await approve({ article_id: TEE, discount_pct: '15' });
    assert.equal((await promotion.get(TEE)).discount_pct, 15);
  });

  test('이용자 화면: 홈, SALE 목록, 상세에 할인가와 정가가 함께 표시', async () => {
    await approve({ article_id: TEE, discount_pct: '20' });
    const home = await anon.get('/');
    assert.match(home.text, /행사 상품/);
    assert.match(home.text, /SALE 20%/);
    assert.match(home.text, /₩10,300 <s class="list-price">₩12,900<\/s>/);
    const list = await anon.get('/products?sale=1');
    assert.match(list.text, /행사 상품<\/h1>|행사 상품\s*<\/h1>/);
    assert.match(list.text, /1개 상품/);
    assert.match(list.text, /Strap top/);
    assert.doesNotMatch(list.text, /Chunky sneakers/);
    const detail = await anon.get(`/products/${TEE}`);
    assert.match(detail.text, /행사 상품 · SALE/);
    assert.match(detail.text, /₩10,300/);
  });

  test('행사가 없으면 홈에 행사 섹션이 없음', async () => {
    const home = await anon.get('/');
    assert.doesNotMatch(home.text, /<h2 class="h2">행사 상품<\/h2>/);
  });

  test('목록 가격순 정렬은 할인가 기준', async () => {
    await approve({ article_id: SNEAKER, discount_pct: '70' }); // 59,000 → 17,700
    const asc = (await product.list({ sort: 'price_asc' })).items.map((i) => i.final_price_krw);
    assert.deepEqual(asc, [...asc].sort((a, b) => a - b));
    assert.ok(asc.includes(17700));
  });

  test('장바구니·결제·주문에 할인가가 적용되고 주문 후 행사가 끝나도 주문 금액은 그대로', async () => {
    await approve({ article_id: TEE, discount_pct: '20' });
    await user.post('/cart/add', { article_id: TEE, size: 'M', qty: 2 });
    const s = (await cart.summary(ACCOUNTS.user.id));
    assert.equal(s.items[0].price_krw, 10300);
    assert.equal(s.items[0].list_price_krw, 12900);
    assert.equal(s.subtotal, 20600);
    const cartPage = await user.get('/cart');
    assert.match(cartPage.text, /<s class="list-price">₩12,900<\/s>/);
    await user.get('/checkout');
    const res = await user.post('/checkout', { recipient: '김인하', phone: '010', address: '인천', payment_method: 'card', agree: '1' });
    const orderNo = res.location.match(/\/orders\/([^?]+)/)[1];
    await admin.get('/admin/promotions');
    await admin.post(`/admin/promotions/${TEE}/end`);
    const o = (await order.getForUser(orderNo, ACCOUNTS.user.id));
    assert.equal(o.items[0].unit_price_krw, 10300);
    assert.equal(o.total_krw, 20600 + config.shippingFeeKrw);
  });

  test('장바구니에 담은 뒤 행사가 시작되면 결제 시 할인가 적용', async () => {
    await user.post('/cart/add', { article_id: TEE, size: 'M', qty: 1 });
    assert.equal((await cart.summary(ACCOUNTS.user.id)).subtotal, 12900);
    await approve({ article_id: TEE, discount_pct: '50' });
    assert.equal((await cart.summary(ACCOUNTS.user.id)).subtotal, 6500); // 6,450 → 6,500
  });

  test('정가를 바꾸면 할인가도 따라 바뀜', async () => {
    await approve({ article_id: TEE, discount_pct: '10' });
    await setProduct(TEE, 'price_krw', 20000);
    try {
      assert.equal((await product.get(TEE)).final_price_krw, 18000);
    } finally {
      await setProduct(TEE, 'price_krw', 12900);
    }
  });

  test('할인율 변경 → promotion.update 기록', async () => {
    await approve({ article_id: TEE, discount_pct: '10' });
    await approve({ article_id: TEE, discount_pct: '25' });
    assert.equal((await promotion.get(TEE)).discount_pct, 25);
    const log = await lastAudit('promotion.update');
    assert.deepEqual(log.detail.discount_pct, [10, 25]);
  });

  test('행사 종료 → 정가로 복귀, 작업 기록', async () => {
    await approve({ article_id: TEE, discount_pct: '20' });
    const res = await admin.post(`/admin/promotions/${TEE}/end`);
    assert.equal(res.status, 302);
    assert.equal((await promotion.get(TEE)), undefined);
    assert.equal((await product.get(TEE)).final_price_krw, 12900);
    assert.equal((await lastAudit('promotion.end')).target, TEE);
    const detail = await anon.get(`/products/${TEE}`);
    assert.doesNotMatch(detail.text, /행사 상품 · SALE/);
  });

  test('행사 중이 아닌 상품 종료는 오류 메시지 (500 아님)', async () => {
    await admin.get('/admin/promotions');
    const res = await admin.post(`/admin/promotions/${TEE}/end`);
    assert.equal(res.status, 302);
    assert.match((await admin.get('/admin/promotions')).text, /진행 중인 행사가 아닙니다/);
  });

  for (const [label, form, msg] of [
    ['할인율 범위 밖', { article_id: TEE, discount_pct: '90' }, /5~70%/],
    ['할인율 누락', { article_id: TEE }, /5~70%/],
    ['없는 상품', { article_id: '9999999999', discount_pct: '20' }, /상품을 찾을 수 없습니다/],
    ['판매 중지 상품', { article_id: ARTICLES.retired.article_id, discount_pct: '20' }, /판매 중지된 상품/],
  ]) {
    test(`${label} → 등록되지 않고 오류 안내`, async () => {
      const res = await approve(form);
      assert.equal(res.status, 302);
      assert.equal((await promotion.count()), 0);
      assert.match((await admin.get('/admin/promotions')).text, msg);
    });
  }

  test('판매 중지되면 행사 중이어도 이용자 화면에서 사라짐', async () => {
    await approve({ article_id: TEE, discount_pct: '20' });
    await setProduct(TEE, 'is_active', 0);
    assert.equal((await product.list({ sale: true })).total, 0);
    assert.match((await admin.get('/admin/promotions')).text, /판매 중지 상태/);
  });

  test('관리자 상품 관리 화면(Elasticsearch)에 행사 표시 — search-indexer 후처리로 반영', async () => {
    await approve({ article_id: TEE, discount_pct: '20' });
    const res = await waitFor(async () => {
      const r = await admin.get(`/admin/products?q=${TEE}`);
      return /행사 20% · ₩10,300/.test(r.text) && r;
    }, { message: 'ES 행사 색인' });
    assert.match(res.text, /행사 20% · ₩10,300/);
    // 행사 필터 + 패싯
    const sale = await admin.get('/admin/products?sale=1');
    assert.match(sale.text, /Strap top/);
    assert.doesNotMatch(sale.text, /Chunky sneakers/);
  });

  test('작업 기록 화면에 한글 이름으로 표시', async () => {
    await approve({ article_id: TEE, discount_pct: '20' });
    await lastAudit('promotion.approve');
    assert.match((await admin.get('/admin/audit')).text, /행사 승인/);
  });
});

describe('권한', () => {
  test('이용자는 행사 관리 화면/승인/종료 불가 (403)', async () => {
    assert.equal((await user.get('/admin/promotions')).status, 403);
    await user.get('/cart');
    assert.equal((await user.post('/admin/promotions', { article_id: TEE, discount_pct: '70' })).status, 403);
    assert.equal((await user.post(`/admin/promotions/${TEE}/end`)).status, 403);
    assert.equal((await promotion.count()), 0);
  });

  test('비로그인은 관리자 로그인으로', async () => {
    assert.equal((await anon.get('/admin/promotions')).location, '/login?as=admin');
  });
});
