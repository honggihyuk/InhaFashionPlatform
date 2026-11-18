// 행사 상품: PyTorch 추천(sales_trends.json 의 promotions) → 관리자 승인 → 이용자 화면 노출 → 장바구니/주문에 할인가 적용
const { test, describe, before, after, beforeEach } = require('node:test');
const assert = require('node:assert/strict');
const fs = require('fs');
const path = require('path');
const { setup, startServer, Client, ACCOUNTS, ARTICLES, db, config } = require('./helpers/setup');

setup();
const promotion = require('../models/promotion');
const product = require('../models/product');
const cart = require('../models/cart');
const order = require('../models/order');

const TEE = ARTICLES.tee.article_id; // 정가 12,900
const SNEAKER = ARTICLES.sneaker.article_id; // 정가 59,000
const SAMPLE = JSON.parse(fs.readFileSync(path.join(__dirname, 'fixtures', 'sales_trends.sample.json'), 'utf8'));

/** PyTorch 분석 결과 파일을 테스트 상품 기준 추천으로 만들어 둠 */
function writeAnalysis(promotions) {
  fs.mkdirSync(path.dirname(config.analysis.resultFile), { recursive: true });
  fs.writeFileSync(config.analysis.resultFile, JSON.stringify({ ...SAMPLE, promotions }));
}
const candidate = (a, extra = {}) => ({
  article_id: a.article_id, prod_name: a.prod_name, product_group: a.product_group_name, stock: a.stock, price_krw: a.price_krw,
  weekly_units: [6, 5, 4, 3, 2, 1, 0, 0], recent_4w_units: 3, prev_4w_units: 18, change_pct: -83.3, weeks_of_cover: 26.7,
  trend_pct_per_week: -30.5, score: 0.82, suggested_discount_pct: 30, reasons: ['재고 27주분', '최근 4주 판매 -83%'], ...extra,
});
const lastAudit = () => db.prepare('SELECT * FROM admin.audit_log ORDER BY id DESC LIMIT 1').get();

let server; let admin; let user; let anon;
before(async () => {
  server = await startServer();
  admin = new Client(server.base);
  user = new Client(server.base);
  anon = new Client(server.base);
  await admin.login(ACCOUNTS.admin, 'admin');
  await user.login(ACCOUNTS.user);
});
after(async () => { await server.close(); });
beforeEach(() => {
  db.exec('DELETE FROM promotions');
  cart.clear(ACCOUNTS.user.id);
  db.prepare('UPDATE products SET stock = ?, is_active = 1 WHERE article_id = ?').run(ARTICLES.tee.stock, TEE);
  writeAnalysis([candidate(ARTICLES.tee), candidate(ARTICLES.sneaker, { score: 0.55, suggested_discount_pct: 20 })]);
});

