// 장바구니 → 결제 → 주문 내역 → 주문 취소, 재고 차감/복구, 주문 소유권
const { test, describe, before, after, beforeEach } = require('node:test');
const assert = require('node:assert/strict');
const { setup, cleanup, startServer, Client, ACCOUNTS, ARTICLES, db, S, config } = require('./helpers/setup');

const cart = require('../models/cart');
const order = require('../models/order');

const TEE = ARTICLES.tee.article_id;
const SNEAKER = ARTICLES.sneaker.article_id;
const stockOf = async (id) => (await db.one(`SELECT stock FROM ${S.catalog}.products WHERE article_id = ?`, [id])).stock;
const popularityOf = async (id) => (await db.one(`SELECT popularity FROM ${S.catalog}.products WHERE article_id = ?`, [id])).popularity;
const setStock = (id, n) => db.exec(`UPDATE ${S.catalog}.products SET stock = ? WHERE article_id = ?`, [n, id]);
const setProduct = (id, col, v) => db.exec(`UPDATE ${S.catalog}.products SET ${col} = ? WHERE article_id = ?`, [v, id]);
const SHIPPING = { recipient: '김인하', phone: '010-1234-5678', address: '인천광역시 미추홀구 인하로 100', payment_method: 'card', agree: '1' };

let server; let user; let other;
before(async () => {
  await setup({ index: false });
  server = await startServer();
  user = new Client(server.base);
  other = new Client(server.base);
  await user.login(ACCOUNTS.user);
  await other.login(ACCOUNTS.other);
});
after(async () => { await server.close(); await cleanup(); });
beforeEach(async () => {
  await cart.clear(db, ACCOUNTS.user.id);
  await cart.clear(db, ACCOUNTS.other.id);
  await setStock(TEE, ARTICLES.tee.stock);
  await setStock(SNEAKER, ARTICLES.sneaker.stock);
});

/** 결제까지 진행하고 주문번호를 돌려줌 */
async function placeOrder(client, items, shipping = SHIPPING) {
  for (const [article_id, size, qty] of items) await client.post('/cart/add', { article_id, size, qty });
  await client.get('/checkout');
  const res = await client.post('/checkout', shipping);
  assert.equal(res.status, 302, `결제 실패: ${res.text.match(/class="[^"]*error[^"]*"[^>]*>([^<]+)/)?.[1]}`);
  const m = res.location.match(/^\/orders\/(IF\d{8}-[0-9A-F]{6})\?placed=1$/);
  assert.ok(m, `주문 완료 페이지로 이동해야 함: ${res.location}`);
  return m[1];
}

describe('장바구니', () => {
  test('담기 → 개수와 합계가 반영', async () => {
    const res = await user.post('/cart/add', { article_id: TEE, size: 'M', qty: 2 });
    assert.equal(res.location, `/products/${TEE}`);
    const s = (await cart.summary(ACCOUNTS.user.id));
    assert.equal(s.count, 2);
    assert.equal(s.subtotal, 2 * 12900);
  });

  test('같은 상품·사이즈는 수량이 합쳐지고 최대 10개', async () => {
    await cart.add(db, ACCOUNTS.user.id, SNEAKER, '42', 6);
    await cart.add(db, ACCOUNTS.user.id, SNEAKER, '42', 6);
    assert.equal((await cart.count(ACCOUNTS.user.id)), 10);
  });

  test('사이즈가 다르면 별도 줄', async () => {
    await cart.add(db, ACCOUNTS.user.id, TEE, 'S', 1);
    await cart.add(db, ACCOUNTS.user.id, TEE, 'M', 1);
    assert.equal((await cart.items(ACCOUNTS.user.id)).length, 2);
  });

  test('상품에 없는 사이즈는 거절', async () => {
    const res = await user.post('/cart/add', { article_id: SNEAKER, size: 'M', qty: 1 }); // 신발은 숫자 사이즈
    assert.equal(res.location, `/products/${SNEAKER}`);
    assert.equal((await cart.count(ACCOUNTS.user.id)), 0);
  });

  test('재고보다 많이 담으면 거절', async () => {
    await user.post('/cart/add', { article_id: TEE, size: 'M', qty: 6 }); // 재고 5
    assert.equal((await cart.count(ACCOUNTS.user.id)), 0);
  });

  test('판매 중지/없는 상품은 거절', async () => {
    await user.post('/cart/add', { article_id: ARTICLES.retired.article_id, size: 'ONE SIZE', qty: 1 });
    await user.post('/cart/add', { article_id: '9999999999', size: 'M', qty: 1 });
    assert.equal((await cart.count(ACCOUNTS.user.id)), 0);
  });

  test('수량은 1~10 으로 보정', async () => {
    await user.post('/cart/add', { article_id: ARTICLES.teeWhite.article_id, size: 'S', qty: -3 });
    assert.equal((await cart.count(ACCOUNTS.user.id)), 1);
    await cart.clear(db, ACCOUNTS.user.id);
    await user.post('/cart/add', { article_id: ARTICLES.teeWhite.article_id, size: 'S', qty: 50 });
    assert.equal((await cart.count(ACCOUNTS.user.id)), 10);
  });

  test('수량 변경과 0 이면 삭제, 삭제 버튼', async () => {
    await cart.add(db, ACCOUNTS.user.id, TEE, 'M', 1);
    await cart.add(db, ACCOUNTS.user.id, SNEAKER, '42', 1);
    await user.get('/cart');
    await user.post('/cart/update', { article_id: TEE, size: 'M', qty: 3 });
    assert.equal((await cart.items(ACCOUNTS.user.id)).find((i) => i.article_id === TEE).qty, 3);
    await user.post('/cart/update', { article_id: TEE, size: 'M', qty: 0 });
    assert.ok(!(await cart.items(ACCOUNTS.user.id)).some((i) => i.article_id === TEE));
    await user.post('/cart/remove', { article_id: SNEAKER, size: '42' });
    assert.equal((await cart.count(ACCOUNTS.user.id)), 0);
  });

  test('바로 구매(buy_now)는 결제 화면으로', async () => {
    const res = await user.post('/cart/add', { article_id: TEE, size: 'M', qty: 1, buy_now: '1' });
    assert.equal(res.location, '/checkout');
  });

  test('다른 이용자의 장바구니와 섞이지 않음', async () => {
    await user.post('/cart/add', { article_id: TEE, size: 'M', qty: 1 });
    assert.equal((await cart.count(ACCOUNTS.other.id)), 0);
  });
});

