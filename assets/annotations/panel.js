import { labelFor, locationInfo, pageKey } from './dom.js';

const LABELS = { note: '메모', good: '좋아요', change: '수정 요청', question: '질문' };
const element = (tag, text, className) => { const el = document.createElement(tag); if (text) el.textContent = text; if (className) el.className = className; return el; };

export function createPanel({ root, base, title, onPick, onSave, onDelete, onPreview }) {
  const ui = element('div');
  ui.innerHTML = `
    <div class="toolbar" role="group" aria-label="시안 피드백">
      <button type="button" id="open" aria-expanded="false" aria-keyshortcuts="Alt+Shift+F" title="피드백 열기/닫기 · Alt+Shift+F">피드백 0개</button>
      <button type="button" id="pick">위치 찍기</button><button type="button" id="memo" aria-keyshortcuts="Alt+Shift+N" title="새 메모 · Alt+Shift+N">메모 추가</button>
      <span id="picking" hidden>찍을 곳을 누르세요 · Esc 취소 <button type="button" id="cancel-pick">취소</button></span>
    </div>
    <aside class="panel" hidden role="dialog" aria-label="시안 피드백 목록">
      <header><h2>시안 피드백</h2><button type="button" id="close" aria-label="피드백 창 닫기">닫기</button></header>
      <p class="help shortcuts">Alt+Shift+F 열기/닫기 · Alt+Shift+N 새 메모<br />Mac에서는 Alt 대신 ⌥ Option</p>
      <p class="status" id="status" role="status"></p>
      <div id="listing">
        <div class="filters"><label>보기 <select id="filter"><option value="all">전체 시안</option><option value="here">현재 화면</option></select></label><a id="export" download="annotations.md">정리본 내려받기</a></div>
        <p class="help">↑↓ 목록 이동 · Enter 편집 · Esc 닫기<br />번호에 올리거나 초점을 주면 선택 범위를 보여줘요.</p><ol class="items" id="items"></ol>
      </div>
      <form id="editor" hidden>
        <h3 id="editor-title">새 피드백</h3><p id="where" class="where"></p><p id="binding" class="help"></p>
        <details id="location-details"><summary>선택 위치 정보</summary><dl><dt>영역 식별자</dt><dd id="anchor-id"></dd><dt>컴포넌트</dt><dd id="component"></dd><dt>선택 당시 값 (참고)</dt><dd id="original-text"></dd></dl></details>
        <button type="button" id="repick">위치 다시 찍기</button>
        <fieldset class="kind-group"><legend>분류 (선택) · Alt+1~4</legend><div class="kind-chips">
          <label class="kind-chip"><input type="radio" name="kind" value="note" aria-keyshortcuts="Alt+1" checked /><span>1 메모</span></label>
          <label class="kind-chip"><input type="radio" name="kind" value="good" aria-keyshortcuts="Alt+2" /><span>2 좋아요</span></label>
          <label class="kind-chip"><input type="radio" name="kind" value="change" aria-keyshortcuts="Alt+3" /><span>3 수정 요청</span></label>
          <label class="kind-chip"><input type="radio" name="kind" value="question" aria-keyshortcuts="Alt+4" /><span>4 질문</span></label>
        </div></fieldset>
        <label>피드백 내용<textarea id="text" rows="5" placeholder="좋은 점, 불편한 점, 바꾸고 싶은 점, 질문을 자유롭게 적으세요."></textarea></label>
        <img id="snapshot" alt="선택 당시 화면 캡처" hidden />
        <p class="help">⌘/Ctrl+Enter 저장 · Alt+← 목록 · Esc 닫기<br />위치·시안 주소·작성 시각도 함께 저장해요.</p>
        <div class="actions"><button id="save" type="submit" class="primary" aria-keyshortcuts="Meta+Enter Control+Enter">저장</button><button id="back" type="button" aria-keyshortcuts="Alt+ArrowLeft">목록으로</button><button id="delete" type="button" hidden>삭제</button></div>
      </form>
    </aside>`;
  root.append(ui);
  const $ = (id) => ui.querySelector('#' + id);
  let items = [], draft = null, busy = false, isPicking = false;
  const draftKey = '__uifb_annotation_draft:' + location.origin;
  $('export').href = base + '/export';
  function focusList() { ($('items').querySelector('.item-title') || $('filter')).focus(); }
  function open(value = true) {
    $('open').setAttribute('aria-expanded', String(value)); ui.querySelector('.panel').hidden = !value;
    if (value) { if (draft) $('text').focus(); else focusList(); }
    else if (!isPicking) $('open').focus();
    if (!value) onPreview(null);
  }
  function currentDraft() { return draft ? { ...draft, text: $('text').value, kind: ui.querySelector('input[name="kind"]:checked').value } : null; }
  function remember() { try { localStorage.setItem(draftKey, JSON.stringify(currentDraft())); } catch {} }
  function clearDraft() { try { localStorage.removeItem(draftKey); } catch {} }
  function showList() { draft = null; $('editor').hidden = true; $('listing').hidden = false; renderList(); if (!ui.querySelector('.panel').hidden) focusList(); }
  function edit(item, { reveal = true } = {}) {
    draft = { ...item }; $('listing').hidden = true; $('editor').hidden = false;
    $('editor-title').textContent = item.id ? `피드백 ${item.number} 수정` : '새 피드백';
    for (const radio of ui.querySelectorAll('input[name="kind"]')) radio.checked = radio.value === (item.kind || 'note');
    $('text').value = item.text || '';
    $('where').textContent = item.where ? `선택: ${labelFor(item)}` : '위치 없는 전체 의견';
    $('binding').textContent = item.where ? locationInfo(item) : '';
    $('location-details').hidden = !item.where;
    $('anchor-id').textContent = item.where?.anchorId || '등록된 식별자 없음';
    $('component').textContent = item.where?.component || '-';
    $('original-text').textContent = item.where?.text || '(빈 여백)';
    $('delete').hidden = !item.id;
    const shot = item.snapshot;
    $('snapshot').hidden = !shot;
    if (shot) $('snapshot').src = shot.startsWith('data:') ? shot : base + '/images/' + shot.split('/').at(-1);
    remember(); if (reveal) open();
  }
  function renderList() {
    const focusedId = root.activeElement?.dataset.id;
    const shown = items.filter((x) => $('filter').value === 'all' || pageKey(x.url) === pageKey(location.href));
    const list = $('items'); list.replaceChildren();
    if (!shown.length) list.append(element('li', '아직 피드백이 없어요. 위치를 찍거나 메모를 추가하세요.', 'empty'));
    for (const item of shown) {
      const row = element('li');
      const button = element('button', `${item.number}. ${LABELS[item.kind]} · ${labelFor(item)}`, 'item-title');
      button.type = 'button'; button.dataset.id = item.id; button.onclick = () => { status(''); edit(item); };
      button.onpointerenter = () => onPreview(item); button.onpointerleave = () => onPreview(null);
      button.onfocus = () => onPreview(item); button.onblur = () => onPreview(null);
      row.append(button, element('p', item.text || '(메모 없음)'), element('small', item.title || new URL(item.url).search || '화면'));
      if (item.where) row.append(element('small', locationInfo(item)));
      if (pageKey(item.url) !== pageKey(location.href)) {
        const link = element('a', '해당 시안 열기'); link.href = item.url; row.append(link);
      }
      list.append(row);
    }
    $('open').textContent = `피드백 ${items.length}개`;
    if (focusedId) [...list.querySelectorAll('.item-title')].find((button) => button.dataset.id === focusedId)?.focus();
  }
  function status(message, error = false) { $('status').textContent = message; $('status').dataset.error = error ? 'true' : ''; }
  function setBusy(value) {
    busy = value; $('save').disabled = value; $('delete').disabled = value; $('save').textContent = value ? '저장 중…' : '저장';
  }
  $('open').onclick = () => open(ui.querySelector('.panel').hidden);
  $('close').onclick = () => open(false);
  $('pick').onclick = () => onPick(currentDraft()); $('repick').onclick = () => onPick(currentDraft());
  $('memo').onclick = () => edit({ kind: 'note', text: '', url: location.href, title: title(), where: null });
  $('back').onclick = () => { clearDraft(); showList(); };
  $('text').oninput = remember;
  for (const radio of ui.querySelectorAll('input[name="kind"]')) radio.onchange = remember;
  $('filter').onchange = renderList;
  $('editor').onsubmit = (event) => { event.preventDefault(); if (!busy) onSave(currentDraft()); };
  $('delete').onclick = () => { if (!busy && draft?.id) onDelete(draft.id); };
  function keydown(event) {
    if (event.defaultPrevented || event.isComposing || event.keyCode === 229 || event.repeat || root.host.hidden || isPicking) return;
    const claim = () => { event.preventDefault(); event.stopImmediatePropagation(); };
    if (event.altKey && event.shiftKey && !event.ctrlKey && !event.metaKey) {
      if (event.code === 'KeyF') { claim(); open(ui.querySelector('.panel').hidden); }
      if (event.code === 'KeyN' && !busy) { claim(); $('memo').click(); }
      return;
    }
    if (ui.querySelector('.panel').hidden || !event.composedPath().includes(ui)) return;
    if (event.key === 'Escape') { claim(); open(false); return; }
    if (draft) {
      if ((event.ctrlKey || event.metaKey) && !event.altKey && !event.shiftKey && event.key === 'Enter') {
        claim(); if (!busy) $('editor').requestSubmit(); return;
      }
      if (event.altKey && !event.ctrlKey && !event.metaKey && !event.shiftKey) {
        const index = ['Digit1', 'Digit2', 'Digit3', 'Digit4'].indexOf(event.code);
        if (index >= 0) { claim(); ui.querySelectorAll('input[name="kind"]')[index].checked = true; remember(); }
        if (event.key === 'ArrowLeft' && !busy) { claim(); $('back').click(); }
      }
    } else if (!event.altKey && !event.ctrlKey && !event.metaKey && !event.shiftKey) {
      const buttons = [...$('items').querySelectorAll('.item-title')], index = buttons.indexOf(root.activeElement);
      if (index < 0 || !['ArrowDown', 'ArrowUp', 'Home', 'End'].includes(event.key)) return;
      claim();
      const next = event.key === 'Home' ? 0 : event.key === 'End' ? buttons.length - 1 : Math.max(0, Math.min(buttons.length - 1, index + (event.key === 'ArrowDown' ? 1 : -1)));
      buttons[next].focus();
    }
  }
  document.addEventListener('keydown', keydown, true);
  return {
    edit, showList, open, status, setBusy, clearDraft,
    setItems(next) { items = next; renderList(); },
    picking(value, cancel) {
      isPicking = value;
      $('picking').hidden = !value;
      for (const id of ['open', 'pick', 'memo']) $(id).hidden = value;
      if (value) open(false);
      $('cancel-pick').onclick = cancel;
    },
    restore() {
      if (draft || !ui.querySelector('.panel').hidden) return;
      try { const item = JSON.parse(localStorage.getItem(draftKey)); if (item) edit(item, { reveal: false }); } catch {}
    },
    destroy() { document.removeEventListener('keydown', keydown, true); ui.remove(); },
  };
}
