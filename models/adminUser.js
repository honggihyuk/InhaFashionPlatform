// 관리자 계정 모델 (MySQL admin 스키마) — 이용자 계정과 별도 스키마로 관리
// 감사 로그는 MongoDB audit_log 에 있으며, 관리자 작업 이벤트를 RabbitMQ 후처리(audit-writer)가 기록합니다.
const db = require('../db/mysql');
const mongo = require('../db/mongo');
const password = require('../services/password');

const { S } = db;
const norm = (email) => String(email).toLowerCase().trim();

function findByEmail(email) {
  return db.one(`SELECT * FROM ${S.admin}.admin_users WHERE email = ?`, [norm(email)]);
}

async function create({ email, name, role = 'manager', plainPassword }) {
  await db.exec(`INSERT INTO ${S.admin}.admin_users (email, password_hash, name, role) VALUES (?, ?, ?, ?)`,
    [norm(email), password.hash(plainPassword), name, role]);
  return findByEmail(email);
}

async function authenticate(email, plainPassword) {
  const admin = await findByEmail(email);
  if (!admin || !password.verify(plainPassword, admin.password_hash)) return null;
  await db.exec(`UPDATE ${S.admin}.admin_users SET last_login_at = CURRENT_TIMESTAMP WHERE id = ?`, [admin.id]);
  const { password_hash, ...safe } = admin;
  return safe;
}

/** 이벤트 actor 정보 (세션 → outbox 이벤트에 실음) */
function actorOf(session) {
  return { type: 'admin', id: session.auth.id, name: session.auth.name };
}

async function recentAudit(limit = 100) {
  const c = await mongo.col('audit_log');
  return c.find({}).sort({ created_at: -1 }).limit(limit).toArray();
}

module.exports = { findByEmail, create, authenticate, actorOf, recentAudit };
