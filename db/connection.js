// SQLite 연결: catalog.db(메인) + admin.db / member.db 를 별도 스키마로 ATTACH
//   main.*   : H&M 원본 데이터(articles, customers, transactions) + 판매용 products
//   admin.*  : 관리자 계정, 분석 실행 이력, 감사 로그
//   member.* : 이용자 계정, 장바구니, 주문
const fs = require('fs');
const path = require('path');
const { DatabaseSync } = require('node:sqlite');
const config = require('../config');

fs.mkdirSync(path.dirname(config.db.catalog), { recursive: true });

const db = new DatabaseSync(config.db.catalog);
const quote = (p) => p.replace(/'/g, "''");
db.exec(`
  PRAGMA journal_mode = WAL;
  PRAGMA busy_timeout = 5000;
  ATTACH DATABASE '${quote(config.db.admin)}' AS admin;
  ATTACH DATABASE '${quote(config.db.member)}' AS member;
  PRAGMA foreign_keys = ON;
`);

for (const file of ['catalog.sql', 'admin.sql', 'member.sql']) {
  db.exec(fs.readFileSync(path.join(config.db.schemaDir, file), 'utf8'));
}

/** fn 을 하나의 트랜잭션으로 실행 */
function transaction(fn) {
  db.exec('BEGIN IMMEDIATE');
  try {
    const result = fn();
    db.exec('COMMIT');
    return result;
  } catch (err) {
    db.exec('ROLLBACK');
    throw err;
  }
}

function catalogReady() {
  return db.prepare('SELECT COUNT(*) AS n FROM products').get().n > 0;
}

module.exports = { db, transaction, catalogReady };
