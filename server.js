// server.js — 依存ゼロの静的ファイルサーバー + 対人戦のWebSocket。
// ローカル開発（npm start）と、Render の Web Service の両方で同じものを使う。
// ES Modules を配信するため、.js に正しい MIME を付けることだけが要件。
//
// 対人戦は /ws。GitHub Pages は静的配信しかできないので、対人戦を使うには
// このサーバーを動かす必要がある（Render なら Web Service 側）。

import { createServer } from 'node:http';
import { accept } from './net/ws.js';
import { handleConnection, stats } from './net/rooms.js';
import { createReadStream } from 'node:fs';
import { stat } from 'node:fs/promises';
import { extname, join, normalize, sep } from 'node:path';
import { fileURLToPath } from 'node:url';

const ROOT = fileURLToPath(new URL('.', import.meta.url));
const PORT = Number(process.env.PORT) || 8080;
const HOST = process.env.HOST || '0.0.0.0';

const TYPES = {
  '.html': 'text/html; charset=utf-8',
  '.js': 'text/javascript; charset=utf-8',
  '.mjs': 'text/javascript; charset=utf-8',
  '.css': 'text/css; charset=utf-8',
  '.json': 'application/json; charset=utf-8',
  '.svg': 'image/svg+xml',
  '.png': 'image/png',
  '.ico': 'image/x-icon',
  '.webmanifest': 'application/manifest+json',
};

function resolveSafe(urlPath) {
  let p = decodeURIComponent(urlPath.split('?')[0].split('#')[0]);
  if (p.endsWith('/')) p += 'index.html';
  const abs = normalize(join(ROOT, p));
  // ルート外への脱出を許さない
  if (!abs.startsWith(ROOT.endsWith(sep) ? ROOT : ROOT + sep) && abs !== ROOT) return null;
  return abs;
}

const server = createServer(async (req, res) => {
  // 対人戦が生きているかの確認用
  if (req.url === '/health') {
    res.writeHead(200, { 'content-type': 'application/json' });
    res.end(JSON.stringify({ ok: true, ...stats() }));
    return;
  }
  if (req.method !== 'GET' && req.method !== 'HEAD') {
    res.writeHead(405, { allow: 'GET, HEAD' }).end();
    return;
  }

  const file = resolveSafe(req.url || '/');
  if (!file) {
    res.writeHead(403).end('Forbidden');
    return;
  }

  try {
    const info = await stat(file);
    const target = info.isDirectory() ? join(file, 'index.html') : file;
    const size = info.isDirectory() ? (await stat(target)).size : info.size;

    res.writeHead(200, {
      'content-type': TYPES[extname(target).toLowerCase()] || 'application/octet-stream',
      'content-length': size,
      // ゲーム本体はビルドしないので、更新が即座に届くほうを優先する
      'cache-control': 'public, max-age=0, must-revalidate',
    });
    if (req.method === 'HEAD') { res.end(); return; }
    createReadStream(target).pipe(res);
  } catch {
    res.writeHead(404, { 'content-type': 'text/plain; charset=utf-8' }).end('Not Found');
  }
});

// 対人戦：/ws だけ WebSocket に昇格させる
server.on('upgrade', (req, socket, head) => {
  const path = (req.url || '').split('?')[0];
  if (path !== '/ws') { socket.destroy(); return; }
  const conn = accept(req, socket, head);
  if (conn) handleConnection(conn);
});

server.listen(PORT, HOST, () => {
  console.log(`PAIR KICK → http://localhost:${PORT}`);
});