describe('배송비', () => {
  test(`${config.freeShippingOverKrw.toLocaleString()}원 미만이면 배송비 ${config.shippingFeeKrw}원`, async () => {
    await cart.add(db, ACCOUNTS.user.id, TEE, 'M', 1); // 12,900
    const s = (await cart.summary(ACCOUNTS.user.id));
    assert.equal(s.shipping, config.shippingFeeKrw);
    assert.equal(s.total, 12900 + config.shippingFeeKrw);
  });
  test('기준 금액 이상이면 무료', async () => {
    await cart.add(db, ACCOUNTS.user.id, SNEAKER, '42', 1); // 59,000
    const s = (await cart.summary(ACCOUNTS.user.id));
    assert.equal(s.shipping, 0);
    assert.equal(s.total, 59000);
  });
  test('빈 장바구니는 0원', async () => {
    assert.deepEqual({ ...(await cart.summary(ACCOUNTS.user.id)), items: [] }, { items: [], subtotal: 0, shipping: 0, total: 0, count: 0 });
  });
});

describe('결제(checkout) 입력 검증', () => {
  for (const [label, patch, msg] of [
    ['받는 분 누락', { recipient: '  ' }, /배송 정보를 모두 입력/],
    ['주소 누락', { address: '' }, /배송 정보를 모두 입력/],
    ['알 수 없는 결제수단', { payment_method: 'bitcoin' }, /결제 수단을 선택/],
    ['동의 체크 안 함', { agree: '' }, /동의해 주세요/],
  ]) {
    test(`${label} → 400, 주문이 생기지 않음`, async () => {
      await cart.add(db, ACCOUNTS.user.id, TEE, 'M', 1);
      const before = (await order.listByUser(ACCOUNTS.user.id)).length;
      await user.get('/checkout');
      const res = await user.post('/checkout', { ...SHIPPING, ...patch });
      assert.equal(res.status, 400);
      assert.match(res.text, msg);
      assert.equal((await order.listByUser(ACCOUNTS.user.id)).length, before);
      assert.equal((await cart.count(ACCOUNTS.user.id)), 1, '장바구니는 유지');
    });
  }

  test('빈 장바구니로 결제하면 400', async () => {
    await user.get('/cart');
    const res = await user.post('/checkout', SHIPPING);
    assert.equal(res.status, 400);
    assert.match(res.text, /장바구니가 비어 있습니다/);
  });

  test('결제 화면에 회원 정보가 미리 채워짐', async () => {
    await cart.add(db, ACCOUNTS.user.id, TEE, 'M', 1);
    const res = await user.get('/checkout');
    assert.equal(res.status, 200);
    assert.match(res.text, /인하로 100/);
  });
});

