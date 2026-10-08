// 리뷰 페이지 동작(항목·평가 저장·이미지 확대·핀·번호 상자·캡처 근거·자동 이어가기 표시).
// review-template.html 로 만든 모든 리뷰 페이지가 리뷰 서버(/__uifb/review-page.js)에서 받아 쓴다. 페이지에는 REVIEW 데이터만 있다.
const ITEMS = REVIEW.items;
const API = '/api/feedback?round=' + REVIEW.round;
const LABELS = { good: '좋음', tweak: '수정 필요', revert: '되돌리기' };
const state = {};
const $ = (s) => document.querySelector(s);

function pinsOf(itemId) {
  return state[itemId]?.pins || [];
}

function drawPins(wrap, itemId, file) {
  wrap.querySelectorAll('.pin').forEach((p) => p.remove());
  pinsOf(itemId).forEach((pin, i) => {
    if (pin.image !== file) return;
    const dot = document.createElement('span');
    dot.className = 'pin';
    dot.textContent = String(i + 1);
    dot.style.left = pin.x + '%';
    dot.style.top = pin.y + '%';
    wrap.append(dot);
  });
}

// 이미지 항목은 파일 이름 문자열이거나, capture-2x.js 가 돌려준 { file, marks, source } 객체다.
const imgOf = (x) => (typeof x === 'string' ? { file: x } : x);

// 캡처할 때 잰 번호 상자(이미지 기준 %). 이미지와 같은 층에 그려서 확대해도 정확히 겹친다.
// 번호는 상자 왼쪽 위 모서리에 걸친 작은 원이라, 붙어 있는 상자끼리 번호가 겹치거나 글자를 덮는 일이 적다.
function drawMarks(wrap, marks) {
  wrap.querySelectorAll('.mark').forEach((m) => m.remove());
  for (const m of marks || []) {
    const box = document.createElement('span');
    box.className = 'mark' + (m.x < 2 || m.y < 2 ? ' edge' : ''); // 이미지 가장자리면 번호를 상자 안쪽에 둔다
    box.dataset.n = String(m.n);
    Object.assign(box.style, { left: m.x + '%', top: m.y + '%', width: m.w + '%', height: m.h + '%' });
    const b = document.createElement('b');
    b.textContent = String(m.n);
    box.append(b);
    wrap.append(box);
  }
}

// 캡처 근거. 직접 찍은 화면은 주소·창 크기·테마·시각을, 아니면 출처와 "직접 캡처 아님"을 보여 준다.
function sourceLine(source) {
  if (!source) return null;
  const p = document.createElement('p');
  if (source.direct === false) {
    p.className = 'src indirect';
    p.textContent = `직접 캡처 아님 · ${source.note || '출처 미상'}`;
  } else {
    p.className = 'src';
    const at = source.at ? new Date(source.at).toLocaleString('ko-KR', { month: 'numeric', day: 'numeric', hour: '2-digit', minute: '2-digit' }) : '';
    p.textContent = [source.url && source.url.replace(/^https?:\/\/[^/]+/, ''), source.viewport, source.theme, at, source.note].filter(Boolean).join(' · ');
    // 예시 응답으로 찍었으면 실제 데이터 화면으로 오해하지 않게 따로 눈에 띄게 적는다.
    if (source.mocked?.length || source.steps) {
      const w = document.createElement('span');
      w.className = 'mocked';
      w.textContent = [source.mocked?.length ? `예시 데이터: ${source.mocked.join(', ')}` : '', source.steps ? '조작 후 캡처' : ''].filter(Boolean).join(' · ');
      p.append(document.createElement('br'), w);
    }
  }
  return p;
}

// 비교할 UI 묶음. 전후든, 추천안끼리든, 다른 사람 결과물과 지금 시스템이든 같은 틀로 그린다.
// 항목에 options 가 없으면 before/after 를 '전'/'후' 두 안으로 본다.
const optionsOf = (it) => it.options || [{ label: '전', tone: 'before', shots: it.before || [] }, { label: '후', shots: it.after || [] }];
// 고를 평가. 전후 비교는 좋음/수정 필요/되돌리기, options 로 안끼리 비교하면 안 이름 중 하나(+ 다른 방향).
const choicesOf = (it) => (it.choices || (it.options ? [...it.options.map((o) => o.label), '다른 방향'] : Object.keys(LABELS)));

