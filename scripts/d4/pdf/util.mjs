/**
 * D4 PDF fixture generator — small binary/util helpers (zero npm deps).
 *
 * Part of the D4-0 frozen B1/B2 acceptance-set tooling (charter
 * docs/d4/D4-project-v1.md §6 B1/B2; contracts docs/d4/D4-contracts.md §6).
 */

import { createHash } from "node:crypto";

export function assert(condition, message) {
  if (!condition) throw new Error(`assert failed: ${message}`);
}

/** Big-endian byte writer with table-friendly alignment helpers. */
export class ByteWriter {
  constructor() {
    this.chunks = [];
    this.length = 0;
  }

  u8(v) {
    this.chunks.push(Buffer.of(v & 0xff));
    this.length += 1;
    return this;
  }

  u16(v) {
    this.chunks.push(Buffer.of((v >> 8) & 0xff, v & 0xff));
    this.length += 2;
    return this;
  }

  /** 2-byte signed. */
  s16(v) {
    const u = v < 0 ? v + 0x10000 : v;
    return this.u16(u);
  }

  u32(v) {
    const b = Buffer.alloc(4);
    b.writeUInt32BE(v >>> 0, 0);
    this.chunks.push(b);
    this.length += 4;
    return this;
  }

  bytes(buf) {
    this.chunks.push(Buffer.from(buf));
    this.length += buf.length;
    return this;
  }

  /** Pad with zero bytes up to a multiple of `n`. */
  align(n) {
    const rem = this.length % n;
    if (rem !== 0) this.bytes(Buffer.alloc(n - rem));
    return this;
  }

  toBuffer() {
    return Buffer.concat(this.chunks, this.length);
  }
}

/** Sum of big-endian uint32 words over 4-byte-padded data (TrueType checksum). */
export function checksumBytes(buf) {
  const padded = buf.length % 4 === 0 ? buf : Buffer.concat([buf, Buffer.alloc(4 - (buf.length % 4))]);
  let sum = 0;
  for (let i = 0; i < padded.length; i += 4) {
    sum = (sum + padded.readUInt32BE(i)) >>> 0;
  }
  return sum >>> 0;
}

export function sha256(buf) {
  return createHash("sha256").update(buf).digest();
}

export function sha256hex(buf) {
  return createHash("sha256").update(buf).digest("hex");
}

export function md5(buf) {
  return createHash("md5").update(buf).digest();
}

/** Standard 32-byte PDF password padding string (Table 3.2, PDF 1.7 spec). */
export const PDF_PAD = Buffer.from([
  0x28, 0xbf, 0x4e, 0x5e, 0x4e, 0x75, 0x8a, 0x41, 0x64, 0x00, 0x4e, 0x56, 0xff, 0xfa, 0x01, 0x08,
  0x2e, 0x2e, 0x00, 0xb6, 0xd0, 0x68, 0x3e, 0x80, 0x2f, 0x0c, 0xa9, 0xfe, 0x64, 0x53, 0x69, 0x7a,
]);

/** CRC-32 (PNG chunks). */
const CRC_TABLE = (() => {
  const table = new Int32Array(256);
  for (let n = 0; n < 256; n += 1) {
    let c = n;
    for (let k = 0; k < 8; k += 1) c = c & 1 ? 0xedb88320 ^ (c >>> 1) : c >>> 1;
    table[n] = c;
  }
  return table;
})();

export function crc32(buf) {
  let c = 0xffffffff;
  for (let i = 0; i < buf.length; i += 1) c = CRC_TABLE[(c ^ buf[i]) & 0xff] ^ (c >>> 8);
  return (c ^ 0xffffffff) >>> 0;
}

/** RC4 (for the encrypted-negative fixture; ~15 lines, standard KSA+PRGA). */
export function rc4(key, data) {
  const s = new Uint8Array(256);
  for (let i = 0; i < 256; i += 1) s[i] = i;
  let j = 0;
  for (let i = 0; i < 256; i += 1) {
    j = (j + s[i] + key[i % key.length]) & 0xff;
    const t = s[i];
    s[i] = s[j];
    s[j] = t;
  }
  const out = Buffer.allocUnsafe(data.length);
  let i = 0;
  j = 0;
  for (let k = 0; k < data.length; k += 1) {
    i = (i + 1) & 0xff;
    j = (j + s[i]) & 0xff;
    const t = s[i];
    s[i] = s[j];
    s[j] = t;
    out[k] = data[k] ^ s[(s[i] + s[j]) & 0xff];
  }
  return out;
}

/** Deterministic "random-looking" bytes (for the corrupt-negative tail). */
export function pseudoRandomBytes(seed, length) {
  let state = seed >>> 0 || 0x9e3779b9;
  const out = Buffer.allocUnsafe(length);
  for (let i = 0; i < length; i += 1) {
    state ^= state << 13;
    state >>>= 0;
    state ^= state >>> 17;
    state ^= state << 5;
    state >>>= 0;
    out[i] = state & 0xff;
  }
  return out;
}
