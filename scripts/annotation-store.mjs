import fs from 'node:fs';
import path from 'node:path';
import { randomUUID } from 'node:crypto';

export const KINDS = { note: '메모', good: '좋아요', change: '수정 요청', question: '질문' };
const text = (value, max) => typeof value === 'string' ? value.slice(0, max) : '';
const finite = (value) => Number.isFinite(value) ? value : 0;

export function normalizeAnnotation(input) {
  const kind = input.kind ?? 'note';
  if (!Object.hasOwn(KINDS, kind)) throw new Error('분류가 올바르지 않습니다.');
  const note = text(input.text, 8000).trim();
  const url = text(input.url, 3000);
  if (!url.startsWith('http://') && !url.startsWith('https://')) throw new Error('화면 주소가 필요합니다.');
  let where = null;
  if (input.where) {
    if (typeof input.where.selector !== 'string' || !input.where.selector) throw new Error('선택 위치가 올바르지 않습니다.');
    where = {
      selector: text(input.where.selector, 2000), text: text(input.where.text, 300), component: text(input.where.component, 120),
      ...(input.where.name !== undefined || input.where.anchorId !== undefined ? {
        name: text(input.where.name, 300), anchorId: text(input.where.anchorId, 500),
        exact: Boolean(input.where.anchorId && input.where.exact === true), tag: text(input.where.tag, 40),
      } : {}),
      rect: Object.fromEntries(['x', 'y', 'w', 'h'].map((k) => [k, finite(input.where.rect?.[k])])),
      viewport: { w: finite(input.where.viewport?.w), h: finite(input.where.viewport?.h) },
    };
  }
  if (!note && !where) throw new Error('영역을 선택하거나 메모를 입력하세요.');
  return { kind, text: note, url, title: text(input.title, 300), where };
}

export function annotationMarkdown(items) {
  const lines = ['# 시안 화면 피드백', '', `- 총 ${items.length}건`, ''];
  for (const item of items) {
    lines.push(`## ${item.number}. ${KINDS[item.kind]} · ${item.title || '화면'}`, '',
      `- 기록: ${item.createdAt}`, `- 화면: ${item.url}`);
    if (item.where) {
      lines.push(`- 선택: ${item.where.name || item.where.component || '영역'}`, `- 요소: \`${item.where.selector.replaceAll('`', '')}\``);
      if (item.where.anchorId) lines.push(`- 영역 식별자: ${item.where.anchorId} (${item.where.exact ? '고정 영역' : '내부 구조 기반'})`);
      if (item.where.text) lines.push(`- 선택 당시 값: ${item.where.text}`);
    }
    if (item.snapshot) lines.push(`- 캡처: ${item.snapshot}`);
    lines.push('', item.text || '(메모 없음)', '');
  }
  return lines.join('\n');
}

export function createAnnotationStore(root) {
  const file = path.join(root, 'annotations.json');
  const images = path.join(root, 'annotation-images');
  function read() {
    try { return JSON.parse(fs.readFileSync(file, 'utf8')); }
    catch (error) { if (error.code === 'ENOENT') return { version: 1, nextNumber: 1, items: [] }; throw error; }
  }
  function write(db) {
    fs.mkdirSync(root, { recursive: true });
    const temp = file + '.tmp';
    fs.writeFileSync(temp, JSON.stringify(db, null, 2) + '\n');
    fs.renameSync(temp, file);
    fs.writeFileSync(path.join(root, 'annotations.md'), annotationMarkdown(db.items));
    return db;
  }
  function snapshot(id, data) {
    if (!data) return null;
    const match = /^data:image\/(png|jpeg);base64,([A-Za-z0-9+/=]+)$/.exec(data);
    if (!match) throw new Error('캡처 형식이 올바르지 않습니다.');
    const bytes = Buffer.from(match[2], 'base64');
    if (bytes.length > 5 * 1024 * 1024) throw new Error('캡처는 5MB 이하로 저장하세요.');
    fs.mkdirSync(images, { recursive: true });
    const name = `${id}.${match[1] === 'jpeg' ? 'jpg' : 'png'}`;
    fs.writeFileSync(path.join(images, name), bytes);
    return `annotation-images/${name}`;
  }
  return {
    read,
    create(input) {
      const fields = normalizeAnnotation(input);
      const db = read(), id = randomUUID(), now = new Date().toISOString();
      const image = snapshot(id, input.snapshot);
      const item = { id, number: db.nextNumber++, ...fields, snapshot: image, createdAt: now, updatedAt: now };
      db.items.push(item); write(db); return item;
    },
    update(id, patch) {
      const db = read(), item = db.items.find((x) => x.id === id);
      if (!item) return null;
      Object.assign(item, normalizeAnnotation({ ...item, ...patch }), { updatedAt: new Date().toISOString() });
      if (typeof patch.snapshot === 'string' && patch.snapshot.startsWith('data:')) item.snapshot = snapshot(id, patch.snapshot);
      write(db); return item;
    },
    remove(id) {
      const db = read(), item = db.items.find((x) => x.id === id);
      if (!item) return false;
      db.items = db.items.filter((x) => x.id !== id); write(db);
      if (item.snapshot) fs.rmSync(path.join(root, item.snapshot), { force: true });
      return true;
    },
  };
}
