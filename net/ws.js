// ws.js — 最小限の WebSocket サーバー（RFC 6455）。依存パッケージなし。
//
// このゲームが必要とするのは「小さなJSONテキストを双方向に流す」ことだけなので、
// 拡張（permessage-deflate）も継続フレームの結合も、64bit長のペイロードも扱わない。
// 扱うのは：テキスト/バイナリの単一フレーム、ping/pong、close。
// それを超えるものが来たら、黙って握りつぶさずに接続を閉じる。

import { createHash } from 'node:crypto';

const GUID = '258EAFA5-E914-47DA-95CA-C5AB0DC85B11';
const MAX_PAYLOAD = 1 << 20;   // 1MB。これ以上は受け付けない

export function accept(req, socket, head) {
  const key = req.headers['sec-websocket-key'];
  if (req.headers.upgrade?.toLowerCase() !== 'websocket' || !key) {
    socket.destroy();
    return null;
  }
  const hash = createHash('sha1').update(key + GUID).digest('base64');
  socket.write(
    'HTTP/1.1 101 Switching Protocols\r\n' +
    'Upgrade: websocket\r\n' +
    'Connection: Upgrade\r\n' +
    `Sec-WebSocket-Accept: ${hash}\r\n\r\n`
  );
  socket.setNoDelay(true);
  return new Conn(socket, head);
}

class Conn {
  constructor(socket, head) {
    this.socket = socket;
    this.buf = head && head.length ? Buffer.from(head) : Buffer.alloc(0);
    this.open = true;
    this.handlers = { message: [], close: [] };
    this.alive = true;

    socket.on('data', (d) => {
      this.buf = this.buf.length ? Buffer.concat([this.buf, d]) : d;
      try {
        this.drain();
      } catch (err) {
        this.close(1002, String(err && err.message));
      }
    });
    socket.on('error', () => this.finish());
    socket.on('close', () => this.finish());

    // 死んだ接続を掴んだままにしない
    this.ping = setInterval(() => {
      if (!this.open) return;
      if (!this.alive) { this.finish(); return; }
      this.alive = false;
      this.frame(0x9, Buffer.alloc(0));
    }, 20000);
  }

  on(ev, fn) { (this.handlers[ev] ||= []).push(fn); return this; }
  emit(ev, ...a) { for (const fn of this.handlers[ev] || []) fn(...a); }

  drain() {
    for (;;) {
      const b = this.buf;
      if (b.length < 2) return;
      const fin = (b[0] & 0x80) !== 0;
      const opcode = b[0] & 0x0f;
      const masked = (b[1] & 0x80) !== 0;
      let len = b[1] & 0x7f;
      let off = 2;

      if (len === 126) {
        if (b.length < off + 2) return;
        len = b.readUInt16BE(off);
        off += 2;
      } else if (len === 127) {
        if (b.length < off + 8) return;
        const hi = b.readUInt32BE(off), lo = b.readUInt32BE(off + 4);
        if (hi !== 0 || lo > MAX_PAYLOAD) throw new Error('payload too large');
        len = lo;
        off += 8;
      }
      if (len > MAX_PAYLOAD) throw new Error('payload too large');
      // クライアントからのフレームは必ずマスクされている決まり
      if (!masked) throw new Error('unmasked frame from client');
      if (b.length < off + 4 + len) return;

      const mask = b.subarray(off, off + 4);
      off += 4;
      const payload = Buffer.allocUnsafe(len);
      for (let i = 0; i < len; i++) payload[i] = b[off + i] ^ mask[i & 3];
      off += len;
      this.buf = b.subarray(off);

      // 分割フレームは使わない想定。来たら閉じる（黙って壊れた解釈をしない）
      if (!fin) throw new Error('fragmented frames not supported');

      switch (opcode) {
        case 0x1: this.emit('message', payload.toString('utf8')); break;
        case 0x2: this.emit('message', payload.toString('utf8')); break;
        case 0x8: this.close(1000); return;
        case 0x9: this.frame(0xA, payload); break;   // ping → pong
        case 0xA: this.alive = true; break;          // pong
        default: throw new Error('bad opcode ' + opcode);
      }
    }
  }

  frame(opcode, payload) {
    if (!this.open) return;
    const len = payload.length;
    let head;
    if (len < 126) {
      head = Buffer.allocUnsafe(2);
      head[1] = len;
    } else if (len < 65536) {
      head = Buffer.allocUnsafe(4);
      head[1] = 126;
      head.writeUInt16BE(len, 2);
    } else {
      head = Buffer.allocUnsafe(10);
      head[1] = 127;
      head.writeUInt32BE(0, 2);
      head.writeUInt32BE(len, 6);
    }
    head[0] = 0x80 | opcode;
    try {
      this.socket.write(Buffer.concat([head, payload]));
    } catch (_) {
      this.finish();
    }
  }

  send(text) {
    this.frame(0x1, Buffer.from(text, 'utf8'));
  }

  close(code = 1000) {
    if (!this.open) return;
    const p = Buffer.allocUnsafe(2);
    p.writeUInt16BE(code, 0);
    this.frame(0x8, p);
    this.finish();
  }

  finish() {
    if (!this.open) return;
    this.open = false;
    clearInterval(this.ping);
    try { this.socket.end(); } catch (_) {}
    try { this.socket.destroy(); } catch (_) {}
    this.emit('close');
  }
}
