/* Build the complete calendar in short tasks, only while its drawer is visible. */
(function (root) {
  'use strict';
  function create(options) {
    const element = options.element;
    const schedule = options.schedule || (fn => setTimeout(fn, 16));
    const cancel = options.cancel || clearTimeout;
    const visible = options.visible || (() => true);
    const batchSize = options.batchSize || 24;
    let timer = null, job = null, key = null;
    function pause() {
      if (timer !== null) cancel(timer);
      timer = null;
    }
    function step() {
      timer = null;
      if (!job || !visible()) return;
      const current = job;
      if (current.index === 0) element.innerHTML = '';
      const end = Math.min(current.index + batchSize, current.rows.length);
      const html = current.rows.slice(current.index, end).map(current.render).join('');
      if (html) element.insertAdjacentHTML('beforeend', html);
      current.index = end;
      if (current.scroll && (element.scrollHeight >= current.scroll + element.clientHeight || end === current.rows.length)) {
        element.scrollTop = current.scroll;
      }
      if (!current.rows.length) element.innerHTML = options.empty || '';
      if (end < current.rows.length) resume();
      else { job = null; if (options.complete) options.complete(); }
    }
    function resume() {
      if (job && timer === null && visible()) timer = schedule(step);
    }
    function update(rows, nextKey, render) {
      if (key !== nextKey) {
        pause();
        key = nextKey;
        job = {rows: rows.slice(), render, index: 0, scroll: element.scrollTop};
      }
      resume();
    }
    return {update, pause, resume};
  }
  root.NewsListRenderer = {create};
  if (typeof module !== 'undefined' && module.exports) module.exports = {create};
})(typeof window === 'undefined' ? globalThis : window);
