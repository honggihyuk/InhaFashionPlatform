// Elasticsearch 상품 인덱스 전체 재색인 (npm run search:reindex)
//   --recreate : 인덱스를 지우고 매핑부터 다시 만듦 (매핑을 바꿨을 때)
const db = require('../db/mysql');
const search = require('../search/products');

(async () => {
  const t0 = Date.now();
  const n = await search.reindexAll({ recreate: process.argv.includes('--recreate') });
  console.log(`Elasticsearch ${search.INDEX}: 상품 ${n.toLocaleString('ko-KR')}건 색인 (${((Date.now() - t0) / 1000).toFixed(1)}s)`);
})().catch((err) => {
  console.error(`재색인 실패: ${err.message}`);
  process.exitCode = 1;
}).finally(() => Promise.allSettled([db.close(), search.close()]));