function caption(label) {
  const cap = document.createElement('figcaption');
  const b = document.createElement('b');
  b.textContent = label;
  cap.append(b);
  return cap;
}

// 움직임·누르는 감각처럼 정지 이미지로 볼 수 없는 비교는 실제로 동작하는 HTML(demo)을 띄운다.
function demoFrame(opt) {
  const f = document.createElement('figure');
  f.className = 'demo ' + (opt.tone || 'after');
  const cap = caption(opt.label);
  const a = document.createElement('a');
  a.href = opt.demo; a.target = '_blank'; a.textContent = '새 창으로 열기';
  cap.append(a);
  const frame = document.createElement('iframe');
  frame.src = opt.demo; frame.loading = 'lazy'; frame.title = opt.label;
  f.append(cap, frame);
  const src = sourceLine(opt.source);
  if (src) f.append(src);
  return f;
}

function shot(image, label, tone, itemId) {
  const { file, marks, source } = imgOf(image);
  const f = document.createElement('figure');
  f.className = tone;
  const cap = caption(label);
  cap.append(file.replace('.png', ''));
  const btn = document.createElement('button');
  btn.type = 'button';
  btn.setAttribute('aria-label', '크게 보고 핀 메모 남기기');
  const wrap = document.createElement('span');
  wrap.className = 'pinwrap';
  const img = document.createElement('img');
  img.src = file; img.alt = file; img.loading = 'lazy';
  img.onload = () => { if (img.naturalHeight > img.naturalWidth * 1.3) f.classList.add('tall'); };
  wrap.append(img);
  drawMarks(wrap, marks);
  drawPins(wrap, itemId, file);
  btn.append(wrap);
  btn.onclick = () => openZoom(itemId, file, marks);
  f.append(cap, btn);
  const src = sourceLine(source);
  if (src) f.append(src);
  return f;
}

let zoomCtx = null;
let pinT;

function savePins(itemId) {
  clearTimeout(pinT);
  pinT = setTimeout(() => save(itemId, { pins: pinsOf(itemId) }), 500);
}

function renderZoomPins() {
  const { itemId, file } = zoomCtx;
  drawPins($('#zoomWrap'), itemId, file);
  const list = $('#zoomPins');
  list.textContent = '';
  pinsOf(itemId).forEach((pin, i) => {
    if (pin.image !== file) return;
    const li = document.createElement('li');
    const num = document.createElement('span');
    num.className = 'num'; num.textContent = String(i + 1);
    const input = document.createElement('input');
    input.value = pin.note || '';
    input.placeholder = '이 위치에 대한 의견';
    input.setAttribute('aria-label', `핀 ${i + 1} 메모`);
    input.oninput = () => { pin.note = input.value; savePins(itemId); };
    const del = document.createElement('button');
    del.type = 'button'; del.className = 'ghost'; del.textContent = '삭제';
    del.onclick = () => {
      state[itemId].pins = pinsOf(itemId).filter((p) => p !== pin);
      savePins(itemId);
      renderZoomPins();
    };
    li.append(num, input, del);
    list.append(li);
  });
}

let zoomScale = 'fit';

const MIN_ZOOM = 0.1;
const MAX_ZOOM = 8;

function baseWidth() {
  const img = $('#zoomImg');
  return img.naturalWidth / (REVIEW.scale || 1);
}

function currentScale() {
  return zoomScale === 'fit' ? $('#zoomImg').getBoundingClientRect().width / baseWidth() : zoomScale;
}

