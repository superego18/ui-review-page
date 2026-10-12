#!/usr/bin/env node
// 예전 커밋의 앱을 따로 띄워, 비교 페이지에서 "전"도 실제 앱(자바스크립트 동작 포함)으로 보게 한다. 의존성 없음 (Node 18+).
// 사용: node live-app.mjs --commit <커밋> [--repo .] [--dir .ui-feedback] [--port 3011]
//                         [--cmd "npx next dev -p {port} --hostname 127.0.0.1"] [--copy data/admin.db,…]
//       node live-app.mjs --remove <커밋> [--repo .] [--dir .ui-feedback]
//   <dir>/worktrees/<커밋 앞 8자> 에 git worktree 를 만들고(이미 있으면 그대로), node_modules 를 복사해 넣고(macOS 는 APFS 복제라 빠르고 자리를 거의 안 씀),
//   --copy 로 준 파일(DB 등)을 지금 상태로 복사한 뒤 --cmd 를 그 폴더에서 실행한다. 이 명령은 끝나지 않으니 백그라운드로 돌린다.
//   DB 는 복사본이라 "전" 앱에서 고친 내용은 원래 DB 에 가지 않는다. 앱이 켜질 때 외부로 무언가 보내는 동작(자동 수집 등)이 있는지는 프로젝트에서 확인한다.
//   다른 기기에서 보려면 app-proxy.mjs --app http://localhost:<port> --port <프록시 포트> --no-widget --lan 으로 접속 키를 거치게 한다.

import fs from 'node:fs';
import path from 'node:path';
import { execFileSync, spawn } from 'node:child_process';

function arg(name, fallback) {
  const i = process.argv.indexOf(`--${name}`);
  return i !== -1 && process.argv[i + 1] ? process.argv[i + 1] : fallback;
}

const repo = path.resolve(arg('repo', '.'));
const dir = path.resolve(arg('dir', '.ui-feedback'));
const git = (...a) => execFileSync('git', ['-C', repo, ...a], { encoding: 'utf8' }).trim();

const removeRef = arg('remove', '');
const ref = removeRef || arg('commit', '');
if (!ref) {
  console.error('--commit <커밋> 이 필요합니다(지울 때는 --remove <커밋>).');
  process.exit(2);
}
const sha = git('rev-parse', '--verify', `${ref}^{commit}`);
const wt = path.join(dir, 'worktrees', sha.slice(0, 8));

if (removeRef) {
  git('worktree', 'remove', '--force', wt);
  console.log(`지움: ${wt}`);
  process.exit(0);
}

if (!fs.existsSync(wt)) {
  fs.mkdirSync(path.dirname(wt), { recursive: true });
  git('worktree', 'add', '--detach', wt, sha);
  console.log(`만듦: ${wt} (${sha.slice(0, 8)})`);
}
const nm = path.join(repo, 'node_modules');
if (fs.existsSync(nm) && !fs.existsSync(path.join(wt, 'node_modules'))) {
  console.log('node_modules 복사 중…');
  if (process.platform === 'darwin') execFileSync('cp', ['-cR', nm, path.join(wt, 'node_modules')]);
  else fs.cpSync(nm, path.join(wt, 'node_modules'), { recursive: true, verbatimSymlinks: true });
}
for (const rel of arg('copy', '').split(',').filter(Boolean)) {
  const from = path.join(repo, rel);
  if (!fs.existsSync(from)) {
    console.log(`복사 건너뜀(없음): ${rel}`);
    continue;
  }
  fs.mkdirSync(path.dirname(path.join(wt, rel)), { recursive: true });
  fs.copyFileSync(from, path.join(wt, rel));
  console.log(`복사: ${rel}`);
}

const port = arg('port', '3011');
const cmd = arg('cmd', 'npx next dev -p {port} --hostname 127.0.0.1').replaceAll('{port}', port);
console.log(`실행: ${cmd} (${wt})`);
const child = spawn(cmd, { cwd: wt, shell: true, stdio: 'inherit', env: { ...process.env, PORT: port } });
for (const sig of ['SIGINT', 'SIGTERM']) process.on(sig, () => child.kill(sig));
child.on('exit', (code) => process.exit(code ?? 0));
