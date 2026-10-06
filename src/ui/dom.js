// Shared DOM helper for the roll screens.

/** Create an element with an optional class attribute and text content. */
export function el(doc, tag, className, text) {
  const node = doc.createElement(tag);
  if (className) node.setAttribute('class', className);
  if (text != null) node.textContent = String(text);
  return node;
}
