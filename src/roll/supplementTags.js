// Shared by the supplementary-roll code (issue #127): the tags a merged entry
// can carry, the deletion predicate the roll view hides by, and the URL-list
// filter for supplementPdfUrls. Small and dependency-free, so the merge
// (src/roll/applySupplements.js) can stay lazily loaded.

/** The `supplement` tag of an entry a supplementary roll changed. */
export const SUPPLEMENT_KINDS = Object.freeze(['addition', 'deletion']);

/** Whether an entry is a supplementary deletion, hidden unless deletions show. */
export function isSupplementDeletion(entry) {
  return Boolean(entry) && entry.supplement === 'deletion';
}

/** The non-empty strings of a URL list; [] for anything that is not an array. */
export function urlList(urls) {
  return Array.isArray(urls) ? urls.filter((url) => typeof url === 'string' && url) : [];
}
