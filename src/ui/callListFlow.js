// The call list as a screen in the app (issue #70): the ward's consented
// voters with their assigned worker, a 'Call' link and a worker select per
// row (src/ui/callListScreen.js), plus a field to add a worker to the roster.
// Opened from the roll view's call-list button (src/ui/rollSearch.js wires it).
//
// - Voters come from the contact store (only consented voters are there);
//   their names come from the ward's roll entries.
// - Choosing a worker saves the assignment (src/calls/assignmentStore.js);
//   a failed save shows a Hindi message and the stored state again.
// - Workers come from the device's roster (src/calls/workerRoster.js), plus
//   anyone already assigned who is not on it.
// Everything is read from and written to the device, so it works offline.
// All text comes from the strings table.

import { buildCallList } from '../calls/callList.js';
import { renderCallList } from './callListScreen.js';
import { el } from './dom.js';

/**
 * @param {Element} container replaced with the screen
 * @param {Record<string, string>} strings the Hindi string table
 * @param {{
 *   contacts: {listConsented}, wardId: string,
 *   entries: {serial: number, name: string}[],
 *   assignments: {assignVoter, loadAssignments},
 *   roster: {listWorkers, addWorker},
 *   onClose?: () => void, log?: Function,
 * }} opts
 * @returns {{root, ready: Promise<void>, listHost, message, nameInput, addButton,
 *   retryButton, closeButton, reload: () => Promise<void>}}
 */
export function mountCallListFlow(container, strings, opts) {
  const doc = container.ownerDocument;
  const text = (key) => (strings && Object.prototype.hasOwnProperty.call(strings, key) ? strings[key] : '');
  const { contacts, wardId, entries = [], assignments, roster } = opts;
  const log = opts.log || ((...args) => console.error(...args));
  const names = new Map(entries.map((entry) => [entry.serial, entry.name]));

  const root = el(doc, 'section', 'contact-panel call-list-screen');
  root.setAttribute('lang', 'hi');
  root.appendChild(el(doc, 'h2', 'contact-title', text('call_list_title')));

  // Add a worker by name; they then appear in every row's select.
  const form = el(doc, 'form', 'call-worker-form');
  form.setAttribute('novalidate', '');
  const field = el(doc, 'label', 'picker-field');
  field.appendChild(el(doc, 'span', 'picker-label', text('call_worker_name_label')));
  const nameInput = el(doc, 'input', 'picker-select call-worker-name');
  nameInput.setAttribute('type', 'text');
  nameInput.setAttribute('autocomplete', 'off');
  nameInput.setAttribute('maxlength', '60');
  field.appendChild(nameInput);
  form.appendChild(field);
  const addButton = el(doc, 'button', 'btn-secondary call-worker-add', text('call_worker_add'));
  addButton.setAttribute('type', 'submit');
  form.appendChild(addButton);

  const message = el(doc, 'p', 'picker-message contact-message');
  message.setAttribute('aria-live', 'polite');
  const retryButton = el(doc, 'button', 'btn-secondary call-list-retry', text('roll_retry'));
  retryButton.setAttribute('type', 'button');
  retryButton.hidden = true;
  const listHost = el(doc, 'div', 'call-list-host');
  const closeButton = el(doc, 'button', 'btn-secondary call-list-close', text('contact_close'));
  closeButton.setAttribute('type', 'button');

  root.appendChild(form);
  root.appendChild(message);
  root.appendChild(retryButton);
  root.appendChild(listHost);
  root.appendChild(closeButton);
  container.replaceChildren(root);

  function onAssign(serial, worker) {
    message.textContent = '';
    Promise.resolve()
      .then(() => assignments.assignVoter(serial, worker))
      .then(() => {
        message.textContent = text('call_assigned');
      }, (err) => {
        log('assignment could not be saved', err);
        // Show what is really stored.
        return reload().then(() => {
          message.textContent = text('call_assign_failed');
        });
      });
  }

  function show(rows, workers) {
    renderCallList(listHost, rows, { workers, onAssign, strings });
    message.textContent = rows.length ? '' : text('call_list_empty');
  }

  let generation = 0;
  function reload() {
    const mine = ++generation;
    retryButton.hidden = true;
    message.textContent = text('call_list_loading');
    return Promise.resolve()
      .then(() => Promise.all([contacts.listConsented(wardId), assignments.loadAssignments(), roster.listWorkers()]))
      .then(([consented, assigned, listed]) => {
        if (mine !== generation) return;
        const voters = consented.map(({ serial, phone }) => ({ serial, name: names.get(serial) || '', phone }));
        const rows = buildCallList(voters, assigned);
        const workers = [...listed];
        for (const row of rows) {
          if (row.workerId && !workers.some((w) => w.workerId === row.workerId)) {
            workers.push({ workerId: row.workerId, workerName: row.workerName });
          }
        }
        show(rows, workers);
      }, (err) => {
        if (mine !== generation) return;
        log('call list could not be read', err);
        listHost.replaceChildren();
        message.textContent = text('call_list_failed');
        retryButton.hidden = false;
      });
  }
  retryButton.addEventListener('click', () => { reload(); });

  let adding = false;
  form.addEventListener('submit', (event) => {
    if (event && typeof event.preventDefault === 'function') event.preventDefault();
    const name = String(nameInput.value || '').trim();
    if (!name || adding) return;
    adding = true;
    Promise.resolve()
      .then(() => roster.addWorker(name))
      .then(() => {
        nameInput.value = '';
        return reload().then(() => {
          // Keep the empty-list or failure message if one is showing.
          if (!message.textContent) message.textContent = text('call_worker_added');
        });
      }, (err) => {
        log('worker could not be added', err);
        message.textContent = text('contact_failed');
      })
      .finally(() => {
        adding = false;
      });
  });

  closeButton.addEventListener('click', () => {
    generation += 1;
    container.replaceChildren();
    if (typeof opts.onClose === 'function') opts.onClose();
  });

  const ready = reload();

  return { root, ready, listHost, message, nameInput, addButton, retryButton, closeButton, reload };
}
