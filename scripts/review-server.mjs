#!/usr/bin/env node
// UI 피드백 리뷰 서버. 의존성 없음 (Node 18+).
// 사용: node review-server.mjs [--dir .ui-feedback] [--port 4799]
//   <dir>/review.html 과 캡처 이미지를 정적으로 제공하고,
//   페이지가 보낸 평가를 <dir>/r<round>.json 에, 대화를 <dir>/chat.json 에 저장한다.
//   세션별 대화: 등록된 세션(<dir>/sessions/)을 /api/sessions 로 알려 주고, 메시지는 to(받는 세션)·session(보낸 세션)으로 나눈다.

import http from 'node:http';
import fs from 'node:fs';
import path from 'node:path';

function arg(name, fallback) {
  const i = process.argv.indexOf(`--${name}`);
  return i !== -1 && process.argv[i + 1] ? process.argv[i + 1] : fallback;
}

const root = path.resolve(arg('dir', '.ui-feedback'));
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
  return /^\d{1,3}$/.test(round) ? path.join(root, `r${round}.json`) : null;
}

function readFeedback(file, round) {
  try {
    return JSON.parse(fs.readFileSync(file, 'utf8'));
  } catch {
    return { round: Number(round), items: {}, overall: '', done: false };
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
    .map((s) => ({ id: s.sessionId, name: s.name, tool: s.tool, agent: s.agent, watch: readWatchFile(`watch-${s.sessionId}.json`) }));
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
    if (!text || (p.role === 'user' && (text.startsWith('<') || text.includes('AGENTS.md instructions')))) continue;
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
    if (Date.parse(watch.expiresAt) < Date.now()) return { active: false };
    process.kill(watch.pid, 0);
    return { active: true, agent: watch.agent, session: watch.session, handlesDone: !!watch.handlesDone, round: watch.round, expiresAt: watch.expiresAt };
  } catch {
    return { active: false };
  }
}

// 리뷰 완료 표시를 받아 반영할 감시(handlesDone)가 살아 있는지. 페이지 위쪽 "자동 이어가기" 표시에 쓴다.
function readReviewWatch() {
  let files = [];
  try {
    files = fs.readdirSync(root).filter((f) => /^watch-.+\.json$/.test(f));
  } catch {}
  const live = files.map(readWatchFile).filter((w) => w.active && w.handlesDone);
  return live[0] || { active: false };
}

const server = http.createServer((req, res) => {
  const url = new URL(req.url, 'http://localhost');

  if (url.pathname === '/favicon.ico') {
    res.writeHead(204);
    return res.end();
  }

  if (url.pathname === '/api/watch') {
    return send(res, 200, readReviewWatch());
  }

  if (url.pathname === '/api/sessions') {
    return send(res, 200, { sessions: listSessions() });
  }

  if (url.pathname === '/api/transcript') {
    return send(res, 200, readTranscript(url.searchParams.get('session') || ''));
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
        const text = typeof msg.text === 'string' ? msg.text.trim().slice(0, 4000) : '';
        if (!text || !['user', 'agent'].includes(msg.from)) {
          return send(res, 400, { error: 'from(user|agent)과 text가 필요합니다.' });
        }
        const chat = readChat();
        const entry = { id: chat.messages.length + 1, from: msg.from, text, round: Number(msg.round) || null, at: new Date().toISOString() };
        if (msg.from === 'agent' && typeof msg.agent === 'string') entry.agent = msg.agent.slice(0, 40);
        // 사용자 메시지는 받을 세션(to), 에이전트 답과 터미널 입력은 그 세션(session)을 적는다.
        const sid = (v) => (typeof v === 'string' && /^[\w.-]{1,80}$/.test(v) ? v : undefined);
        if (sid(msg.to)) entry.to = msg.to;
        if (sid(msg.session)) entry.session = msg.session;
        if (typeof msg.context === 'string') entry.context = msg.context.slice(0, 20);
        if (msg.where && typeof msg.where === 'object') {
          const w = msg.where;
          const str = (v, n) => (typeof v === 'string' ? v.slice(0, n) : undefined);
          const num = (o) => (o && typeof o === 'object' ? Object.fromEntries(Object.entries(o).filter(([, v]) => Number.isFinite(v)).slice(0, 4)) : undefined);
          entry.where = { url: str(w.url, 300), selector: str(w.selector, 300), text: str(w.text, 120), rect: num(w.rect), viewport: num(w.viewport) };
        }
        chat.messages.push(entry);
        fs.writeFileSync(chatFile, JSON.stringify(chat, null, 2) + '\n');
        send(res, 200, entry);
      });
      return;
    }
    return send(res, 405, { error: 'GET 또는 POST만 됩니다.' });
  }

  if (url.pathname === '/api/feedback') {
    const round = url.searchParams.get('round') ?? '';
    const file = feedbackFile(round);
    if (!file) return send(res, 400, { error: 'round 는 숫자여야 합니다.' });

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
        if (patch.done === true) data.done = true;
        data.updatedAt = new Date().toISOString();
        fs.writeFileSync(file, JSON.stringify(data, null, 2) + '\n');
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

server.listen(port, '127.0.0.1', () => {
  console.log(`리뷰 페이지: http://localhost:${port}/`);
  console.log(`평가 저장 위치: ${root}${path.sep}r<round>.json`);
});