// anchor: 화면 좌표(clientX, clientY). 그 지점 아래의 이미지 위치가 확대 후에도 같은 자리에 오게 스크롤을 맞춘다.
function applyZoom(scale, anchor) {
  const img = $('#zoomImg');
  const stage = $('#zoomStage');
  let fx = 0, fy = 0, ax = 0, ay = 0;
  if (anchor && scale !== 'fit') {
    const r = img.getBoundingClientRect();
    const sr = stage.getBoundingClientRect();
    fx = (anchor.x - r.left) / r.width;
    fy = (anchor.y - r.top) / r.height;
    ax = anchor.x - sr.left;
    ay = anchor.y - sr.top;
  }
  if (scale !== 'fit') scale = Math.min(MAX_ZOOM, Math.max(MIN_ZOOM, scale));
  zoomScale = scale;
  stage.dataset.fit = String(scale === 'fit');
  img.style.width = scale === 'fit' ? '' : Math.round(baseWidth() * scale) + 'px';
  if (anchor && scale !== 'fit') {
    const r = img.getBoundingClientRect();
    stage.scrollLeft += r.left - stage.getBoundingClientRect().left + fx * r.width - ax;
    stage.scrollTop += r.top - stage.getBoundingClientRect().top + fy * r.height - ay;
  }
  document.querySelectorAll('[data-zoom]').forEach((b) => {
    b.setAttribute('aria-pressed', String(b.dataset.zoom === String(scale)));
  });
}

document.querySelectorAll('[data-zoom]').forEach((b) => {
  b.onclick = () => applyZoom(b.dataset.zoom === 'fit' ? 'fit' : Number(b.dataset.zoom));
});

// Ctrl+휠, 트랙패드 핀치(브라우저가 ctrlKey 휠로 보냄): 움직인 만큼 연속으로 확대·축소
$('#zoomStage').addEventListener('wheel', (e) => {
  if (!e.ctrlKey && !e.metaKey) return;
  e.preventDefault();
  const delta = e.deltaMode === 1 ? e.deltaY * 16 : e.deltaY;
  applyZoom(currentScale() * Math.exp(-delta * 0.0025), { x: e.clientX, y: e.clientY });
}, { passive: false });

// 터치: 두 손가락은 핀치 확대·축소(두 손가락 가운데 중심), 한 손가락은 이동.
// 확대 영역은 touch-action: none 이라 브라우저 대신 여기서 둘 다 처리한다.
const touches = new Map();
let pinch = null;
let moved = false;
let gestureEndedAt = 0;
const stageEl = $('#zoomStage');
stageEl.addEventListener('pointerdown', (e) => {
  if (e.pointerType !== 'touch') return;
  touches.set(e.pointerId, { x: e.clientX, y: e.clientY });
  if (touches.size === 1) moved = false;
  if (touches.size === 2) {
    const [a, b] = [...touches.values()];
    pinch = { dist: Math.hypot(a.x - b.x, a.y - b.y), scale: currentScale() };
    moved = true;
  }
});
stageEl.addEventListener('pointermove', (e) => {
  const prev = touches.get(e.pointerId);
  if (!prev) return;
  const now = { x: e.clientX, y: e.clientY };
  touches.set(e.pointerId, now);
  if (pinch && touches.size === 2) {
    const [a, b] = [...touches.values()];
    const dist = Math.hypot(a.x - b.x, a.y - b.y);
    applyZoom(pinch.scale * (dist / pinch.dist), { x: (a.x + b.x) / 2, y: (a.y + b.y) / 2 });
  } else if (touches.size === 1) {
    const dx = now.x - prev.x, dy = now.y - prev.y;
    if (Math.abs(dx) + Math.abs(dy) > 0) {
      stageEl.scrollLeft -= dx;
      stageEl.scrollTop -= dy;
    }
    if (Math.hypot(dx, dy) > 3) moved = true;
  }
});
function endTouch(e) {
  if (!touches.has(e.pointerId)) return;
  touches.delete(e.pointerId);
  if (moved) gestureEndedAt = Date.now();
  if (touches.size < 2) pinch = null;
}
['pointerup', 'pointercancel', 'pointerleave'].forEach((t) => stageEl.addEventListener(t, endTouch));

function openZoom(itemId, file, marks) {
  zoomCtx = { itemId, file };
  $('#zoomName').textContent = file.replace('.png', '');
  $('#zoomImg').src = file;
  drawMarks($('#zoomWrap'), marks);
  applyZoom('fit');
  $('#zoomStage').scrollTo(0, 0);
  renderZoomPins();
  $('#zoom').showModal();
}

