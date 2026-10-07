// Call list screen: one row per consented voter with the assigned worker, a
// 'Call' link and a control to assign the voter to a worker.
//
// The 'Call' control is a plain anchor with a tel: href. Android's dialer
// fills the number in and waits for the worker to press call, so nothing
// dials until the worker taps it; this module never navigates to the link
// itself. All text comes from the strings table passed in opts.strings.
// No network access: it works offline in the installed PWA.

import { el } from './dom.js';

/** tel: URI for a stored phone number, with spaces and hyphens removed. */
export function telHref(phone) {
  return `tel:${String(phone ?? '').replace(/[\s-]/g, '')}`;
}

/**
 * Mount the call list into container (replacing its content).
 * @param {object} container
 * @param {{serial, name, phone, workerId: string | null, workerName: string | null}[]} rows
 *   the output of buildCallList
 * @param {{workers?: {workerId: string, workerName: string}[],
 *   onAssign?: (serial, assignee: {workerId: string, workerName: string}) => void,
 *   strings?: Record<string, string>}} [opts]
 * @returns {{root}}
 */
export function renderCallList(container, rows, { workers = [], onAssign, strings } = {}) {
  const doc = container.ownerDocument;
  const text = (key) => (strings && Object.prototype.hasOwnProperty.call(strings, key) ? strings[key] : '');

  const root = el(doc, 'div', 'call-list');
  root.setAttribute('lang', 'hi');
  root.setAttribute('role', 'list');

  function buildRow(row) {
    const node = el(doc, 'div', 'call-row');
    node.setAttribute('role', 'listitem');
    node.appendChild(el(doc, 'span', 'call-name', `${row.serial}. ${row.name}`));
    node.appendChild(el(doc, 'span', 'call-assignee', row.workerName || text('call_not_assigned')));

    const call = el(doc, 'a', 'call-btn', text('call_action'));
    if (row.phone) call.setAttribute('href', telHref(row.phone));
    node.appendChild(call);

    const select = el(doc, 'select', 'call-assign');
    select.setAttribute('aria-label', text('call_assign_label'));
    const placeholder = el(doc, 'option', null, text('call_assign_label'));
    placeholder.setAttribute('value', '');
    select.appendChild(placeholder);
    for (const worker of workers) {
      const option = el(doc, 'option', null, worker.workerName);
      option.setAttribute('value', worker.workerId);
      if (worker.workerId === row.workerId) option.setAttribute('selected', '');
      select.appendChild(option);
    }
    select.value = row.workerId ?? '';
    select.addEventListener('change', () => {
      const worker = workers.find((w) => w.workerId === select.value);
      if (!worker) return;
      const assignee = { workerId: worker.workerId, workerName: worker.workerName };
      if (typeof onAssign === 'function') onAssign(row.serial, assignee);
      row.workerId = assignee.workerId;
      row.workerName = assignee.workerName;
      const fresh = buildRow(row);
      root.replaceChildren(...root.childNodes.map((n) => (n === node ? fresh : n)));
    });
    node.appendChild(select);
    return node;
  }

  for (const row of rows) root.appendChild(buildRow({ ...row }));
  container.replaceChildren(root);
  return { root };
}
