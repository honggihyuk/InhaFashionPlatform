// 행사(할인) 상품 모델 (main 스키마 promotions)
//   PyTorch 분석 결과(sales_trends.json 의 promotions)는 '추천 후보'일 뿐이고,
//   관리자가 승인해야 promotions 테이블에 들어가 이용자 화면에 행사 상품으로 보입니다.
const { db } = require('../db/connection');

const MIN_PCT = 5;
const MAX_PCT = 70;

/** 정가와 할인율로 할인가 계산 (100원 단위 반올림) — SQL 의 SALE_PRICE_SQL 과 같은 규칙 */
function salePrice(priceKrw, discountPct) {
  return Math.round((priceKrw * (100 - discountPct)) / 10000) * 100;
}

/** product/cart 쿼리에서 쓰는 할인가 SQL (p = products, pr = promotions) */
const FINAL_PRICE_SQL = `(CASE WHEN pr.article_id IS NULL THEN p.price_krw
  ELSE CAST(ROUND(p.price_krw * (100 - pr.discount_pct) / 10000.0) * 100 AS INTEGER) END)`;

class PromotionError extends Error {}

function parsePct(value) {
  const n = Number(value);
  if (!Number.isInteger(n) || n < MIN_PCT || n > MAX_PCT) {
    throw new PromotionError(`할인율은 ${MIN_PCT}~${MAX_PCT}% 사이의 정수로 입력하세요.`);
  }
  return n;
}

function get(articleId) {
  return db.prepare('SELECT * FROM promotions WHERE article_id = ?').get(articleId);
}

/** 진행 중인 행사 목록 (관리자 화면) */
function active() {
  return db.prepare(`SELECT pr.*, a.prod_name, a.colour_group_name, a.product_type_name, p.price_krw, p.stock, p.is_active,
      ${FINAL_PRICE_SQL} AS sale_price_krw, ad.name AS admin_name
    FROM promotions pr JOIN products p ON p.article_id = pr.article_id JOIN articles a ON a.article_id = pr.article_id
    LEFT JOIN admin.admin_users ad ON ad.id = pr.approved_by
    ORDER BY pr.approved_at DESC, pr.article_id`).all();
}

/** 관리자 승인 → 행사 등록 (이미 행사 중이면 할인율 변경) */
function approve({ articleId, discountPct, reason = null, score = null, adminId }) {
  const pct = parsePct(discountPct);
  const product = db.prepare('SELECT article_id, is_active, stock, price_krw FROM products WHERE article_id = ?').get(articleId);
  if (!product) throw new PromotionError('상품을 찾을 수 없습니다.');
  if (!product.is_active) throw new PromotionError('판매 중지된 상품은 행사로 등록할 수 없습니다.');
  const before = get(articleId);
  db.prepare(`INSERT INTO promotions (article_id, discount_pct, reason, score, approved_by) VALUES (?, ?, ?, ?, ?)
    ON CONFLICT(article_id) DO UPDATE SET discount_pct = excluded.discount_pct, reason = COALESCE(excluded.reason, reason),
      score = COALESCE(excluded.score, score), approved_by = excluded.approved_by, approved_at = datetime('now')`)
    .run(articleId, pct, reason || null, score == null || score === '' ? null : Number(score), adminId);
  return { before, after: get(articleId), price_krw: product.price_krw, sale_price_krw: salePrice(product.price_krw, pct) };
}

/** 행사 종료 */
function end(articleId) {
  const before = get(articleId);
  if (!before) throw new PromotionError('진행 중인 행사가 아닙니다.');
  db.prepare('DELETE FROM promotions WHERE article_id = ?').run(articleId);
  return before;
}

/**
 * PyTorch 추천 후보에 현재 상품 상태를 붙여 돌려줌.
 * 이미 행사 중이거나, 판매 중지/품절/삭제된 상품은 후보에서 뺌.
 */
function candidates(result) {
  if (!result || !Array.isArray(result.promotions)) return [];
  const prod = db.prepare(`SELECT p.price_krw, p.stock, p.is_active, pr.article_id AS promo FROM products p
    LEFT JOIN promotions pr ON pr.article_id = p.article_id WHERE p.article_id = ?`);
  return result.promotions.map((c) => {
    const p = prod.get(c.article_id);
    if (!p || !p.is_active || p.stock <= 0 || p.promo) return null;
    const pct = Math.min(Math.max(Number(c.suggested_discount_pct) || 10, MIN_PCT), MAX_PCT);
    return { ...c, price_krw: p.price_krw, stock: p.stock, suggested_discount_pct: pct, sale_price_krw: salePrice(p.price_krw, pct) };
  }).filter(Boolean);
}

function count() {
  return db.prepare('SELECT COUNT(*) AS n FROM promotions pr JOIN products p ON p.article_id = pr.article_id AND p.is_active = 1').get().n;
}

module.exports = { salePrice, FINAL_PRICE_SQL, PromotionError, parsePct, get, active, approve, end, candidates, count, MIN_PCT, MAX_PCT };
