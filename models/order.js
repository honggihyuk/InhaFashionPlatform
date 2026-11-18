// 주문 모델 (MySQL member 스키마)
//
// 한 트랜잭션에 반드시 있어야 하는 것만 트랜잭션 안에서 처리합니다:
//   재고 확인·차감, 주문/주문상품 생성, 장바구니 비우기, outbox 이벤트 기록
// 트랜잭션 밖(RabbitMQ 후처리)으로 분리한 것:
//   주문 알림 생성(MongoDB), 검색 색인 재고 갱신(Elasticsearch), 구매 활동 로그(MongoDB)
const crypto = require('crypto');
const db = require('../db/mysql');
const outbox = require('../messaging/outbox');
const cart = require('./cart');
const { imageUrl } = require('./product');

const { S } = db;
const STATUS_LABEL = { PAID: '결제완료', SHIPPING: '배송중', DELIVERED: '배송완료', CANCELLED: '주문취소' };

class OrderError extends Error {}

function newOrderNo() {
  const d = new Date();
  const ymd = `${d.getFullYear()}${String(d.getMonth() + 1).padStart(2, '0')}${String(d.getDate()).padStart(2, '0')}`;
  return `IF${ymd}-${crypto.randomBytes(3).toString('hex').toUpperCase()}`;
}

/** 장바구니 → 주문. 재고 확인, 차감, 주문 생성, 장바구니 비우기 + order.placed 이벤트(outbox) */
async function placeFromCart(user, { recipient, phone, address, payment_method }) {
  return db.transaction(async (tx) => {
    const { items, total } = await cart.summary(user.id, tx, { lock: true });
    if (!items.length) throw new OrderError('장바구니가 비어 있습니다.');
    for (const it of items) {
      if (!it.is_active) throw new OrderError(`${it.prod_name} 상품은 현재 판매 중이 아닙니다.`);
      if (it.stock < it.qty) throw new OrderError(`${it.prod_name} 재고가 부족합니다. (남은 수량 ${it.stock}개)`);
    }
    const orderNo = newOrderNo();
    const r = await tx.exec(`INSERT INTO ${S.member}.orders (order_no, user_id, total_krw, recipient, phone, address, payment_method)
      VALUES (?, ?, ?, ?, ?, ?, ?)`, [orderNo, user.id, total, recipient, phone, address, payment_method]);
    const orderId = r.insertId;
    for (const it of items) {
      await tx.exec(`INSERT INTO ${S.member}.order_items (order_id, article_id, prod_name, size, qty, unit_price_krw)
        VALUES (?, ?, ?, ?, ?, ?)`, [orderId, it.article_id, it.prod_name, it.size, it.qty, it.price_krw]);
      const u = await tx.exec(`UPDATE ${S.catalog}.products SET stock = stock - ?, popularity = popularity + ?
        WHERE article_id = ? AND stock >= ?`, [it.qty, it.qty, it.article_id, it.qty]);
      if (u.affectedRows !== 1) throw new OrderError(`${it.prod_name} 재고가 부족합니다.`);
    }
    await cart.clear(tx, user.id);
    await outbox.enqueue(tx, 'member', 'order.placed', {
      order_id: orderId, order_no: orderNo, user_id: user.id, total_krw: total,
      items: items.map((i) => ({ article_id: i.article_id, prod_name: i.prod_name, size: i.size, qty: i.qty, unit_price_krw: i.price_krw })),
      article_ids: items.map((i) => i.article_id),
    }, { type: 'user', id: user.id, name: user.name });
    return orderNo;
  });
}

async function withItems(order, runner = db) {
  if (!order) return order;
  order.items = (await runner.query(`SELECT * FROM ${S.member}.order_items WHERE order_id = ?`, [order.id]))
    .map((i) => ({ ...i, image: imageUrl(i.article_id) }));
  order.status_label = STATUS_LABEL[order.status];
  return order;
}

async function listByUser(userId) {
  const rows = await db.query(`SELECT o.*, (SELECT COUNT(*) FROM ${S.member}.order_items i WHERE i.order_id = o.id) AS item_count
    FROM ${S.member}.orders o WHERE o.user_id = ? ORDER BY o.id DESC`, [userId]);
  return rows.map((o) => ({ ...o, status_label: STATUS_LABEL[o.status] }));
}

async function getForUser(orderNo, userId, runner = db, { lock = false } = {}) {
  const o = await runner.one(`SELECT * FROM ${S.member}.orders WHERE order_no = ? AND user_id = ?${lock ? ' FOR UPDATE' : ''}`, [orderNo, userId]);
  return withItems(o, runner);
}

