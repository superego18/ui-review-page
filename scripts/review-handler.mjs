// 비교 페이지 서버의 요청 처리. 의존성 없음 (Node 18+).
// createReviewHandler({ root, onDone, watch }) 가 돌려주는 handle(req, res, url) 를 http 서버에 붙인다(혼자 쓸 때는 review-server.mjs).
//   <root>/review.html 등 비교 페이지와 캡처 이미지를 정적으로 내보내고, 페이지가 보낸 평가를 <root>/r<round>.json 에,
//   캡처 기록을 <root>/captures.json 에 남긴다. 공용 페이지 파일(assets/review-page.js·css)은 /__uifb/* 로 내보낸다.
//   onDone({ round, data, summary, session }): 평가 완료를 처음 표시했을 때 부른다(대화창과 함께 쓸 때 대화에 남기는 데 씀).
//   watch(session, round): 페이지 위쪽 "자동 이어가기" 표시에 쓸 감시 상태. 없으면 꺼짐으로 보인다.
// handle 은 자기 요청이면 true 를 돌려준다. 정적 파일까지 맡으므로 다른 처리기 뒤에 붙인다.

import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const assetsDir = path.join(path.dirname(fileURLToPath(import.meta.url)), '..', 'assets');
// 모든 비교 페이지가 함께 쓰는 공용 파일. 요청마다 새로 읽으므로 고치면 이미 만든 페이지도 새로고침만으로 바뀐다.
const SHARED = {
  '/__uifb/review-page.js': ['review-page.js', 'text/javascript; charset=utf-8'],
  '/__uifb/review-page.css': ['review-page.css', 'text/css; charset=utf-8'],
};
const MAX_BODY = 256 * 1024;
const MAX_SNAPSHOT = 30 * 1024 * 1024; // 움직이는 조각은 글꼴·이미지를 품고 있어 크다
const TYPES = {
  '.html': 'text/html; charset=utf-8',
  '.png': 'image/png',
  '.jpg': 'image/jpeg',
  '.jpeg': 'image/jpeg',
  '.webp': 'image/webp',
  '.svg': 'image/svg+xml',
  '.json': 'application/json; charset=utf-8',
};

function send(res, status, body, type = 'application/json; charset=utf-8') {
  res.writeHead(status, { 'Content-Type': type, 'Cache-Control': 'no-store' });
  res.end(typeof body === 'string' || Buffer.isBuffer(body) ? body : JSON.stringify(body));
}

