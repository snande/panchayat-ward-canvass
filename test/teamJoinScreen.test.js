// Team join screen (issue #48) on the fake DOM from ./helpers/fakeDom.js,
// run by `npm test`.

import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';

import { mountTeamJoin } from '../src/ui/teamJoinScreen.js';
import { TeamJoinError } from '../src/sync/teamAuth.js';
import { createDocument, type } from './helpers/fakeDom.js';

const strings = JSON.parse(readFileSync(new URL('../src/strings.hi.json', import.meta.url), 'utf8'));
const KEYS = [
  'team_join_title', 'team_join_body', 'team_candidate_code', 'team_passphrase', 'team_join_action',
  'team_join_pending', 'team_join_wrong', 'team_join_invalid', 'team_join_failed',
];

function mount(joinTeam) {
  const doc = createDocument();
  const joined = [];
  const screen = mountTeamJoin(doc.body, strings, { joinTeam, onJoined: (auth) => joined.push(auth) });
  return { doc, screen, joined };
}

test('the join strings are Hindi entries in the string table', () => {
  for (const key of KEYS) assert.match(strings[key] || '', /[ऀ-ॿ]/, key);
});

test('the screen has a candidate code field and a passphrase field, labelled from the table', () => {
  const { doc, screen } = mount(async () => ({}));
  const inputs = doc.body.querySelectorAll('input');
  assert.deepEqual(inputs.map((i) => i.getAttribute('type')), ['text', 'password']);
  assert.equal(inputs[0], screen.candidateInput);
  assert.equal(inputs[1], screen.passphraseInput);

  const labels = doc.body.querySelectorAll('label');
  assert.deepEqual(labels.map((l) => l.textContent), [strings.team_candidate_code, strings.team_passphrase]);
  assert.deepEqual(labels.map((l) => l.getAttribute('for')), inputs.map((i) => i.getAttribute('id')));
  assert.equal(doc.body.querySelector('h2').textContent, strings.team_join_title);
  assert.equal(screen.button.textContent, strings.team_join_action);
  assert.equal(screen.button.getAttribute('type'), 'submit');
  assert.equal(doc.body.querySelectorAll('form').length, 1);
});

test('submitting joins with the typed values and reports success', async () => {
  const calls = [];
  let release;
  const { screen, joined } = mount((id, pass) => {
    calls.push([id, pass]);
    return new Promise((resolve) => { release = () => resolve({ token: 't', candidateId: id, key: {} }); });
  });
  type(screen.candidateInput, '  candA ');
  type(screen.passphraseInput, 'हमारी टीम');
  let prevented = false;
  screen.form.dispatchEvent({ type: 'submit', preventDefault: () => { prevented = true; } });
  assert.ok(prevented);
  assert.deepEqual(calls, [['candA', 'हमारी टीम']]);
  assert.equal(screen.message.textContent, strings.team_join_pending);
  assert.ok(screen.button.hasAttribute('disabled'));

  // A second submit while the first is pending does nothing.
  await screen.submit();
  assert.equal(calls.length, 1);

  release();
  await new Promise((resolve) => setImmediate(resolve));
  assert.deepEqual(joined, [{ token: 't', candidateId: 'candA', key: {} }]);
  assert.equal(screen.passphraseInput.value, '', 'the passphrase does not linger in the field');
  assert.ok(!screen.button.hasAttribute('disabled'));
});

test('failures show the matching Hindi message and clear the passphrase', async () => {
  for (const [error, key] of [
    [new TeamJoinError('unauthorized', 'x'), 'team_join_wrong'],
    [new TeamJoinError('invalid', 'x'), 'team_join_invalid'],
    [new TeamJoinError('failed', 'x'), 'team_join_failed'],
    [new Error('boom'), 'team_join_failed'],
  ]) {
    const { screen, joined } = mount(async () => { throw error; });
    type(screen.candidateInput, 'candA');
    type(screen.passphraseInput, 'गलत');
    await screen.submit();
    assert.equal(screen.message.textContent, strings[key], key);
    assert.equal(screen.passphraseInput.value, '');
    assert.equal(screen.candidateInput.value, 'candA');
    assert.deepEqual(joined, []);
  }
});

test('empty fields are caught before any join request', async () => {
  let calls = 0;
  const { screen } = mount(async () => { calls += 1; });
  await screen.submit();
  type(screen.candidateInput, 'candA');
  type(screen.passphraseInput, '   ');
  await screen.submit();
  assert.equal(calls, 0);
  assert.equal(screen.message.textContent, strings.team_join_invalid);
});

test('index.html has an empty, hidden section for the join screen', () => {
  const html = readFileSync(new URL('../index.html', import.meta.url), 'utf8');
  assert.match(html, /<section id="team-join"[^>]*hidden><\/section>/);
});
