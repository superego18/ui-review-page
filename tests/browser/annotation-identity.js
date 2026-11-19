// Evaluate on an app exposing /__uifb-feedback. No feedback records are written.
async () => {
  const { locate, resolve, labelFor, locationInfo } = await import('/__uifb-feedback/dom.js');
  const host = document.createElement('div');
  host.innerHTML = '<section data-feedback-id="regression:identity" data-feedback-name="결론 요약"><p>당시 값</p></section>';
  document.body.append(host);
  const assert = (value, message) => { if (!value) throw new Error(message); };
  try {
    const region = host.firstElementChild, child = region.firstElementChild;
    const item = { url: location.href, where: locate(region) };
    assert(item.where.exact && labelFor(item) === '결론 요약', '영역 이름과 고정 ID를 기록해야 함');
    region.append(document.createTextNode('값 변경'));
    const wrapper = document.createElement('div'); host.append(wrapper); wrapper.append(region);
    host.prepend(document.createElement('section'));
    assert(resolve(item) === region, '문구 변경·주변 구조 변경 후에도 같은 고정 영역이어야 함');
    const leaf = { url: location.href, where: locate(child) };
    assert(!leaf.where.exact && resolve(leaf) === child, '영역 안 요소를 전체 영역으로 바꾸면 안 됨');
    assert(locationInfo(leaf).includes('구조 변경 시 재확인'), '구조 기반 선택을 고정 영역으로 표시하면 안 됨');
    const moved = document.createElement('p'); moved.textContent = '다른 내용'; region.prepend(moved);
    assert(resolve(leaf) === null, '내부 구조가 바뀌면 엉뚱한 요소에 붙이면 안 됨');
    const duplicate = region.cloneNode(true); host.append(duplicate);
    assert(resolve(item) === null, '중복 식별자 중 하나를 임의로 고르면 안 됨');
    duplicate.remove(); region.remove();
    assert(resolve(item) === null, '고정 영역이 사라지면 다른 영역으로 대체하면 안 됨');
    const originalUrl = location.href;
    host.innerHTML = '<a data-feedback-id="regression:tab" data-feedback-scope="path" data-feedback-name="A 시안"><span>A</span> 시안</a><section data-feedback-id="regression:body">본문</section>';
    const tab = host.firstElementChild, body = host.lastElementChild;
    const tabItem = { url: originalUrl, where: locate(tab) };
    const tabChild = { url: originalUrl, where: locate(tab.firstElementChild) };
    const bodyItem = { url: originalUrl, where: locate(body) };
    try {
      const other = new URL(originalUrl); other.searchParams.set('v', 'regression-other');
      history.replaceState(history.state, '', other);
      assert(resolve(tabItem) === tab, '다른 시안에서도 공용 탭의 위치 표시가 유지되어야 함');
      assert(resolve(tabChild) === tab.firstElementChild, '탭 안 글자를 찍어도 다른 시안에서 유지되어야 함');
      assert(resolve(bodyItem) === null, '본문 위치는 다른 시안에 표시하면 안 됨');
      tab.removeAttribute('data-feedback-scope');
      assert(resolve(tabItem) === null, '현재 요소도 공용 범위를 명시해야 함');
      tab.setAttribute('data-feedback-scope', 'path');
      other.pathname += '/regression-other'; history.replaceState(history.state, '', other);
      assert(resolve(tabItem) === null, '다른 페이지에서는 같은 식별자로 표시하면 안 됨');
    } finally { history.replaceState(history.state, '', originalUrl); }
    return { passed: true, cases: ['이름·값 분리', '문구·순서 변경', '하위 요소 유지', '잘못된 연결 차단', '중복·삭제 감지', '시안 전환 후 탭 표시 유지', '본문·다른 페이지 격리'] };
  } finally { host.remove(); }
}
