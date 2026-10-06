// Minimal in-process DOM used as the test DOM environment for the UI
// screens. It implements only the subset of the DOM the screens rely on
// (elements, text nodes, fragments, attributes, input events), so the suite
// runs under plain `node --test` with no extra dependencies.

class FakeNode {
  constructor(ownerDocument) {
    this.ownerDocument = ownerDocument;
    this.parentNode = null;
    this.childNodes = [];
    this.replaceCount = 0;
  }

  get firstChild() {
    return this.childNodes[0] || null;
  }

  get children() {
    return this.childNodes.filter((n) => n instanceof FakeElement);
  }

  appendChild(child) {
    if (child instanceof FakeFragment) {
      for (const c of [...child.childNodes]) this.appendChild(c);
      return child;
    }
    if (child.parentNode) child.parentNode.removeChild(child);
    child.parentNode = this;
    this.childNodes.push(child);
    if (this.ownerDocument) this.ownerDocument.mutations += 1;
    return child;
  }

  removeChild(child) {
    const i = this.childNodes.indexOf(child);
    if (i < 0) throw new Error('removeChild: not a child');
    this.childNodes.splice(i, 1);
    child.parentNode = null;
    if (this.ownerDocument) this.ownerDocument.mutations += 1;
    return child;
  }

  replaceChildren(...nodes) {
    for (const c of this.childNodes) c.parentNode = null;
    this.childNodes = [];
    for (const n of nodes) this.appendChild(n);
    this.replaceCount += 1;
  }

  get textContent() {
    return this.childNodes.map((c) => c.textContent).join('');
  }

  set textContent(value) {
    this.replaceChildren(new FakeText(this.ownerDocument, value));
  }
}

class FakeText extends FakeNode {
  constructor(ownerDocument, data) {
    super(ownerDocument);
    this.data = String(data);
  }

  get textContent() {
    return this.data;
  }

  set textContent(value) {
    this.data = String(value);
  }
}

class FakeFragment extends FakeNode {}

class FakeElement extends FakeNode {
  constructor(ownerDocument, tagName) {
    super(ownerDocument);
    this.tagName = tagName.toUpperCase();
    this.attributes = new Map();
    this.listeners = new Map();
    this.value = '';
  }

  setAttribute(name, value) {
    this.attributes.set(name, String(value));
  }

  getAttribute(name) {
    return this.attributes.has(name) ? this.attributes.get(name) : null;
  }

  hasAttribute(name) {
    return this.attributes.has(name);
  }

  removeAttribute(name) {
    this.attributes.delete(name);
  }

  get className() {
    return this.getAttribute('class') || '';
  }

  get classList() {
    const names = this.className.split(/\s+/).filter(Boolean);
    return { contains: (n) => names.includes(n) };
  }

  get hidden() {
    return this.hasAttribute('hidden');
  }

  get placeholder() {
    return this.getAttribute('placeholder') || '';
  }

  addEventListener(type, fn) {
    if (!this.listeners.has(type)) this.listeners.set(type, new Set());
    this.listeners.get(type).add(fn);
  }

  removeEventListener(type, fn) {
    const set = this.listeners.get(type);
    if (set) set.delete(fn);
  }

  dispatchEvent(event) {
    event.target = this;
    for (const fn of [...(this.listeners.get(event.type) || [])]) fn.call(this, event);
    return true;
  }

  // Supports simple selectors only: "tag", ".class" or "tag.class".
  querySelectorAll(selector) {
    const [tag, cls] = selector.includes('.') ? selector.split('.') : [selector, null];
    const out = [];
    const walk = (node) => {
      for (const c of node.children) {
        const tagOk = !tag || c.tagName === tag.toUpperCase();
        const clsOk = !cls || c.classList.contains(cls);
        if (tagOk && clsOk) out.push(c);
        walk(c);
      }
    };
    walk(this);
    return out;
  }

  querySelector(selector) {
    return this.querySelectorAll(selector)[0] || null;
  }
}

class FakeDocument {
  constructor() {
    this.mutations = 0;
    this.body = new FakeElement(this, 'body');
  }

  createElement(tagName) {
    return new FakeElement(this, tagName);
  }

  createTextNode(data) {
    return new FakeText(this, data);
  }

  createDocumentFragment() {
    return new FakeFragment(this);
  }
}

export function createDocument() {
  return new FakeDocument();
}

/** Set the input's value and fire an `input` event, like a keystroke. */
export function type(input, value) {
  input.value = value;
  input.dispatchEvent({ type: 'input' });
}
