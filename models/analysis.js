// 분석 실행 이력 모델 (admin 스키마) + 분석 결과(JSON) 읽기
const fs = require('fs');
const { db } = require('../db/connection');
const config = require('../config');

function start(adminId) {
  const info = db.prepare("INSERT INTO admin.analysis_runs (status, triggered_by) VALUES ('running', ?)").run(adminId || null);
  return Number(info.lastInsertRowid);
}

function finish(id, { status, summary, log }) {
  db.prepare(`UPDATE admin.analysis_runs SET status = ?, finished_at = datetime('now'), result_path = ?,
      summary_json = ?, log = ? WHERE id = ?`)
    .run(status, config.analysis.resultFile, summary ? JSON.stringify(summary) : null, (log || '').slice(-8000), id);
}

function latest() {
  return db.prepare('SELECT * FROM admin.analysis_runs ORDER BY id DESC LIMIT 1').get();
}

function running() {
  return db.prepare("SELECT * FROM admin.analysis_runs WHERE status = 'running' ORDER BY id DESC LIMIT 1").get();
}

function history(limit = 8) {
  return db.prepare(`SELECT r.id, r.status, r.started_at, r.finished_at, a.name AS admin_name
    FROM admin.analysis_runs r LEFT JOIN admin.admin_users a ON a.id = r.triggered_by ORDER BY r.id DESC LIMIT ?`).all(limit);
}

function readResult() {
  try {
    return JSON.parse(fs.readFileSync(config.analysis.resultFile, 'utf8'));
  } catch {
    return null;
  }
}

/** 서버 재시작 등으로 끝나지 못한 실행 정리 */
function markStaleFailed() {
  db.prepare("UPDATE admin.analysis_runs SET status = 'failed', finished_at = datetime('now'), log = '서버 재시작으로 중단됨' WHERE status = 'running'").run();
}

module.exports = { start, finish, latest, running, history, readResult, markStaleFailed };
