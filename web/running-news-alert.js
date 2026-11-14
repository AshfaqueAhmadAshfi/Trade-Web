/* Notify once for a newly running release or a fresh selected-market headline. */
(function (root) {
  'use strict';
  function createObserver(onNew, onReset) {
    let market = '', primed = false;
    const seen = new Map();
    function observe(snapshot) {
      if (!snapshot || !snapshot.market) return;
      if (market !== snapshot.market) {
        market = snapshot.market;
        primed = false;
        seen.clear();
        if (onReset) onReset();
      }
      // An empty loading screen is not the first news snapshot.
      if (!snapshot.ready) return;
      const now = Number(snapshot.now);
      for (const [key, expires] of seen) if (expires <= now) seen.delete(key);
      const fresh = [];
      for (const event of snapshot.events || []) {
        if (!event.key || !(event.expiresAt > now)) continue;
        if (!seen.has(event.key)) fresh.push(event);
        seen.set(event.key, event.expiresAt);
      }
      if (primed && fresh.length) onNew(fresh, snapshot.label || market);
      primed = true;
    }
    return {observe};
  }
  if (typeof module !== 'undefined' && module.exports) module.exports = {createObserver};
  if (!root.document) return;

  const doc = root.document;
  const popup = doc.createElement('aside');
  popup.id = 'running-news-popup';
  popup.className = 'running-news-popup';
  popup.setAttribute('role', 'status');
  popup.setAttribute('aria-live', 'polite');
  popup.setAttribute('aria-atomic', 'true');
  let timer = null, deadline = 0;

  function moveToVisiblePage() {
    const parent = doc.fullscreenElement || doc.body;
    if (popup.parentElement !== parent) parent.appendChild(popup);
  }
  function hide() {
    if (timer !== null) root.clearTimeout(timer);
    timer = null;
    deadline = 0;
    popup.classList.remove('is-visible');
  }
  function textElement(tag, className, text) {
    const node = doc.createElement(tag);
    node.className = className;
    node.textContent = text;
    return node;
  }
  function show(events, label) {
    hide();
    moveToVisiblePage();
    const content = doc.createDocumentFragment();
    content.appendChild(textElement('div', 'rnews-alert-kicker', 'SOFTRADEX · NEWS ALERT'));
    content.appendChild(textElement('h2', 'rnews-alert-heading', events.length === 1
      ? (events[0].headline ? 'New market headline' : 'New running news') : events.length + ' new news updates'));
    content.appendChild(textElement('p', 'rnews-alert-market', label));
    const list = textElement('div', 'rnews-alert-items', '');
    events.slice(0, 3).forEach(event => {
      const item = textElement('div', 'rnews-alert-item', '');
      item.appendChild(textElement('strong', 'rnews-alert-title', event.title || 'New market update'));
      item.appendChild(textElement('span', 'rnews-alert-meta',
        (event.headline ? 'Recent headline · impact unconfirmed' : 'Scheduled release now running') +
        (event.source ? ' · ' + event.source : '')));
      list.appendChild(item);
    });
    content.appendChild(list);
    if (events.length > 3) content.appendChild(textElement('p', 'rnews-alert-more',
      '+' + (events.length - 3) + ' more updates in the news panels'));
    content.appendChild(textElement('p', 'rnews-alert-footer', 'Closes automatically in 5 seconds'));
    const progress = textElement('div', 'rnews-alert-progress', '');
    progress.setAttribute('aria-hidden', 'true');
    progress.appendChild(doc.createElement('span'));
    content.appendChild(progress);
    popup.replaceChildren(content);
    popup.classList.add('is-visible');
    deadline = Date.now() + 5000;
    timer = root.setTimeout(hide, 5000);
  }
  moveToVisiblePage();
  doc.addEventListener('fullscreenchange', moveToVisiblePage);
  doc.addEventListener('visibilitychange', () => {
    if (!doc.hidden && deadline && Date.now() >= deadline) hide();
  });
  root.RunningNewsAlerts = createObserver(show, hide);
})(typeof window === 'undefined' ? globalThis : window);
