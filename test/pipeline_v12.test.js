const test = require('node:test');
const assert = require('node:assert/strict');
const { pipelinePhaseFromStatus } = require('../lib/features/pengajuan/data/dashboard_helper');

test('V12 pipeline phase maps workflow statuses correctly', () => {
  assert.equal(pipelinePhaseFromStatus('0'), 'PENGAJUAN');
  assert.equal(pipelinePhaseFromStatus('2'), 'PENGAJUAN');
  assert.equal(pipelinePhaseFromStatus('10'), 'VERIFIKASI');
  assert.equal(pipelinePhaseFromStatus('5'), 'SURVEI');
  assert.equal(pipelinePhaseFromStatus('6'), 'SURVEI');
  assert.equal(pipelinePhaseFromStatus('8'), 'ANALISA_MUK');
  assert.equal(pipelinePhaseFromStatus('7'), 'ANALISA_MUK');
  assert.equal(pipelinePhaseFromStatus('9'), 'PUTUSAN');
  assert.equal(pipelinePhaseFromStatus('11'), 'PUTUSAN');
  assert.equal(pipelinePhaseFromStatus('100'), 'SELESAI');
  assert.equal(pipelinePhaseFromStatus('99'), 'DITOLAK');
});

test('V12 pipeline unknown status stays isolated', () => {
  assert.equal(pipelinePhaseFromStatus('1234'), 'LAINNYA');
  assert.equal(pipelinePhaseFromStatus(null), 'LAINNYA');
});