export function createReviewHandler({ root, onDone, watch }) {
function feedbackFile(round) {
  return /^[a-z0-9-]{1,40}$/i.test(round) ? path.join(root, `r${round}.json`) : null;
}

// 평가 파일을 대화에 남길 짧은 글로. 항목마다 고른 평가·한 줄 의견·핀 수.
const VERDICTS = { good: '좋음', tweak: '수정 필요', revert: '되돌리기' };
function feedbackSummary(data, round, name) {
  const lines = [`[평가 완료] ${name || (/^\d+$/.test(round) ? `${round}차 비교` : round)}`];
  for (const [id, it] of Object.entries(data.items || {})) {
    const pins = (it.pins || []).filter((p) => p.note);
    lines.push(`- ${it.title || id}: ${VERDICTS[it.verdict] || it.verdict || '평가 없음'}${it.memo ? ` · ${it.memo.trim()}` : ''}${pins.length ? ` · 핀 ${pins.map((p) => p.note).join(' / ')}` : ''}`);
  }
  if (data.overall) lines.push(`전체 의견: ${data.overall.trim()}`);
  lines.push(`(.ui-feedback/r${round}.json)`);
  return lines.join('\n');
}

function readFeedback(file, round) {
  try {
    return JSON.parse(fs.readFileSync(file, 'utf8'));
  } catch {
    return { round: /^\d+$/.test(round) ? Number(round) : round, items: {}, overall: '', done: false };
  }
}

// ── 캡처 기록 ──
// make-capture.mjs 로 만든 캡처가 찍을 때마다 남긴다. 이미지 파일마다 한 줄(같은 파일을 다시 찍으면 덮어씀)이라
// 이미지 수보다 늘지 않고, 레시피·차수·예시 응답 여부로 어떤 조건에서 찍었는지 추적한다. 오래된 이미지 정리는 prune-captures.mjs.
const capturesFile = path.join(root, 'captures.json');
function readCaptures() {
  try {
    return JSON.parse(fs.readFileSync(capturesFile, 'utf8'));
  } catch {
    return { shots: {} };
  }
}
function recordCapture(r) {
  if (typeof r.file !== 'string' || !/^[\w가-힣.-]{1,120}\.png$/.test(r.file)) return null;
  const db = readCaptures();
  const src = r.source && typeof r.source === 'object' ? r.source : {};
  db.shots[r.file] = {
    round: Number(r.round) || null,
    recipe: typeof src.recipe === 'string' ? src.recipe.slice(0, 60) : null,
    url: typeof src.url === 'string' ? src.url.slice(0, 300) : null,
    viewport: typeof src.viewport === 'string' ? src.viewport.slice(0, 20) : null,
    theme: src.theme === 'dark' ? 'dark' : 'light',
    mocked: Array.isArray(src.mocked) ? src.mocked.slice(0, 20).map((m) => String(m).slice(0, 120)) : [],
    steps: !!src.steps,
    marks: Array.isArray(r.marks) ? r.marks.length : 0,
    at: new Date().toISOString(),
  };
  fs.writeFileSync(capturesFile, JSON.stringify(db, null, 2) + '\n');
  return db.shots[r.file];
}

function inner(req, res, url) {
  if (SHARED[url.pathname]) {
    const [file, type] = SHARED[url.pathname];
    res.writeHead(200, { 'Content-Type': type, 'Cache-Control': 'no-store' });
    res.end(fs.readFileSync(path.join(assetsDir, file)));
    return true;
  }
  if (url.pathname === '/favicon.ico') {
    res.writeHead(204);
    res.end();
    return true;
  }
  if (url.pathname === '/api/watch') {
    send(res, 200, watch ? watch(url.searchParams.get('session') || '', url.searchParams.get('round') || '') : { active: false });
    return true;
  }
  if (url.pathname === '/api/captures') {
    if (req.method === 'GET') return send(res, 200, readCaptures());
    if (req.method === 'POST') {
      let body = '';
      req.on('data', (chunk) => {
        body += chunk;
        if (body.length > MAX_BODY) req.destroy();
      });
      req.on('end', () => {
        try {
          const rec = recordCapture(JSON.parse(body));
          send(res, rec ? 200 : 400, rec || { error: 'file(.png)이 필요합니다.' });
        } catch {
          send(res, 400, { error: 'JSON 형식이 아닙니다.' });
        }
      });
      return;
    }
    return send(res, 405, { error: 'GET 또는 POST만 됩니다.' });
  }

  // 움직이는 조각: 캡처할 때 그 부분의 HTML·CSS를 떼어 한 파일로 남긴다(capture-2x.js 의 RECIPE.html).
  if (url.pathname === '/api/snapshots') {
    if (req.method !== 'POST') return send(res, 405, { error: 'POST만 됩니다.' });
    let body = '';
    req.on('data', (chunk) => {
      body += chunk;
      if (body.length > MAX_SNAPSHOT) req.destroy();
    });
    req.on('end', () => {
      try {
        const { file, html } = JSON.parse(body);
        if (typeof file !== 'string' || !/^[\w가-힣.-]{1,120}\.snap\.html$/.test(file) || typeof html !== 'string') {
          return send(res, 400, { error: 'file(<이름>.snap.html)과 html 이 필요합니다.' });
        }
        fs.writeFileSync(path.join(root, file), html);
        send(res, 200, { file, bytes: Buffer.byteLength(html) });
      } catch {
        send(res, 400, { error: 'JSON 형식이 아닙니다.' });
      }
    });
    return;
  }

  if (url.pathname === '/api/feedback') {
    const round = url.searchParams.get('round') ?? '';
    const file = feedbackFile(round);
    if (!file) return send(res, 400, { error: 'round 는 숫자나 영문 id 여야 합니다.' });

    if (req.method === 'GET') return send(res, 200, readFeedback(file, round));

    if (req.method === 'POST') {
      let body = '';
      req.on('data', (chunk) => {
        body += chunk;
        if (body.length > MAX_BODY) req.destroy();
      });
      req.on('end', () => {
        let patch;
        try {
          patch = JSON.parse(body);
        } catch {
          return send(res, 400, { error: 'JSON 형식이 아닙니다.' });
        }
        const data = readFeedback(file, round);
        if (patch.id && typeof patch.id === 'string') {
          data.items[patch.id] = { ...(data.items[patch.id] || {}), ...patch.fields, updatedAt: new Date().toISOString() };
        }
        if (typeof patch.overall === 'string') data.overall = patch.overall;
        const newlyDone = patch.done === true && data.done !== true;
        if (patch.done === true) data.done = true;
        data.updatedAt = new Date().toISOString();
        fs.writeFileSync(file, JSON.stringify(data, null, 2) + '\n');
        // 완료를 알린다. 대화창과 함께 쓸 때는 붙이는 쪽이 이 요약을 그 세션 대화에 남기고 세션을 깨운다.
        if (newlyDone) onDone?.({ round, data, summary: feedbackSummary(data, round, typeof patch.name === 'string' ? patch.name : ''), session: typeof patch.session === 'string' ? patch.session : '' });
        send(res, 200, { ok: true });
      });
      return;
    }
    return send(res, 405, { error: 'GET 또는 POST만 됩니다.' });
  }

  const rel = url.pathname === '/' ? 'review.html' : decodeURIComponent(url.pathname.slice(1));
  const target = path.resolve(root, rel);
  if (!target.startsWith(root + path.sep) || !TYPES[path.extname(target).toLowerCase()]) {
    send(res, 404, 'not found', 'text/plain; charset=utf-8');
    return true;
  }
  fs.readFile(target, (err, buf) => {
    if (err) return send(res, 404, 'not found', 'text/plain; charset=utf-8');
    send(res, 200, buf, TYPES[path.extname(target).toLowerCase()]);
  });
  return true;
}

  // 정적 파일까지 맡아 모르는 주소는 404 로 끝내므로, 늘 "내 요청"이다(다른 처리기 뒤에 붙인다).
  return { handle: (req, res, url) => { inner(req, res, url); return true; } };
}
