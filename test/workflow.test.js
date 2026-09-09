const test = require('node:test');
const assert = require('node:assert/strict');
const {
    WORKFLOW_NEXT_STATUS: next, isDraftSubmission,
    afterVerification, afterAnalisa, afterMukReview,
} = require('../lib/features/pengajuan/data/workflow');

test('complete applications reach survey before analysis and review after MUK', () => {
    const path = [
        '0', '1', afterVerification(true), next.CHECKLIST_LANJUT,
        next.SURVEY_DEBITUR_SIMPAN, next.SURVEY_AGUNAN_SIMPAN,
        afterAnalisa(true), next.MUK_SETUJUI, afterMukReview(true),
    ];
    assert.deepEqual(path, ['0', '1', '3', '5', '6', '4', '8', '7', '9']);
    assert.equal(new Set(path).size, path.length, 'normal flow must not loop');
});

test('legacy applications cannot skip missing forms, surveys, or MUK', () => {
    assert.equal(afterVerification(false), '2');
    assert.equal(afterAnalisa(false), '5');
    assert.equal(afterMukReview(false), '8');
    assert.equal(next.APPROVAL_AWAL_SETUJUI, '2');
    assert.equal(next.APPROVAL_REKAP_SETUJUI, '5');
});

test('MUK corrections return to composition for another review', () => {
    assert.equal(next.APPROVAL_MUK_KOREKSI, '8');
    assert.equal(next.MUK_SETUJUI, '7');
    assert.equal(next.APPROVAL_MUK_TOLAK, '99');
});

test('draft flags are explicit and supported consistently', () => {
    for (const body of [{ is_draft: true }, { save_as_draft: true }, { mode: 'draft' }]) {
        assert.equal(isDraftSubmission(body), true);
    }
    for (const body of [{}, { is_draft: false }, { is_draft: 'false' }]) {
        assert.equal(isDraftSubmission(body), false);
    }
});