$('#zoomImg').onclick = (e) => {
  if (pinch || Date.now() - gestureEndedAt < 400) return;
  const r = e.currentTarget.getBoundingClientRect();
  const x = Math.round(((e.clientX - r.left) / r.width) * 1000) / 10;
  const y = Math.round(((e.clientY - r.top) / r.height) * 1000) / 10;
  const { itemId, file } = zoomCtx;
  state[itemId] = { ...(state[itemId] || {}), pins: [...pinsOf(itemId), { image: file, x, y, note: '' }] };
  savePins(itemId);
  renderZoomPins();
  const inputs = $('#zoomPins').querySelectorAll('input');
  inputs[inputs.length - 1]?.focus();
};
$('#zoomClose').onclick = () => $('#zoom').close();
$('#zoom').addEventListener('click', (e) => { if (e.target === $('#zoom')) $('#zoom').close(); });
$('#zoom').addEventListener('close', () => render());

function render() {
  const root = $('#items');
  root.textContent = '';
  for (const it of ITEMS) {
    const sec = document.createElement('section');
    sec.className = 'item';
    sec.innerHTML = `<h2><span class="k">${ITEMS.indexOf(it) + 1}</span><span></span></h2><ul class="changes"></ul><div class="shots"></div>
      <div class="verdict"></div><textarea id="memo-${it.id}" rows="1" placeholder="한 줄 의견 (선택)"></textarea>`;
    sec.querySelector('h2 span:last-child').textContent = it.title;
    const ul = sec.querySelector('.changes');
    const shots = sec.querySelector('.shots');
    // "1 바뀐 점"처럼 번호로 시작하는 줄은 같은 번호 상자와 이어진다. 올리거나 누르면 그 상자를 강조한다.
    const highlight = (n, on) => shots.querySelectorAll(`.mark[data-n="${n}"]`).forEach((m) => m.classList.toggle('hl', on));
    it.changes.forEach((c) => {
      const li = document.createElement('li');
      const m = /^(\d+)[.)]?\s+/.exec(c);
      if (m) {
        li.dataset.n = m[1];
        const num = document.createElement('span');
        num.className = 'mnum';
        num.textContent = m[1];
        li.append(num, c.slice(m[0].length));
        li.tabIndex = 0;
        li.onmouseenter = li.onfocus = () => highlight(m[1], true);
        li.onmouseleave = li.onblur = () => highlight(m[1], false);
      } else {
        li.textContent = c;
      }
      ul.append(li);
    });
    for (const o of optionsOf(it)) {
      const figs = [...(o.demo ? [demoFrame(o)] : []), ...(o.shots || []).map((f) => shot(f, o.label, o.tone || 'after', it.id))];
      if (o.note && figs[0]) {
        const p = document.createElement('p');
        p.className = 'optnote'; p.textContent = o.note;
        figs[0].insertBefore(p, figs[0].children[1]);
      }
      shots.append(...figs);
    }
    const v = sec.querySelector('.verdict');
    for (const key of choicesOf(it)) {
      const b = document.createElement('button');
      b.type = 'button'; b.className = 'opt' + (LABELS[key] ? '' : ' pick'); b.dataset.v = key; b.textContent = LABELS[key] || key;
      b.setAttribute('aria-pressed', String(state[it.id]?.verdict === key));
      b.onclick = () => save(it.id, { verdict: key });
      v.append(b);
    }
    const saved = document.createElement('span');
    saved.className = 'saved'; saved.id = 'saved-' + it.id;
    v.append(saved);
    const ta = sec.querySelector('textarea');
    ta.value = state[it.id]?.memo ?? '';
    let t;
    ta.oninput = () => { clearTimeout(t); t = setTimeout(() => save(it.id, { memo: ta.value }), 600); };
    const pins = pinsOf(it.id);
    if (pins.length) {
      const ul2 = document.createElement('ul');
      ul2.className = 'pinsummary';
      pins.forEach((pin, i) => {
        const li = document.createElement('li');
        li.innerHTML = `<span class="num">${i + 1}</span>`;
        li.append(`${pin.image.replace('.png', '')}: ${pin.note || '(메모 없음)'}`);
        ul2.append(li);
      });
      sec.append(ul2);
    }
    root.append(sec);
  }
  updateCount();
}

function updateCount() {
  const n = ITEMS.filter((it) => state[it.id]?.verdict).length;
  $('#count').textContent = `${n} / ${ITEMS.length}`;
}

async function post(body) {
  const res = await fetch(API, { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify(body) });
  if (!res.ok) throw new Error(String(res.status));
}

