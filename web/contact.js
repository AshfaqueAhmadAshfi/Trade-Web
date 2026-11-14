/* Keep the complete social dock visible inside the chart's native fullscreen. */
(function () {
  'use strict';
  var contact = document.querySelector('[data-sx-social-dock]');
  if (!contact) return;
  document.addEventListener('fullscreenchange', function () {
    var parent = document.fullscreenElement || document.body;
    if (contact.parentElement !== parent) parent.appendChild(contact);
  });
})();
