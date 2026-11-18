// 후처리 핸들러 — 큐 이름(messaging/rabbit.js QUEUES) → async (event, ctx)
//
// 모든 핸들러는 "같은 메시지를 두 번 처리해도 결과가 같도록(멱등)" 작성합니다.
//   - search-indexer : MySQL 의 현재 값을 다시 읽어 ES 에 덮어씀
//   - user-notifier / audit-writer / activity-logger : event_id 로 만든 고정 _id 에 upsert
//   - analysis-runner: 실행 레코드 상태(queued→running→success/failed)로 중복 실행 방지
const fs = require('fs');
const os = require('os');
const path = require('path');
const { spawn } = require('child_process');
const config = require('../config');
const mongo = require('../db/mongo');
const search = require('../search/products');
const analysis = require('../models/analysis');
const { NonRetryableError } = require('../messaging/consumer');

const STATUS_LABEL = { PAID: '결제완료', SHIPPING: '배송중', DELIVERED: '배송완료', CANCELLED: '주문취소' };
const won = (n) => `${Math.round(Number(n) || 0).toLocaleString('ko-KR')}원`;

// ---- 1) Elasticsearch 색인 갱신 (재고·가격·행사 변경 반영) ----
async function searchIndexer(event) {
  const ids = (event.data && event.data.article_ids) || [];
  if (ids.length) await search.indexArticles(ids);
}

// ---- 2) 이용자 알림 생성 (MongoDB notifications) ----
async function userNotifier(event, { routingKey }) {
  const d = event.data || {};
  let title;
  let body;
  if (routingKey === 'order.placed') {
    const first = d.items && d.items[0];
    const more = d.items && d.items.length > 1 ? ` 외 ${d.items.length - 1}건` : '';
    title = '주문이 접수되었습니다';
    body = `${first ? first.prod_name : '상품'}${more} · 결제금액 ${won(d.total_krw)}`;
  } else if (routingKey === 'order.cancelled') {
    title = '주문이 취소되었습니다';
    body = `${won(d.total_krw)} 결제가 취소되고 재고가 복원되었습니다.`;
  } else if (routingKey === 'order.status_changed') {
    if (d.from === d.to) return;
    title = `주문 상태가 ${STATUS_LABEL[d.to] || d.to}(으)로 바뀌었습니다`;
    body = `${STATUS_LABEL[d.from] || d.from} → ${STATUS_LABEL[d.to] || d.to}`;
  } else {
    return;
  }
  const c = await mongo.col('notifications');
  await c.updateOne({ _id: event.event_id }, {
    $setOnInsert: {
      user_id: d.user_id, type: routingKey, title, body, order_no: d.order_no, read: false,
      created_at: new Date(event.occurred_at),
    },
  }, { upsert: true });
}

// ---- 3) 관리자 감사 로그 (MongoDB audit_log) ----
const AUDIT_ACTION = {
  'product.updated': 'product.update',
  'order.status_changed': 'order.status',
  'promotion.approved': 'promotion.approve',
  'promotion.updated': 'promotion.update',
  'promotion.ended': 'promotion.end',
  'analysis.requested': 'analysis.run',
  'jobs.replayed': 'jobs.replay',
};
async function auditWriter(event, { routingKey }) {
  if (!event.actor || event.actor.type !== 'admin') return; // 관리자 작업만 기록
  const d = event.data || {};
  const c = await mongo.col('audit_log');
  await c.updateOne({ _id: event.event_id }, {
    $setOnInsert: {
      admin_id: event.actor.id, admin_name: event.actor.name, action: AUDIT_ACTION[routingKey] || routingKey,
      target: d.target || null, detail: d.detail || null, created_at: new Date(event.occurred_at),
    },
  }, { upsert: true });
}

// ---- 4) 이용자 활동 로그 (MongoDB activity_events) ----
async function activityLogger(event, { routingKey }) {
  const d = event.data || {};
  const at = new Date(event.occurred_at);
  const base = { user_id: event.actor && event.actor.type === 'user' ? event.actor.id : null, created_at: at };
  let docs;
  if (routingKey === 'order.placed') {
    docs = (d.items || []).map((it, i) => ({ _id: `${event.event_id}:${i}`, ...base, type: 'purchase', article_id: it.article_id, qty: it.qty, amount: it.qty * it.unit_price_krw }));
  } else if (routingKey === 'cart.item_added') {
    docs = [{ _id: event.event_id, ...base, type: 'cart_add', article_id: d.article_id, qty: d.qty, size: d.size }];
  } else if (routingKey === 'product.viewed') {
    docs = [{ _id: event.event_id, ...base, type: 'view', article_id: d.article_id, session: d.session || null }];
  } else {
    return;
  }
  if (!docs.length) return;
  const c = await mongo.col('activity_events');
  await c.bulkWrite(docs.map((doc) => ({ updateOne: { filter: { _id: doc._id }, update: { $setOnInsert: doc }, upsert: true } })), { ordered: false });
}

// ---- 5) PyTorch 분석 실행 ----
function runPython(outFile) {
  const args = [config.analysis.script,
    '--mysql', '--catalog-schema', config.mysql.schemas.catalog, '--member-schema', config.mysql.schemas.member,
    '--out', outFile];
  const env = {
    ...process.env,
    MYSQL_HOST: config.mysql.host, MYSQL_PORT: String(config.mysql.port),
    MYSQL_USER: config.mysql.user, MYSQL_PASSWORD: config.mysql.password,
  };
  return new Promise((resolve) => {
    let log = '';
    const child = spawn(config.analysis.python, args, { cwd: config.root, env });
    child.stdout.on('data', (d) => { log += d; });
    child.stderr.on('data', (d) => { log += d; });
    child.on('error', (err) => resolve({ code: -1, log: `${log}\n${err.message}\nPython 실행 파일을 찾을 수 없습니다. PYTHON 환경변수를 확인하세요.` }));
    child.on('close', (code) => resolve({ code, log }));
  });
}

async function analysisRunner(event) {
  const runId = event.data && event.data.run_id;
  const run = runId && await analysis.get(runId);
  if (!run || run.status === 'success' || run.status === 'failed') return; // 이미 끝난 실행(중복 메시지)
  await analysis.markRunning(runId);
  const outFile = path.join(os.tmpdir(), `inha-analysis-${config.ns}${runId}-${process.pid}.json`);
  const { code, log } = await runPython(outFile);
  if (code !== 0) {
    await analysis.finish(runId, { status: 'failed', log: `${log}\nexit code ${code}` });
    return; // 분석 스크립트 오류는 재시도해도 같으므로 실패로 기록하고 끝냄
  }
  let result;
  try {
    result = JSON.parse(fs.readFileSync(outFile, 'utf8'));
  } catch (err) {
    await analysis.finish(runId, { status: 'failed', log: `${log}\n결과 파일을 읽을 수 없습니다: ${err.message}` });
    return;
  } finally {
    fs.rm(outFile, { force: true }, () => {});
  }
  // MongoDB 저장 실패는 일시 장애일 수 있으므로 예외를 던져 재시도 큐로 보냄
  const resultId = await analysis.saveResult(result, runId);
  await analysis.finish(runId, { status: 'success', resultId, log });
}

module.exports = {
  'search-indexer': searchIndexer,
  'user-notifier': userNotifier,
  'audit-writer': auditWriter,
  'activity-logger': activityLogger,
  'analysis-runner': analysisRunner,
  NonRetryableError,
  runPython,
};
