// 이용자 계정 모델 (member 스키마)
const { db } = require('../db/connection');
const password = require('../services/password');

function findByEmail(email) {
  return db.prepare('SELECT * FROM member.users WHERE email = ?').get(String(email).toLowerCase().trim());
}

function findById(id) {
  return db.prepare('SELECT id, email, name, phone, address, hm_customer_id, created_at FROM member.users WHERE id = ?').get(id);
}

function create({ email, name, phone, address, plainPassword, hmCustomerId = null }) {
  const info = db.prepare(`INSERT INTO member.users (email, password_hash, name, phone, address, hm_customer_id)
    VALUES (?, ?, ?, ?, ?, ?)`).run(String(email).toLowerCase().trim(), password.hash(plainPassword), name, phone || null, address || null, hmCustomerId);
  return findById(Number(info.lastInsertRowid));
}

function authenticate(email, plainPassword) {
  const user = findByEmail(email);
  if (!user || !password.verify(plainPassword, user.password_hash)) return null;
  return findById(user.id);
}

function count() {
  return db.prepare('SELECT COUNT(*) AS n FROM member.users').get().n;
}

module.exports = { findByEmail, findById, create, authenticate, count };
