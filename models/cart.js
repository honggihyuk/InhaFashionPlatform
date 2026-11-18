// 장바구니 모델 (MySQL member 스키마)
const db = require('../db/mysql');
const config = require('../config');
const { imageUrl } = require('./product');
const { FINAL_PRICE_SQL } = require('./pricing');

const { S } = db;

// price_krw 는 실제 결제 단가(행사 중이면 할인가), list_price_krw 는 정가
const ITEMS_SQL = `
  SELECT c.article_id, c.size, c.qty, a.prod_name, a.colour_group_name, a.product_type_name,
         ${FINAL_PRICE_SQL} AS price_krw, p.price_krw AS list_price_krw, pr.discount_pct,
         p.stock, p.is_active, (c.qty * ${FINAL_PRICE_SQL}) AS line_total
  FROM ${S.member}.cart_items c
  JOIN ${S.catalog}.products p ON p.article_id = c.article_id
  JOIN ${S.catalog}.articles a ON a.article_id = c.article_id
  LEFT JOIN ${S.catalog}.promotions pr ON pr.article_id = c.article_id
  WHERE c.user_id = ? ORDER BY c.added_at`;

/** runner: db 또는 트랜잭션 tx. lock=true 면 주문 중 재고·가격이 바뀌지 않도록 상품 행을 잠금 */
async function items(userId, runner = db, { lock = false } = {}) {
  const rows = await runner.query(`${ITEMS_SQL}${lock ? ' FOR UPDATE' : ''}`, [userId]);
  return rows.map((r) => ({ ...r, line_total: Number(r.line_total), image: imageUrl(r.article_id) }));
}

async function summary(userId, runner = db, opts) {
  const list = await items(userId, runner, opts);
  const subtotal = list.reduce((s, i) => s + i.line_total, 0);
  const shipping = subtotal === 0 || subtotal >= config.freeShippingOverKrw ? 0 : config.shippingFeeKrw;
  return { items: list, subtotal, shipping, total: subtotal + shipping, count: list.reduce((s, i) => s + i.qty, 0) };
}

async function count(userId) {
  return Number((await db.one(`SELECT COALESCE(SUM(qty), 0) AS n FROM ${S.member}.cart_items WHERE user_id = ?`, [userId])).n);
}

function add(runner, userId, articleId, size, qty) {
  return runner.exec(`INSERT INTO ${S.member}.cart_items (user_id, article_id, size, qty) VALUES (?, ?, ?, ?)
    ON DUPLICATE KEY UPDATE qty = LEAST(qty + VALUES(qty), 10)`, [userId, articleId, size, qty]);
}

async function setQty(userId, articleId, size, qty) {
  if (qty <= 0) return remove(userId, articleId, size);
  return db.exec(`UPDATE ${S.member}.cart_items SET qty = ? WHERE user_id = ? AND article_id = ? AND size = ?`,
    [Math.min(qty, 10), userId, articleId, size]);
}

function remove(userId, articleId, size) {
  return db.exec(`DELETE FROM ${S.member}.cart_items WHERE user_id = ? AND article_id = ? AND size = ?`, [userId, articleId, size]);
}

function clear(runner, userId) {
  return runner.exec(`DELETE FROM ${S.member}.cart_items WHERE user_id = ?`, [userId]);
}

module.exports = { items, summary, count, add, setQty, remove, clear };
