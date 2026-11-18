// 애플리케이션 설정 (Spring의 application.properties 역할)
const path = require('path');

const ROOT = path.resolve(__dirname, '..');

module.exports = {
  root: ROOT,
  port: Number(process.env.PORT) || 3000,
  sessionSecret: process.env.SESSION_SECRET || 'inha-fashion-dev-secret-change-me',
  db: {
    catalog: process.env.CATALOG_DB || path.join(ROOT, 'data', 'db', 'catalog.db'),
    admin: process.env.ADMIN_DB || path.join(ROOT, 'data', 'db', 'admin.db'),
    member: process.env.MEMBER_DB || path.join(ROOT, 'data', 'db', 'member.db'),
    schemaDir: path.join(ROOT, 'db', 'schema'),
  },
  analysis: {
    python: process.env.PYTHON || 'python3',
    script: path.join(ROOT, 'analysis', 'sales_trend.py'),
    resultFile: path.join(ROOT, 'data', 'analysis', 'sales_trends.json'),
  },
  images: {
    dir: path.join(ROOT, 'public', 'images', 'articles'),
  },
  shippingFeeKrw: 3000,
  freeShippingOverKrw: 50000,
};