describe('할인가 계산', () => {
  test('100원 단위 반올림', () => {
    assert.equal(promotion.salePrice(12900, 20), 10300); // 10,320
    assert.equal(promotion.salePrice(59000, 30), 41300);
    assert.equal(promotion.salePrice(19900, 15), 16900); // 16,915
  });

  test('SQL 계산과 JS 계산이 같음', () => {
    for (const pct of [5, 10, 15, 20, 25, 30, 33, 50, 70]) {
      promotion.approve({ articleId: TEE, discountPct: pct, adminId: ACCOUNTS.admin.id });
      assert.equal(product.get(TEE).final_price_krw, promotion.salePrice(12900, pct), `${pct}%`);
    }
  });

  test('할인율은 5~70% 정수만', () => {
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
    assert.equal(product.list({ sale: true }).total, 0);
    const sale = await anon.get('/products?sale=1');
    assert.match(sale.text, /조건에 맞는 상품이 없습니다/);
    const detail = await anon.get(`/products/${TEE}`);
    assert.doesNotMatch(detail.text, /행사 상품 · SALE/);
  });

  test('분석 결과가 없으면 안내 문구', async () => {
    fs.rmSync(config.analysis.resultFile, { force: true });
    const res = await admin.get('/admin/promotions');
    assert.equal(res.status, 200);
    assert.match(res.text, /아직 분석 결과가 없습니다/);
  });

  test('예전 분석 결과(promotions 없음)여도 화면이 열림', async () => {
    const { promotions, ...old } = SAMPLE; // eslint-disable-line no-unused-vars
    fs.writeFileSync(config.analysis.resultFile, JSON.stringify(old));
    const res = await admin.get('/admin/promotions');
    assert.equal(res.status, 200);
    assert.match(res.text, /PyTorch 분석을 다시 실행하면/);
  });

  test('품절·판매 중지·없는 상품·이미 행사 중인 상품은 후보에서 제외', () => {
    writeAnalysis([
      candidate(ARTICLES.tee), candidate(ARTICLES.retired), candidate({ ...ARTICLES.kidsDress }), candidate({ ...ARTICLES.tee, article_id: '9999999999' }),
    ]);
    db.prepare('UPDATE products SET stock = 0 WHERE article_id = ?').run(ARTICLES.kidsDress.article_id);
    promotion.approve({ articleId: TEE, discountPct: 10, adminId: ACCOUNTS.admin.id });
    try {
      assert.deepEqual(promotion.candidates(JSON.parse(fs.readFileSync(config.analysis.resultFile, 'utf8'))), []);
    } finally {
      db.prepare('UPDATE products SET stock = ? WHERE article_id = ?').run(ARTICLES.kidsDress.stock, ARTICLES.kidsDress.article_id);
    }
  });

  test('후보에는 분석 시점이 아니라 현재 가격·재고가 붙음', () => {
    writeAnalysis([candidate(ARTICLES.tee, { price_krw: 1, stock: 999 })]);
    const [c] = promotion.candidates(JSON.parse(fs.readFileSync(config.analysis.resultFile, 'utf8')));
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
    const row = promotion.get(TEE);
    assert.equal(row.discount_pct, 30);
    assert.equal(row.score, 0.82);
    assert.equal(row.approved_by, ACCOUNTS.admin.id);
    const log = lastAudit();
    assert.equal(log.action, 'promotion.approve');
    assert.equal(log.target, TEE);
    assert.deepEqual(JSON.parse(log.detail), { discount_pct: 30, price_krw: 12900, sale_price_krw: 9000, score: 0.82, reason: '재고 27주분 · 최근 4주 판매 -83%' });
    const page = await admin.get('/admin/promotions');
    assert.match(page.text, /9,000원으로 표시됩니다/);
    assert.match(page.text, /진행 중인 행사 <span class="soft num">1/);
    assert.doesNotMatch(page.text, new RegExp(`id="pct-${TEE}"`), '승인한 상품은 추천 목록에서 빠짐');
  });

  test('관리자가 추천 할인율을 바꿔서 승인할 수 있음', async () => {
    await approve({ article_id: TEE, discount_pct: '15' });
    assert.equal(promotion.get(TEE).discount_pct, 15);
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
    const asc = product.list({ sort: 'price_asc' }).items.map((i) => i.final_price_krw);
    assert.deepEqual(asc, [...asc].sort((a, b) => a - b));
    assert.ok(asc.includes(17700));
  });

  test('장바구니·결제·주문에 할인가가 적용되고 주문 후 행사가 끝나도 주문 금액은 그대로', async () => {
    await approve({ article_id: TEE, discount_pct: '20' });
    await user.post('/cart/add', { article_id: TEE, size: 'M', qty: 2 });
    const s = cart.summary(ACCOUNTS.user.id);
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
    const o = order.getForUser(orderNo, ACCOUNTS.user.id);
    assert.equal(o.items[0].unit_price_krw, 10300);
    assert.equal(o.total_krw, 20600 + config.shippingFeeKrw);
  });

  test('장바구니에 담은 뒤 행사가 시작되면 결제 시 할인가 적용', async () => {
    await user.post('/cart/add', { article_id: TEE, size: 'M', qty: 1 });
    assert.equal(cart.summary(ACCOUNTS.user.id).subtotal, 12900);
    await approve({ article_id: TEE, discount_pct: '50' });
    assert.equal(cart.summary(ACCOUNTS.user.id).subtotal, 6500); // 6,450 → 6,500
  });

  test('정가를 바꾸면 할인가도 따라 바뀜', async () => {
    await approve({ article_id: TEE, discount_pct: '10' });
    db.prepare('UPDATE products SET price_krw = 20000 WHERE article_id = ?').run(TEE);
    try {
      assert.equal(product.get(TEE).final_price_krw, 18000);
    } finally {
      db.prepare('UPDATE products SET price_krw = 12900 WHERE article_id = ?').run(TEE);
    }
  });

  test('할인율 변경 → promotion.update 기록', async () => {
    await approve({ article_id: TEE, discount_pct: '10' });
    await approve({ article_id: TEE, discount_pct: '25' });
    assert.equal(promotion.get(TEE).discount_pct, 25);
    const log = lastAudit();
    assert.equal(log.action, 'promotion.update');
    assert.deepEqual(JSON.parse(log.detail).discount_pct, [10, 25]);
  });

  test('행사 종료 → 정가로 복귀, 작업 기록', async () => {
    await approve({ article_id: TEE, discount_pct: '20' });
    const res = await admin.post(`/admin/promotions/${TEE}/end`);
    assert.equal(res.status, 302);
    assert.equal(promotion.get(TEE), undefined);
    assert.equal(product.get(TEE).final_price_krw, 12900);
    assert.equal(lastAudit().action, 'promotion.end');
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
      assert.equal(promotion.count(), 0);
      assert.match((await admin.get('/admin/promotions')).text, msg);
    });
  }

  test('판매 중지되면 행사 중이어도 이용자 화면에서 사라짐', async () => {
    await approve({ article_id: TEE, discount_pct: '20' });
    db.prepare('UPDATE products SET is_active = 0 WHERE article_id = ?').run(TEE);
    assert.equal(product.list({ sale: true }).total, 0);
    assert.match((await admin.get('/admin/promotions')).text, /판매 중지 상태/);
  });

  test('관리자 상품 관리 화면에 행사 표시', async () => {
    await approve({ article_id: TEE, discount_pct: '20' });
    const res = await admin.get('/admin/products');
    assert.match(res.text, /행사 20% · ₩10,300/);
  });

  test('작업 기록 화면에 한글 이름으로 표시', async () => {
    await approve({ article_id: TEE, discount_pct: '20' });
    assert.match((await admin.get('/admin/audit')).text, /행사 승인/);
  });
});

describe('권한', () => {
  test('이용자는 행사 관리 화면/승인/종료 불가 (403)', async () => {
    assert.equal((await user.get('/admin/promotions')).status, 403);
    await user.get('/cart');
    assert.equal((await user.post('/admin/promotions', { article_id: TEE, discount_pct: '70' })).status, 403);
    assert.equal((await user.post(`/admin/promotions/${TEE}/end`)).status, 403);
    assert.equal(promotion.count(), 0);
  });

  test('비로그인은 관리자 로그인으로', async () => {
    assert.equal((await anon.get('/admin/promotions')).location, '/login?as=admin');
  });
});
