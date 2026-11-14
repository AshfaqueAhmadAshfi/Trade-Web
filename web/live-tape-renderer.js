/* Execution records are immutable: retain existing rows as new prints arrive. */
(function (root) {
  'use strict';
  const tapes = new WeakMap();
  function render(element, rows, keyOf, rowHtml, emptyHtml) {
    let tape = tapes.get(element);
    if (!tape) {
      tape = {nodes: new Map(), empty: null};
      tapes.set(element, tape);
      element.textContent = '';
    }
    if (!rows.length) {
      if (tape.empty !== emptyHtml || tape.nodes.size) element.innerHTML = emptyHtml || '';
      tape.nodes.clear();
      tape.empty = emptyHtml;
      return;
    }
    if (tape.empty !== null) { element.textContent = ''; tape.empty = null; }
    const keys = rows.map(keyOf);
    const wanted = new Set(keys);
    for (const [key, node] of tape.nodes) {
      if (!wanted.has(key)) { node.remove(); tape.nodes.delete(key); }
    }
    const missing = rows.filter((row, index) => !tape.nodes.has(keys[index]));
    if (missing.length) {
      const template = element.ownerDocument.createElement('template');
      template.innerHTML = missing.map(rowHtml).join('');
      Array.from(template.content.children).forEach((node, index) => tape.nodes.set(keyOf(missing[index]), node));
    }
    let cursor = element.firstElementChild;
    for (const key of keys) {
      const node = tape.nodes.get(key);
      if (node === cursor) cursor = cursor.nextElementSibling;
      else element.insertBefore(node, cursor);
    }
  }
  root.LiveTapeRenderer = {render};
})(window);