async function save(id, patch) {
  state[id] = { ...(state[id] || {}), ...patch };
  if (patch.verdict) {
    const sec = $('#memo-' + id).closest('.item');
    sec.querySelectorAll('.opt').forEach((b) => b.setAttribute('aria-pressed', String(b.dataset.v === patch.verdict)));
    updateCount();
  }
  const el = $('#saved-' + id);
  el.textContent = '저장 중…';
  try {
    await post({ id, fields: { ...patch, title: ITEMS.find((i) => i.id === id)?.title ?? id } });
    el.textContent = '저장됨';
  } catch (e) { el.textContent = '저장 실패 — 리뷰 서버가 켜져 있는지 확인하세요'; }
}

let overallT;
$('#overall').oninput = () => {
  clearTimeout(overallT);
  overallT = setTimeout(() => post({ overall: $('#overall').value }).catch(() => {}), 600);
};
let autoOn = false;
let autoAtDone = false;
let finished = false;

function renderMode() {
  const time = (iso) => new Date(iso).toLocaleTimeString('ko-KR', { hour: '2-digit', minute: '2-digit' });
  const auto = finished ? autoAtDone : autoOn;
  $('#mode').dataset.auto = auto ? 'on' : 'off';
  if (auto && finished) {
    $('#modeTitle').textContent = `자동 이어가기 · ${watch.agent}가 피드백을 받아 작업을 이어갑니다`;
    $('#modeSub').textContent = '터미널에 보낼 메시지는 없습니다.';
  } else if (auto) {
    $('#modeTitle').textContent = `자동 이어가기 켜짐 · ${watch.agent}가 기다리는 중${watch.expiresAt ? ` (${time(watch.expiresAt)}까지)` : ''}`;
    $('#modeSub').textContent = '완료 표시만 누르면 바로 이어서 작업합니다. 터미널에 메시지를 보낼 필요가 없습니다.';
  } else {
    $('#modeTitle').textContent = '자동 이어가기 꺼짐';
    $('#modeSub').textContent = '완료 표시를 누른 뒤 터미널에 "피드백 확인해"라고 보내야 작업이 이어집니다.';
  }
  if (!finished) {
    $('#doneNote').textContent = autoOn
      ? '다 봤으면 완료를 누르세요. 터미널 메시지는 필요 없습니다.'
      : '다 봤으면 완료를 누르고, 터미널에 "피드백 확인해"라고 보내 주세요.';
  }
}

let watch = {};
async function pollWatch() {
  try {
    watch = await (await fetch('/api/watch?round=' + REVIEW.round + '&session=' + encodeURIComponent(REVIEW.session || ''))).json();
    autoOn = watch.active === true;
  } catch { autoOn = false; }
  renderMode();
}
pollWatch();
setInterval(pollWatch, 5000);


$('#done').onclick = async () => {
  $('#done').disabled = true;
  finished = true;
  autoAtDone = autoOn;
  try {
    await post({ done: true, session: REVIEW.session });
    renderMode();
    $('#doneNote').textContent = autoAtDone
      ? `완료로 표시했습니다. ${watch.agent}가 이어서 작업합니다. 터미널에 보낼 메시지는 없습니다.`
      : '완료로 표시했습니다. 이제 터미널에 "피드백 확인해"라고 보내 주세요.';
  } catch (e) { finished = false; $('#doneNote').textContent = '저장 실패 — 리뷰 서버가 켜져 있는지 확인하세요.'; $('#done').disabled = false; }
};

$('#title').textContent = document.title;
$('#eyebrow').textContent = `${REVIEW.project} · ${REVIEW.name || `${REVIEW.round}차 리뷰`}`;
render();

(async () => {
  try {
    const res = await fetch(API);
    const data = await res.json();
    Object.assign(state, data.items || {});
    $('#overall').value = data.overall || '';
    if (data.done) { finished = true; $('#done').disabled = true; $('#doneNote').textContent = '이미 완료로 표시된 리뷰입니다. 작업이 이어지지 않았다면 터미널에 "피드백 확인해"라고 보내 주세요.'; }
    $('#conn').textContent = '선택하면 자동 저장됩니다.';
    render();
  } catch (e) { $('#conn').textContent = '리뷰 서버에 연결되지 않았습니다. 터미널에서 서버를 켜 주세요.'; }
})();
