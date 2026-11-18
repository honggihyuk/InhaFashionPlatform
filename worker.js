// 후처리 워커 프로세스 (npm run worker)
//   1) Outbox relay  : MySQL outbox_events → RabbitMQ
//   2) 컨슈머 5종      : 검색 색인, 이용자 알림, 감사 로그, 활동 로그, PyTorch 분석
//   3) DLQ 보관기     : 재시도를 모두 실패한 메시지를 MongoDB failed_messages 로 옮김
//
// 웹 서버(app.js)와 분리된 프로세스라 워커가 잠시 멈춰도 주문·관리 기능은 계속 동작하고,
// 밀린 메시지는 outbox/큐에 남아 있다가 워커가 다시 뜨면 처리됩니다.
const config = require('./config');
const db = require('./db/mysql');
const mongo = require('./db/mongo');
const rabbit = require('./messaging/rabbit');
const relay = require('./messaging/relay');
const { consume, archiveDeadLetters } = require('./messaging/consumer');
const search = require('./search/products');
const defaultHandlers = require('./workers/handlers');

/**
 * @param opts.handlers   큐 이름 → 핸들러 (테스트에서 일부 교체 가능)
 * @param opts.relay      false 면 relay 를 띄우지 않음
 * @param opts.onSettled  메시지 1건 처리 결과 콜백 (테스트용)
 */
async function start(opts = {}) {
  await db.migrate();
  await mongo.ensureIndexes();
  await rabbit.setupTopology();
  try { await search.ensureIndex(); } catch (err) { console.warn('[worker] Elasticsearch 연결 실패, 색인 작업은 재시도됩니다:', err.message); }

  const handlers = { ...defaultHandlers, ...(opts.handlers || {}) };
  let consumers = [];
  let stopping = false;
  let reconnectTimer = null;

  async function startConsumers() {
    const conn = await rabbit.connect();
    const list = [];
    for (const name of Object.keys(rabbit.QUEUES)) {
      list.push(await consume(name, handlers[name], {
        prefetch: name === 'analysis-runner' ? 1 : config.rabbitmq.prefetch,
        onSettled: opts.onSettled,
      }));
    }
    list.push(await archiveDeadLetters(opts.onArchived));
    consumers = list;
    // RabbitMQ 연결이 끊기면(재시작·네트워크 장애) 컨슈머를 다시 붙임.
    // 처리 중이던(ack 전) 메시지는 브로커가 큐에 되돌려 두므로 유실되지 않습니다.
    conn.once('close', () => {
      consumers = [];
      if (!stopping) scheduleReconnect(1000);
    });
  }

  function scheduleReconnect(delay) {
    clearTimeout(reconnectTimer);
    reconnectTimer = setTimeout(async () => {
      try {
        await rabbit.setupTopology();
        await startConsumers();
        console.log('[worker] RabbitMQ 재연결, 컨슈머 재시작');
      } catch (err) {
        console.warn(`[worker] RabbitMQ 재연결 실패 (${err.message}), ${Math.min(delay * 2, 30000) / 1000}초 뒤 다시 시도`);
        if (!stopping) scheduleReconnect(Math.min(delay * 2, 30000));
      }
    }, delay);
  }

  await startConsumers();
  if (opts.relay !== false) relay.start();

  return {
    async stop() {
      stopping = true;
      clearTimeout(reconnectTimer);
      await relay.stop();
      for (const c of consumers) await c.cancel();
    },
  };
}

if (require.main === module) {
  start().then((w) => {
    console.log(`[worker] 실행 중 — exchange=${config.rabbitmq.exchange}, 큐=${Object.keys(rabbit.QUEUES).join(', ')}`);
    // 7일 지난 SENT outbox 행 정리 (1시간마다)
    const purge = setInterval(() => relay.purgeSent().catch(() => {}), 60 * 60 * 1000);
    const shutdown = async () => {
      clearInterval(purge);
      await w.stop();
      await Promise.allSettled([rabbit.close(), db.close(), mongo.close(), search.close()]);
      process.exit(0);
    };
    process.on('SIGINT', shutdown);
    process.on('SIGTERM', shutdown);
  }).catch((err) => {
    console.error('[worker] 시작 실패:', err.message);
    process.exit(1);
  });
}

module.exports = { start };
