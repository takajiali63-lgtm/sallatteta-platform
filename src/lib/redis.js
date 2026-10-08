// Minimal Redis / Valkey client (RESP2) — no dependencies.
// Supports redis:// and rediss:// (TLS) URLs with user/password and db index, pipelining, and auto-reconnect.
// Commands fail fast while disconnected, so callers can "fail open" instead of hanging.
import net from 'node:net';
import tls from 'node:tls';

export function createRedis(url, { connectTimeoutMs = 5000, commandTimeoutMs = 2000, log = console } = {}) {
  const u = new URL(url);
  const useTls = u.protocol === 'rediss:';
  const host = u.hostname;
  const port = Number(u.port) || 6379;
  const password = decodeURIComponent(u.password || '');
  const username = decodeURIComponent(u.username || '');
  const dbIndex = Number((u.pathname || '/0').slice(1)) || 0;

  let socket = null, ready = false, closing = false, buffer = Buffer.alloc(0), backoff = 200;
  const pending = []; // { resolve, reject, timer }

  const encode = (args) => {
    let out = `*${args.length}\r\n`;
    for (const a of args) { const s = String(a); out += `$${Buffer.byteLength(s)}\r\n${s}\r\n`; }
    return out;
  };

  // Parse one reply from buffer at offset; returns [value, nextOffset] or null if incomplete.
  function parse(buf, i) {
    if (i >= buf.length) return null;
    const type = String.fromCharCode(buf[i]);
    const end = buf.indexOf('\r\n', i);
    if (end < 0) return null;
    const line = buf.toString('utf8', i + 1, end);
    if (type === '+') return [line, end + 2];
    if (type === '-') return [new Error(line), end + 2];
    if (type === ':') return [Number(line), end + 2];
    if (type === '$') {
      const len = Number(line);
      if (len < 0) return [null, end + 2];
      if (buf.length < end + 2 + len + 2) return null;
      return [buf.toString('utf8', end + 2, end + 2 + len), end + 2 + len + 2];
    }
    if (type === '*') {
      const n = Number(line);
      if (n < 0) return [null, end + 2];
      const arr = [];
      let j = end + 2;
      for (let k = 0; k < n; k++) {
        const r = parse(buf, j);
        if (!r) return null;
        arr.push(r[0]); j = r[1];
      }
      return [arr, j];
    }
    throw new Error('redis protocol error');
  }

  function onData(chunk) {
    buffer = buffer.length ? Buffer.concat([buffer, chunk]) : chunk;
    let i = 0;
    for (;;) {
      const r = parse(buffer, i);
      if (!r) break;
      i = r[1];
      const p = pending.shift();
      if (!p) continue;
      clearTimeout(p.timer);
      if (r[0] instanceof Error) p.reject(r[0]); else p.resolve(r[0]);
    }
    buffer = buffer.subarray(i);
  }

  function failAll(err) {
    while (pending.length) { const p = pending.shift(); clearTimeout(p.timer); p.reject(err); }
  }

  function rawSend(args) {
    return new Promise((resolve, reject) => {
      if (!socket) return reject(new Error('redis not connected'));
      const timer = setTimeout(() => reject(new Error('redis timeout')), commandTimeoutMs);
      pending.push({ resolve, reject, timer });
      socket.write(encode(args));
    });
  }

  function connect() {
    if (closing) return;
    buffer = Buffer.alloc(0);
    const s = useTls ? tls.connect({ host, port, servername: host }) : net.connect({ host, port });
    socket = s;
    s.setNoDelay(true);
    const ct = setTimeout(() => s.destroy(new Error('redis connect timeout')), connectTimeoutMs);
    s.once(useTls ? 'secureConnect' : 'connect', async () => {
      clearTimeout(ct);
      try {
        if (password) await rawSend(username ? ['AUTH', username, password] : ['AUTH', password]);
        if (dbIndex) await rawSend(['SELECT', dbIndex]);
        ready = true; backoff = 200;
      } catch (err) { log.warn?.(`[redis] handshake failed: ${err.message}`); s.destroy(); }
    });
    s.on('data', onData);
    s.on('error', (err) => { if (!closing) log.warn?.(`[redis] ${err.message}`); });
    s.on('close', () => {
      clearTimeout(ct);
      ready = false; socket = null;
      failAll(new Error('redis connection closed'));
      if (!closing) { setTimeout(connect, backoff).unref?.(); backoff = Math.min(backoff * 2, 10_000); }
    });
  }
  connect();

  return {
    kind: 'redis',
    get ready() { return ready; },
    async command(...args) {
      if (!ready) throw new Error('redis not ready');
      return rawSend(args);
    },
    async ping() { return (await this.command('PING')) === 'PONG'; },
    async close() { closing = true; failAll(new Error('redis closed')); socket?.end(); },
  };
}
