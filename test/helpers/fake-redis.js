// A tiny in-process Redis-compatible server (RESP2) for tests: AUTH, SELECT, PING, INCR, PEXPIRE, GET, SET [NX] [PX], DEL, EXISTS.
import net from 'node:net';

export async function startFakeRedis({ password } = {}) {
  const data = new Map(); // key → { v, exp }
  const live = (k) => { const e = data.get(k); if (e && e.exp && e.exp <= Date.now()) { data.delete(k); return null; } return e || null; };
  const commands = [];
  const server = net.createServer((sock) => {
    let buf = Buffer.alloc(0), authed = !password;
    sock.on('data', (chunk) => {
      buf = Buffer.concat([buf, chunk]);
      for (;;) {
        const r = parseArray(buf); if (!r) break;
        buf = buf.subarray(r.next);
        const [cmd, ...a] = r.args; const C = cmd.toUpperCase();
        commands.push(C);
        const out = (s) => sock.write(s);
        if (C === 'AUTH') { authed = a[a.length - 1] === password; out(authed ? '+OK\r\n' : '-WRONGPASS invalid\r\n'); continue; }
        if (!authed) { out('-NOAUTH Authentication required\r\n'); continue; }
        if (C === 'PING') out('+PONG\r\n');
        else if (C === 'SELECT') out('+OK\r\n');
        else if (C === 'INCR') { const e = live(a[0]); const v = (e ? Number(e.v) : 0) + 1; data.set(a[0], { v: String(v), exp: e?.exp }); out(`:${v}\r\n`); }
        else if (C === 'PEXPIRE') { const e = live(a[0]); if (e) e.exp = Date.now() + Number(a[1]); out(`:${e ? 1 : 0}\r\n`); }
        else if (C === 'GET') { const e = live(a[0]); out(e ? `$${Buffer.byteLength(e.v)}\r\n${e.v}\r\n` : '$-1\r\n'); }
        else if (C === 'SET') {
          const nx = a.map((x) => x.toUpperCase()).includes('NX');
          const pxI = a.findIndex((x) => x.toUpperCase() === 'PX');
          if (nx && live(a[0])) { out('$-1\r\n'); continue; }
          data.set(a[0], { v: a[1], exp: pxI > 0 ? Date.now() + Number(a[pxI + 1]) : 0 }); out('+OK\r\n');
        } else if (C === 'DEL') { out(`:${data.delete(a[0]) ? 1 : 0}\r\n`); }
        else if (C === 'EXISTS') { out(`:${live(a[0]) ? 1 : 0}\r\n`); }
        else out(`-ERR unknown command ${C}\r\n`);
      }
    });
  });
  await new Promise((r) => server.listen(0, '127.0.0.1', r));
  const sockets = new Set();
  server.on('connection', (s) => { sockets.add(s); s.on('close', () => sockets.delete(s)); });
  return {
    url: `redis://${password ? `:${password}@` : ''}127.0.0.1:${server.address().port}/1`,
    data, commands,
    dropConnections() { for (const s of sockets) s.destroy(); },
    async stop() { for (const s of sockets) s.destroy(); await new Promise((r) => server.close(r)); },
  };
}

function parseArray(buf) {
  if (!buf.length || buf[0] !== 42) return null; // '*'
  let i = buf.indexOf('\r\n'); if (i < 0) return null;
  const n = Number(buf.toString('utf8', 1, i)); let p = i + 2; const args = [];
  for (let k = 0; k < n; k++) {
    const e = buf.indexOf('\r\n', p); if (e < 0) return null;
    const len = Number(buf.toString('utf8', p + 1, e));
    if (buf.length < e + 2 + len + 2) return null;
    args.push(buf.toString('utf8', e + 2, e + 2 + len)); p = e + 2 + len + 2;
  }
  return { args, next: p };
}
