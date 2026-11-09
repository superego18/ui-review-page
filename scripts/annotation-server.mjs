#!/usr/bin/env node
import http from 'node:http';
import path from 'node:path';
import { createAnnotationHandler } from './annotation-handler.mjs';

const arg = (key, fallback) => { const i = process.argv.indexOf(`--${key}`); return i < 0 ? fallback : process.argv[i + 1]; };
const root = path.resolve(arg('dir', '.ui-feedback'));
const port = Number(arg('port', '4797'));
const handler = createAnnotationHandler({ root, allowedOrigin: arg('origin', undefined) });
const server = http.createServer((req, res) => {
  if (!handler.handle(req, res, new URL(req.url, `http://${req.headers.host}`))) { res.writeHead(404); res.end(); }
});
server.on('error', (error) => { process.stderr.write(error.message + '\n'); process.exitCode = 1; });
server.listen(port, '127.0.0.1', () => process.stdout.write(`영역 피드백: http://127.0.0.1:${port} · 저장: ${root}\n`));
