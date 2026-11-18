// Outbox Relay: MySQL outbox_events(PENDING) → RabbitMQ 발행 → SENT 표시
//
// - SELECT ... FOR UPDATE SKIP LOCKED 로 행을 잠가, relay 를 여러 개 띄워도 같은 메시지를 동시에 보내지 않습니다.
// - publisher confirm 으로 브로커가 받았음을 확인한 뒤에만 SENT 로 바꿉니다.
//   (확인 후 SENT 기록 전에 죽으면 다음 회차에 한 번 더 보낼 수 있음 → "최소 한 번(at-least-once)" 전달.
//    중복은 컨슈머의 멱등 처리로 흡수합니다.)
// - RabbitMQ 가 내려가 있으면 attempts 를 늘리고 지수 백오프(2^n 초, 최대 60초) 뒤에 다시 시도합니다.
//   메시지는 outbox 에 그대로 남아 있으므로 유실되지 않습니다.
const db = require('../db/mysql');
const rabbit = require('./rabbit');
const { TABLE } = require('./outbox');
const config = require('../config');

let timer = null;
let running = false;
let stopped = true;

async function drainTable(table) {
  let sent = 0;
  await db.transaction(async (tx) => {
    const rows = await tx.query(`SELECT id, event_id, routing_key, payload, attempts FROM ${table}
      WHERE status = 'PENDING' AND next_attempt_at <= CURRENT_TIMESTAMP(3)
      ORDER BY id LIMIT ${Number(config.outbox.batch)} FOR UPDATE SKIP LOCKED`);
    for (const row of rows) {
      const event = typeof row.payload === 'string' ? JSON.parse(row.payload) : row.payload;
      try {
        await rabbit.publish(row.routing_key, event);
        await tx.exec(`UPDATE ${table} SET status = 'SENT', sent_at = CURRENT_TIMESTAMP(3), attempts = attempts + 1, last_error = NULL WHERE id = ?`, [row.id]);
        sent += 1;
      } catch (err) {
        const backoff = Math.min(2 ** (row.attempts + 1), config.outbox.maxBackoffSec);
        await tx.exec(`UPDATE ${table} SET attempts = attempts + 1, last_error = ?,
            next_attempt_at = CURRENT_TIMESTAMP(3) + INTERVAL ? SECOND WHERE id = ?`,
        [String(err.message).slice(0, 500), backoff, row.id]);
        // 브로커 연결 문제면 나머지도 실패할 것이므로 이번 회차는 중단
        break;
      }
    }
  });
  return sent;
}

/** outbox 를 한 번 비움 (테스트·관리자 '지금 발행' 버튼에서도 사용) */
async function drainOnce() {
  let total = 0;
  for (const table of Object.values(TABLE)) total += await drainTable(table);
  return total;
}

async function tick() {
  if (running || stopped) return;
  running = true;
  try {
    await drainOnce();
  } catch (err) {
    if (!stopped) console.error('[relay]', err.message);
  } finally {
    running = false;
    if (!stopped) timer = setTimeout(tick, config.outbox.pollMs);
  }
}

function start() {
  stopped = false;
  timer = setTimeout(tick, 0);
}

async function stop() {
  stopped = true;
  clearTimeout(timer);
  while (running) await new Promise((r) => setTimeout(r, 20));
}

/** 관리자 화면용 outbox 현황 */
async function stats() {
  const out = {};
  for (const [scope, table] of Object.entries(TABLE)) {
    out[scope] = await db.one(`SELECT
        SUM(status = 'PENDING') AS pending,
        SUM(status = 'PENDING' AND attempts > 0) AS retrying,
        SUM(status = 'SENT') AS sent,
        MIN(CASE WHEN status = 'PENDING' THEN created_at END) AS oldest_pending,
        MAX(CASE WHEN status = 'PENDING' THEN last_error END) AS last_error
      FROM ${table}`);
    for (const k of ['pending', 'retrying', 'sent']) out[scope][k] = Number(out[scope][k] || 0);
  }
  return out;
}

/** 오래된 SENT 행 정리 (기본 7일) */
async function purgeSent(days = 7) {
  for (const table of Object.values(TABLE)) {
    await db.exec(`DELETE FROM ${table} WHERE status = 'SENT' AND sent_at < CURRENT_TIMESTAMP(3) - INTERVAL ? DAY`, [days]);
  }
}

module.exports = { start, stop, drainOnce, stats, purgeSent };
