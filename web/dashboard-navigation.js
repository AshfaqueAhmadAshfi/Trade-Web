/* Revoke the current browser session, then return to the access website. */
(function () {
  'use strict';
  const button = document.getElementById('dashboard-logout');
  if (!button) return;
  const label = button.querySelector('span');
  let pending = false;
  button.addEventListener('click', async () => {
    if (pending) return;
    pending = true;
    button.disabled = true;
    label.textContent = 'Logging out…';
    try {
      const response = await fetch('/api/logout', {
        method: 'POST', credentials: 'same-origin', cache: 'no-store',
        signal: AbortSignal.timeout(10000)
      });
      const result = await response.json();
      if (!response.ok || result.ok !== true) throw new Error('Logout could not be completed. Please try again.');
      window.location.replace('/access');
    } catch (error) {
      const message = 'Logout could not be completed. Please try again.';
      button.title = message;
      if (typeof window.toast === 'function') window.toast('error', message);
    } finally {
      pending = false;
      button.disabled = false;
      label.textContent = 'Logout';
    }
  });
})();
