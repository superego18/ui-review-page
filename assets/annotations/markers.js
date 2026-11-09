import { resolve, labelFor, nameOf } from './dom.js';

export function createMarkers({ root, onEdit }) {
  const layer = document.createElement('div'); layer.className = 'markers'; root.append(layer);
  const box = document.createElement('div'); box.className = 'outline'; box.hidden = true; root.append(box);
  const tag = document.createElement('span'); box.append(tag);
  let items = [], enabled = true, selected = null;
  const buttons = new Map();
  function outline(element) {
    selected = element;
    if (!element) { box.hidden = true; return; }
    const r = element.getBoundingClientRect();
    Object.assign(box.style, { left: r.left + 'px', top: r.top + 'px', width: r.width + 'px', height: r.height + 'px' });
    tag.textContent = nameOf(element);
    box.hidden = false;
  }
  function refresh() {
    const positions = new Map();
    for (const item of items) {
      let button = buttons.get(item.id);
      if (!button) {
        button = document.createElement('button'); button.type = 'button'; button.className = 'marker';
        button.textContent = String(item.number); button.dataset.id = item.id;
        button.onclick = () => onEdit(item.id);
        button.onpointerenter = () => outline(resolve(items.find((x) => x.id === button.dataset.id)));
        button.onpointerleave = () => outline(null);
        button.onfocus = button.onpointerenter; button.onblur = () => outline(null);
        layer.append(button); buttons.set(item.id, button);
      }
      button.title = `${item.number}. ${labelFor(item)}${item.text ? ' · ' + item.text : ''}`;
      button.setAttribute('aria-label', `피드백 ${item.number}: ${labelFor(item)}`);
      const element = resolve(item), r = element?.getBoundingClientRect();
      button.hidden = !enabled || !r || !r.width || !r.height || r.bottom < 0 || r.top > innerHeight || r.right < 0 || r.left > innerWidth;
      if (r) {
        const key = `${Math.round(r.left)}:${Math.round(r.top)}`;
        const offset = positions.get(key) || 0; positions.set(key, offset + 1);
        Object.assign(button.style, { left: Math.min(innerWidth - 30, Math.max(4, r.left) + offset * 28) + 'px', top: Math.max(4, r.top) + 'px' });
      }
    }
    for (const [id, button] of buttons) if (!items.some((x) => x.id === id)) { button.remove(); buttons.delete(id); }
    if (selected) outline(selected.isConnected ? selected : null);
  }
  let frame;
  const queue = () => { if (!frame) frame = requestAnimationFrame(() => { frame = null; refresh(); }); };
  addEventListener('scroll', queue, { capture: true, passive: true }); addEventListener('resize', queue);
  const timer = setInterval(refresh, 700);
  return {
    outline,
    setItems(next) { items = next; refresh(); },
    show(value) { enabled = value; if (!value) outline(null); refresh(); },
    destroy() { clearInterval(timer); cancelAnimationFrame(frame); removeEventListener('scroll', queue, true); removeEventListener('resize', queue); layer.remove(); box.remove(); },
  };
}
