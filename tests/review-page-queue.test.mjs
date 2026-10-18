import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import test from 'node:test';
import { runInNewContext } from 'node:vm';

const source = readFileSync(new URL('../assets/review-page.js', import.meta.url), 'utf8');

async function page(watch, { saved = {}, postOk = true } = {}) {
  const elements = new Map();
  const requests = [];
  let poll;
  let watchError = false;
  const element = (selector) => {
    if (!elements.has(selector)) {
      elements.set(selector, { textContent: '', dataset: {}, disabled: false, addEventListener() {} });
    }
    return elements.get(selector);
  };
  const context = {
    REVIEW: { items: [], round: 'isolated-test', session: 'test/session', name: 'Test', project: 'Test' },
    location: { hostname: 'localhost' },
    document: { title: 'Test', querySelector: element, querySelectorAll: () => [] },
    setInterval(fn, delay) { assert.equal(delay, 5000); poll = fn; },
    async fetch(url, options) {
      requests.push({ url, options });
      if (url.startsWith('/api/watch?')) {
        if (watchError) throw new Error('Mock watch unavailable');
        return { json: async () => watch };
      }
      assert.equal(url, '/api/feedback?round=isolated-test');
      if (options) {
        assert.equal(options.method, 'POST');
        return { ok: postOk, status: postOk ? 200 : 500 };
      }
      return { json: async () => saved };
    },
  };
  runInNewContext(source, context, { filename: 'review-page.js' });
  // Drain initial watch and saved-feedback reads without a server or real timers.
  await new Promise(setImmediate);
  return {
    element,
    requests,
    text(selector) { return element(selector).textContent; },
    async poll(next, fail = false) { watch = next; watchError = fail; await poll(); },
    done() { return element('#done').onclick(); },
    retryPosts() { postOk = true; },
  };
}

function assertQueueCopy(p) {
  assert.equal(p.text('#modeTitle'), '자동 전달 설정됨');
  assert.match(p.text('#modeSub'), /세션에 전달을 요청합니다/);
  assert.match(p.text('#modeSub'), /실제 세션 실행 여부/);
  const copy = ['#modeTitle', '#modeSub', '#doneNote'].map((selector) => p.text(selector)).join(' ');
  assert.doesNotMatch(copy, /큐|queue/i);
  assert.doesNotMatch(copy, /기다리는 중|바로 이어서|받아 작업|이어서 작업합니다|undefined/);
}

test('configured queue availability is generic and does not imply a running session', async () => {
  for (const agent of ['Codex', 'Another agent', undefined]) {
    const p = await page({ active: true, configured: true, via: 'queue', handlesDone: true, agent, expiresAt: '2030-01-01T12:00:00Z' });
    assert.equal(p.element('#mode').dataset.auto, 'on');
    assertQueueCopy(p);
    assert.equal(p.text('#doneNote'), '다 봤으면 완료를 누르세요. 세션에 전달을 요청합니다.');
    assert.equal(p.element('#done').disabled, false);
    assert.deepEqual(p.requests.map(({ url }) => url), [
      '/api/watch?round=isolated-test&session=test%2Fsession',
      '/api/feedback?round=isolated-test',
    ]);
  }
});

test('queue identity alone does not enable automatic continuation', async () => {
  for (const active of [false, undefined, 'true']) {
    const p = await page({ active, configured: active, via: 'queue', handlesDone: true, agent: 'Codex' });
    assert.equal(p.element('#mode').dataset.auto, 'off');
    assert.equal(p.text('#modeTitle'), '자동 이어가기 꺼짐');
    assert.match(p.text('#doneNote'), /터미널에 "피드백 확인해"/);
  }
});

test('real Claude watchers keep their waiting copy and expiration', async () => {
  for (const via of [undefined, 'chat']) {
    const expiresAt = '2030-01-01T12:00:00Z';
    const p = await page({ active: true, via, agent: 'Claude', expiresAt });
    const time = new Date(expiresAt).toLocaleTimeString('ko-KR', { hour: '2-digit', minute: '2-digit' });
    assert.equal(p.text('#modeTitle'), `자동 이어가기 켜짐 · Claude가 기다리는 중 (${time}까지)`);
    assert.equal(p.text('#modeSub'), '완료 표시만 누르면 바로 이어서 작업합니다. 터미널에 메시지를 보낼 필요가 없습니다.');
    assert.equal(p.text('#doneNote'), '다 봤으면 완료를 누르세요. 터미널 메시지는 필요 없습니다.');
  }
});

