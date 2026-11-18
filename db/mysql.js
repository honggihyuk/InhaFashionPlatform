// MySQL 연결 풀 + 스키마 이름 + 트랜잭션 도우미
//   S.catalog / S.admin / S.member : 관리자·이용자·카탈로그 스키마(database) 이름 (백틱 포함)
//   query(sql, params)   → rows
//   one(sql, params)     → 첫 행 또는 undefined
//   exec(sql, params)    → { affectedRows, insertId }
//   transaction(async (tx) => ...) → tx.query / tx.one / tx.exec 는 같은 커넥션·트랜잭션 안에서 실행
const fs = require('fs');
const path = require('path');
const mysql = require('mysql2/promise');
const config = require('../config');

const S = Object.fromEntries(Object.entries(config.mysql.schemas).map(([k, v]) => [k, `\`${v}\``]));

let pool;
function getPool() {
  if (!pool) {
    pool = mysql.createPool({
      host: config.mysql.host,
      port: config.mysql.port,
      user: config.mysql.user,
      password: config.mysql.password,
      database: config.mysql.schemas.catalog,
      connectionLimit: config.mysql.connectionLimit,
      namedPlaceholders: true,
      dateStrings: true, // DATETIME 을 'YYYY-MM-DD HH:MM:SS' 문자열로 받음 (화면 표시용)
      decimalNumbers: true,
      supportBigNumbers: true,
      timezone: config.mysql.timeZone,
      multipleStatements: false,
    });
    // 세션 시간대를 고정해 CURRENT_TIMESTAMP(주문 시각)가 한국 시간으로 기록되게 함
    pool.on('connection', (conn) => { conn.query(`SET time_zone = '${config.mysql.timeZone}'`); });
  }
  return pool;
}

function bind(runner) {
  return {
    async query(sql, params) { const [rows] = await runner.query(sql, params); return rows; },
    async one(sql, params) { const [rows] = await runner.query(sql, params); return rows[0]; },
    async exec(sql, params) { const [r] = await runner.query(sql, params); return r; },
  };
}

const api = bind({ query: (sql, params) => getPool().query(sql, params) });

/** fn(tx) 를 하나의 트랜잭션으로 실행. 예외가 나면 롤백 후 다시 던짐 */
async function transaction(fn) {
  const conn = await getPool().getConnection();
  try {
    await conn.beginTransaction();
    const result = await fn({ ...bind(conn), conn });
    await conn.commit();
    return result;
  } catch (err) {
    try { await conn.rollback(); } catch { /* 연결 끊김 등 */ }
    throw err;
  } finally {
    conn.release();
  }
}

/** db/schema/*.sql 을 실행해 스키마·테이블 생성 (멱등) */
async function migrate() {
  const conn = await mysql.createConnection({
    host: config.mysql.host, port: config.mysql.port, user: config.mysql.user, password: config.mysql.password,
    multipleStatements: true,
  });
  try {
    for (const file of ['catalog.sql', 'admin.sql', 'member.sql']) {
      const sql = fs.readFileSync(path.join(config.schemaDir, file), 'utf8')
        .replace(/\{\{(\w+)\}\}/g, (_, k) => config.mysql.schemas[k]);
      await conn.query(sql);
    }
  } finally {
    await conn.end();
  }
}

/** 이 네임스페이스의 스키마 삭제 (테스트 정리용) */
async function dropSchemas() {
  for (const s of Object.values(S)) await api.exec(`DROP DATABASE IF EXISTS ${s}`);
}

async function catalogReady() {
  try {
    const r = await api.one(`SELECT EXISTS(SELECT 1 FROM ${S.catalog}.products) AS ok`);
    return Boolean(r && r.ok);
  } catch {
    return false;
  }
}

async function close() {
  if (pool) { const p = pool; pool = null; await p.end(); }
}

module.exports = { S, ...api, transaction, migrate, dropSchemas, catalogReady, close, getPool };
