// 장바구니 모델 (member 스키마)
const { db } = require('../db/connection');
const config = require('../config');
const { imageUrl } = require('./product');
const { FINAL_PRICE_SQL } = require('./promotion');

// price_krw 는 실제 결제 단가(행사 중이면 할인가), list_price_krw 는 정가

function items(userId) {
  return db.prepare(`
    SELECT c.article_id, c.size, c.qty, a.prod_name, a.colour_group_name, a.product_type_name,
           ${FINAL_PRICE_SQL} AS price_krw, p.price_krw AS list_price_krw, pr.discount_pct,
           p.stock, p.is_active, (c.qty * ${FINAL_PRICE_SQL}) AS line_total
    FROM member.cart_items c
    JOIN products p ON p.article_id = c.article_id
    JOIN articles a ON a.article_id = c.article_id
    LEFT JOIN promotions pr ON pr.article_id = c.article_id
    WHERE c.user_id = ? ORDER BY c.added_at`).all(userId)
    .map((r) => ({ ...r, image: imageUrl(r.article_id) }));
}

function summary(userId) {
  const list = items(userId);
  const subtotal = list.reduce((s, i) => s + i.line_total, 0);
  const shipping = subtotal === 0 || subtotal >= config.freeShippingOverKrw ? 0 : config.shippingFeeKrw;
  return { items: list, subtotal, shipping, total: subtotal + shipping, count: list.reduce((s, i) => s + i.qty, 0) };
}

function count(userId) {
  return db.prepare('SELECT COALESCE(SUM(qty), 0) AS n FROM member.cart_items WHERE user_id = ?').get(userId).n;
}

function add(userId, articleId, size, qty) {
  db.prepare(`INSERT INTO member.cart_items (user_id, article_id, size, qty) VALUES (?, ?, ?, ?)
    ON CONFLICT(user_id, article_id, size) DO UPDATE SET qty = MIN(qty + excluded.qty, 10)`)
    .run(userId, articleId, size, qty);
}

function setQty(userId, articleId, size, qty) {
  if (qty <= 0) return remove(userId, articleId, size);
  db.prepare('UPDATE member.cart_items SET qty = ? WHERE user_id = ? AND article_id = ? AND size = ?')
    .run(Math.min(qty, 10), userId, articleId, size);
}

function remove(userId, articleId, size) {
  db.prepare('DELETE FROM member.cart_items WHERE user_id = ? AND article_id = ? AND size = ?').run(userId, articleId, size);
}

function clear(userId) {
  db.prepare('DELETE FROM member.cart_items WHERE user_id = ?').run(userId);
}

module.exports = { items, summary, count, add, setQty, remove, clear };
