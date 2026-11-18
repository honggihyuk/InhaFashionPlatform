// 분석 실행 상태(MySQL admin.analysis_runs) + 분석 결과 문서(MongoDB analysis_results)
//
// 관리자가 "분석 실행" 을 누르면 같은 트랜잭션으로 queued 실행 레코드와 analysis.requested 이벤트(outbox)를 남기고,
// 실제 PyTorch 실행은 RabbitMQ analysis-runner 워커가 맡습니다. 웹 서버는 무거운 작업을 직접 돌리지 않습니다.
const db = require('../db/mysql');
const mongo = require('../db/mongo');
const outbox = require('../messaging/outbox');

const { S } = db;

/** 실행 요청: queued 레코드 + 이벤트. 이미 대기/실행 중이면 그 실행을 돌려줌 */
async function request(actor) {
  return db.transaction(async (tx) => {
    const active = await tx.one(`SELECT * FROM ${S.admin}.analysis_runs WHERE status IN ('queued', 'running') ORDER BY id DESC LIMIT 1 FOR UPDATE`);
    if (active) return { started: false, runId: active.id };
    const r = await tx.exec(`INSERT INTO ${S.admin}.analysis_runs (status, triggered_by) VALUES ('queued', ?)`, [actor ? actor.id : null]);
    await outbox.enqueue(tx, 'admin', 'analysis.requested', { run_id: r.insertId, target: `run#${r.insertId}` }, actor);
    return { started: true, runId: r.insertId };
  });
}

function markRunning(id) {
  return db.exec(`UPDATE ${S.admin}.analysis_runs SET status = 'running', started_at = CURRENT_TIMESTAMP WHERE id = ? AND status IN ('queued', 'running')`, [id]);
}

function finish(id, { status, resultId = null, log }) {
  return db.exec(`UPDATE ${S.admin}.analysis_runs SET status = ?, finished_at = CURRENT_TIMESTAMP, result_id = ?, log = ? WHERE id = ?`,
    [status, resultId, (log || '').slice(-8000), id]);
}

function get(id) {
  return db.one(`SELECT * FROM ${S.admin}.analysis_runs WHERE id = ?`, [id]);
}

function latest() {
  return db.one(`SELECT * FROM ${S.admin}.analysis_runs ORDER BY id DESC LIMIT 1`);
}

function history(limit = 8) {
  return db.query(`SELECT r.id, r.status, r.started_at, r.finished_at, a.name AS admin_name
    FROM ${S.admin}.analysis_runs r LEFT JOIN ${S.admin}.admin_users a ON a.id = r.triggered_by ORDER BY r.id DESC LIMIT ${Number(limit)}`);
}

/** 분석 결과 저장 (MongoDB). 반환값: 문서 _id 문자열 */
async function saveResult(result, runId = null) {
  const c = await mongo.col('analysis_results');
  const doc = { ...result, run_id: runId, saved_at: new Date() };
  const r = await c.insertOne(doc);
  // 최신 20개만 보관
  const old = await c.find({}, { projection: { _id: 1 } }).sort({ saved_at: -1 }).skip(20).toArray();
  if (old.length) await c.deleteMany({ _id: { $in: old.map((o) => o._id) } });
  return String(r.insertedId);
}

/** 최신 분석 결과 (없으면 null) */
async function readResult() {
  try {
    const c = await mongo.col('analysis_results');
    const doc = await c.find({}, { projection: { _id: 0, saved_at: 0 } }).sort({ saved_at: -1 }).limit(1).next();
    return doc || null;
  } catch {
    return null;
  }
}

module.exports = { request, markRunning, finish, get, latest, history, saveResult, readResult };
