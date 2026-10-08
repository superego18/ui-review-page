#!/usr/bin/env node
// UI 피드백 리뷰 서버. 의존성 없음 (Node 18+).
// 사용: node review-server.mjs [--dir .ui-feedback] [--port 4799] [--lan]
//   --lan: 폰 등 다른 기기에서도 열리게 한다(접속 키 필요, lan-auth.mjs).
//   <dir>/review.html 과 캡처 이미지를 정적으로 제공하고,
//   페이지가 보낸 평가를 <dir>/r<round>.json 에, 대화를 <dir>/chat.json 에 저장한다.
//   세션별 대화: 등록된 세션(<dir>/sessions/)을 /api/sessions 로 알려 주고, 메시지는 to(받는 세션)·session(보낸 세션)으로 나눈다.
//   보관함: 나중에 보낼 메시지를 <dir>/drafts.json 에 세션별로 모았다가, 사용자가 고른 것만 하나로 묶거나 따로 보낸다(/api/drafts).
//   Codex 세션에게 온 메시지는 `codex queue` 로 그 세션에 바로 넣어 깨운다(감시 명령이 필요 없다). 답은 Codex 대화 기록에서 읽어 보여 준다.

import http from 'node:http';
import fs from 'node:fs';
import path from 'node:path';
import { spawn, execFileSync } from 'node:child_process';
import { fileURLToPath } from 'node:url';
import { lanAuth } from './lan-auth.mjs';

function arg(name, fallback) {
  const i = process.argv.indexOf(`--${name}`);
  return i !== -1 && process.argv[i + 1] ? process.argv[i + 1] : fallback;
}

const root = path.resolve(arg('dir', '.ui-feedback'));
const auth = lanAuth({ dir: root, lan: process.argv.includes('--lan') });
const assetsDir = path.join(path.dirname(fileURLToPath(import.meta.url)), '..', 'assets');
// 모든 리뷰 페이지가 함께 쓰는 공용 파일. 요청마다 새로 읽으므로 고치면 이미 만든 페이지도 새로고침만으로 바뀐다.
const SHARED = {
  '/__uifb/widget.js': ['app-widget.js', 'text/javascript; charset=utf-8'],
  '/__uifb/review-page.js': ['review-page.js', 'text/javascript; charset=utf-8'],
  '/__uifb/review-page.css': ['review-page.css', 'text/css; charset=utf-8'],
};
const port = Number(arg('port', '4799'));
const MAX_BODY = 256 * 1024;
const TYPES = {
  '.html': 'text/html; charset=utf-8',
  '.png': 'image/png',
  '.jpg': 'image/jpeg',
  '.jpeg': 'image/jpeg',
  '.webp': 'image/webp',
  '.svg': 'image/svg+xml',
  '.json': 'application/json; charset=utf-8',
};

if (!fs.existsSync(path.join(root, 'review.html'))) {
  console.error(`review.html 이 없습니다: ${root}`);
  process.exit(1);
}

function feedbackFile(round) {
  return /^[a-z0-9-]{1,40}$/i.test(round) ? path.join(root, `r${round}.json`) : null;
}

function readFeedback(file, round) {
  try {
    return JSON.parse(fs.readFileSync(file, 'utf8'));
  } catch {
    return { round: /^\d+$/.test(round) ? Number(round) : round, items: {}, overall: '', done: false };
  }
}

function send(res, status, body, type = 'application/json; charset=utf-8') {
  res.writeHead(status, { 'Content-Type': type, 'Cache-Control': 'no-store' });
  res.end(typeof body === 'string' || Buffer.isBuffer(body) ? body : JSON.stringify(body));
}

const chatFile = path.join(root, 'chat.json');
const sessionsDir = path.join(root, 'sessions');
const TAIL_BYTES = 4 * 1024 * 1024;
const transcriptCache = new Map();

