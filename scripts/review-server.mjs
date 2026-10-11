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
import { vapidKeys, sendPush } from './web-push.mjs';

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
  '/__uifb/sw.js': ['sw.js', 'text/javascript; charset=utf-8'],
  '/__uifb/icon-180.png': ['icon-180.png', 'image/png'],
  '/__uifb/icon-192.png': ['icon-192.png', 'image/png'],
  '/__uifb/icon-512.png': ['icon-512.png', 'image/png'],
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

// ── 알림(웹 푸시) 구독 ──
const subsFile = path.join(root, 'push-subs.json');
const plainBody = (t) => String(t).replace(/^\s*<re[^>]*>\s*/, '').replace(/[`*#>]/g, '').replace(/\s+/g, ' ').slice(0, 140);
function readSubs() {
  try { return JSON.parse(fs.readFileSync(subsFile, 'utf8')); } catch { return []; }
}
function writeSubs(list) {
  fs.writeFileSync(subsFile, JSON.stringify(list, null, 2) + '\n', { mode: 0o600 });
}
// 기기마다 고른 알림 종류. answer 세션 답장, done 작업 끝남, permission 승인 필요, review 비교 페이지 준비, stale 오래 멈춤, peer 세션끼리 메시지.
// quiet: 그 기기에서 대화창을 보고 있는 동안(최근 30초 안에 보고 있다고 알려 옴)에는 보내지 않는다.
const PUSH_DEFAULTS = { answer: true, done: true, permission: true, review: true, stale: true, peer: false, quiet: true };
const prefsOf = (s) => ({ ...PUSH_DEFAULTS, ...(s.prefs || {}) });
// 구독한 기기 중 kind 를 켠 기기에 보낸다(kind 가 없으면 모두, 시험용). 끝난 구독(404·410)은 지운다. 보낸 수를 돌려준다(실패해도 대화 기록은 막지 않는다).
async function pushAll(data, kind) {
  const subs = readSubs().filter((s) => {
    if (!kind) return true;
    const p = prefsOf(s);
    return p[kind] && !(p.quiet && s.viewingAt && Date.now() - Date.parse(s.viewingAt) < 30_000);
  });
  if (!subs.length) return 0;
  const keys = vapidKeys(root);
  let sent = 0;
  const gone = new Set();
  await Promise.all(subs.map(async (s) => {
    try {
      const st = await sendPush(keys, s, { ...data, url: s.url });
      if (st === 404 || st === 410) gone.add(s.endpoint);
      else if (st < 300) sent++;
    } catch {}
  }));
  if (gone.size) writeSubs(readSubs().filter((s) => !gone.has(s.endpoint)));
  return sent;
}

// 상태가 바뀔 때의 알림: 작업 끝남(작업 중 → 쉬는 중), 승인 필요(→ 승인 대기).
function notifyStatus(s, prev) {
  const name = findSession(s.session)?.name || '세션';
  const busy = (x) => x === 'working' || x === 'permission';
  if (s.state === 'permission' && prev.state !== 'permission') pushAll({ title: `${name} 승인 필요`, body: s.detail || '터미널에서 승인을 기다리는 중', tag: `uifb-perm-${s.session}` }, 'permission');
  if (s.state === 'idle' && busy(prev.state)) {
    // 마지막 답은 작업이 끝나는 것과 거의 같은 때 기록되므로 잠깐 기다렸다가 그 답을 알림 본문에 담는다.
    setTimeout(() => {
      const last = readChat().messages.filter((m) => m.from === 'agent' && m.session === s.session).at(-1);
      pushAll({ title: `${name} 작업 끝`, body: last ? plainBody(last.text) : '하던 일을 마쳤습니다', tag: `uifb-done-${s.session}` }, 'done');
    }, 3000);
  }
}
// 오래 멈춤: "작업 중"이 5분 넘게 그대로면 그 상태에 한 번 알린다.
const staleSent = new Map();
setInterval(() => {
  for (const x of listSessions()) {
    const st = x.status;
    if (st?.state !== 'working' || !st.at || Date.now() - Date.parse(st.at) < 5 * 60_000 || staleSent.get(x.id) === st.at) continue;
    staleSent.set(x.id, st.at);
    pushAll({ title: `${x.name} 오래 멈춤`, body: `"${st.detail || '작업 중'}" 상태가 5분 넘게 그대로예요`, tag: `uifb-stale-${x.id}` }, 'stale');
  }
}, 60_000).unref();
// 비교 페이지 준비: .ui-feedback 에 review*.html 이 새로 생기면 알린다.
try {
  const known = new Set(fs.readdirSync(root).filter((f) => /^review.*\.html$/.test(f)));
  fs.watch(root, (ev, f) => {
    if (!f || !/^review.*\.html$/.test(f) || known.has(f) || !fs.existsSync(path.join(root, f))) return;
    known.add(f);
    setTimeout(() => {
      const title = /<title>([^<]*)<\/title>/.exec(fs.readFileSync(path.join(root, f), 'utf8'))?.[1] || f;
      pushAll({ title: '비교 페이지 준비', body: `${title} — 평가할 차례예요`, tag: `uifb-review-${f}` }, 'review');
    }, 1500);
  });
} catch {}

// ── 세션끼리 주고받은 메시지 ──
// 보낸 세션의 훅이 보낼 때(PreToolUse SendMessage) 한 번, 받은 세션의 훅이 받을 때(UserPromptSubmit) 한 번 알려 온다.
// SendMessage 는 받는 쪽을 세션 이름(peer 이름)으로 부르고, 그 이름은 대화창 탭 이름과 다르다.
// 받은 쪽이 같은 글을 알려 오면 그 이름이 어느 세션인지 배워 peers.json 에 적어 두고, 다음부터는 보낼 때 바로 찾는다.
const peersFile = path.join(root, 'peers.json');
const peerName = (v) => (typeof v === 'string' ? v.replace(/\s*\[[^\]]*\]\s*$/, '').trim().slice(0, 80) : '');
function readPeers() {
  try { return JSON.parse(fs.readFileSync(peersFile, 'utf8')); } catch { return {}; }
}
function addPeer(msg, text) {
  const chat = readChat();
  const peers = readPeers();
  const now = new Date().toISOString();
  if (sid(msg.to)) {
    // 받은 쪽: 10분 안에 같은 글을 보낸 기록이 있으면 그 기록에 받은 세션과 받은 시각을 적는다.
    const sent = chat.messages.findLast((m) => m.from === 'peer' && !m.readAt && m.text === text && Date.now() - Date.parse(m.at) < 10 * 60_000 && (!m.to || m.to === msg.to));
    const fromName = peerName(msg.fromName);
    if (sent) {
      sent.to = msg.to;
      sent.readAt = now;
      if (sent.toName) peers[sent.toName] = msg.to;
      if (fromName && sent.session) peers[fromName] = sent.session;
      fs.writeFileSync(peersFile, JSON.stringify(peers, null, 2) + '\n');
    } else {
      chat.messages.push({ id: chat.messages.length + 1, from: 'peer', text, at: now, to: msg.to, readAt: now, ...(fromName ? { fromName } : {}), ...(peers[fromName] ? { session: peers[fromName] } : {}) });
    }
  } else {
    const toName = peerName(msg.toName);
    const entry = { id: chat.messages.length + 1, from: 'peer', text, at: now, toName };
    if (sid(msg.session)) entry.session = msg.session;
    if (peers[toName]) entry.to = peers[toName];
    chat.messages.push(entry);
  }
  fs.writeFileSync(chatFile, JSON.stringify(chat, null, 2) + '\n');
  const last = chat.messages.at(-1);
  if (!sid(msg.to)) pushAll({ title: `${findSession(last.session)?.name || '세션'} → ${last.to ? findSession(last.to)?.name || last.toName : last.toName}`, body: plainBody(text), tag: 'uifb-peer' }, 'peer');
  return last;
}

// 보관함에서 보낸 메시지의 구조(분류, 항목마다 글·위치·저장 시각·커밋·담은 화면). 대화창이 사용자가 쓴 글과 위치 같은 덧붙인 정보를 나눠 보이고,
// 다시 보내기에서 글만 고치게 한다. 세션에 가는 글(text)은 이 구조로 만든다.
function cleanDraft(v) {
  if (!v || typeof v !== 'object' || !Array.isArray(v.items) || !v.items.length) return undefined;
  const items = v.items.slice(0, 50).map((d) => ({
    ...(Number.isInteger(d?.id) ? { id: d.id } : {}), // 보관함 항목 번호(보낸 기록과 메시지를 잇는다)
    text: typeof d?.text === 'string' ? d.text.trim().slice(0, 4000) : '',
    where: cleanWhere(d?.where),
    at: typeof d?.at === 'string' && !Number.isNaN(Date.parse(d.at)) ? d.at : null,
    commit: typeof d?.commit === 'string' && /^[0-9a-f]{4,40}$/.test(d.commit) ? d.commit : null,
    round: Number(d?.round) || null,
    device: d?.device === 'mobile' || d?.device === 'desktop' ? d.device : null,
  })).filter((d) => d.text);
  return items.length ? { label: cleanLabel(v.label) || '미분류', items } : undefined;
}
function draftMessageText(draft) {
  const { label, items } = draft;
  if (items.length > 1) return `[${label}] 보관함에서 모아 보낸 ${items.length}개입니다.\n\n` + items.map((d, i) => `${i + 1}. ${draftText(d).replace(/\n/g, '\n   ')}`).join('\n\n');
  return `[${label}] ` + draftText(items[0]);
}

// 대화 기록에 메시지를 더하고, Codex 세션에게 온 사용자 메시지는 그 세션에 바로 넣는다.
function addChat(msg) {
  const draft = msg.from === 'user' ? cleanDraft(msg.draft) : undefined;
  const text = draft ? draftMessageText(draft) : typeof msg.text === 'string' ? msg.text.trim().slice(0, 12000) : '';
  if (text && msg.from === 'peer') return addPeer(msg, text);
  if (!text || !['user', 'agent'].includes(msg.from)) return null;
  const chat = readChat();
  // 같은 cid 로 다시 온 글(느린 망에서 다시 누름)은 새로 만들지 않고 먼저 받은 것을 돌려준다.
  const cid = typeof msg.cid === 'string' ? msg.cid.slice(0, 80) : null;
  if (cid) { const dup = chat.messages.find((x) => x.cid === cid); if (dup) return dup; }
  const entry = { id: chat.messages.length + 1, from: msg.from, text, round: Number(msg.round) || null, at: new Date().toISOString() };
  if (cid) entry.cid = cid;
  if (msg.from === 'agent' && typeof msg.agent === 'string') entry.agent = msg.agent.slice(0, 40);
  // 세션 답 맨 앞의 <re 1090 1091>: 이 답이 어느 메시지에 대한 답인지. 글에서는 떼어 내고 re 로 남긴다(대화창이 연결선으로 잇는다).
  if (msg.from === 'agent') {
    const mk = /^\s*<re\s+([#\d,\s]+)>\s*/.exec(text);
    if (mk) {
      entry.re = [...new Set(mk[1].match(/\d+/g).map(Number))].filter((n) => n < entry.id).slice(0, 50);
      entry.text = text.slice(mk[0].length) || text;
    }
  }
  // 사용자 메시지는 받을 세션(to), 에이전트 답과 터미널 입력은 그 세션(session)을 적는다.
  if (sid(msg.to)) entry.to = msg.to;
  if (sid(msg.session)) entry.session = msg.session;
  if (typeof msg.context === 'string') entry.context = msg.context.slice(0, 20);
  if (msg.device === 'mobile' || msg.device === 'desktop') entry.device = msg.device;
  if (cleanWhere(msg.where)) entry.where = cleanWhere(msg.where);
  if (draft) entry.draft = draft;
  if (Number.isInteger(msg.replyTo) && msg.replyTo > 0 && msg.replyTo < entry.id) {
    entry.replyTo = msg.replyTo;
    if (msg.refer === true) entry.refer = true; // 답장이 아니라 참고로만 붙인 인용
    if (typeof msg.replyQuote === 'string' && msg.replyQuote.trim()) entry.replyQuote = msg.replyQuote.trim().slice(0, 500); // 원문 중 사용자가 고른 부분만 인용
  }
  if (msg.interject === true && entry.from === 'user') entry.interject = true;
  if (Number.isInteger(msg.resendOf) && msg.resendOf > 0 && msg.resendOf < entry.id) entry.resendOf = msg.resendOf;
  chat.messages.push(entry);
  fs.writeFileSync(chatFile, JSON.stringify(chat, null, 2) + '\n');
  const target = entry.from === 'user' && entry.to ? findSession(entry.to) : null;
  if (target?.tool === 'codex' && !msg.noQueue) { queueToCodex(target, entry); markDelivered(target.sessionId, entry.id); } // noQueue: 서버가 따로 넣는 글(리뷰 완료)이 있어 두 번 넣지 않는다
  // 사용자가 터미널이나 화면에서 그 세션에 말을 걸었다면 그때까지의 답은 읽은 것이다.
  // 세션이 답하면 알림을 켠 기기들에 알린다.
  if (entry.from === 'agent' && entry.session) {
    const name = findSession(entry.session)?.name || '세션';
    pushAll({ title: `${name} 답장`, body: plainBody(entry.text), tag: `uifb-${entry.session}` }, 'answer');
  }
  const talkedTo = entry.from === 'user' ? entry.session || entry.to : null;
  if (talkedTo) markSeen({ [talkedTo]: entry.at });
  return entry;
}

// ── 읽음 상태 ──
// 세션마다 사용자가 마지막으로 읽은 답의 시각. 앱 화면(4798)과 리뷰 페이지(4799)는 주소가 달라 브라우저 저장소를 함께 못 쓰므로 서버에 둔다.
// 세션이 받아 간 마지막 메시지 번호. Claude 는 대화 감시(wait-review)가 메시지를 넘길 때, Codex 는 codex queue 에 넣을 때 적는다.
const deliveredFile = path.join(root, 'delivered.json');
function readDelivered() {
  try { return JSON.parse(fs.readFileSync(deliveredFile, 'utf8')); } catch { return {}; }
}
function markDelivered(id, msgId) {
  const d = readDelivered();
  if (!(d[id] >= msgId)) fs.writeFileSync(deliveredFile, JSON.stringify({ ...d, [id]: msgId, _at: { ...(d._at || {}), [msgId]: new Date().toISOString() } }, null, 2) + '\n');
}

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
  // 보관함에서 접어 둔 분류와 "최근 보낸 것·지운 것"을 펼쳤는지(세션마다, 두 화면 공용)
  if (req.fold && sid(req.fold.session)) {
    const labels = Array.isArray(req.fold.labels) ? req.fold.labels.filter((x) => typeof x === 'string').map((x) => x.slice(0, 30)).slice(0, 50) : [];
    prefs.fold = { ...(prefs.fold || {}), [req.fold.session]: { labels, trash: req.fold.trash === true } };
  }
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

// trash: 보낸 것·지운 것을 7일 동안 남겨 두어, 보관함에서 확인하고 다시 담을 수 있게 한다.
const TRASH_DAYS = 7;
function readDrafts() {
  let store;
  try {
    store = JSON.parse(fs.readFileSync(draftsFile, 'utf8'));
  } catch {
    store = { nextId: 1, drafts: [] };
  }
  store.trash = (store.trash || []).filter((d) => Date.now() - Date.parse(d.goneAt) < TRASH_DAYS * 86_400_000);
  return store;
}
const toTrash = (store, list, gone, extra = {}) => {
  const now = new Date().toISOString();
  store.trash.push(...list.map((d) => ({ ...d, gone, goneAt: now, ...(extra[d.id] || {}) })));
};

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
  if (d.round || d.device) lines.push(`(${[d.round ? `${d.round}차 비교 페이지를 보다가` : '', d.device === 'mobile' ? '모바일에서' : d.device === 'desktop' ? '데스크톱에서' : ''].filter(Boolean).join(' ')} 남김)`);
  return lines.join('\n');
}

// 고른 항목을 받는 세션별로 묶어 보낸다. combine 이면 세션마다 번호 매긴 메시지 하나, 아니면 하나씩.
// device: 보내기를 누른 화면(대화 라벨에 붙음). 항목마다 담은 화면은 본문에 "(모바일에서 남김)"으로 남는다.
// 보류에서 보내기: 보관함 형식(분류·위치 덧붙임) 없이 처음 쓴 그대로 보낸다. 보낸 것은 7일 기록에 남긴다.
function sendPlain(ids, device, interject) {
  const store = readDrafts();
  const picked = store.drafts.filter((d) => ids.includes(d.id));
  const sent = picked.map((d) => addChat({ from: 'user', to: d.to, text: d.text, where: d.where, context: d.context, round: d.round, device: device || d.device, interject })).filter(Boolean);
  toTrash(store, picked, 'sent', Object.fromEntries(picked.map((d, i) => [d.id, { msgId: sent[i]?.id }])));
  store.drafts = store.drafts.filter((d) => !ids.includes(d.id));
  writeDrafts(store);
  return sent;
}

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
      sent.push(addChat({ from: 'user', to, draft: { label, items: list }, device, context: list.every((d) => d.context === 'review') ? 'review' : 'app' }));
    } else {
      for (const d of list) sent.push(addChat({ from: 'user', to, draft: { label, items: [d] }, context: d.context, round: d.round, where: d.where, device: device || d.device }));
    }
  }
  // 보낸 항목은 어느 메시지로 갔는지(msgId)와 함께 7일 동안 남긴다.
  const msgOf = {};
  for (const e of sent.filter(Boolean)) for (const it of e.draft?.items || []) if (it.id) msgOf[it.id] = { msgId: e.id };
  toTrash(store, picked, 'sent', msgOf);
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
    const cid = typeof req.cid === 'string' ? req.cid.slice(0, 80) : null;
    const dup = cid && [...store.drafts, ...store.trash].find((x) => x.cid === cid);
    if (dup) return { status: 200, body: dup };
    const d = { id: store.nextId++, to: req.to, text, label: cleanLabel(req.label), device: req.device === 'mobile' ? 'mobile' : req.device === 'desktop' ? 'desktop' : null, context: req.context === 'review' ? 'review' : 'app', round: Number(req.round) || null, where: cleanWhere(req.where), commit: currentCommit(), at: new Date().toISOString(), ...(req.hold === true ? { hold: true } : {}), ...(Number.isInteger(req.fromMsg) ? { fromMsg: req.fromMsg } : {}), ...(cid ? { cid } : {}) };
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
    // 보류(대화창 맨 아래에 잠깐 대기) ↔ 보관함(완전 나중)
    if ('hold' in req) { if (req.hold === true) d.hold = true; else delete d.hold; }
    if (req.where !== undefined) {
      d.where = cleanWhere(req.where);
      d.commit = currentCommit();
      d.at = new Date().toISOString();
    }
    writeDrafts(store);
    return { status: 200, body: d };
  }
  if (req.action === 'delete') {
    toTrash(store, store.drafts.filter((d) => ids.includes(d.id)), 'deleted');
    store.drafts = store.drafts.filter((d) => !ids.includes(d.id));
    writeDrafts(store);
    return { status: 200, body: { ok: true } };
  }
  // 보낸 것·지운 것을 보관함으로 되돌린다.
  if (req.action === 'restore') {
    const back = store.trash.filter((d) => ids.includes(d.id));
    store.trash = store.trash.filter((d) => !ids.includes(d.id));
    store.drafts.push(...back.map(({ gone, goneAt, msgId, ...d }) => d));
    writeDrafts(store);
    return { status: 200, body: { ok: true, restored: back.length } };
  }
  if (req.action === 'send') {
    if (!ids.length) return { status: 400, body: { error: '보낼 항목(ids)이 필요합니다.' } };
    const device = req.device === 'mobile' || req.device === 'desktop' ? req.device : null;
    if (req.plain === true) return { status: 200, body: { sent: sendPlain(ids, device, req.interject === true) } };
    return { status: 200, body: { sent: sendDrafts(ids, req.combine !== false, device) } };
  }
  return { status: 400, body: { error: 'action은 add·update·delete·restore·send 중 하나입니다.' } };
}

const QUEUE_PREFIX = '[대화/피드백 · ';

// 페이지 메시지를 실행 중인 Codex 세션에 넣는다. 쉬고 있으면 바로 새 턴이 시작되고, 작업 중이면 그 턴이 끝난 뒤 처리된다.
// 메시지는 인자나 환경 변수로만 넘겨 셸이 해석하지 않게 한다(Windows는 codex.cmd 라서 PowerShell 로 부른다).
function queueToCodex(session, entry) {
  const where = entry.where?.url || entry.where?.selector
    ? `\n위치: ${entry.where.url || ''}${entry.where.selector ? ' · ' + entry.where.selector : ''}${entry.where.text ? ' · "' + entry.where.text + '"' : ''}`
    : '';
  const src = (entry.context === 'app' ? '앱 화면' : '비교 페이지') + (entry.device === 'mobile' ? ' · 모바일' : entry.device === 'desktop' ? ' · 데스크톱' : '');
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
    // 서비스 워커는 /__uifb/ 아래 있지만 페이지 전체(/)를 맡게 한다(화면 요청은 가로채지 않고 알림만 띄운다).
    res.writeHead(200, { 'Content-Type': type, 'Cache-Control': 'no-store', ...(file === 'sw.js' ? { 'Service-Worker-Allowed': '/' } : {}) });
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
        // 다른 세션에 메시지를 보내는 중이면(peer) 받는 세션을 함께 적어, 대화창이 세션 탭 사이에 화살표를 그린다.
        const to = s.peer ? readPeers()[peerName(s.peer)] : undefined;
        const prev = readStatus(s.session);
        notifyStatus(s, prev);
        fs.writeFileSync(path.join(root, `status-${s.session}.json`), JSON.stringify({ state: s.state, detail: String(s.detail || '').slice(0, 120), at: new Date().toISOString(), ...(s.peer ? { peer: peerName(s.peer) } : {}), ...(to ? { peerTo: to } : {}) }) + '\n');
        send(res, 200, { ok: true });
      } catch {
        send(res, 400, { error: 'session, state(working|permission|idle)가 필요합니다.' });
      }
    });
    return;
  }

  // 홈 화면에 앱처럼 설치하기 위한 정보. start 는 설치한 화면의 주소(앱 화면이면 /worklog 등).
  if (url.pathname === '/__uifb/manifest.webmanifest') {
    const start = /^\/[\w\-./]*$/.test(url.searchParams.get('start') || '') ? url.searchParams.get('start') : '/';
    const startUrl = start + (auth.key ? `?k=${auth.key}` : '');
    return send(res, 200, { name: '대화/피드백', short_name: '대화', start_url: startUrl, scope: '/', display: 'standalone', background_color: '#f6f5f1', theme_color: '#4f46e5', icons: [192, 512].map((n) => ({ src: `/__uifb/icon-${n}.png`, sizes: `${n}x${n}`, type: 'image/png' })) });
  }

  // 알림(웹 푸시): 공개 키 주기, 기기 구독 받기·빼기, 시험 보내기
  // 대화창 위젯 파일이 바뀌었는지(고친 시각). 홈 화면 앱처럼 새로고침이 없는 곳에서 새 버전을 알려 주는 데 쓴다.
  if (url.pathname === '/api/widget-version') return send(res, 200, { v: fs.statSync(path.join(assetsDir, 'app-widget.js')).mtimeMs });
  if (url.pathname === '/api/push-key') return send(res, 200, { publicKey: vapidKeys(root).publicKey });
  if ((url.pathname === '/api/push-subscribe' || url.pathname === '/api/push-unsubscribe' || url.pathname === '/api/push-test' || url.pathname === '/api/push-prefs' || url.pathname === '/api/push-viewing') && req.method === 'POST') {
    let body = '';
    req.on('data', (chunk) => {
      body += chunk;
      if (body.length > MAX_BODY) req.destroy();
    });
    req.on('end', async () => {
      let b = {};
      try { b = JSON.parse(body); } catch {}
      const subs = readSubs();
      if (url.pathname === '/api/push-test') {
        const n = await pushAll({ title: '대화/피드백', body: '알림이 잘 옵니다.', tag: 'uifb-test' });
        return send(res, 200, { sent: n });
      }
      const ep = b.subscription?.endpoint || b.endpoint;
      if (typeof ep !== 'string' || !/^https:\/\//.test(ep)) return send(res, 400, { error: 'endpoint 가 필요합니다.' });
      // 이 기기의 알림 설정 읽기·바꾸기, 이 기기에서 대화창을 보고 있다는 신호
      const me = subs.find((x) => x.endpoint === ep);
      if (url.pathname === '/api/push-prefs') {
        if (!me) return send(res, 404, { error: '알림을 켠 기기가 아닙니다.' });
        if (b.prefs && typeof b.prefs === 'object') me.prefs = Object.fromEntries(Object.keys(PUSH_DEFAULTS).map((k) => [k, k in b.prefs ? b.prefs[k] === true : prefsOf(me)[k]]));
        writeSubs(subs);
        return send(res, 200, { prefs: prefsOf(me) });
      }
      if (url.pathname === '/api/push-viewing') {
        if (me) { if (b.off === true) delete me.viewingAt; else me.viewingAt = new Date().toISOString(); writeSubs(subs); }
        return send(res, 200, { ok: true });
      }
      const rest = subs.filter((s) => s.endpoint !== ep);
      if (url.pathname === '/api/push-subscribe') {
        const k = b.subscription?.keys;
        if (!k?.p256dh || !k?.auth) return send(res, 400, { error: 'keys 가 필요합니다.' });
        rest.push({ endpoint: ep, keys: { p256dh: String(k.p256dh), auth: String(k.auth) }, url: typeof b.url === 'string' && b.url.startsWith('/') ? b.url.slice(0, 200) : '/', device: b.device === 'mobile' ? 'mobile' : 'desktop', at: new Date().toISOString() });
      }
      writeSubs(rest);
      send(res, 200, { ok: true, count: rest.length });
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

  // 진단 기록: 폰에서만 생기는 문제(초점이 엉뚱한 곳으로 가는 등)를 원인까지 보려고, 위젯이 그 순간 전후의 터치·초점 순서를 남긴다.
  if (url.pathname === '/api/diag' && req.method === 'POST') {
    let body = '';
    req.on('data', (chunk) => {
      body += chunk;
      if (body.length > MAX_BODY) req.destroy();
    });
    req.on('end', () => {
      try {
        const file = path.join(root, 'diag.jsonl');
        if (!fs.existsSync(file) || fs.statSync(file).size < 500_000) fs.appendFileSync(file, JSON.stringify({ at: new Date().toISOString(), ...JSON.parse(body) }) + '\n');
        send(res, 200, { ok: true });
      } catch {
        send(res, 400, { error: 'JSON 형식이 아닙니다.' });
      }
    });
    return;
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
    if (req.method === 'GET') { const st = readDrafts(); return send(res, 200, { drafts: st.drafts, trash: st.trash }); }
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

  // 보내기 취소: 세션이 아직 받아 가지 않은 내 메시지만 취소된다(받아 간 뒤에는 되돌릴 수 없다).
  if (url.pathname === '/api/chat-cancel' && req.method === 'POST') {
    let body = '';
    req.on('data', (chunk) => {
      body += chunk;
      if (body.length > MAX_BODY) req.destroy();
    });
    req.on('end', () => {
      let id;
      try { id = Number(JSON.parse(body).id); } catch {}
      const chat = readChat();
      const m = chat.messages.find((x) => x.id === id);
      const d = readDelivered();
      if (!m || m.from !== 'user' || !m.to || m.context === 'terminal') return send(res, 400, { error: '취소할 수 없는 메시지입니다.' });
      if (m.id <= (d[m.to] || 0) || d._at?.[m.id] || findSession(m.to)?.tool === 'codex') return send(res, 409, { error: '세션이 이미 받아 가서 취소할 수 없습니다.' });
      m.cancelled = new Date().toISOString();
      fs.writeFileSync(chatFile, JSON.stringify(chat, null, 2) + '\n');
      send(res, 200, { ok: true });
    });
    return;
  }

  // 이미 보낸(아직 안 받아 간) 메시지를 끼워넣기로 바꾸거나 끼워넣기를 취소한다.
  if (url.pathname === '/api/chat-interject' && req.method === 'POST') {
    let body = '';
    req.on('data', (chunk) => {
      body += chunk;
      if (body.length > MAX_BODY) req.destroy();
    });
    req.on('end', () => {
      let id, on;
      try { ({ id, on } = JSON.parse(body)); } catch {}
      const chat = readChat();
      const m = chat.messages.find((x) => x.id === Number(id));
      const d = readDelivered();
      if (!m || m.from !== 'user' || !m.to || m.cancelled || m.context === 'terminal') return send(res, 400, { error: '바꿀 수 없는 메시지입니다.' });
      if (d._at?.[m.id] || findSession(m.to)?.tool === 'codex') return send(res, 409, { error: '세션이 이미 받아 갔습니다.' });
      if (on === true) m.interject = true;
      else delete m.interject;
      fs.writeFileSync(chatFile, JSON.stringify(chat, null, 2) + '\n');
      send(res, 200, { ok: true });
    });
    return;
  }

  if (url.pathname === '/api/chat') {
    if (req.method === 'GET') return send(res, 200, { ...readChat(), delivered: readDelivered() });
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
        if (!entry) return send(res, 400, { error: 'from(user|agent|peer)과 text가 필요합니다.' });
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
        // 완료한 평가를 대화에도 남긴다. 어느 페이지(라운드 리뷰든 비교 페이지든)에서 평가했는지와 상관없이 대화창에서 보이고, 그 세션의 대화 감시가 받는다.
        if (newlyDone && reviewer) addChat({ from: 'user', to: reviewer.sessionId, context: 'review', round, noQueue: true, text: feedbackSummary(data, round, typeof patch.name === 'string' ? patch.name : '') });
        if (reviewer?.tool === 'codex') {
          queueText(reviewer, `${QUEUE_PREFIX}비교 페이지 · ${round}차] 피드백 확인해. 사용자가 ${round}차 비교 페이지에서 평가 완료를 표시했습니다. .ui-feedback/r${round}.json 을 읽고 ui-feedback-loop 5단계대로 반영하세요.`);
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
  console.log(`비교 페이지: http://localhost:${port}/`);
  for (const u of auth.urls(port)) console.log(`다른 기기(폰)에서: ${u}`);
  console.log(`평가 저장 위치: ${root}${path.sep}r<round>.json`);
});
