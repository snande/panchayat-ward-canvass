// Household cards wired to the search screen (issue #144): a typed house
// number shows one card listing every member of that house, and tapping a
// member opens their voter card at "#/voter/<ward>/<serial>".

import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';

import { createVoterSearchScreen, DEBOUNCE_MS } from '../src/ui/voterSearchScreen.js';
import { startVoterRoute, voterRouteHash } from '../src/ui/voterRoute.js';
import { createDocument, type } from './helpers/fakeDom.js';

const read = (rel) => readFileSync(new URL('../' + rel, import.meta.url), 'utf8');
const strings = JSON.parse(read('src/strings.hi.json'));

const W3 = '17/125/6313/3';
const W5 = '17/125/6313/5';
const ROLL3 = [
  { serial: 145, name: 'रमेश कुमार', relative: 'सुरेश', age: 42, gender: 'पुरुष', house: '12' },
  { serial: 146, name: 'सीता देवी', relative: 'रमेश कुमार', age: 38, gender: 'स्त्री', house: '12 ' },
  { serial: 147, name: 'मुन्नी', relative: 'रमेश कुमार', age: 19, gender: 'स्त्री', house: '१२' },
  { serial: 7, name: 'कमला', relative: 'मोहन', age: 67, gender: 'स्त्री', house: '4/2' },
  { serial: 8, name: 'हरि', relative: 'मोहन', age: 70, gender: 'पुरुष', house: '' },
];
const ROLL5 = [
  { serial: 1, name: 'रमेश चंद', relative: 'हरि', age: 25, gender: 'पुरुष', house: '9' },
  { serial: 2, name: 'गीता', relative: 'श्याम', age: 55, gender: 'स्त्री', house: '12' },
];
const ROLLS = new Map([[W3, ROLL3], [W5, ROLL5]]);
const PHONES = new Map([[`${W3}#145`, '9876543210']]);

const contacts = {
  listConsented: async () => [],
  getContact: async (wardKey, serial) => {
    const phone = PHONES.get(`${wardKey}#${serial}`);
    return phone ? { wardId: wardKey, serial, phone } : null;
  },
};

const sleep = (ms) => new Promise((resolve) => setTimeout(resolve, ms));

function mount(opts = {}) {
  const doc = createDocument();
  const host = doc.createElement('section');
  doc.body.appendChild(host);
  const opened = [];
  const screen = createVoterSearchScreen(host, strings, {
    contacts, log: () => {}, onOpenVoter: (voter) => opened.push(voter), ...opts,
  });
  return { doc, host, screen, opened };
}

async function search(screen, query) {
  type(screen.input, query);
  await sleep(DEBOUNCE_MS + 20);
  await Promise.all(screen.households.map((card) => card.ready));
}

const serialsOf = (card) => card.list.querySelectorAll('button.household-member')
  .map((row) => Number(row.getAttribute('data-serial')));

function change(node, value) {
  node.value = value;
  node.dispatchEvent({ type: 'change' });
}

test('a typed house number shows one household card listing every member, above the result rows', async () => {
  const { screen } = mount();
  await screen.setRolls(new Map([[W3, ROLL3]]));
  await search(screen, '12');
  assert.equal(screen.state, 'filled');
  assert.equal(screen.households.length, 1, 'one card');
  const [card] = screen.households;
  assert.equal(card.state, 'success');
  assert.deepEqual(serialsOf(card), [145, 146, 147], '"12", "12 " and "१२" are one house');
  assert.ok(card.root.querySelector('h2.panel-title').textContent.includes('12'));
  assert.equal(card.root.querySelector('p.household-count').textContent, `3 ${strings.household_members}`);
  const kids = screen.root.children;
  assert.ok(kids.indexOf(screen.householdHost) < kids.indexOf(screen.list), 'the card sits above the rows');
  assert.equal(screen.householdHost.hidden, false);
  assert.ok(screen.list.children.length > 0, 'the result rows still show');
});

test('Devanagari digits and spacing around "/" find the same house', async () => {
  const { screen } = mount();
  await screen.setRolls(new Map([[W3, ROLL3]]));
  await search(screen, '१२');
  assert.deepEqual(serialsOf(screen.households[0]), [145, 146, 147]);
  await search(screen, ' 4 / 2 ');
  assert.equal(screen.state, 'filled', 'a house that looks like a ward/serial jump shows its card, not the jump error');
  assert.deepEqual(serialsOf(screen.households[0]), [7]);
});