function stripTags(text) {
  return text
    .replace(/<system-reminder[^>]*>[\s\S]*?<\/system-reminder>/g, '')
    .replace(/<(local-command-[a-z]+|command-[a-z]+)>[\s\S]*?<\/\1>/g, '')
    .trim();
}

function readChat() {
  try {
    return JSON.parse(fs.readFileSync(chatFile, 'utf8'));
  } catch {
    return { messages: [] };
  }
}

// register-session.mjs 가 등록한 세션들(.ui-feedback/sessions/<세션 id>.json)
function listSessions() {
  let files = [];
  try {
    files = fs.readdirSync(sessionsDir).filter((f) => f.endsWith('.json'));
  } catch {}
  return files
    .map((f) => {
      try {
        return JSON.parse(fs.readFileSync(path.join(sessionsDir, f), 'utf8'));
      } catch {
        return null;
      }
    })
    .filter(Boolean)
    .sort((a, b) => String(a.registeredAt).localeCompare(String(b.registeredAt)))
    .map((s) => ({ id: s.sessionId, name: s.name, tool: s.tool, agent: s.agent, watch: s.tool === 'codex' ? { active: true, via: 'queue' } : readWatchFile(`watch-${s.sessionId}.json`), status: readStatus(s.sessionId) }));
}

// hook-relay.mjs 가 보낸 세션 상태(작업 중·승인 대기·쉬는 중). 오래된 "작업 중"은 믿지 않는다.
function readStatus(id) {
  try {
    const s = JSON.parse(fs.readFileSync(path.join(root, `status-${id}.json`), 'utf8'));
    if (s.state !== 'idle' && Date.now() - Date.parse(s.at) > 30 * 60_000) return { state: 'unknown' };
    return s;
  } catch {
    return { state: 'unknown' };
  }
}

function findSession(id) {
  try {
    return JSON.parse(fs.readFileSync(path.join(sessionsDir, `${id}.json`), 'utf8'));
  } catch {
    return null;
  }
}

// Codex 세션은 훅이 없어서 대화 기록 파일에서 사용자 입력과 에이전트 답만 뽑아 보여 준다(내부 형식).
// Claude 세션은 hook-relay.mjs 훅이 chat.json 으로 보내므로 여기서는 읽지 않는다.
const sid = (v) => (typeof v === 'string' && /^[\w.-]{1,80}$/.test(v) ? v : undefined);

function cleanWhere(w) {
  if (!w || typeof w !== 'object') return undefined;
  const str = (v, n) => (typeof v === 'string' ? v.slice(0, n) : undefined);
  const num = (o) => (o && typeof o === 'object' ? Object.fromEntries(Object.entries(o).filter(([, v]) => Number.isFinite(v)).slice(0, 4)) : undefined);
  return { url: str(w.url, 300), selector: str(w.selector, 300), text: str(w.text, 120), rect: num(w.rect), viewport: num(w.viewport) };
}

// 대화 기록에 메시지를 더하고, Codex 세션에게 온 사용자 메시지는 그 세션에 바로 넣는다.
function addChat(msg) {
  const text = typeof msg.text === 'string' ? msg.text.trim().slice(0, 12000) : '';
  if (!text || !['user', 'agent'].includes(msg.from)) return null;
  const chat = readChat();
  const entry = { id: chat.messages.length + 1, from: msg.from, text, round: Number(msg.round) || null, at: new Date().toISOString() };
  if (msg.from === 'agent' && typeof msg.agent === 'string') entry.agent = msg.agent.slice(0, 40);
  // 사용자 메시지는 받을 세션(to), 에이전트 답과 터미널 입력은 그 세션(session)을 적는다.
  if (sid(msg.to)) entry.to = msg.to;
  if (sid(msg.session)) entry.session = msg.session;
  if (typeof msg.context === 'string') entry.context = msg.context.slice(0, 20);
  if (msg.device === 'mobile' || msg.device === 'desktop') entry.device = msg.device;
  if (cleanWhere(msg.where)) entry.where = cleanWhere(msg.where);
  chat.messages.push(entry);
  fs.writeFileSync(chatFile, JSON.stringify(chat, null, 2) + '\n');
  const target = entry.from === 'user' && entry.to ? findSession(entry.to) : null;
  if (target?.tool === 'codex') queueToCodex(target, entry);
  // 사용자가 터미널이나 화면에서 그 세션에 말을 걸었다면 그때까지의 답은 읽은 것이다.
  const talkedTo = entry.from === 'user' ? entry.session || entry.to : null;
  if (talkedTo) markSeen({ [talkedTo]: entry.at });
  return entry;
}

