import { locate } from './dom.js';

export function createPicker({ host, outline, onPick, onCancel }) {
  let active = false;
  const isOwn = (event) => event.composedPath().includes(host);
  function move(event) {
    if (isOwn(event)) return;
    const element = document.elementFromPoint(event.clientX, event.clientY);
    if (element && element !== document.documentElement && element !== document.body) outline(element);
  }
  function block(event) {
    if (!isOwn(event)) { event.preventDefault(); event.stopPropagation(); }
  }
  function click(event) {
    if (isOwn(event)) return;
    event.preventDefault(); event.stopImmediatePropagation();
    const element = document.elementFromPoint(event.clientX, event.clientY);
    if (!element || element === document.documentElement) return;
    const where = locate(element);
    stop(); onPick(where);
  }
  function key(event) {
    if (event.key === 'Escape') { event.preventDefault(); event.stopImmediatePropagation(); stop(); onCancel(); }
  }
  function stop() {
    active = false; outline(null);
    document.removeEventListener('pointermove', move, true);
    document.removeEventListener('click', click, true);
    document.removeEventListener('keydown', key, true);
    for (const type of ['pointerdown', 'mousedown', 'mouseup', 'pointerup']) document.removeEventListener(type, block, true);
  }
  return {
    start() {
      if (active) return;
      active = true;
      document.addEventListener('pointermove', move, true);
      document.addEventListener('click', click, true);
      document.addEventListener('keydown', key, true);
      for (const type of ['pointerdown', 'mousedown', 'mouseup', 'pointerup']) document.addEventListener(type, block, true);
    },
    stop,
  };
}
