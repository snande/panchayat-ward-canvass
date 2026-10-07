// Pages file routing maps functions/sync.js to /sync alone; this catch-all
// sends /sync/push, /sync/pull and any other /sync/* path to the same handler.
export { onRequest } from '../sync.js';
