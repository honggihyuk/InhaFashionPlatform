// 주문 모델 (member 스키마) — 결제/재고 차감을 하나의 트랜잭션으로 처리
const crypto = require('crypto');
const { db, transaction } = require('../db/connection');
const cart = require('./cart');
const { imageUrl } = require('./product');

const STATUS_LABEL = { PAID: '결제완료', SHIPPING: '배송중', DELIVERED: '배송완료', CANCELLED: '주문취소' };

class OrderError extends Error {}

function newOrderNo() {
  const d = new Date();
  const ymd = `${d.getFullYear()}${String(d.getMonth() + 1).padStart(2, '0')}${String(d.getDate()).padStart(2, '0')}`;
  return `IF${ymd}-${crypto.randomBytes(3).toString('hex').toUpperCase()}`;
}

/** 장바구니 → 주문. 재고 확인, 차감, 주문 생성, 장바구니 비우기 */
function placeFromCart(userId, { recipient, phone, address, payment_method }) {
  return transaction(() => {
    const { items, total } = cart.summary(userId);
    if (!items.length) throw new OrderError('장바구니가 비어 있습니다.');
    for (const it of items) {
      if (!it.is_active) throw new OrderError(`${it.prod_name} 상품은 현재 판매 중이 아닙니다.`);
      if (it.stock < it.qty) throw new OrderError(`${it.prod_name} 재고가 부족합니다. (남은 수량 ${it.stock}개)`);
    }
    const orderNo = newOrderNo();
    const info = db.prepare(`INSERT INTO member.orders (order_no, user_id, total_krw, recipient, phone, address, payment_method)
      VALUES (?, ?, ?, ?, ?, ?, ?)`).run(orderNo, userId, total, recipient, phone, address, payment_method);
    const orderId = Number(info.lastInsertRowid);
    const insItem = db.prepare(`INSERT INTO member.order_items (order_id, article_id, prod_name, size, qty, unit_price_krw)
      VALUES (?, ?, ?, ?, ?, ?)`);
    const decStock = db.prepare(`UPDATE products SET stock = stock - ?, popularity = popularity + ?, updated_at = datetime('now')
      WHERE article_id = ? AND stock >= ?`);
    for (const it of items) {
      insItem.run(orderId, it.article_id, it.prod_name, it.size, it.qty, it.price_krw);
      const r = decStock.run(it.qty, it.qty, it.article_id, it.qty);
      if (r.changes !== 1) throw new OrderError(`${it.prod_name} 재고가 부족합니다.`);
    }
    cart.clear(userId);
    return orderNo;
  });
}

function withItems(order) {
  if (!order) return order;
  order.items = db.prepare('SELECT * FROM member.order_items WHERE order_id = ?').all(order.id)
    .map((i) => ({ ...i, image: imageUrl(i.article_id) }));
  order.status_label = STATUS_LABEL[order.status];
  return order;
}

function listByUser(userId) {
  return db.prepare(`SELECT o.*, (SELECT COUNT(*) FROM member.order_items i WHERE i.order_id = o.id) AS item_count
    FROM member.orders o WHERE o.user_id = ? ORDER BY o.id DESC`).all(userId)
    .map((o) => ({ ...o, status_label: STATUS_LABEL[o.status] }));
}

function getForUser(orderNo, userId) {
  return withItems(db.prepare('SELECT * FROM member.orders WHERE order_no = ? AND user_id = ?').get(orderNo, userId));
}

function cancelByUser(orderNo, userId) {
  return transaction(() => {
    const order = getForUser(orderNo, userId);
    if (!order) throw new OrderError('주문을 찾을 수 없습니다.');
    if (order.status !== 'PAID') throw new OrderError('결제완료 상태의 주문만 취소할 수 있습니다.');
    restock(order);
    db.prepare("UPDATE member.orders SET status = 'CANCELLED' WHERE id = ?").run(order.id);
  });
}

function restock(order) {
  const st = db.prepare('UPDATE products SET stock = stock + ? WHERE article_id = ?');
  for (const it of order.items) st.run(it.qty, it.article_id);
}

// ---- 관리자용 ----
function adminList({ status, page = 1, limit = 30 } = {}) {
  const where = status ? 'WHERE o.status = :status' : '';
  const params = status ? { status } : {};
  const total = db.prepare(`SELECT COUNT(*) AS n FROM member.orders o ${where}`).get(params).n;
  const rows = db.prepare(`SELECT o.*, u.name AS user_name, u.email AS user_email,
      (SELECT SUM(qty) FROM member.order_items i WHERE i.order_id = o.id) AS units
    FROM member.orders o JOIN member.users u ON u.id = o.user_id ${where}
    ORDER BY o.created_at DESC, o.id DESC LIMIT :limit OFFSET :offset`)
    .all({ ...params, limit, offset: (page - 1) * limit })
    .map((o) => ({ ...o, status_label: STATUS_LABEL[o.status] }));
  return { rows, total, page, pages: Math.max(Math.ceil(total / limit), 1) };
}

function adminUpdateStatus(orderId, status) {
  if (!STATUS_LABEL[status]) throw new OrderError('알 수 없는 주문 상태입니다.');
  return transaction(() => {
    const order = withItems(db.prepare('SELECT * FROM member.orders WHERE id = ?').get(orderId));
    if (!order) throw new OrderError('주문을 찾을 수 없습니다.');
    if (order.status === 'CANCELLED') throw new OrderError('취소된 주문은 변경할 수 없습니다.');
    if (status === 'CANCELLED') restock(order);
    db.prepare('UPDATE member.orders SET status = ? WHERE id = ?').run(status, orderId);
    return order;
  });
}

/** 관리자 대시보드: 플랫폼 주문 실시간 지표 (시간 정보가 있는 자체 주문 기준) */
function platformStats() {
  const today = db.prepare(`SELECT COUNT(*) AS orders, COALESCE(SUM(total_krw), 0) AS revenue
    FROM member.orders WHERE status <> 'CANCELLED' AND date(created_at) = date('now', 'localtime')`).get();
  const all = db.prepare(`SELECT COUNT(*) AS orders, COALESCE(SUM(total_krw), 0) AS revenue
    FROM member.orders WHERE status <> 'CANCELLED'`).get();
  const pending = db.prepare("SELECT COUNT(*) AS n FROM member.orders WHERE status = 'PAID'").get().n;
  const todayHourly = db.prepare(`SELECT CAST(strftime('%H', created_at) AS INTEGER) AS hour, COUNT(*) AS orders,
      SUM(total_krw) AS revenue FROM member.orders
    WHERE status <> 'CANCELLED' AND date(created_at) = date('now', 'localtime') GROUP BY hour`).all();
  return { today, all, pending, todayHourly };
}

module.exports = { placeFromCart, listByUser, getForUser, cancelByUser, adminList, adminUpdateStatus, platformStats, OrderError, STATUS_LABEL };