test('tapping a member hands its ward number and serial to onOpenVoter, once per tap', async () => {
  const { screen, opened } = mount();
  await screen.setRolls(new Map([[W3, ROLL3]]));
  await search(screen, '12');
  const rows = screen.households[0].list.querySelectorAll('button.household-member');
  rows[1].dispatchEvent({ type: 'click' });
  assert.deepEqual(opened, [{ ward: '3', serial: 146, wardKey: W3 }]);
  assert.equal(voterRouteHash(opened[0].ward, opened[0].serial), '#/voter/3/146');
});

test('end to end: a member tap opens that voter\'s card on the voter route, and back returns to the search', async () => {
  const doc = createDocument();
  const main = doc.createElement('main');
  const searchHost = doc.createElement('section');
  const routeHost = doc.createElement('section');
  routeHost.hidden = true;
  main.appendChild(searchHost);
  main.appendChild(routeHost);
  doc.body.appendChild(main);
  const listeners = new Map();
  const win = {
    backs: 0,
    location: { pathname: '/', search: '', hash: '' },
    history: { back() { win.backs += 1; } },
    addEventListener(kind, fn) { listeners.set(kind, fn); },
  };
  const go = (hash) => {
    win.location.hash = hash;
    listeners.get('hashchange')();
  };
  const route = startVoterRoute(routeHost, strings, {
    window: win,
    main,
    store: { lastWardKey: async () => W3, loadStored: async (key) => (key === W3 ? ROLL3 : null) },
    seat: () => ({ seatType: 'ward', panchayat: 'बडली', ward: '3' }),
    log: () => {},
  });
  // As js/picker.js does.
  const screen = createVoterSearchScreen(searchHost, strings, {
    contacts, log: () => {}, onOpenVoter: (voter) => go(voterRouteHash(voter.ward, voter.serial)),
  });
  await screen.setRolls(new Map([[W3, ROLL3]]));
  await search(screen, '12');
  screen.households[0].list.querySelectorAll('button.household-member')[2].dispatchEvent({ type: 'click' });
  assert.equal(await route.settled, 'card');
  assert.equal(main.getAttribute('data-route'), 'voter');
  const card = routeHost.querySelector('section.voter-roll-card');
  assert.ok(card.textContent.includes('मुन्नी'), 'the tapped member\'s voter card');

  routeHost.querySelector('button.voter-route-back').dispatchEvent({ type: 'click' });
  assert.equal(win.backs, 1, 'back goes to the search it was opened from');
  go('');
  assert.equal(main.getAttribute('data-route'), null);
  assert.equal(screen.input.value, '12', 'the typed query stays');
  assert.equal(screen.households.length, 1);
});

test('each member shows the number from the contact store and the tag and visit status from the lookups', async () => {
  const tags = new Map([['3:145', 'समर्थक']]);
  const visits = new Map([['3:146', ['मिले', 'दोबारा']]]);
  const { screen } = mount({ tags, visits });
  await screen.setRolls(new Map([[W3, ROLL3]]));
  await search(screen, '12');
  const rows = screen.households[0].list.querySelectorAll('button.household-member');
  const value = (row, cls) => row.querySelector(`span.${cls}`).querySelector('span.household-member-value').textContent;
  assert.equal(value(rows[0], 'household-member-phone'), '9876543210');
  assert.equal(value(rows[0], 'household-member-tag'), 'समर्थक');
  assert.equal(value(rows[1], 'household-member-visit'), 'मिले, दोबारा');
  assert.equal(value(rows[1], 'household-member-phone'), '—');
  assert.equal(value(rows[2], 'household-member-tag'), '—');

  screen.setLookups({ tags: new Map([['3:147', 'तटस्थ']]) });
  await Promise.all(screen.households.map((card) => card.ready));
  const again = screen.households[0].list.querySelectorAll('button.household-member');
  assert.equal(value(again[2], 'household-member-tag'), 'तटस्थ', 'new lookups redraw the card');
});

