// PyTorch 분석 스크립트(analysis/sales_trend.py) 실행 서비스
const { spawn } = require('child_process');
const config = require('../config');
const analysis = require('../models/analysis');

function run(adminId) {
  const active = analysis.running();
  if (active) return { started: false, runId: active.id };

  const runId = analysis.start(adminId);
  const args = [config.analysis.script, '--catalog', config.db.catalog, '--member', config.db.member,
    '--out', config.analysis.resultFile];
  const child = spawn(config.analysis.python, args, { cwd: config.root });
  let log = '';
  child.stdout.on('data', (d) => { log += d; });
  child.stderr.on('data', (d) => { log += d; });
  child.on('error', (err) => {
    analysis.finish(runId, { status: 'failed', log: `${log}\n${err.message}\nPython 실행 파일을 찾을 수 없습니다. PYTHON 환경변수를 확인하세요.` });
  });
  child.on('close', (code) => {
    if (code === 0) {
      const result = analysis.readResult();
      analysis.finish(runId, { status: 'success', summary: result && result.summary, log });
    } else if (analysis.running()) {
      analysis.finish(runId, { status: 'failed', log: `${log}\nexit code ${code}` });
    }
  });
  return { started: true, runId };
}

module.exports = { run };
