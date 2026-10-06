// Downloads the selected ward's roll PDF. No upload path: the only input is a
// selection resolved from the bundled catalogue (src/picker/wardPicker.js).
//
// The transport follows the verdict line at the end of
// docs/research/sec-roll-source.md (test/fetchRoll.test.js fails if they
// drift):
//   direct-fetch    the browser GETs the commission's URL itself
//   relay-required  the browser GETs the same-origin relay at RELAY_PATH,
//                   which only fetches URLs listed in config/constituency.json
//                   (relay/rollRelay.mjs)

export const ROLL_TRANSPORT = 'relay-required';
export const TRANSPORTS = Object.freeze(['direct-fetch', 'relay-required']);
export const RELAY_PATH = '/roll';

/** A download that failed: network error, non-OK status or not a PDF. */
export class RollFetchError extends Error {
  constructor(message, { status = null, cause } = {}) {
    super(message, cause === undefined ? undefined : { cause });
    this.name = 'RollFetchError';
    this.status = status;
  }
}

/** URL the browser requests for a ward's PDF under the given transport. */
export function rollRequestUrl(pdfUrl, transport = ROLL_TRANSPORT) {
  if (transport === 'direct-fetch') return pdfUrl;
  if (transport === 'relay-required') return `${RELAY_PATH}?url=${encodeURIComponent(pdfUrl)}`;
  throw new Error(`unknown roll transport: ${transport}`);
}

const PDF_MAGIC = [0x25, 0x50, 0x44, 0x46, 0x2d]; // "%PDF-"

function looksLikePdf(buffer) {
  const head = new Uint8Array(buffer, 0, Math.min(buffer.byteLength, PDF_MAGIC.length));
  return head.length === PDF_MAGIC.length && PDF_MAGIC.every((b, i) => head[i] === b);
}

/**
 * Download the roll PDF for a ward selection ({..., pdfUrl}).
 * @returns {Promise<ArrayBuffer>} the PDF bytes
 * @throws {RollFetchError}
 */
export async function fetchRoll(selection, { fetch = globalThis.fetch, transport = ROLL_TRANSPORT } = {}) {
  if (!selection || typeof selection.pdfUrl !== 'string' || !selection.pdfUrl) {
    throw new RollFetchError('no ward selected');
  }
  const url = rollRequestUrl(selection.pdfUrl, transport);
  let response;
  try {
    response = await fetch(url, { credentials: 'same-origin', cache: 'no-store' });
  } catch (cause) {
    throw new RollFetchError('roll download failed', { cause });
  }
  if (!response || !response.ok) {
    const status = response ? response.status : null;
    throw new RollFetchError(`roll download failed: HTTP ${status}`, { status });
  }
  let buffer;
  try {
    buffer = await response.arrayBuffer();
  } catch (cause) {
    throw new RollFetchError('roll download interrupted', { cause });
  }
  if (!looksLikePdf(buffer)) throw new RollFetchError('roll download is not a PDF');
  return buffer;
}
