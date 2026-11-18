// 행사(할인) 상품 모델 (MySQL catalog.promotions)
//   PyTorch 분석 결과(MongoDB analysis_results 의 promotions)는 '추천 후보'일 뿐이고,
//   관리자가 승인해야 promotions 테이블에 들어가 이용자 화면에 행사 상품으로 보입니다.
//   승인/변경/종료는 outbox 이벤트(promotion.*)로 남아 검색 색인·감사 로그가 후처리됩니다.
const db = require('../db/mysql');
const outbox = require('../messaging/outbox');
const { salePrice, FINAL_PRICE_SQL } = require('./pricing');

const { S } = db;
const MIN_PCT = 5;
const MAX_PCT = 70;

class PromotionError extends Error {}

function parsePct(value) {
  const n = Number(value);
  if (!Number.isInteger(n) || n < MIN_PCT || n > MAX_PCT) {
    throw new PromotionError(`할인율은 ${MIN_PCT}~${MAX_PCT}% 사이의 정수로 입력하세요.`);
  }
  return n;
}

function get(articleId, runner = db) {
  return runner.one(`SELECT * FROM ${S.catalog}.promotions WHERE article_id = ?`, [articleId]);
}

/** 진행 중인 행사 목록 (관리자 화면) */
function active() {
  return db.query(`SELECT pr.*, a.prod_name, a.colour_group_name, a.product_type_name, p.price_krw, p.stock, p.is_active,
      ${FINAL_PRICE_SQL} AS sale_price_krw, ad.name AS admin_name
    FROM ${S.catalog}.promotions pr JOIN ${S.catalog}.products p ON p.article_id = pr.article_id
    JOIN ${S.catalog}.articles a ON a.article_id = pr.article_id
    LEFT JOIN ${S.admin}.admin_users ad ON ad.id = pr.approved_by
    ORDER BY pr.approved_at DESC, pr.article_id`);
}

/** 관리자 승인 → 행사 등록 (이미 행사 중이면 할인율 변경) */
async function approve({ articleId, discountPct, reason = null, score = null, actor }) {
  const pct = parsePct(discountPct);
  return db.transaction(async (tx) => {
    const product = await tx.one(`SELECT article_id, is_active, stock, price_krw FROM ${S.catalog}.products WHERE article_id = ? FOR UPDATE`, [articleId]);
    if (!product) throw new PromotionError('상품을 찾을 수 없습니다.');
    if (!product.is_active) throw new PromotionError('판매 중지된 상품은 행사로 등록할 수 없습니다.');
    const before = await get(articleId, tx);
    await tx.exec(`INSERT INTO ${S.catalog}.promotions (article_id, discount_pct, reason, score, approved_by) VALUES (?, ?, ?, ?, ?)
      ON DUPLICATE KEY UPDATE discount_pct = VALUES(discount_pct), reason = COALESCE(VALUES(reason), reason),
        score = COALESCE(VALUES(score), score), approved_by = VALUES(approved_by), approved_at = CURRENT_TIMESTAMP`,
    [articleId, pct, reason || null, score == null || score === '' ? null : Number(score), actor.id]);
    const after = await get(articleId, tx);
    const sale = salePrice(product.price_krw, pct);
    await outbox.enqueue(tx, 'admin', before ? 'promotion.updated' : 'promotion.approved', {
      article_ids: [articleId], target: articleId,
      detail: {
        discount_pct: before ? [before.discount_pct, after.discount_pct] : after.discount_pct,
        price_krw: product.price_krw, sale_price_krw: sale, score: after.score, reason: after.reason,
      },
    }, actor);
    return { before, after, price_krw: product.price_krw, sale_price_krw: sale };
  });
}

/** 행사 종료 */
async function end(articleId, actor) {
  return db.transaction(async (tx) => {
    const before = await tx.one(`SELECT * FROM ${S.catalog}.promotions WHERE article_id = ? FOR UPDATE`, [articleId]);
    if (!before) throw new PromotionError('진행 중인 행사가 아닙니다.');
    await tx.exec(`DELETE FROM ${S.catalog}.promotions WHERE article_id = ?`, [articleId]);
    await outbox.enqueue(tx, 'admin', 'promotion.ended', {
      article_ids: [articleId], target: articleId, detail: { discount_pct: before.discount_pct },
    }, actor);
    return before;
  });
}

/**
 * PyTorch 추천 후보에 현재 상품 상태를 붙여 돌려줌.
 * 이미 행사 중이거나, 판매 중지/품절/삭제된 상품은 후보에서 뺌.
 */
async function candidates(result) {
  if (!result || !Array.isArray(result.promotions) || !result.promotions.length) return [];
  const ids = result.promotions.map((c) => c.article_id);
  const rows = await db.query(`SELECT p.article_id, p.price_krw, p.stock, p.is_active, pr.article_id AS promo
    FROM ${S.catalog}.products p LEFT JOIN ${S.catalog}.promotions pr ON pr.article_id = p.article_id
    WHERE p.article_id IN (?)`, [ids]);
  const byId = new Map(rows.map((r) => [r.article_id, r]));
  return result.promotions.map((c) => {
    const p = byId.get(c.article_id);
    if (!p || !p.is_active || p.stock <= 0 || p.promo) return null;
    const pct = Math.min(Math.max(Number(c.suggested_discount_pct) || 10, MIN_PCT), MAX_PCT);
    return { ...c, price_krw: p.price_krw, stock: p.stock, suggested_discount_pct: pct, sale_price_krw: salePrice(p.price_krw, pct) };
  }).filter(Boolean);
}

async function count() {
  return (await db.one(`SELECT COUNT(*) AS n FROM ${S.catalog}.promotions pr
    JOIN ${S.catalog}.products p ON p.article_id = pr.article_id AND p.is_active = 1`)).n;
}

module.exports = { salePrice, FINAL_PRICE_SQL, PromotionError, parsePct, get, active, approve, end, candidates, count, MIN_PCT, MAX_PCT };