test('the card lists all members whatever the gender or age filters keep; the ward filter picks the ward', async () => {
  const { screen } = mount();
  await screen.setRolls(ROLLS);
  await search(screen, '12');
  assert.equal(screen.households.length, 2, 'house 12 exists in wards 3 and 5');
  const wards = screen.householdHost.querySelectorAll('p.search-household-ward').map((p) => p.textContent);
  assert.deepEqual(wards, [`${strings.search_ward} 3`, `${strings.search_ward} 5`], 'each card names its ward');

  change(screen.controls.place, 'w:3');
  await Promise.all(screen.households.map((card) => card.ready));
  assert.equal(screen.households.length, 1);
  assert.deepEqual(serialsOf(screen.households[0]), [145, 146, 147]);
  assert.equal(screen.householdHost.querySelectorAll('p.search-household-ward').length, 0);

  const before = screen.households[0];
  change(screen.controls.gender, 'पुरुष');
  assert.equal(screen.households[0], before, 'the same household is not read again');
  assert.deepEqual(serialsOf(screen.households[0]), [145, 146, 147]);
  assert.deepEqual(screen.list.children.map((row) => row.getAttribute('data-key')), ['3:145']);
});

test('a query that is no house shows no card; a missing jump with no such house is still the error', async () => {
  const { screen } = mount();
  await screen.setRolls(ROLLS);
  await search(screen, 'रमेश');
  assert.equal(screen.state, 'filled');
  assert.equal(screen.households.length, 0);
  assert.equal(screen.householdHost.children.length, 0);

  await search(screen, '12');
  assert.equal(screen.households.length, 2);
  await search(screen, '3/999');
  assert.equal(screen.state, 'error');
  assert.equal(screen.householdHost.hidden, true);
  assert.equal(screen.households.length, 0, 'the error state shows no card');

  await search(screen, '');
  assert.equal(screen.households.length, 0, 'an empty query matches no house, not the voters with no house');
});

test('a filter that hides every row leaves the household card, without a "0 found" count', async () => {
  const { screen } = mount();
  await screen.setRolls(new Map([[W3, ROLL3]]));
  type(screen.controls.ageMin, '90');
  await search(screen, '12');
  assert.equal(screen.state, 'filled');
  assert.equal(screen.list.children.length, 0);
  assert.equal(screen.count.hidden, true);
  assert.deepEqual(serialsOf(screen.households[0]), [145, 146, 147]);
});

test('a number that cannot be read is the card\'s error state with a retry; the search rows stay', async () => {
  let fail = true;
  const { screen } = mount({
    contacts: {
      listConsented: async () => [],
      getContact: async () => { if (fail) throw new Error('locked'); return null; },
    },
  });
  await screen.setRolls(new Map([[W3, ROLL3]]));
  await search(screen, '12');
  const [card] = screen.households;
  assert.equal(card.state, 'error');
  assert.equal(card.message.getAttribute('data-tone'), 'error');
  assert.equal(card.retryButton.hidden, false);
  assert.equal(screen.state, 'filled');
  assert.ok(screen.list.children.length > 0);
  fail = false;
  card.retryButton.dispatchEvent({ type: 'click' });
  await sleep(0);
  await card.ready;
  await sleep(0);
  assert.equal(card.state, 'success');
});

test('a contact store without getContact shows "—" for every number instead of failing', async () => {
  const { screen } = mount({ contacts: { listConsented: async () => [] } });
  await screen.setRolls(new Map([[W3, ROLL3]]));
  await search(screen, '12');
  assert.equal(screen.households[0].state, 'success');
});

test('the app opens the voter route from a member tap, and the household modules are precached', () => {
  const picker = read('js/picker.js');
  assert.match(picker, /import \{ voterRouteHash \} from '\.\.\/src\/ui\/voterRoute\.js'/);
  assert.match(picker, /onOpenVoter: function \(voter\) \{\s*window\.location\.hash = voterRouteHash\(voter\.ward, voter\.serial\);/);
  const sw = read('sw.js');
  for (const file of ['src/households/householdIndex.js', 'src/households/householdCard.js']) {
    assert.ok(sw.includes(`"${file}"`), file);
  }
});

test('the household slot is styled from tokens and named in DESIGN.md', () => {
  const css = read('styles.css');
  const block = css.slice(css.indexOf('.search-households,'), css.indexOf('/* Voter route'));
  assert.ok(block.includes('.search-household-ward {'));
  assert.match(block, /\.search-households\[hidden\]/, 'hidden wins over display: flex');
  assert.doesNotMatch(block, /#[0-9a-f]{3,8}\b|rgba?\(|\d+px/i);
  for (const [, value] of block.matchAll(/font-size:\s*([^;]+);/g)) assert.match(value, /^var\(--font-size-(sm|body|lg|xl)\)$/);
  const design = read('DESIGN.md');
  assert.ok(design.includes('`.search-households`'));
});
