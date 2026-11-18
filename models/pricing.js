// 판매가 계산 규칙 (행사 할인). SQL 과 JS 가 같은 규칙을 쓰도록 한 곳에 둡니다.

/** 정가와 할인율로 할인가 계산 (100원 단위 반올림) */
function salePrice(priceKrw, discountPct) {
  return Math.round((priceKrw * (100 - discountPct)) / 10000) * 100;
}

/** product/cart 쿼리에서 쓰는 할인가 SQL (p = products, pr = promotions) — MySQL 문법 */
const FINAL_PRICE_SQL = `(CASE WHEN pr.article_id IS NULL THEN p.price_krw
  ELSE CAST(ROUND(p.price_krw * (100 - pr.discount_pct) / 10000.0) * 100 AS SIGNED) END)`;

module.exports = { salePrice, FINAL_PRICE_SQL };
