#!/usr/bin/env node
// 비교 페이지 서버를 혼자 띄운다. 의존성 없음 (Node 18+).
// 사용: node review-server.mjs [--dir .ui-feedback] [--port 4799]
//   <dir>/review.html 과 캡처 이미지를 내보내고, 페이지가 보낸 평가를 <dir>/r<round>.json 에 저장한다.
//   이 컴퓨터(localhost)에서만 열린다. 폰에서 보거나 대화창을 함께 쓰려면 agent-chat-widget 과 함께 붙인 서버를 쓴다.
import http from 'node:http';
import fs from 'node:fs';
import path from 'node:path';
import { createReviewHandler } from './review-handler.mjs';

const arg = (name, fallback) => { const i = process.argv.indexOf(`--${name}`); return i !== -1 && process.argv[i + 1] ? process.argv[i + 1] : fallback; };
const root = path.resolve(arg('dir', '.ui-feedback'));
const port = Number(arg('port', '4799'));
if (!fs.existsSync(path.join(root, 'review.html'))) {
  console.error(`review.html 이 없습니다: ${root}`);
  process.exit(1);
}
const review = createReviewHandler({ root });

const server = http.createServer((req, res) => review.handle(req, res, new URL(req.url, 'http://localhost')));
server.on('error', (err) => {
  console.error(err.code === 'EADDRINUSE' ? `포트 ${port} 이(가) 이미 쓰이고 있습니다. --port 로 바꾸세요.` : err.message);
  process.exit(1);
});
server.listen(port, '127.0.0.1', () => {
  console.log(`비교 페이지: http://localhost:${port}/`);
  console.log(`평가 저장 위치: ${root}${path.sep}r<round>.json`);
});
