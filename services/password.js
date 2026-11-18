// 비밀번호 해시 (Node 내장 scrypt, 별도 의존성 없음)
const crypto = require('crypto');

function hash(password) {
  const salt = crypto.randomBytes(16).toString('hex');
  const key = crypto.scryptSync(password, salt, 64).toString('hex');
  return `scrypt$${salt}$${key}`;
}

function verify(password, stored) {
  const [scheme, salt, key] = String(stored).split('$');
  if (scheme !== 'scrypt' || !salt || !key) return false;
  const candidate = crypto.scryptSync(password, salt, 64);
  const expected = Buffer.from(key, 'hex');
  return expected.length === candidate.length && crypto.timingSafeEqual(expected, candidate);
}

module.exports = { hash, verify };
