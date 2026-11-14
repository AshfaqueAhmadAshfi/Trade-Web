(function () {
  'use strict';
  var stage = document.getElementById('systems');
  var toggle = document.getElementById('orbit-toggle');
  if (!stage || !toggle) return;
  var reduced = window.matchMedia('(prefers-reduced-motion: reduce)');
  var manuallyPaused = false;
  var hovering = false, inView = true, frame = null, lastFrame = null, phase = 0;
  var path = stage.querySelector('.path-outer');
  var cards = Array.from(stage.querySelectorAll('.orbit-card')).map(function (card) {
    return {element: card, angle: parseFloat(card.style.getPropertyValue('--angle')) * Math.PI / 180 || 0};
  });
  var radiusX = 0, radiusY = 0;

  function positionCards() {
    cards.forEach(function (card) {
      var angle = card.angle + phase;
      card.element.style.transform = 'translate(-50%, -50%) translate3d(' +
        (Math.cos(angle) * radiusX).toFixed(2) + 'px,' + (Math.sin(angle) * radiusY).toFixed(2) + 'px,0)';
    });
  }
  function resizeOrbit() {
    if (!path) return;
    radiusX = path.clientWidth / 2;
    radiusY = path.clientHeight / 2;
    positionCards();
  }
  function moving() { return !manuallyPaused && !reduced.matches && !hovering && inView && !document.hidden; }
  function animate(time) {
    frame = null;
    if (!moving()) { lastFrame = null; return; }
    if (lastFrame === null) lastFrame = time;
    if (time - lastFrame >= 1000 / 30) {
      phase = (phase + Math.min(100, time - lastFrame) * Math.PI * 2 / 160000) % (Math.PI * 2);
      lastFrame = time;
      positionCards();
    }
    frame = requestAnimationFrame(animate);
  }
  function syncAnimation() {
    if (!moving()) {
      if (frame !== null) cancelAnimationFrame(frame);
      frame = null; lastFrame = null;
    } else if (frame === null) frame = requestAnimationFrame(animate);
  }

  function updateMotion() {
    var paused = manuallyPaused || reduced.matches;
    stage.classList.toggle('orbit-paused', paused);
    toggle.setAttribute('aria-pressed', String(paused));
    toggle.setAttribute('aria-label', paused ? 'Resume orbital animation' : 'Pause orbital animation');
    toggle.querySelector('.motion-label').textContent = paused ? 'Resume orbit' : 'Pause orbit';
    toggle.querySelector('.motion-symbol').textContent = paused ? '▷' : 'Ⅱ';
    toggle.disabled = reduced.matches;
    if (reduced.matches) {
      toggle.querySelector('.motion-label').textContent = 'Reduced motion';
      toggle.setAttribute('aria-label', 'Orbital animation is disabled by your reduced motion preference');
    }
    syncAnimation();
  }

  toggle.addEventListener('click', function () { manuallyPaused = !manuallyPaused; updateMotion(); });
  if (reduced.addEventListener) reduced.addEventListener('change', updateMotion);
  cards.forEach(function (card) {
    card.element.addEventListener('pointerenter', function () { hovering = true; syncAnimation(); });
    card.element.addEventListener('pointerleave', function () { hovering = false; syncAnimation(); });
  });
  document.addEventListener('visibilitychange', syncAnimation);
  if (typeof IntersectionObserver !== 'undefined') new IntersectionObserver(function (entries) {
    inView = entries[0].isIntersecting;
    syncAnimation();
  }).observe(stage);
  if (typeof ResizeObserver !== 'undefined') new ResizeObserver(resizeOrbit).observe(stage);
  else window.addEventListener('resize', resizeOrbit);
  resizeOrbit();
  updateMotion();
})();