test('polling switches between queue, real watcher and unavailable states', async () => {
  const p = await page({ active: false });
  await p.poll({ active: true, configured: true, via: 'queue', handlesDone: true, agent: 'Codex' });
  assertQueueCopy(p);
  await p.poll({ active: true, via: 'chat', agent: 'Claude' });
  assert.equal(p.text('#modeTitle'), '자동 이어가기 켜짐 · Claude가 기다리는 중');
  await p.poll({ active: true, configured: true, via: 'queue', handlesDone: true, agent: 'Codex' });
  await p.poll({}, true);
  assert.equal(p.element('#mode').dataset.auto, 'off');
  assert.equal(p.text('#modeTitle'), '자동 이어가기 꺼짐');
});

test('queue completion saves the same payload without claiming execution', async () => {
  const p = await page({ active: true, configured: true, via: 'queue', handlesDone: true, agent: 'Codex' });
  await p.done();
  assert.equal(p.element('#done').disabled, true);
  assertQueueCopy(p);
  assert.equal(p.text('#doneNote'), '완료로 표시했습니다. 세션에 전달을 요청합니다. 실제 세션 실행 여부는 확인되지 않았습니다.');
  const posts = p.requests.filter(({ options }) => options);
  assert.equal(posts.length, 1);
  assert.deepEqual(JSON.parse(posts[0].options.body), { done: true, session: 'test/session', name: 'Test' });
  await p.poll({ active: true, configured: true, via: 'queue', handlesDone: true, agent: 'Codex' });
  assertQueueCopy(p);
});

test('real watcher completion keeps its existing copy and enabled-at-done behavior', async () => {
  const p = await page({ active: true, via: 'chat', agent: 'Claude' });
  await p.done();
  assert.equal(p.element('#done').disabled, true);
  assert.equal(p.text('#modeTitle'), '자동 이어가기 · Claude가 피드백을 받아 작업을 이어갑니다');
  assert.equal(p.text('#modeSub'), '터미널에 보낼 메시지는 없습니다.');
  assert.equal(p.text('#doneNote'), '완료로 표시했습니다. Claude가 이어서 작업합니다. 터미널에 보낼 메시지는 없습니다.');
  await p.poll({ active: false, agent: 'Claude' });
  assert.equal(p.element('#mode').dataset.auto, 'on');
});

test('manual completion keeps the terminal instruction', async () => {
  const p = await page({ active: false, configured: false, via: 'queue', handlesDone: true });
  await p.done();
  assert.equal(p.element('#done').disabled, true);
  assert.equal(p.text('#doneNote'), '완료로 표시했습니다. 이제 터미널에 "피드백 확인해"라고 보내 주세요.');
  await p.poll({ active: true, configured: true, via: 'queue', handlesDone: true });
  assert.equal(p.element('#mode').dataset.auto, 'off');
});

test('failed completion still re-enables the button and permits retry', async () => {
  const p = await page({ active: true, configured: true, via: 'queue', handlesDone: true }, { postOk: false });
  await p.done();
  assert.equal(p.element('#done').disabled, false);
  assert.equal(p.text('#doneNote'), '저장 실패 — 서버가 켜져 있는지 확인하세요.');
  p.retryPosts();
  await p.done();
  assert.equal(p.element('#done').disabled, true);
  assertQueueCopy(p);
});

test('previously saved completion stays disabled and does not submit again', async () => {
  const p = await page({ active: true, configured: true, via: 'queue', handlesDone: true }, { saved: { done: true } });
  assert.equal(p.element('#done').disabled, true);
  assert.equal(p.text('#doneNote'), '이미 완료로 표시된 비교 페이지입니다. 작업이 이어지지 않았다면 터미널에 "피드백 확인해"라고 보내 주세요.');
  await p.poll({ active: true, configured: true, via: 'queue', handlesDone: true });
  assert.equal(p.element('#done').disabled, true);
  assert.equal(p.requests.filter(({ options }) => options).length, 0);
});
