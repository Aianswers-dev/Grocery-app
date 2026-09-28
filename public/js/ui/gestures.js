// Touch gestures: swipe list rows left/right, drag bottom sheets down to close.

const SWIPE_TRIGGER = 88;
const SLOP = 8;

/**
 * Swipeable rows. Each row element needs [data-swipe] and contains a .swipe-card that moves.
 * onSwipe(row, 'right' | 'left') is called when released past the threshold.
 */
export function enableSwipe(container, onSwipe) {
  let g = null;

  container.addEventListener('pointerdown', (e) => {
    if (e.button !== 0 && e.pointerType === 'mouse') return;
    const row = e.target.closest('[data-swipe]');
    if (!row || e.target.closest('button, a, input')) return;
    g = { row, card: row.querySelector('.swipe-card'), x: e.clientX, y: e.clientY, dx: 0, id: e.pointerId, active: false };
  });

  container.addEventListener(
    'pointermove',
    (e) => {
      if (!g || e.pointerId !== g.id) return;
      const dx = e.clientX - g.x;
      const dy = e.clientY - g.y;
      if (!g.active) {
        if (Math.abs(dy) > SLOP && Math.abs(dy) > Math.abs(dx)) return (g = null); // vertical scroll
        if (Math.abs(dx) < SLOP) return;
        g.active = true;
        g.row.classList.add('swiping');
        try {
          g.row.setPointerCapture(e.pointerId);
        } catch {
          // ignore
        }
      }
      // Resist a little past the trigger point.
      const over = Math.max(0, Math.abs(dx) - SWIPE_TRIGGER);
      g.dx = Math.sign(dx) * (Math.min(Math.abs(dx), SWIPE_TRIGGER) + over * 0.35);
      g.card.style.transform = `translateX(${g.dx}px)`;
      g.row.dataset.dir = g.dx > 0 ? 'right' : 'left';
      const armed = Math.abs(g.dx) >= SWIPE_TRIGGER;
      if (armed !== g.row.classList.contains('armed')) {
        g.row.classList.toggle('armed', armed);
        if (armed) navigator.vibrate?.(8);
      }
    },
    { passive: true },
  );

  const end = (e) => {
    if (!g || e.pointerId !== g.id) return;
    const { row, card, dx, active } = g;
    g = null;
    if (!active) return;
    row.classList.remove('swiping', 'armed');
    // Swallow the click that follows a drag.
    const stop = (ev) => {
      ev.stopPropagation();
      ev.preventDefault();
    };
    window.addEventListener('click', stop, { capture: true, once: true });
    setTimeout(() => window.removeEventListener('click', stop, { capture: true }), 50);
    if (Math.abs(dx) >= SWIPE_TRIGGER) {
      const dir = dx > 0 ? 'right' : 'left';
      card.style.transition = 'transform .18s ease-in';
      card.style.transform = `translateX(${dx > 0 ? '110%' : '-110%'})`;
      setTimeout(() => onSwipe(row, dir), 170);
    } else {
      card.style.transition = 'transform .25s cubic-bezier(.2,.9,.3,1.2)';
      card.style.transform = '';
      setTimeout(() => (card.style.transition = ''), 260);
    }
  };
  container.addEventListener('pointerup', end);
  container.addEventListener('pointercancel', end);
}

/** Drag a <dialog> bottom sheet down by its handle/header to close it. */
export function enableSheetDrag(dialog, onClose) {
  let g = null;
  dialog.addEventListener('pointerdown', (e) => {
    const grip = e.target.closest('.grip, .sheet-head');
    if (!grip || e.target.closest('button, input, a, select')) return;
    g = { y: e.clientY, dy: 0, id: e.pointerId, t: Date.now() };
    dialog.setPointerCapture?.(e.pointerId);
    dialog.style.transition = 'none';
  });
  dialog.addEventListener('pointermove', (e) => {
    if (!g || e.pointerId !== g.id) return;
    g.dy = Math.max(0, e.clientY - g.y);
    dialog.style.transform = `translateY(${g.dy}px)`;
  });
  const end = (e) => {
    if (!g || e.pointerId !== g.id) return;
    const fast = g.dy / Math.max(1, Date.now() - g.t) > 0.6;
    const close = g.dy > 120 || (fast && g.dy > 40);
    g = null;
    dialog.style.transition = 'transform .22s ease';
    dialog.style.transform = close ? 'translateY(100%)' : '';
    setTimeout(() => {
      if (close) onClose();
      dialog.style.transition = '';
      dialog.style.transform = '';
    }, close ? 200 : 230);
  };
  dialog.addEventListener('pointerup', end);
  dialog.addEventListener('pointercancel', end);
}

/** Tween a number shown in an element, e.g. a total changing from $30.10 to $32.80. */
export function tweenNumber(el, to, format) {
  const from = Number(el.dataset.value ?? to);
  el.dataset.value = to;
  if (from === to || matchMedia('(prefers-reduced-motion: reduce)').matches) {
    el.textContent = format(to);
    return;
  }
  const start = performance.now();
  const dur = 450;
  const step = (now) => {
    const t = Math.min(1, (now - start) / dur);
    const eased = 1 - (1 - t) ** 3;
    el.textContent = format(from + (to - from) * eased);
    if (t < 1 && Number(el.dataset.value) === to) requestAnimationFrame(step);
  };
  requestAnimationFrame(step);
}