async function restock(tx, order) {
  for (const it of order.items) {
    await tx.exec(`UPDATE ${S.catalog}.products SET stock = stock + ? WHERE article_id = ?`, [it.qty, it.article_id]);
  }
}

async function cancelByUser(orderNo, user) {
  return db.transaction(async (tx) => {
    const order = await getForUser(orderNo, user.id, tx, { lock: true });
    if (!order) throw new OrderError('주문을 찾을 수 없습니다.');
    if (order.status !== 'PAID') throw new OrderError('결제완료 상태의 주문만 취소할 수 있습니다.');
    await restock(tx, order);
    await tx.exec(`UPDATE ${S.member}.orders SET status = 'CANCELLED' WHERE id = ?`, [order.id]);
    await outbox.enqueue(tx, 'member', 'order.cancelled', {
      order_id: order.id, order_no: order.order_no, user_id: user.id, total_krw: order.total_krw, by: 'user',
      article_ids: order.items.map((i) => i.article_id),
    }, { type: 'user', id: user.id, name: user.name });
  });
}

// ---- 관리자용 ----
async function adminList({ status, page = 1, limit = 30 } = {}) {
  const where = status ? 'WHERE o.status = :status' : '';
  const params = status ? { status } : {};
  const total = (await db.one(`SELECT COUNT(*) AS n FROM ${S.member}.orders o ${where}`, params)).n;
  const rows = (await db.query(`SELECT o.*, u.name AS user_name, u.email AS user_email,
      (SELECT SUM(qty) FROM ${S.member}.order_items i WHERE i.order_id = o.id) AS units
    FROM ${S.member}.orders o JOIN ${S.member}.users u ON u.id = o.user_id ${where}
    ORDER BY o.created_at DESC, o.id DESC LIMIT ${Number(limit)} OFFSET ${(page - 1) * limit}`, params))
    .map((o) => ({ ...o, units: Number(o.units), status_label: STATUS_LABEL[o.status] }));
  return { rows, total, page, pages: Math.max(Math.ceil(total / limit), 1) };
}

async function adminUpdateStatus(orderId, status, actor) {
  if (!STATUS_LABEL[status]) throw new OrderError('알 수 없는 주문 상태입니다.');
  return db.transaction(async (tx) => {
    const order = await withItems(await tx.one(`SELECT * FROM ${S.member}.orders WHERE id = ? FOR UPDATE`, [orderId]), tx);
    if (!order) throw new OrderError('주문을 찾을 수 없습니다.');
    if (order.status === 'CANCELLED') throw new OrderError('취소된 주문은 변경할 수 없습니다.');
    if (status === 'CANCELLED') await restock(tx, order);
    await tx.exec(`UPDATE ${S.member}.orders SET status = ? WHERE id = ?`, [status, orderId]);
    await outbox.enqueue(tx, 'admin', 'order.status_changed', {
      order_id: order.id, order_no: order.order_no, user_id: order.user_id, from: order.status, to: status,
      article_ids: order.items.map((i) => i.article_id),
      target: order.order_no, detail: { from: order.status, to: status },
    }, actor);
    return order;
  });
}

/** 관리자 대시보드: 플랫폼 주문 실시간 지표 (시간 정보가 있는 자체 주문 기준) */
async function platformStats() {
  const today = await db.one(`SELECT COUNT(*) AS orders, COALESCE(SUM(total_krw), 0) AS revenue
    FROM ${S.member}.orders WHERE status <> 'CANCELLED' AND DATE(created_at) = CURRENT_DATE()`);
  const all = await db.one(`SELECT COUNT(*) AS orders, COALESCE(SUM(total_krw), 0) AS revenue
    FROM ${S.member}.orders WHERE status <> 'CANCELLED'`);
  const pending = (await db.one(`SELECT COUNT(*) AS n FROM ${S.member}.orders WHERE status = 'PAID'`)).n;
  const todayHourly = await db.query(`SELECT HOUR(created_at) AS hour, COUNT(*) AS orders, SUM(total_krw) AS revenue
    FROM ${S.member}.orders WHERE status <> 'CANCELLED' AND DATE(created_at) = CURRENT_DATE() GROUP BY hour ORDER BY hour`);
  const num = (o) => Object.fromEntries(Object.entries(o).map(([k, v]) => [k, Number(v)]));
  return { today: num(today), all: num(all), pending: Number(pending), todayHourly: todayHourly.map(num) };
}

module.exports = { placeFromCart, listByUser, getForUser, cancelByUser, adminList, adminUpdateStatus, platformStats, OrderError, STATUS_LABEL };