describe('주문 생성', () => {
  test('재고 차감, 인기도 증가, 장바구니 비움, 금액(배송비 포함) 저장', async () => {
    const pop = await popularityOf(TEE);
    const orderNo = await placeOrder(user, [[TEE, 'M', 2]]);
    assert.equal(await stockOf(TEE), ARTICLES.tee.stock - 2);
    assert.equal(await popularityOf(TEE), pop + 2);
    assert.equal((await cart.count(ACCOUNTS.user.id)), 0);
    const o = (await order.getForUser(orderNo, ACCOUNTS.user.id));
    assert.equal(o.status, 'PAID');
    assert.equal(o.status_label, '결제완료');
    assert.equal(o.source, 'web');
    assert.equal(o.total_krw, 2 * 12900 + config.shippingFeeKrw);
    assert.equal(o.items.length, 1);
    assert.equal(o.items[0].unit_price_krw, 12900, '주문 당시 가격을 저장');
    assert.match(o.created_at, /^\d{4}-\d{2}-\d{2} \d{2}:\d{2}:\d{2}$/, '시간대 분석에 쓰이는 주문 시각');
  });

  test('주문 후 상품 가격이 바뀌어도 주문 금액은 그대로', async () => {
    const orderNo = await placeOrder(user, [[SNEAKER, '42', 1]]);
    await setProduct(SNEAKER, 'price_krw', 1);
    try {
      assert.equal((await order.getForUser(orderNo, ACCOUNTS.user.id)).items[0].unit_price_krw, 59000);
    } finally {
      await setProduct(SNEAKER, 'price_krw', 59000);
    }
  });

  test('주문 완료/상세/내역 화면', async () => {
    const orderNo = await placeOrder(user, [[TEE, 'S', 1]]);
    const detail = await user.get(`/orders/${orderNo}?placed=1`);
    assert.equal(detail.status, 200);
    assert.match(detail.text, new RegExp(orderNo));
    const list = await user.get('/orders');
    assert.match(list.text, new RegExp(orderNo));
  });

  test('장바구니에 담은 뒤 재고가 줄면 결제 실패, 전부 롤백', async () => {
    await cart.add(db, ACCOUNTS.user.id, SNEAKER, '42', 1);
    await cart.add(db, ACCOUNTS.user.id, TEE, 'M', 3);
    await setStock(TEE, 2); // 관리자가 재고를 줄임
    const before = (await order.listByUser(ACCOUNTS.user.id)).length;
    await user.get('/checkout');
    const res = await user.post('/checkout', SHIPPING);
    assert.equal(res.status, 400);
    assert.match(res.text, /재고가 부족합니다/);
    assert.equal((await order.listByUser(ACCOUNTS.user.id)).length, before, '주문 없음');
    assert.equal(await stockOf(SNEAKER), ARTICLES.sneaker.stock, '다른 상품 재고도 그대로');
    assert.equal((await cart.count(ACCOUNTS.user.id)), 4, '장바구니 유지');
  });

  test('장바구니에 담은 뒤 판매 중지되면 결제 실패', async () => {
    await cart.add(db, ACCOUNTS.user.id, TEE, 'M', 1);
    await setProduct(TEE, 'is_active', 0);
    try {
      await user.get('/checkout');
      const res = await user.post('/checkout', SHIPPING);
      assert.equal(res.status, 400);
      assert.match(res.text, /판매 중이 아닙니다/);
    } finally {
      await setProduct(TEE, 'is_active', 1);
    }
  });

  test('주문번호는 매번 다름', async () => {
    const a = await placeOrder(user, [[TEE, 'M', 1]]);
    const b = await placeOrder(user, [[TEE, 'M', 1]]);
    assert.notEqual(a, b);
  });
});

describe('주문 소유권', () => {
  test('다른 사람의 주문 상세는 404', async () => {
    const orderNo = await placeOrder(user, [[TEE, 'M', 1]]);
    assert.equal((await other.get(`/orders/${orderNo}`)).status, 404);
  });

  test('다른 사람의 주문은 취소할 수 없음', async () => {
    const orderNo = await placeOrder(user, [[TEE, 'M', 1]]);
    await other.get('/orders');
    await other.post(`/orders/${orderNo}/cancel`);
    assert.equal((await order.getForUser(orderNo, ACCOUNTS.user.id)).status, 'PAID');
    assert.equal(await stockOf(TEE), ARTICLES.tee.stock - 1, '재고도 그대로');
  });

  test('내 주문 내역에는 내 주문만', async () => {
    await placeOrder(user, [[TEE, 'M', 1]]);
    const mine = (await order.listByUser(ACCOUNTS.other.id));
    assert.ok(mine.every((o) => o.user_id === ACCOUNTS.other.id));
  });
});

