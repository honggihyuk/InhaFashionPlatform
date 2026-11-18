// 후처리 작업 모니터 + 실패 메시지 재처리 (관리자 /admin/jobs)
const db = require('../db/mysql');
const mongo = require('../db/mongo');
const outbox = require('../messaging/outbox');
const relay = require('../messaging/relay');
const rabbit = require('../messaging/rabbit');

class JobError extends Error {}

async function failed({ status = 'FAILED', limit = 100 } = {}) {
  const c = await mongo.col('failed_messages');
  const q = status ? { status } : {};
  return c.find(q).sort({ failed_at: -1 }).limit(limit).toArray();
}

async function failedCounts() {
  const c = await mongo.col('failed_messages');
  const rows = await c.aggregate([{ $group: { _id: '$status', n: { $sum: 1 } } }]).toArray();
  return Object.fromEntries(rows.map((r) => [r._id, r.n]));
}

/**
 * 실패 메시지 재처리: 원래 이벤트를 같은 event_id 로 outbox 에 다시 넣음 → relay 가 발행.
 * (재처리 요청 자체도 outbox 를 거치므로 RabbitMQ 가 잠시 내려가 있어도 요청이 사라지지 않음)
 */
async function replay(ids, actor) {
  const c = await mongo.col('failed_messages');
  const docs = await c.find({ _id: { $in: ids }, status: 'FAILED' }).toArray();
  if (!docs.length) throw new JobError('재처리할 실패 메시지가 없습니다.');
  const replayable = docs.filter((d) => d.payload && d.payload.event_id && d.routing_key);
  if (!replayable.length) throw new JobError('원본 이벤트가 손상되어 재처리할 수 없습니다.');
  await db.transaction(async (tx) => {
    for (const d of replayable) await outbox.enqueueExisting(tx, 'admin', d.routing_key, d.payload);
    await outbox.enqueue(tx, 'admin', 'jobs.replayed', {
      target: replayable.map((d) => d._id).join(', ').slice(0, 300),
      detail: { count: replayable.length, queues: [...new Set(replayable.map((d) => d.queue))] },
    }, actor);
  });
  await c.updateMany({ _id: { $in: replayable.map((d) => d._id) } }, {
    $set: { status: 'REQUEUED', replayed_at: new Date(), replayed_by: actor && actor.name },
    $inc: { replay_count: 1 },
  });
  return replayable.length;
}

/** 화면 표시용 종합 현황. 각 인프라가 내려가 있어도 나머지는 보이도록 개별 처리 */
async function overview() {
  const [outboxStats, queues, counts] = await Promise.all([
    relay.stats().catch((e) => ({ error: e.message })),
    rabbit.queueStats().catch((e) => ({ error: e.message })),
    failedCounts().catch((e) => ({ error: e.message })),
  ]);
  return { outbox: outboxStats, queues, counts };
}

module.exports = { failed, failedCounts, replay, overview, JobError };
