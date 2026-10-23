'use strict';
// A very small DOM for UI tests (no dependencies): parses the well-formed HTML
// the UI modules generate and supports the handful of element APIs they use.
// Selectors: one compound selector made of tag, #id, .class, [attr] and
// [attr="value"] parts.

const VOID = new Set(['input', 'br', 'img', 'meta', 'link', 'hr']);
const decode = text => text.replace(/&(amp|lt|gt|quot|#39);/g, (_, name) => ({ amp: '&', lt: '<', gt: '>', quot: '"', '#39': "'" }[name]));

function parseSelector(selector) {
  const parts = { tag: null, id: null, classes: [], attrs: [] };
  const re = /([a-zA-Z][a-zA-Z0-9-]*)|#([\w-]+)|\.([\w-]+)|\[([\w-]+)(?:="([^"]*)")?\]/g;
  let m;
  while ((m = re.exec(selector))) {
    if (m[1]) parts.tag = m[1].toLowerCase();
    else if (m[2]) parts.id = m[2];
    else if (m[3]) parts.classes.push(m[3]);
    else parts.attrs.push([m[4], m[5]]);
  }
  return parts;
}

function createDocument({ viewport = { width: 1024, height: 768 } } = {}) {
  const docListeners = {};
  const doc = {
    activeElement: null,
    addEventListener(type, fn) { (docListeners[type] = docListeners[type] || []).push(fn); },
    removeEventListener(type, fn) { docListeners[type] = (docListeners[type] || []).filter(x => x !== fn); },
  };
  const win = { innerWidth: viewport.width, innerHeight: viewport.height, addEventListener() {}, removeEventListener() {} };

  class Element {
    constructor(tag, attrs = {}) {
      this.tagName = tag.toUpperCase(); this.attrs = { ...attrs }; this.children = []; this.parent = null;
      this.listeners = {}; this.style = {}; this.rect = { left: 100, top: 100, right: 116, bottom: 116, width: 16, height: 16 };
    }
    getAttribute(name) { return Object.hasOwn(this.attrs, name) ? this.attrs[name] : null; }
    setAttribute(name, value) { this.attrs[name] = String(value); }
    removeAttribute(name) { delete this.attrs[name]; }
    hasAttribute(name) { return Object.hasOwn(this.attrs, name); }
    get hidden() { return this.hasAttribute('hidden'); }
    set hidden(value) { if (value) this.setAttribute('hidden', ''); else this.removeAttribute('hidden'); }
    get id() { return this.getAttribute('id') || ''; }
    get elements() { return this.children.filter(child => child instanceof Element); }
    get textContent() { return this.children.map(child => (child instanceof Element ? child.textContent : child.text)).join(''); }
    get offsetWidth() { return 360; }
    get offsetHeight() { return 240; }
    getBoundingClientRect() { return this.rect; }
    matches(selector) {
      const s = parseSelector(selector);
      if (s.tag && this.tagName.toLowerCase() !== s.tag) return false;
      if (s.id && this.id !== s.id) return false;
      const classes = (this.getAttribute('class') || '').split(/\s+/);
      if (!s.classes.every(name => classes.includes(name))) return false;
      return s.attrs.every(([name, value]) => this.hasAttribute(name) && (value === undefined || this.getAttribute(name) === value));
    }
    closest(selector) { let node = this; while (node) { if (node.matches(selector)) return node; node = node.parent; } return null; }
    querySelectorAll(selector) {
      const out = [];
      const walk = node => { for (const child of node.elements) { if (child.matches(selector)) out.push(child); walk(child); } };
      walk(this); return out;
    }
    querySelector(selector) { return this.querySelectorAll(selector)[0] || null; }
    contains(node) { while (node) { if (node === this) return true; node = node.parent; } return false; }
    focus() {
      const previous = doc.activeElement;
      if (previous && previous !== this) dispatch(previous, { type: 'focusout', relatedTarget: this });
      doc.activeElement = this;
    }
    addEventListener(type, fn) { (this.listeners[type] = this.listeners[type] || []).push(fn); }
    removeEventListener(type, fn) { this.listeners[type] = (this.listeners[type] || []).filter(x => x !== fn); }
  }

  function dispatch(target, init) {
    const event = { detail: 0, ...init, target, defaultPrevented: false, preventDefault() { this.defaultPrevented = true; } };
    for (let node = target; node; node = node.parent) for (const fn of node.listeners[event.type] || []) fn(event);
    for (const fn of docListeners[event.type] || []) fn(event);
    return event;
  }

  function parse(html) {
    const root = new Element('div');
    let current = root, m;
    const re = /<!--[\s\S]*?-->|<\/([a-zA-Z0-9]+)\s*>|<([a-zA-Z0-9]+)((?:\s+[^\s=>/]+(?:="[^"]*")?)*)\s*\/?>|([^<]+)/g;
    while ((m = re.exec(html))) {
      if (m[1]) { if (current.parent) current = current.parent; continue; }
      if (m[2]) {
        const attrs = {}; let a; const are = /([^\s=]+)(?:="([^"]*)")?/g;
        while ((a = are.exec(m[3] || ''))) attrs[a[1]] = a[2] === undefined ? '' : decode(a[2]);
        const element = new Element(m[2].toLowerCase(), attrs);
        element.parent = current; current.children.push(element);
        if (!VOID.has(m[2].toLowerCase())) current = element;
        continue;
      }
      if (m[4]) current.children.push({ text: decode(m[4]) });
    }
    return root;
  }

  return { doc, win, parse, dispatch, Element };
}

module.exports = { createDocument };
