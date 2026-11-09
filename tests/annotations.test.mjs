import assert from 'node:assert/strict';
import test from 'node:test';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import http from 'node:http';
import { createAnnotationStore, normalizeAnnotation } from '../scripts/annotation-store.mjs';
import { createAnnotationHandler } from '../scripts/annotation-handler.mjs';

const item = (extra = {}) => ({ url: 'http://127.0.0.1:13100/beta/ideas?s=combo&v=ribbon', title: '가로 띠 시안', kind: 'change', text: '이 부분을 더 넓게', ...extra });
function fixture(t) {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'uifb-annotations-'));
  t.after(() => fs.rmSync(root, { recursive: true, force: true }));
  return { root, store: createAnnotationStore(root) };
}

test('메모와 분류를 저장하고 새 인스턴스·정리본에서 다시 읽는다', (t) => {
  const { root, store } = fixture(t);
  const first = store.create(item());
  assert.equal(createAnnotationStore(root).read().items[0].text, first.text);
  assert.match(fs.readFileSync(path.join(root, 'annotations.md'), 'utf8'), /수정 요청.*가로 띠 시안/);
});

test('영역 피드백은 요소·좌표·화면 크기를 보존하고 메모가 없어도 저장한다', (t) => {
  const { store } = fixture(t);
  const where = { selector: '#table td', text: '12롤', component: 'LineTable', rect: { x: 12, y: 40, w: 60, h: 28 }, viewport: { w: 1440, h: 900 } };
  const saved = store.create(item({ kind: 'good', text: '', where }));
  assert.deepEqual(saved.where, where);
  assert.equal(saved.kind, 'good');
});

test('위치도 메모도 없는 기록과 잘못된 분류는 거부한다', () => {
  assert.throws(() => normalizeAnnotation(item({ text: '' })), /영역/);
  assert.throws(() => normalizeAnnotation(item({ kind: '__proto__' })), /분류/);
});

test('영역 이름·고정 식별자와 당시 값을 분리해 보존한다', (t) => {
  const { store, root } = fixture(t);
  const where = { selector: '[data-feedback-id="inspect:line:1:verdict"]', name: '줄 판단 패널 · 결론 요약', anchorId: 'inspect:line:1:verdict', exact: true, tag: 'div', text: '이대로는 어려워요', component: 'VerdictTop', rect: { x: 0, y: 0, w: 300, h: 100 }, viewport: { w: 1440, h: 900 } };
  const saved = store.create(item({ where }));
  assert.deepEqual(createAnnotationStore(root).read().items[0].where, where);
  const markdown = fs.readFileSync(path.join(root, 'annotations.md'), 'utf8');
  assert.match(markdown, /선택: 줄 판단 패널 · 결론 요약/);
  assert.match(markdown, /선택 당시 값: 이대로는 어려워요/);
  assert.equal(store.update(saved.id, { text: '내용 편집' }).where.anchorId, where.anchorId);
});

test('편집은 번호·생성시각·다른 기록을 유지한다', (t) => {
  const { store } = fixture(t);
  const a = store.create(item()), b = store.create(item({ text: '다른 메모' }));
  const changed = store.update(a.id, { text: '고친 메모', kind: 'question' });
  assert.equal(changed.number, a.number); assert.equal(changed.createdAt, a.createdAt);
  assert.equal(store.read().items.find((x) => x.id === b.id).text, '다른 메모');
});

test('삭제 후에도 번호를 재사용하지 않고 해당 캡처만 삭제한다', (t) => {
  const { store, root } = fixture(t);
  const a = store.create(item({ snapshot: 'data:image/png;base64,YWJj' }));
  assert(fs.existsSync(path.join(root, a.snapshot)));
  assert(store.remove(a.id)); assert(!fs.existsSync(path.join(root, a.snapshot)));
  assert.equal(store.create(item()).number, 2);
});

test('허용되지 않은 캡처 형식을 저장하지 않는다', (t) => {
  const { store } = fixture(t);
  assert.throws(() => store.create(item({ snapshot: 'data:image/svg+xml;base64,YWJj' })), /캡처/);
  assert.equal(store.read().items.length, 0);
});

test('요청 처리기는 대화창 없이 정적 모듈·저장·수정·삭제·내보내기를 제공한다', async (t) => {
  const { root } = fixture(t);
  const handler = createAnnotationHandler({ root, allowedOrigin: 'http://127.0.0.1:13100' });
  const server = http.createServer((req, res) => {
    if (!handler.handle(req, res, new URL(req.url, `http://${req.headers.host}`))) { res.writeHead(404); res.end(); }
  });
  await new Promise((resolve) => server.listen(0, '127.0.0.1', resolve));
  t.after(() => { server.closeAllConnections(); server.close(); });
  const base = `http://127.0.0.1:${server.address().port}/__uifb-feedback`;
  const post = (data, origin = 'http://127.0.0.1:13100') => fetch(base + '/api', { method: 'POST', headers: { 'Content-Type': 'application/json', Origin: origin }, body: JSON.stringify(data) });
  assert.equal((await fetch(base + '/client.js')).status, 200);
  assert.equal((await fetch(base + '/style.css')).headers.get('content-type'), 'text/css; charset=utf-8');
  assert.equal((await post({ action: 'create', item: item() }, 'https://example.com')).status, 403);
  const response = await post({ action: 'create', item: item() });
  const created = (await response.json()).item;
  assert.equal(response.status, 200);
  await post({ action: 'update', id: created.id, item: { text: '새 의견' } });
  assert.equal((await (await fetch(base + '/api')).json()).items[0].text, '새 의견');
  assert.match(await (await fetch(base + '/export')).text(), /새 의견/);
  await post({ action: 'delete', id: created.id });
  assert.equal((await (await fetch(base + '/api')).json()).items.length, 0);
  assert.equal((await fetch(base + '/images/../../secret')).status, 404);
});
