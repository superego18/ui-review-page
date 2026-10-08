#!/usr/bin/env node
// 오래된 캡처 이미지와 예전 방식 캡처 스크립트를 정리한다. 의존성 없음 (Node 18+).
// 사용: node prune-captures.mjs [--dir .ui-feedback] [--keep 5] [--apply]
//   기본은 지울 목록만 보여 준다. 사용자에게 보여 주고 확인을 받은 뒤 --apply 로 지운다.
//   남기는 것: 최근 --keep 개 차수의 이미지, 지금 리뷰 페이지(review.html)가 쓰는 이미지, 차수를 알 수 없는 이미지.
//   지우는 것: 그보다 오래된 차수의 이미지(파일 이름의 r<차수> 또는 캡처 기록의 차수 기준)와 그 캡처 기록,
//             레시피 이전 방식으로 화면마다 복사해 둔 캡처 스크립트(cap*.js). 레시피(captures/)는 지우지 않는다.

import fs from 'node:fs';
import path from 'node:path';

function arg(name, fallback) {
  const i = process.argv.indexOf(`--${name}`);
  return i !== -1 && process.argv[i + 1] ? process.argv[i + 1] : fallback;
}

const dir = path.resolve(arg('dir', '.ui-feedback'));
const keep = Math.max(1, Number(arg('keep', '5')) || 5);
const apply = process.argv.includes('--apply');

const dbFile = path.join(dir, 'captures.json');
let db = { shots: {} };
try { db = JSON.parse(fs.readFileSync(dbFile, 'utf8')); } catch {}
const review = (() => { try { return fs.readFileSync(path.join(dir, 'review.html'), 'utf8'); } catch { return ''; } })();
const inReview = new Set(review.match(/[\w가-힣.-]+\.png/g) || []);

const files = fs.readdirSync(dir);
const roundOf = (f) => db.shots[f]?.round ?? (Number((f.match(/(?:^|[-_])r(\d+)(?=[-_.])/) || [])[1]) || null);
const rounds = files.filter((f) => f.endsWith('.png')).map(roundOf).filter(Boolean);
const latest = rounds.length ? Math.max(...rounds) : 0;
const oldest = latest - keep + 1;

const remove = [];
for (const f of files) {
  if (f.endsWith('.png')) {
    const r = roundOf(f);
    if (r && r < oldest && !inReview.has(f)) remove.push(f);
  } else if (/^cap.*\.js$/.test(f)) {
    remove.push(f);
  }
}

const size = remove.reduce((n, f) => n + fs.statSync(path.join(dir, f)).size, 0);
console.log(`최근 차수 ${latest}, ${oldest}차부터 남김. 지울 파일 ${remove.length}개 (${(size / 1048576).toFixed(1)}MB)${apply ? '' : ' — 목록만 보여 줌(--apply 로 지움)'}`);
for (const f of remove) console.log('  ' + f);

if (apply) {
  for (const f of remove) {
    fs.rmSync(path.join(dir, f));
    delete db.shots[f];
  }
  fs.writeFileSync(dbFile, JSON.stringify(db, null, 2) + '\n');
  console.log('지웠습니다.');
}