// ── 읽음 상태 ──
// 세션마다 사용자가 마지막으로 읽은 답의 시각. 앱 화면(4798)과 리뷰 페이지(4799)는 주소가 달라 브라우저 저장소를 함께 못 쓰므로 서버에 둔다.
const seenFile = path.join(root, 'seen.json');
function readSeen() {
  try {
    return JSON.parse(fs.readFileSync(seenFile, 'utf8'));
  } catch {
    return {};
  }
}
// 더 나중 시각만 받아들인다(늦게 도착한 옛 값이 읽음을 되돌리지 않게).
function markSeen(updates) {
  const seen = readSeen();
  let changed = false;
  for (const [id, at] of Object.entries(updates || {})) {
    if (!sid(id) || typeof at !== 'string' || at.length > 40) continue;
    if (!seen[id] || at > seen[id]) { seen[id] = at; changed = true; }
  }
  if (changed) fs.writeFileSync(seenFile, JSON.stringify(seen, null, 2) + '\n');
  return seen;
}

// ── 화면 설정 ──
// 대화 창 크기·입력칸 높이는 데스크톱과 모바일을 따로 두고({ desktop: {...}, mobile: {...} }), 고른 세션 탭(tab)은 함께 쓴다.
const prefsFile = path.join(root, 'prefs.json');
function readPrefs() {
  try {
    return JSON.parse(fs.readFileSync(prefsFile, 'utf8'));
  } catch {
    return {};
  }
}
function savePrefs(req) {
  const device = req.device === 'mobile' ? 'mobile' : 'desktop';
  const prefs = readPrefs();
  const cur = prefs[device] || {};
  const num = (v) => (Number.isFinite(v) && v > 0 && v < 5000 ? Math.round(v) : null);
  if ('panel' in req) cur.panel = req.panel && num(req.panel.w) && num(req.panel.h) ? { w: num(req.panel.w), h: num(req.panel.h) } : null;
  if ('inputH' in req) cur.inputH = num(req.inputH);
  if ('tab' in req && sid(req.tab)) prefs.tab = req.tab;
  // 보관함에 담을 때 마지막으로 고른 분류(두 화면 공용)
  // 세션마다 따로 둔다(분류는 세션마다 다르다).
  if ('draftLabel' in req && sid(req.session)) prefs.draftLabels = { ...(prefs.draftLabels || {}), [req.session]: typeof req.draftLabel === 'string' && req.draftLabel.trim() ? req.draftLabel.trim().slice(0, 30) : null };
  // 세션마다 보고 있던 메시지(맨 위에 보이던 메시지 id, 맨 아래면 'bottom'). 화면 폭과 상관없이 같은 메시지로 돌아간다.
  if (req.pos && sid(req.pos.session) && typeof req.pos.id === 'string' && req.pos.id.length < 80) prefs.pos = { ...(prefs.pos || {}), [req.pos.session]: req.pos.id };
  if ('panel' in req || 'inputH' in req) prefs[device] = cur;
  fs.writeFileSync(prefsFile, JSON.stringify(prefs, null, 2) + '\n');
  return prefs;
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

// ── 쓰던 글 ──
// 세션 탭마다 입력칸에 쓰다가 아직 보내지 않은 글. 새로고침해도 남고, 앱 화면·리뷰 페이지에서 이어 쓸 수 있다.
const composeFile = path.join(root, 'compose.json');
function readCompose() {
  try {
    return JSON.parse(fs.readFileSync(composeFile, 'utf8'));
  } catch {
    return {};
  }
}
function saveCompose(req) {
  const all = readCompose();
  if (!sid(req.session)) return all;
  const text = typeof req.text === 'string' ? req.text.slice(0, 12000) : '';
  if (text) all[req.session] = { text, at: new Date().toISOString() };
  else delete all[req.session];
  fs.writeFileSync(composeFile, JSON.stringify(all, null, 2) + '\n');
  return all;
}

// ── 보관함 ──
const draftsFile = path.join(root, 'drafts.json');
const projectDir = path.dirname(root);

function readDrafts() {
  try {
    return JSON.parse(fs.readFileSync(draftsFile, 'utf8'));
  } catch {
    return { nextId: 1, drafts: [] };
  }
}

function writeDrafts(d) {
  fs.writeFileSync(draftsFile, JSON.stringify(d, null, 2) + '\n');
}

// 저장 당시 코드 버전. 나중에 화면이 바뀌어도 세션이 그때 코드와 비교해 어디를 말한 것인지 찾게 한다.
function currentCommit() {
  try {
    return execFileSync('git', ['-C', projectDir, 'rev-parse', '--short', 'HEAD'], { encoding: 'utf8', stdio: ['ignore', 'pipe', 'ignore'] }).trim();
  } catch {
    return null;
  }
}

const shortTime = (iso) => new Date(iso).toLocaleString('ko-KR', { month: 'numeric', day: 'numeric', hour: '2-digit', minute: '2-digit' });

const cleanLabel = (v) => (typeof v === 'string' && v.trim() ? v.trim().slice(0, 30) : null);

// 보관함 항목 하나를 보낼 글로 만든다. 위치는 저장 당시 맥락(시각·커밋·문구)을 함께 적는다.
function draftText(d) {
  const lines = [d.text];
  if (d.where?.url || d.where?.selector) {
    lines.push(`위치(${shortTime(d.at)} 저장${d.commit ? ` · 커밋 ${d.commit}` : ''} 기준): ${d.where.url || ''}${d.where.selector ? ' · ' + d.where.selector : ''}${d.where.text ? ` · 당시 문구 "${d.where.text}"` : ''}`);
  }
  if (d.round || d.device) lines.push(`(${[d.round ? `${d.round}차 리뷰를 보다가` : '', d.device === 'mobile' ? '모바일에서' : d.device === 'desktop' ? '데스크톱에서' : ''].filter(Boolean).join(' ')} 남김)`);
  return lines.join('\n');
}

// 고른 항목을 받는 세션별로 묶어 보낸다. combine 이면 세션마다 번호 매긴 메시지 하나, 아니면 하나씩.
// device: 보내기를 누른 화면(대화 라벨에 붙음). 항목마다 담은 화면은 본문에 "(모바일에서 남김)"으로 남는다.
function sendDrafts(ids, combine, device) {
  const store = readDrafts();
  const picked = store.drafts.filter((d) => ids.includes(d.id));
  // 받는 세션과 분류가 같은 것끼리 한 메시지로 묶는다. 받는 세션도 분류 단위로 처리할 수 있게 첫 줄에 분류를 적는다.
  const groups = new Map();
  for (const d of picked) {
    const k = d.to + '\u0000' + (d.label || '');
    groups.set(k, [...(groups.get(k) || []), d]);
  }
  const sent = [];
  for (const list of groups.values()) {
    const to = list[0].to;
    const label = list[0].label || '미분류'; // 분류 없이 담은 것도 [미분류]로 붙여 받는 세션이 묶음을 알게 한다
    if (combine && list.length > 1) {
      const text = `${label ? `[${label}] ` : ''}보관함에서 모아 보낸 ${list.length}개입니다.\n\n` + list.map((d, i) => `${i + 1}. ${draftText(d).replace(/\n/g, '\n   ')}`).join('\n\n');
      sent.push(addChat({ from: 'user', to, text, device, context: list.every((d) => d.context === 'review') ? 'review' : 'app' }));
    } else {
      for (const d of list) sent.push(addChat({ from: 'user', to, text: (label ? `[${label}] ` : '') + draftText(d), context: d.context, round: d.round, where: d.where, device: device || d.device }));
    }
  }
  store.drafts = store.drafts.filter((d) => !ids.includes(d.id));
  writeDrafts(store);
  return sent.filter(Boolean);
}

// 보관함 요청: add(새 항목) · update(글·받는 세션·위치 고치기) · delete · send
function handleDrafts(req) {
  const store = readDrafts();
  const ids = Array.isArray(req.ids) ? req.ids.filter(Number.isInteger) : [];
  if (req.action === 'add') {
    const text = typeof req.text === 'string' ? req.text.trim().slice(0, 4000) : '';
    if (!text || !sid(req.to)) return { status: 400, body: { error: 'text와 to(세션)가 필요합니다.' } };
    const d = { id: store.nextId++, to: req.to, text, label: cleanLabel(req.label), device: req.device === 'mobile' ? 'mobile' : req.device === 'desktop' ? 'desktop' : null, context: req.context === 'review' ? 'review' : 'app', round: Number(req.round) || null, where: cleanWhere(req.where), commit: currentCommit(), at: new Date().toISOString() };
    store.drafts.push(d);
    writeDrafts(store);
    return { status: 200, body: d };
  }
  if (req.action === 'update') {
    const d = store.drafts.find((x) => x.id === req.id);
    if (!d) return { status: 404, body: { error: '없는 항목입니다.' } };
    if (typeof req.text === 'string' && req.text.trim()) d.text = req.text.trim().slice(0, 4000);
    if (sid(req.to)) d.to = req.to;
    if ('label' in req) d.label = cleanLabel(req.label);
    if (req.where !== undefined) {
      d.where = cleanWhere(req.where);
      d.commit = currentCommit();
      d.at = new Date().toISOString();
    }
    writeDrafts(store);
    return { status: 200, body: d };
  }
  if (req.action === 'delete') {
    store.drafts = store.drafts.filter((d) => !ids.includes(d.id));
    writeDrafts(store);
    return { status: 200, body: { ok: true } };
  }
  if (req.action === 'send') {
    if (!ids.length) return { status: 400, body: { error: '보낼 항목(ids)이 필요합니다.' } };
    return { status: 200, body: { sent: sendDrafts(ids, req.combine !== false, req.device === 'mobile' || req.device === 'desktop' ? req.device : null) } };
  }
  return { status: 400, body: { error: 'action은 add·update·delete·send 중 하나입니다.' } };
}

const QUEUE_PREFIX = '[대화/피드백 · ';

// 페이지 메시지를 실행 중인 Codex 세션에 넣는다. 쉬고 있으면 바로 새 턴이 시작되고, 작업 중이면 그 턴이 끝난 뒤 처리된다.
// 메시지는 인자나 환경 변수로만 넘겨 셸이 해석하지 않게 한다(Windows는 codex.cmd 라서 PowerShell 로 부른다).
function queueToCodex(session, entry) {
  const where = entry.where?.url || entry.where?.selector
    ? `\n위치: ${entry.where.url || ''}${entry.where.selector ? ' · ' + entry.where.selector : ''}${entry.where.text ? ' · "' + entry.where.text + '"' : ''}`
    : '';
  const src = (entry.context === 'app' ? '앱 화면' : '리뷰') + (entry.device === 'mobile' ? ' · 모바일' : entry.device === 'desktop' ? ' · 데스크톱' : '');
  queueText(session, `${QUEUE_PREFIX}${src}${entry.round ? ` · ${entry.round}차` : ''}] ${entry.text}${where}`);
}

function queueText(session, message) {
  const args = ['queue', '--thread', session.sessionId, '--message', message];
  const child = process.platform === 'win32'
    ? spawn('powershell', ['-NoProfile', '-Command', '& codex queue --thread $env:UIFB_THREAD --message $env:UIFB_MESSAGE'], { env: { ...process.env, UIFB_THREAD: session.sessionId, UIFB_MESSAGE: message }, stdio: 'ignore' })
    : spawn('codex', args, { stdio: 'ignore' });
  child.on('error', (e) => console.error(`codex queue 실패(${session.name}): ${e.message}`));
  child.on('exit', (code) => { if (code) console.error(`codex queue 실패(${session.name}): 종료 코드 ${code}`); });
}

function readTranscript(id) {
  const session = findSession(id);
  if (!session) return { items: [] };
  if (session.tool !== 'codex') return { items: [], via: 'hooks' };
  let st;
  try {
    st = fs.statSync(session.path);
  } catch {
    return { items: [] };
  }
  const key = `${st.size}:${st.mtimeMs}`;
  const cached = transcriptCache.get(id);
  if (cached && cached.key === key) return cached.data;
  const len = Math.min(st.size, TAIL_BYTES);
  const fd = fs.openSync(session.path, 'r');
  const buf = Buffer.alloc(len);
  fs.readSync(fd, buf, 0, len, st.size - len);
  fs.closeSync(fd);
  const lines = buf.toString('utf8').split('\n');
  if (len < st.size) lines.shift();
  const items = [];
  for (const line of lines) {
    let o;
    try {
      o = JSON.parse(line);
    } catch {
      continue;
    }
    const p = o.payload;
    if (o.type !== 'response_item' || p?.type !== 'message' || !['user', 'assistant'].includes(p.role)) continue;
    const text = stripTags((p.content || []).filter((b) => b.type === 'input_text' || b.type === 'output_text').map((b) => b.text).join('\n'));
    if (!text || (p.role === 'user' && (text.startsWith('<') || text.startsWith(QUEUE_PREFIX) || text.includes('AGENTS.md instructions')))) continue;
    items.push({ id: `x${p.id || o.ordinal}`, from: p.role === 'user' ? 'user' : 'agent', session: id, context: 'terminal', agent: session.agent, text: text.slice(0, 8000), at: o.timestamp });
  }
  const data = { items: items.slice(-300) };
  transcriptCache.set(id, { key, data });
  return data;
}

function readWatchFile(name) {
  try {
    const watch = JSON.parse(fs.readFileSync(path.join(root, name), 'utf8'));
    if (watch.state === 'handling') {
      if (Date.parse(watch.until) < Date.now()) return { active: false };
      return { active: true, handling: true, agent: watch.agent, session: watch.session, handlesDone: !!watch.handlesDone, round: watch.round };
    }
    if (watch.expiresAt && Date.parse(watch.expiresAt) < Date.now()) return { active: false };
    process.kill(watch.pid, 0);
    return { active: true, agent: watch.agent, session: watch.session, handlesDone: !!watch.handlesDone, round: watch.round, expiresAt: watch.expiresAt };
  } catch {
    return { active: false };
  }
}

// 리뷰 완료 표시를 받아 반영할 감시(handlesDone)가 살아 있는지. 페이지 위쪽 "자동 이어가기" 표시에 쓴다.
// 리뷰를 반영하는 세션(REVIEW.session)을 이름이나 id 로 찾는다.
function findSessionByKey(key) {
  if (!key) return null;
  return findSession(key) || listSessions().map((s) => findSession(s.id)).find((s) => s?.name === key) || null;
}

// 완료 표시를 받을 세션이 있는지. Claude 는 --done 감시, Codex 는 완료 때 codex queue 로 "피드백 확인해"를 넣는다.
function readReviewWatch(sessionKey, round) {
  let files = [];
  try {
    files = fs.readdirSync(root).filter((f) => /^watch-.+\.json$/.test(f));
  } catch {}
  // 감시가 라운드를 정했으면 그 라운드 페이지에만 보인다. 다른 라운드·비교 페이지에 "자동 이어가기 켜짐"으로 잘못 뜨지 않게.
  const live = files.map(readWatchFile).filter((w) => w.active && w.handlesDone && (w.round == null || !round || String(w.round) === round));
  if (live[0]) return live[0];
  const s = findSessionByKey(sessionKey);
  if (s?.tool === 'codex') return { active: true, via: 'queue', agent: s.agent || s.name, session: s.sessionId, handlesDone: true };
  return { active: false };
}

const server = http.createServer((req, res) => {
  if (!auth.check(req, res)) return;
  const url = new URL(req.url, 'http://localhost');

  // 대화/피드백 위젯(assets/app-widget.js)은 앱 화면(app-proxy)과 리뷰 페이지가 같은 파일을 쓴다.
  // 위젯은 /__uifb/api/* 로 부르므로, 리뷰 서버에서는 앞의 /__uifb 를 떼고 같은 API 로 처리한다.
  if (SHARED[url.pathname]) {
    const [file, type] = SHARED[url.pathname];
    res.writeHead(200, { 'Content-Type': type, 'Cache-Control': 'no-store' });
    return res.end(fs.readFileSync(path.join(assetsDir, file)));
  }
  if (url.pathname.startsWith('/__uifb/api/')) url.pathname = url.pathname.slice('/__uifb'.length);

  if (url.pathname === '/favicon.ico') {
    res.writeHead(204);
    return res.end();
  }

  if (url.pathname === '/api/watch') {
    return send(res, 200, readReviewWatch(url.searchParams.get('session') || '', url.searchParams.get('round') || ''));
  }

  if (url.pathname === '/api/status' && req.method === 'POST') {
    let body = '';
    req.on('data', (chunk) => {
      body += chunk;
      if (body.length > MAX_BODY) req.destroy();
    });
    req.on('end', () => {
      try {
        const s = JSON.parse(body);
        if (!/^[\w.-]{1,80}$/.test(String(s.session)) || !['working', 'permission', 'idle'].includes(s.state)) throw new Error();
        fs.writeFileSync(path.join(root, `status-${s.session}.json`), JSON.stringify({ state: s.state, detail: String(s.detail || '').slice(0, 120), at: new Date().toISOString() }) + '\n');
        send(res, 200, { ok: true });
      } catch {
        send(res, 400, { error: 'session, state(working|permission|idle)가 필요합니다.' });
      }
    });
    return;
  }

  if (url.pathname === '/api/sessions') {
    return send(res, 200, { sessions: listSessions() });
  }

  if (url.pathname === '/api/transcript') {
    return send(res, 200, readTranscript(url.searchParams.get('session') || ''));
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

  if (url.pathname === '/api/compose') {
    if (req.method === 'GET') return send(res, 200, readCompose());
    if (req.method === 'POST') {
      let body = '';
      req.on('data', (chunk) => {
        body += chunk;
        if (body.length > MAX_BODY) req.destroy();
      });
      req.on('end', () => {
        try {
          send(res, 200, saveCompose(JSON.parse(body)));
        } catch {
          send(res, 400, { error: 'JSON 형식이 아닙니다.' });
        }
      });
      return;
    }
    return send(res, 405, { error: 'GET 또는 POST만 됩니다.' });
  }

  if (url.pathname === '/api/prefs') {
    if (req.method === 'GET') return send(res, 200, readPrefs());
    if (req.method === 'POST') {
      let body = '';
      req.on('data', (chunk) => {
        body += chunk;
        if (body.length > MAX_BODY) req.destroy();
      });
      req.on('end', () => {
        try {
          send(res, 200, savePrefs(JSON.parse(body)));
        } catch {
          send(res, 400, { error: 'JSON 형식이 아닙니다.' });
        }
      });
      return;
    }
    return send(res, 405, { error: 'GET 또는 POST만 됩니다.' });
  }

  if (url.pathname === '/api/seen') {
    if (req.method === 'GET') return send(res, 200, readSeen());
    if (req.method === 'POST') {
      let body = '';
      req.on('data', (chunk) => {
        body += chunk;
        if (body.length > MAX_BODY) req.destroy();
      });
      req.on('end', () => {
        try {
          send(res, 200, markSeen(JSON.parse(body)));
        } catch {
          send(res, 400, { error: 'JSON 형식이 아닙니다.' });
        }
      });
      return;
    }
    return send(res, 405, { error: 'GET 또는 POST만 됩니다.' });
  }

  if (url.pathname === '/api/drafts') {
    if (req.method === 'GET') return send(res, 200, { drafts: readDrafts().drafts });
    if (req.method === 'POST') {
      let body = '';
      req.on('data', (chunk) => {
        body += chunk;
        if (body.length > MAX_BODY) req.destroy();
      });
      req.on('end', () => {
        let r;
        try {
          r = JSON.parse(body);
        } catch {
          return send(res, 400, { error: 'JSON 형식이 아닙니다.' });
        }
        const out = handleDrafts(r);
        send(res, out.status, out.body);
      });
      return;
    }
    return send(res, 405, { error: 'GET 또는 POST만 됩니다.' });
  }

  if (url.pathname === '/api/chat') {
    if (req.method === 'GET') return send(res, 200, readChat());
    if (req.method === 'POST') {
      let body = '';
      req.on('data', (chunk) => {
        body += chunk;
        if (body.length > MAX_BODY) req.destroy();
      });
      req.on('end', () => {
        let msg;
        try {
          msg = JSON.parse(body);
        } catch {
          return send(res, 400, { error: 'JSON 형식이 아닙니다.' });
        }
        const entry = addChat(msg);
        if (!entry) return send(res, 400, { error: 'from(user|agent)과 text가 필요합니다.' });
        send(res, 200, entry);
      });
      return;
    }
    return send(res, 405, { error: 'GET 또는 POST만 됩니다.' });
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
        const reviewer = newlyDone ? findSessionByKey(typeof patch.session === 'string' ? patch.session : '') : null;
        if (reviewer?.tool === 'codex') {
          queueText(reviewer, `${QUEUE_PREFIX}리뷰 · ${round}차] 피드백 확인해. 사용자가 ${round}차 리뷰 완료를 표시했습니다. .ui-feedback/r${round}.json 을 읽고 ui-feedback-loop 5단계대로 반영하세요.`);
        }
        send(res, 200, { ok: true });
      });
      return;
    }
    return send(res, 405, { error: 'GET 또는 POST만 됩니다.' });
  }

  const rel = url.pathname === '/' ? 'review.html' : decodeURIComponent(url.pathname.slice(1));
  const target = path.resolve(root, rel);
  if (!target.startsWith(root + path.sep) || !TYPES[path.extname(target).toLowerCase()]) {
    return send(res, 404, 'not found', 'text/plain; charset=utf-8');
  }
  fs.readFile(target, (err, buf) => {
    if (err) return send(res, 404, 'not found', 'text/plain; charset=utf-8');
    send(res, 200, buf, TYPES[path.extname(target).toLowerCase()]);
  });
});

server.on('error', (err) => {
  console.error(err.code === 'EADDRINUSE' ? `포트 ${port} 이(가) 이미 쓰이고 있습니다. --port 로 바꾸세요.` : err.message);
  process.exit(1);
});

server.listen(port, auth.host, () => {
  console.log(`리뷰 페이지: http://localhost:${port}/`);
  for (const u of auth.urls(port)) console.log(`다른 기기(폰)에서: ${u}`);
  console.log(`평가 저장 위치: ${root}${path.sep}r<round>.json`);
});
