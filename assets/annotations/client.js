import { resolve } from './dom.js';
import { createPicker } from './picker.js';
import { createMarkers } from './markers.js';
import { createPanel } from './panel.js';
import { createTransport } from './transport.js';

export function mountFeedback({ base = '/__uifb-feedback', capture, title = () => document.title, active = () => true } = {}) {
  const old = document.querySelector('[data-uifb-overlay]');
  if (old) return { destroy() {} };
  const host = document.createElement('div');
  host.setAttribute('data-uifb-overlay', ''); host.setAttribute('data-feedback-ignore', '');
  document.body.append(host);
  const root = host.attachShadow({ mode: 'open' });
  const sheet = document.createElement('link'); sheet.rel = 'stylesheet'; sheet.href = base + '/style.css'; root.append(sheet);
  const transport = createTransport(base);
  let disposed = false, pickDraft = null, items = [], lastUrl = location.href;
  const markers = createMarkers({ root, onEdit: (id) => { const item = items.find((x) => x.id === id); if (item) { panel.status(''); panel.edit(item); } } });
  const panel = createPanel({
    root, base, title,
    onPick(draft) { pickDraft = draft; panel.picking(true, cancelPick); markers.show(false); picker.start(); },
    onPreview(item) { markers.outline(item ? resolve(item) : null); },
    async onSave(draft) {
      panel.setBusy(true); panel.status('');
      try {
        const result = draft.id ? await transport.update(draft.id, draft) : await transport.create(draft);
        if (disposed) return;
        apply(result.items); panel.clearDraft(); panel.showList(); panel.status('저장했어요.');
      } catch (error) { panel.status(error.message, true); }
      finally { if (!disposed) panel.setBusy(false); }
    },
    async onDelete(id) {
      panel.setBusy(true);
      try { const result = await transport.remove(id); if (!disposed) { apply(result.items); panel.clearDraft(); panel.showList(); panel.status('삭제했어요.'); } }
      catch (error) { panel.status(error.message, true); }
      finally { if (!disposed) panel.setBusy(false); }
    },
  });
  function cancelPick() { picker.stop(); markers.show(true); panel.picking(false); panel.open(); }
  const picker = createPicker({
    host, outline: markers.outline, onCancel: cancelPick,
    async onPick(where) {
      panel.picking(false); markers.show(true);
      const draft = { kind: 'note', text: '', ...pickDraft, url: location.href, title: title(), where };
      if (capture) {
        panel.open(); panel.status('선택한 화면 캡처 중…');
        try { draft.snapshot = await capture(); }
        catch { panel.status('캡처를 저장하지 못했어요. 위치와 메모는 저장할 수 있어요.', true); }
      }
      if (!disposed) { panel.edit(draft); if (draft.snapshot) panel.status(''); }
    },
  });
  function apply(next) { items = next; markers.setItems(items); panel.setItems(items); }
  transport.load().then((data) => { if (!disposed) { apply(data.items); panel.restore(); } }).catch((error) => { if (!disposed) { panel.open(); panel.status(error.message, true); } });
  const timer = setInterval(() => {
    host.hidden = !active();
    if (location.href !== lastUrl) { lastUrl = location.href; markers.setItems(items); panel.setItems(items); }
  }, 400);
  return {
    destroy() { disposed = true; clearInterval(timer); picker.stop(); markers.destroy(); panel.destroy(); host.remove(); },
  };
}

window.UiFeedback = { mountFeedback };
