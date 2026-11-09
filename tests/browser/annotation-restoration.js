// Browser regression: evaluate this function on an app exposing /__uifb-feedback.
async () => {
  const { createPanel } = await import('/__uifb-feedback/panel.js');
  const key = '__uifb_annotation_draft:' + location.origin;
  const previous = localStorage.getItem(key);
  const active = document.activeElement;
  const host = document.createElement('div'); document.body.append(host);
  const root = host.attachShadow({ mode: 'open' });
  let panel;
  const assert = (value, message) => { if (!value) throw new Error(message); };
  const mount = () => createPanel({ root, base: '/__uifb-feedback', title: () => '검증', onPick() {}, onSave() {}, onDelete() {}, onPreview() {} });
  try {
    for (const text of ['', '동작확인용: 작성 중인 메모']) {
      panel = mount();
      root.querySelector('#memo').click();
      root.querySelector('#text').value = text;
      root.querySelector('#text').dispatchEvent(new Event('input'));
      root.querySelector('#close').click();
      panel.destroy();
      const focus = document.activeElement;
      panel = mount(); panel.restore();
      assert(root.querySelector('.panel').hidden, 'FAIL: 화면 재진입 시 닫은 새 피드백 창이 자동으로 열림');
      assert(document.activeElement === focus, 'FAIL: 복원이 화면의 입력 초점을 빼앗음');
      root.querySelector('#open').click();
      assert(!root.querySelector('.panel').hidden, 'FAIL: 명시적으로 열 수 없음');
      assert(root.querySelector('#text').value === text, 'FAIL: 작성 중 메모가 사라짐');
      assert(root.activeElement === root.querySelector('#text'), 'FAIL: 열었을 때 본문에 초점이 없음');
      panel.destroy(); panel = null;
    }
    return { passed: true, cases: ['빈 메모', '작성 중 메모', '닫힌 상태 복원', '초점 유지', '명시적 열기'] };
  } finally {
    panel?.destroy(); host.remove();
    if (previous === null) localStorage.removeItem(key); else localStorage.setItem(key, previous);
    active?.focus();
  }
}
