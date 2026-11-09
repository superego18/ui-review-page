export function pageKey(url) {
  const value = new URL(url, location.origin);
  value.searchParams.sort();
  return value.pathname + (value.search ? value.search : '');
}

// Adapted from agent-chat-widget's picker; storage uses selectors, not viewport coordinates.
export function selectorOf(element) {
  const anchor = element.closest('[data-feedback-id]');
  if (anchor) {
    const prefix = `[data-feedback-id="${CSS.escape(anchor.getAttribute('data-feedback-id'))}"]`;
    const parts = [];
    for (let node = element; node !== anchor; node = node.parentElement) {
      const siblings = [...node.parentElement.children].filter((x) => x.tagName === node.tagName);
      parts.unshift(node.tagName.toLowerCase() + (siblings.length > 1 ? `:nth-of-type(${siblings.indexOf(node) + 1})` : ''));
    }
    return [prefix, ...parts].join(' > ');
  }
  const parts = [];
  for (let node = element; node && node !== document.body && parts.length < 8; node = node.parentElement) {
    if (node.id && document.querySelectorAll('#' + CSS.escape(node.id)).length === 1) {
      parts.unshift('#' + CSS.escape(node.id)); break;
    }
    const name = node.tagName.toLowerCase();
    const siblings = [...(node.parentElement?.children ?? [])].filter((x) => x.tagName === node.tagName);
    const classes = [...node.classList].filter((x) => !x.includes(':') && x.length < 40).slice(0, 2);
    parts.unshift(name + classes.map((x) => '.' + CSS.escape(x)).join('') + (siblings.length > 1 ? `:nth-of-type(${siblings.indexOf(node) + 1})` : ''));
  }
  return parts.join(' > ');
}

const TAG_NAMES = { DIV: '영역', SPAN: '문구', P: '설명', BUTTON: '버튼', A: '링크', TD: '표 칸', TH: '표 머리글', SVG: '그림', PATH: '그림 요소', INPUT: '입력칸', SECTION: '구역' };
export function nameOf(element) {
  const own = element.getAttribute('data-feedback-name') || element.getAttribute('aria-label');
  if (own) return own;
  const names = [];
  for (let node = element.parentElement; node; node = node.parentElement) {
    const name = node.getAttribute('data-feedback-name');
    if (name) names.unshift(name);
  }
  names.push(TAG_NAMES[element.tagName.toUpperCase()] || element.tagName.toLowerCase());
  return names.slice(-3).join(' → ');
}

function textOf(element) {
  return (element.innerText || element.getAttribute('aria-label') || element.querySelector('title')?.textContent || '').trim().replace(/\s+/g, ' ').slice(0, 300);
}

function componentOf(element) {
  const key = Object.keys(element).find((x) => x.startsWith('__reactFiber$'));
  for (let fiber = key && element[key]; fiber; fiber = fiber.return) {
    const type = fiber.type?.render || fiber.type?.type || fiber.type;
    const name = typeof type === 'function' ? fiber.type.displayName || type.displayName || type.name : '';
    if (name && /^[A-Z]/.test(name)) return name;
  }
  return element.tagName.toLowerCase();
}

export function locate(element) {
  const rect = element.getBoundingClientRect();
  const anchor = element.closest('[data-feedback-id]');
  return {
    selector: selectorOf(element),
    name: nameOf(element), anchorId: anchor?.getAttribute('data-feedback-id') || '', exact: anchor === element,
    tag: element.tagName.toLowerCase(), text: textOf(element),
    component: componentOf(element), rect: { x: rect.left, y: rect.top, w: rect.width, h: rect.height },
    viewport: { w: innerWidth, h: innerHeight },
  };
}

export function resolve(item) {
  if (!item?.where?.selector || pageKey(item.url) !== pageKey(location.href)) return null;
  try {
    const where = item.where;
    if (where.anchorId && document.querySelectorAll(`[data-feedback-id="${CSS.escape(where.anchorId)}"]`).length !== 1) return null;
    const matches = document.querySelectorAll(where.selector);
    if (matches.length !== 1) return null;
    const element = matches[0];
    if (where.tag && element.tagName.toLowerCase() !== where.tag) return null;
    if (!where.exact && where.text && textOf(element) !== where.text) return null;
    return element;
  } catch { return null; }
}

export function labelFor(item) {
  return item.where?.name || item.where?.component || item.title || '화면 전체 의견';
}

export function locationInfo(item) {
  if (!item.where) return '위치 없는 전체 의견';
  const where = item.where;
  let text = where.anchorId && where.exact ? '고정 식별자 · 문구가 바뀌어도 같은 영역에 연결' : where.anchorId ? '이름 있는 영역 안의 요소 · 내부 구조 변경 시 재확인' : '화면 구조 기반 · 위치를 다시 찍으면 식별 정보를 갱신해요';
  if (pageKey(item.url) === pageKey(location.href) && !resolve(item)) text += ' · 현재 대상을 확인할 수 없어요';
  return text;
}
