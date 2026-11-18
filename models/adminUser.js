// 관리자 계정 모델 (admin 스키마) — 이용자 계정과 별도 DB 파일/스키마로 관리
const { db } = require('../db/connection');
const password = require('../services/password');

function findByEmail(email) {
  return db.prepare('SELECT * FROM admin.admin_users WHERE email = ?').get(String(email).toLowerCase().trim());
}

function create({ email, name, role = 'manager', plainPassword }) {
  db.prepare('INSERT INTO admin.admin_users (email, password_hash, name, role) VALUES (?, ?, ?, ?)')
    .run(String(email).toLowerCase().trim(), password.hash(plainPassword), name, role);
  return findByEmail(email);
}

function authenticate(email, plainPassword) {
  const admin = findByEmail(email);
  if (!admin || !password.verify(plainPassword, admin.password_hash)) return null;
  db.prepare("UPDATE admin.admin_users SET last_login_at = datetime('now') WHERE id = ?").run(admin.id);
  const { password_hash, ...safe } = admin;
  return safe;
}

function audit(adminId, action, target, detail) {
  db.prepare('INSERT INTO admin.audit_log (admin_id, action, target, detail) VALUES (?, ?, ?, ?)')
    .run(adminId, action, target || null, detail ? JSON.stringify(detail) : null);
}

function recentAudit(limit = 10) {
  return db.prepare(`SELECT l.*, a.name AS admin_name FROM admin.audit_log l
    LEFT JOIN admin.admin_users a ON a.id = l.admin_id ORDER BY l.id DESC LIMIT ?`).all(limit);
}

module.exports = { findByEmail, create, authenticate, audit, recentAudit };
