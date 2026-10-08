// Minimal CBOR decoder (RFC 8949) — enough for WebAuthn attestation objects and COSE public keys.
// Supports: unsigned/negative integers, byte strings, text strings, arrays, maps, simple values (false/true/null).

export function decodeCbor(buf) {
  const data = Buffer.isBuffer(buf) ? buf : Buffer.from(buf);
  let pos = 0;

  function readLength(info) {
    if (info < 24) return info;
    if (info === 24) { const v = data.readUInt8(pos); pos += 1; return v; }
    if (info === 25) { const v = data.readUInt16BE(pos); pos += 2; return v; }
    if (info === 26) { const v = data.readUInt32BE(pos); pos += 4; return v; }
    if (info === 27) {
      const v = data.readBigUInt64BE(pos); pos += 8;
      if (v > BigInt(Number.MAX_SAFE_INTEGER)) throw new Error('cbor: integer too large');
      return Number(v);
    }
    throw new Error('cbor: indefinite lengths not supported');
  }

  function item() {
    if (pos >= data.length) throw new Error('cbor: unexpected end');
    const first = data.readUInt8(pos++);
    const major = first >> 5;
    const info = first & 0x1f;
    switch (major) {
      case 0: return readLength(info);
      case 1: return -1 - readLength(info);
      case 2: { const n = readLength(info); if (pos + n > data.length) throw new Error('cbor: truncated bytes'); const b = data.subarray(pos, pos + n); pos += n; return Buffer.from(b); }
      case 3: { const n = readLength(info); if (pos + n > data.length) throw new Error('cbor: truncated text'); const s = data.toString('utf8', pos, pos + n); pos += n; return s; }
      case 4: { const n = readLength(info); if (n > 10000) throw new Error('cbor: array too long'); const a = []; for (let i = 0; i < n; i++) a.push(item()); return a; }
      case 5: { const n = readLength(info); if (n > 1000) throw new Error('cbor: map too large'); const m = new Map(); for (let i = 0; i < n; i++) { const k = item(); m.set(k, item()); } return m; }
      case 7:
        if (info === 20) return false;
        if (info === 21) return true;
        if (info === 22 || info === 23) return null;
        throw new Error('cbor: unsupported simple value');
      default: throw new Error('cbor: unsupported type');
    }
  }

  const value = item();
  return { value, length: pos };
}
