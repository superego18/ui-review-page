import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { annotationMarkdown, createAnnotationStore } from './annotation-store.mjs';

export const ANNOTATION_PREFIX = '/__uifb-feedback';
const assets = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '../assets/annotations');
const FILES = new Set(['client.js', 'dom.js', 'picker.js', 'markers.js', 'panel.js', 'transport.js', 'style.css']);
function send(res, status, data, type = 'application/json; charset=utf-8') {
  res.writeHead(status, { 'Content-Type': type, 'Cache-Control': 'no-store', 'X-Content-Type-Options': 'nosniff' });
  res.end(typeof data === 'string' || Buffer.isBuffer(data) ? data : JSON.stringify(data));
}
async function body(req) {
  let size = 0, chunks = [];
  for await (const chunk of req) {
    size += chunk.length;
    if (size > 8 * 1024 * 1024) throw new Error('내용이 너무 큽니다.');
    chunks.push(chunk);
  }
  return JSON.parse(Buffer.concat(chunks).toString('utf8'));
}

export function createAnnotationHandler({ root, allowedOrigin }) {
  const store = createAnnotationStore(root);
  return {
    store,
    handle(req, res, url) {
      if (!url.pathname.startsWith(ANNOTATION_PREFIX + '/')) return false;
      const tail = url.pathname.slice(ANNOTATION_PREFIX.length + 1);
      if (req.method === 'GET' && FILES.has(tail)) {
        send(res, 200, fs.readFileSync(path.join(assets, tail)), tail.endsWith('.css') ? 'text/css; charset=utf-8' : 'text/javascript; charset=utf-8');
        return true;
      }
      if (req.method === 'GET' && /^images\/[a-f0-9-]{36}\.(png|jpg)$/.test(tail)) {
        const file = path.join(root, 'annotation-images', tail.slice('images/'.length));
        if (!fs.existsSync(file)) send(res, 404, { error: '캡처가 없습니다.' });
        else send(res, 200, fs.readFileSync(file), tail.endsWith('.png') ? 'image/png' : 'image/jpeg');
        return true;
      }
      if (req.method === 'GET' && tail === 'api') {
        send(res, 200, { items: store.read().items }); return true;
      }
      if (req.method === 'GET' && tail === 'export') {
        res.setHeader('Content-Disposition', 'attachment; filename="annotations.md"');
        send(res, 200, annotationMarkdown(store.read().items), 'text/markdown; charset=utf-8'); return true;
      }
      if (req.method !== 'POST' || tail !== 'api') { send(res, 404, { error: '없는 경로입니다.' }); return true; }
      const origin = req.headers.origin;
      const ownOrigin = `http://${req.headers.host}`;
      if ((origin && origin !== allowedOrigin && origin !== ownOrigin) || !req.headers['content-type']?.startsWith('application/json')) {
        send(res, 403, { error: '이 화면에서 저장하세요.' }); return true;
      }
      (async () => {
        try {
          const input = await body(req);
          let result;
          if (input.action === 'create') result = store.create(input.item ?? {});
          else if (input.action === 'update') result = store.update(input.id, input.item ?? {});
          else if (input.action === 'delete') result = store.remove(input.id);
          else throw new Error('지원하지 않는 동작입니다.');
          send(res, result ? 200 : 404, result ? { item: result, items: store.read().items } : { error: '피드백을 찾지 못했습니다.' });
        } catch (error) { send(res, 400, { error: error.message }); }
      })();
      return true;
    },
  };
}
