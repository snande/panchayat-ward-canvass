// Call list screen: one row per consented voter with the assigned worker, a
// 'Call' link and a control to assign the voter to a worker.
//
// The 'Call' control is a plain anchor with a tel: href. Android's dialer
// fills the number in and waits for the worker to press call, so nothing
// dials until the worker taps it. Rendering never sets window.location or
// location.href, never calls window.open, and never clicks the link.
// All text comes from the strings table (src/strings.hi.json) passed in
// opts.strings; a missing table or key is an error, not a blank label.
// No network access: it works offline in the installed PWA.

import { el } from './dom.js';

const REQUIRED_STRINGS = ['call_action', 'call_not_assigned', 'call_assign_label'];

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
 *   strings: Record<string, string>}} opts strings is the parsed src/strings.hi.json
 * @returns {{root}}
 */
export function renderCallList(container, rows, { workers = [], onAssign, strings } = {}) {
  for (const key of REQUIRED_STRINGS) {
    if (!strings || typeof strings[key] !== 'string' || !strings[key]) {
      throw new TypeError(`renderCallList: strings.${key} is required (pass the parsed src/strings.hi.json)`);
    }
  }
  const doc = container.ownerDocument;

  const root = el(doc, 'div', 'call-list');
  root.setAttribute('lang', 'hi');
  root.setAttribute('role', 'list');

  function buildRow(source) {
    const row = { ...source };
    const node = el(doc, 'div', 'call-row');
    node.setAttribute('role', 'listitem');
    node.appendChild(el(doc, 'span', 'call-name', `${row.serial}. ${row.name}`));
    const assignee = el(doc, 'span', 'call-assignee');
    node.appendChild(assignee);

    // Without a stored number there is nothing to dial: show a disabled
    // control instead of an anchor that goes nowhere.
    let call;
    if (row.phone) {
      call = el(doc, 'a', 'call-btn', strings.call_action);
      call.setAttribute('href', telHref(row.phone));
    } else {
      call = el(doc, 'span', 'call-btn call-btn-disabled', strings.call_action);
      call.setAttribute('aria-disabled', 'true');
    }
    node.appendChild(call);

    const select = el(doc, 'select', 'call-assign');
    select.setAttribute('aria-label', strings.call_assign_label);
    const placeholder = el(doc, 'option', null, strings.call_assign_label);
    placeholder.setAttribute('value', '');
    select.appendChild(placeholder);
    for (const worker of workers) {
      const option = el(doc, 'option', null, worker.workerName);
      option.setAttribute('value', worker.workerId);
      select.appendChild(option);
    }
    node.appendChild(select);

    // Update the assignee text and the select in place, so the control the
    // worker just used keeps focus and shows their choice.
    function show() {
      assignee.textContent = row.workerName || strings.call_not_assigned;
      select.value = row.workerId ?? '';
    }
    show();

    select.addEventListener('change', () => {
      const worker = workers.find((w) => w.workerId === select.value);
      if (!worker) return;
      const previous = { workerId: row.workerId, workerName: row.workerName };
      row.workerId = worker.workerId;
      row.workerName = worker.workerName;
      show();
      if (typeof onAssign !== 'function') return;
      try {
        onAssign(row.serial, { workerId: worker.workerId, workerName: worker.workerName });
      } catch (err) {
        // The assignment was not saved: put the row back as it was.
        row.workerId = previous.workerId;
        row.workerName = previous.workerName;
        show();
        throw err;
      }
    });
    return node;
  }

  for (const row of rows) root.appendChild(buildRow(row));
  container.replaceChildren(root);
  return { root };
}
