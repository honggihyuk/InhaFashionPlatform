// 이용자 계정 모델 (MySQL member 스키마)
const db = require('../db/mysql');
const password = require('../services/password');

const { S } = db;
const norm = (email) => String(email).toLowerCase().trim();

function findByEmail(email) {
  return db.one(`SELECT * FROM ${S.member}.users WHERE email = ?`, [norm(email)]);
}

function findById(id) {
  return db.one(`SELECT id, email, name, phone, address, hm_customer_id, created_at FROM ${S.member}.users WHERE id = ?`, [id]);
}

async function create({ email, name, phone, address, plainPassword, hmCustomerId = null }) {
  const r = await db.exec(`INSERT INTO ${S.member}.users (email, password_hash, name, phone, address, hm_customer_id)
    VALUES (?, ?, ?, ?, ?, ?)`, [norm(email), password.hash(plainPassword), name, phone || null, address || null, hmCustomerId]);
  return findById(r.insertId);
}

async function authenticate(email, plainPassword) {
  const user = await findByEmail(email);
  if (!user || !password.verify(plainPassword, user.password_hash)) return null;
  return findById(user.id);
}

async function count() {
  return (await db.one(`SELECT COUNT(*) AS n FROM ${S.member}.users`)).n;
}

module.exports = { findByEmail, findById, create, authenticate, count };
