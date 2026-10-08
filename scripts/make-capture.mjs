#!/usr/bin/env node
// 화면별 캡처 레시피로 이번에 실행할 캡처 스크립트(.ui-feedback/capture.js)를 만든다. 의존성 없음 (Node 18+).
// 사용: node make-capture.mjs --recipe <이름> --round <차수> [--dir .ui-feedback] [--base http://localhost:3001] [--port 4799]
//   레시피: <dir>/captures/<이름>.js. 화면마다 하나만 두고 고쳐 쓴다(차수마다 새로 만들지 않는다). 내용은 객체 하나다:
//     ({
//       url: '/worklog',                              // --base 기준 주소
//       viewport: { width: 1440, height: 900 },       // 모바일은 { width: 390, height: 844 }
//       selector: null,                               // 특정 영역만 찍으려면 CSS 선택자
//       marks: [{ n: 1, selector: '.summary' }],      // 번호 상자
//       mocks: [{ url: '**/api/items**', label: '목록 API', json: [...] }],   // 예시 응답. 복잡하면 handle: async (route) => …
//       steps: async (page) => { await page.click('text=열기'); },          // 찍기 전에 화면 상태 만들기
//     })
//   결과 파일: <dir>/capture.js(매번 덮어씀). 이미지: <dir>/r<차수>-<이름>.png
//   레시피 코드는 그대로 실행되므로 이 프로젝트에서 직접 쓴 레시피만 쓴다.

import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

function arg(name, fallback) {
  const i = process.argv.indexOf(`--${name}`);
  return i !== -1 && process.argv[i + 1] ? process.argv[i + 1] : fallback;
}

const dir = path.resolve(arg('dir', '.ui-feedback'));
const name = arg('recipe', '');
const round = Number(arg('round', ''));
const base = arg('base', 'http://localhost:3001');
const port = arg('port', '4799');

if (!/^[\w가-힣.-]{1,60}$/.test(name) || !Number.isInteger(round)) {
  console.error('--recipe <이름>(글자·숫자·-·.) 과 --round <차수> 가 필요합니다.');
  process.exit(2);
}
const recipeFile = path.join(dir, 'captures', `${name}.js`);
if (!fs.existsSync(recipeFile)) {
  console.error(`레시피가 없습니다: ${recipeFile}\n이 파일에 ({ url, viewport, selector, marks, mocks, steps }) 객체 하나를 적어 주세요.`);
  process.exit(2);
}
const recipe = fs.readFileSync(recipeFile, 'utf8').trim().replace(/;\s*$/, '');
const file = `r${round}-${name}.png`;
const meta = { out: path.join(dir, file), file, recipe: name, round, base, record: `http://localhost:${port}/api/captures` };

const template = fs.readFileSync(path.join(path.dirname(fileURLToPath(import.meta.url)), '..', 'assets', 'capture-2x.js'), 'utf8');
const out = template.replace('__RECIPE__', `(${recipe})`).replace('__META__', JSON.stringify(meta));
fs.writeFileSync(path.join(dir, 'capture.js'), out);
console.log(`만듦: ${path.join(dir, 'capture.js')} (레시피 ${name}, ${round}차 → ${file})`);