describe('주문 취소', () => {
  test('결제완료(PAID) 주문 취소 → CANCELLED, 재고 복구', async () => {
    const orderNo = await placeOrder(user, [[TEE, 'M', 2], [SNEAKER, '42', 1]]);
    assert.equal(await stockOf(TEE), 3);
    const res = await user.post(`/orders/${orderNo}/cancel`);
    assert.equal(res.location, `/orders/${orderNo}`);
    assert.equal((await order.getForUser(orderNo, ACCOUNTS.user.id)).status, 'CANCELLED');
    assert.equal(await stockOf(TEE), ARTICLES.tee.stock);
    assert.equal(await stockOf(SNEAKER), ARTICLES.sneaker.stock);
    const page = await user.get(res.location);
    assert.match(page.text, /주문이 취소되었습니다/);
  });

  test('이미 취소한 주문을 다시 취소해도 재고가 두 번 늘지 않음', async () => {
    const orderNo = await placeOrder(user, [[TEE, 'M', 1]]);
    await user.post(`/orders/${orderNo}/cancel`);
    await user.post(`/orders/${orderNo}/cancel`);
    assert.equal(await stockOf(TEE), ARTICLES.tee.stock);
    const page = await user.get(`/orders/${orderNo}`);
    assert.match(page.text, /결제완료 상태의 주문만 취소할 수 있습니다/);
  });

  test('배송중(SHIPPING) 주문은 이용자가 취소할 수 없음', async () => {
    const orderNo = await placeOrder(user, [[TEE, 'M', 1]]);
    const o = (await order.getForUser(orderNo, ACCOUNTS.user.id));
    await order.adminUpdateStatus(o.id, 'SHIPPING');
    await assert.rejects(order.cancelByUser(orderNo, ACCOUNTS.user), order.OrderError);
    assert.equal((await order.getForUser(orderNo, ACCOUNTS.user.id)).status, 'SHIPPING');
  });

  test('없는 주문 취소 → 오류 메시지만, 서버 오류 없음', async () => {
    const res = await user.post('/orders/IF00000000-XXXXXX/cancel');
    assert.equal(res.status, 302);
  });
});

describe('관리자 주문 상태 변경 (모델)', () => {
  test('알 수 없는 상태는 거절', async () => {
    await assert.rejects(order.adminUpdateStatus(1, 'LOST'), /알 수 없는 주문 상태/);
  });

  test('없는 주문은 거절', async () => {
    await assert.rejects(order.adminUpdateStatus(999999, 'SHIPPING'), /주문을 찾을 수 없습니다/);
  });

  test('관리자가 취소하면 재고 복구, 취소된 주문은 다시 바꿀 수 없음', async () => {
    const orderNo = await placeOrder(user, [[TEE, 'M', 2]]);
    const { id } = (await order.getForUser(orderNo, ACCOUNTS.user.id));
    await order.adminUpdateStatus(id, 'CANCELLED');
    assert.equal(await stockOf(TEE), ARTICLES.tee.stock);
    await assert.rejects(order.adminUpdateStatus(id, 'PAID'), /취소된 주문은 변경할 수 없습니다/);
    assert.equal(await stockOf(TEE), ARTICLES.tee.stock);
  });

  test('platformStats: 오늘 주문/매출은 취소 주문 제외, 시간대별 집계', async () => {
    const before = (await order.platformStats());
    const keep = await placeOrder(user, [[SNEAKER, '42', 1]]);
    const drop = await placeOrder(user, [[TEE, 'M', 1]]);
    await user.post(`/orders/${drop}/cancel`);
    const after = (await order.platformStats());
    assert.equal(after.today.orders, before.today.orders + 1);
    assert.equal(after.today.revenue, before.today.revenue + 59000);
    const hour = Number((await order.getForUser(keep, ACCOUNTS.user.id)).created_at.slice(11, 13));
    const slot = after.todayHourly.find((h) => h.hour === hour);
    assert.ok(slot && slot.orders >= 1, '주문 시각의 시간대에 집계');
  });

  test('adminList: 상태 필터와 페이지', async () => {
    await placeOrder(user, [[TEE, 'M', 1]]);
    const all = (await order.adminList());
    const paid = (await order.adminList({ status: 'PAID' }));
    assert.ok(paid.rows.every((o) => o.status === 'PAID'));
    assert.ok(paid.total <= all.total);
    const p = (await order.adminList({ limit: 1, page: 2 }));
    assert.equal(p.rows.length, 1);
    assert.equal(p.pages, all.total);
  });
});
