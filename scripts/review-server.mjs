#!/usr/bin/env node
// UI 피드백 리뷰 서버. 의존성 없음 (Node 18+).
// 사용: node review-server.mjs [--dir .ui-feedback] [--port 4799]
//   <dir>/review.html 과 캡처 이미지를 정적으로 제공하고,
//   페이지가 보낸 평가를 <dir>/r<round>.json 에 저장한다.

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

function readChat() {
  try {
    return JSON.parse(fs.readFileSync(chatFile, 'utf8'));
  } catch {
    return { messages: [] };
  }
}

function readWatch(round) {
  if (!/^\d{1,3}$/.test(round)) return { active: false };
  try {
    const watch = JSON.parse(fs.readFileSync(path.join(root, `watch-r${round}.json`), 'utf8'));
    if (Date.parse(watch.expiresAt) < Date.now()) return { active: false };
    process.kill(watch.pid, 0);
    return { active: true, agent: watch.agent, expiresAt: watch.expiresAt };
  } catch {
    return { active: false };
  }
}

const server = http.createServer((req, res) => {
  const url = new URL(req.url, 'http://localhost');

  if (url.pathname === '/favicon.ico') {
    res.writeHead(204);
    return res.end();
  }

  if (url.pathname === '/api/watch') {
    const round = url.searchParams.get('round');
    if (round) return send(res, 200, readWatch(round));
    const rounds = fs.readdirSync(root).map((f) => f.match(/^watch-r(\d+)\.json$/)?.[1]).filter(Boolean);
    return send(res, 200, rounds.map(readWatch).find((w) => w.active) || { active: false });
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
        entry.target = msg.target === 'skill' ? 'skill' : 'system';
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
