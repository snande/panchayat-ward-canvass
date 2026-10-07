// Call list screen: each consented voter with their assigned worker, a 'Call'
// link and a control to (re)assign the voter to a worker.
//
// Calls are placed from the worker's own phone. The 'Call' control is a plain
// <a href="tel:..."> anchor: a user tap hands the number to the phone's dialer,
// which fills it in and waits for the worker to press call. This module never
// navigates on its own, opens windows or fires synthetic taps, and makes no
// network request; text is set with textContent only, inherits the page's
// self-hosted Noto Sans Devanagari font and comes from the strings table.

import { el } from './dom.js';

/** The tel: href for a stored phone number, with spaces and hyphens removed. */
export function telHref(phone) {
  return `tel:${String(phone ?? '').replace(/[\s-]/g, '')}`;
}

/**
 * Render the call list into container (replacing its content).
 * @param {{serial, name, phone, workerId: string | null, workerName: string | null}[]} rows
 *   the output of buildCallList (src/calls/callList.js)
 * @param {{workers?: {workerId: string, workerName: string}[],
 *   onAssign?: (serial, worker: {workerId: string, workerName: string}) => void,
 *   strings?: Record<string,string>}} [opts] strings is the Hindi string table
 * @returns {{root, list, rows: () => object[]}}
 */
export function renderCallList(container, rows, { workers = [], onAssign, strings = {} } = {}) {
  if (!Array.isArray(rows)) throw new TypeError('rows must be an array');
  const doc = container.ownerDocument;
  const text = (key) => (strings && Object.prototype.hasOwnProperty.call(strings, key) ? strings[key] : '');
  const state = rows.map((row) => ({ ...row }));

  const root = el(doc, 'div', 'call-list');
  root.setAttribute('lang', 'hi');
  const list = el(doc, 'ul', 'call-list__rows');
  list.setAttribute('aria-label', text('call_list_label'));
  root.appendChild(list);

  function fillAssignee(node, row) {
    const assigned = row.workerId != null && row.workerName != null;
    node.setAttribute('class', assigned ? 'call-row__assignee' : 'call-row__assignee call-row__assignee--none');
    node.textContent = assigned ? row.workerName : text('call_not_assigned');
  }

  function renderRow(row) {
    const item = el(doc, 'li', 'call-row');
    item.setAttribute('data-serial', String(row.serial));

    const info = el(doc, 'div', 'call-row__info');
    info.appendChild(el(doc, 'span', 'call-row__name', row.name ?? ''));
    const assignee = el(doc, 'span');
    fillAssignee(assignee, row);
    info.appendChild(assignee);
    item.appendChild(info);

    const call = el(doc, 'a', 'call-btn', text('call_action'));
    call.setAttribute('href', telHref(row.phone));
    item.appendChild(call);

    const field = el(doc, 'label', 'call-row__assign');
    field.appendChild(el(doc, 'span', 'call-row__assign-label', text('call_assign_label')));
    const select = el(doc, 'select', 'call-row__select');
    const prompt = el(doc, 'option', null, text('call_assign_prompt'));
    prompt.setAttribute('value', '');
    prompt.setAttribute('disabled', '');
    select.appendChild(prompt);
    for (const worker of workers) {
      const option = el(doc, 'option', null, worker.workerName);
      option.setAttribute('value', worker.workerId);
      select.appendChild(option);
    }
    select.value = row.workerId ?? '';
    select.addEventListener('change', () => {
      const chosen = workers.find((w) => w.workerId === select.value);
      if (!chosen) {
        select.value = row.workerId ?? '';
        return;
      }
      const worker = { workerId: chosen.workerId, workerName: chosen.workerName };
      if (typeof onAssign === 'function') onAssign(row.serial, worker);
      row.workerId = worker.workerId;
      row.workerName = worker.workerName;
      fillAssignee(assignee, row);
    });
    field.appendChild(select);
    item.appendChild(field);
    return item;
  }

  const fragment = doc.createDocumentFragment();
  for (const row of state) fragment.appendChild(renderRow(row));
  list.appendChild(fragment);
  container.replaceChildren(root);

  return {
    root,
    list,
    rows: () => state.map((row) => ({ ...row })),
  };
}
