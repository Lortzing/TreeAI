/**
 * D4 PDF fixture generator — the four committed negative fixtures.
 *
 *   neg-pdf-encrypted.pdf  REAL /Encrypt dictionary: standard security
 *                          handler, RC4 128-bit (V2/R3), empty user password.
 *                          The content stream and the Info strings are
 *                          genuinely encrypted; the file opens without a
 *                          password but a text-layer parser must reject it
 *                          (reason: encrypted).
 *   neg-pdf-corrupt.pdf    structurally broken: truncated before the xref
 *                          table and given a garbage tail.
 *   neg-pdf-image-only.pdf a valid page whose only content is one embedded
 *                          image XObject (a hand-rolled 64x64 grayscale
 *                          gradient PNG, reusing the exact IDAT stream) —
 *                          zero text operators.
 *   neg-pdf-zero-text.pdf  a valid single page with an empty content stream.
 */

import { deflateSync } from "node:zlib";
import { assert, md5, PDF_PAD, rc4, pseudoRandomBytes, crc32 } from "./util.mjs";
import { PdfDoc, pdfHex, pdfLiteral } from "./pdfwriter.mjs";
import { winAnsiEncode } from "./textenc.mjs";

/* ---------------------------------------------------------------------- */
/* RC4 128-bit standard security handler (V2 / R3)                         */
/* ---------------------------------------------------------------------- */

function padPassword(pw) {
  const bytes = Buffer.from(pw, "latin1").subarray(0, 32);
  return Buffer.concat([bytes, PDF_PAD.subarray(0, 32 - bytes.length)]);
}

/** Algorithm 3.3: the /O entry (owner password falls back to the user one). */
function computeO(userPw) {
  let hash = md5(padPassword(userPw));
  for (let i = 0; i < 50; i += 1) hash = md5(hash.subarray(0, 16));
  const key = hash.subarray(0, 16);
  let o = rc4(key, padPassword(userPw));
  for (let i = 1; i <= 19; i += 1) {
    o = rc4(Buffer.from(key.map((b) => b ^ i)), o);
  }
  return o;
}

/** Algorithm 3.2: the file encryption key from the (empty) user password. */
function computeKey(userPw, o, p, idBytes) {
  const pLe = Buffer.alloc(4);
  pLe.writeInt32LE(p, 0);
  let hash = md5(Buffer.concat([padPassword(userPw), o, pLe, idBytes]));
  for (let i = 0; i < 50; i += 1) hash = md5(hash.subarray(0, 16));
  return hash.subarray(0, 16);
}

/** Algorithm 3.5: the /U entry for revision 3. */
function computeU(key, idBytes) {
  let u = rc4(key, md5(Buffer.concat([PDF_PAD, idBytes])));
  for (let i = 1; i <= 19; i += 1) {
    u = rc4(Buffer.from(key.map((b) => b ^ i)), u);
  }
  return Buffer.concat([u, Buffer.alloc(16)]); // trailing 16 bytes arbitrary -> zeros
}

const objectKey = (key, objNum) => {
  const extra = Buffer.from([objNum & 0xff, (objNum >> 8) & 0xff, (objNum >> 16) & 0xff, 0, 0]);
  return md5(Buffer.concat([key, extra])).subarray(0, Math.min(key.length + 5, 16));
};

/**
 * Build the encrypted negative: a one-page text document (WinAnsi Helvetica)
 * whose content stream and Info strings are RC4-encrypted with an empty user
 * password. Object numbers are fixed: 1 catalog, 2 pages, 3 page,
 * 4 content stream, 5 font, 6 Info, 7 Encrypt.
 *
 * Returns { bytes, key, o, u, p, idBytes, plainContent } so the self-check
 * can prove the encryption is real (decrypt round-trips) without guessing.
 */
export function buildEncryptedNegative({ title, bodyLines }) {
  const P = -4;
  const plainContent = Buffer.from(
    bodyLines
      .map((l) => `BT\n/F1 12 Tf\n72.00 ${String(l.y)} Td\n${pdfLiteral(winAnsiEncode(l.text))} Tj\nET`)
      .join("\n"),
    "latin1",
  );
  // The document ID enters the key derivation; derive it from deterministic
  // pre-encryption bytes (title + plaintext content).
  const idBytes = md5(md5(Buffer.concat([Buffer.from(title, "latin1"), plainContent])));
  const o = computeO("");
  const key = computeKey("", o, P, idBytes);
  const u = computeU(key, idBytes);
  const enc = (objNum, bytes) => rc4(objectKey(key, objNum), bytes);

  const contentEnc = enc(4, plainContent);
  const objects = new Map([
    [1, "<< /Type /Catalog /Pages 2 0 R >>"],
    [2, "<< /Type /Pages /Kids [3 0 R] /Count 1 >>"],
    [3, "<< /Type /Page /Parent 2 0 R /MediaBox [0 0 595.28 841.89] /Resources << /Font << /F1 5 0 R >> >> /Contents 4 0 R >>"],
    [4, `<< /Length ${String(contentEnc.length)} >>\nstream\n${contentEnc.toString("latin1")}\nendstream`],
    [5, "<< /Type /Font /Subtype /Type1 /BaseFont /Helvetica /Encoding /WinAnsiEncoding >>"],
    [6, `<< /Title ${pdfLiteral(enc(6, Buffer.from(title, "latin1")))} /Producer ${pdfLiteral(enc(6, Buffer.from("TreeAI D4 PDF fixture generator d4-pdf-v1", "latin1")))} /CreationDate ${pdfLiteral(enc(6, Buffer.from("D:20260930000000Z", "latin1")))} /ModDate ${pdfLiteral(enc(6, Buffer.from("D:20260930000000Z", "latin1")))} >>`],
    [7, `<< /Filter /Standard /V 2 /R 3 /Length 128 /O ${pdfHex(o)} /U ${pdfHex(u)} /P ${String(P)} >>`],
  ]);

  const parts = [Buffer.from("%PDF-1.5\n%\xE2\xE3\xCF\xD3\n", "latin1")];
  const offsets = new Map();
  let pos = parts[0].length;
  for (const num of [1, 2, 3, 4, 5, 6, 7]) {
    offsets.set(num, pos);
    const body = Buffer.from(`${String(num)} 0 obj\n${objects.get(num)}\nendobj\n`, "latin1");
    parts.push(body);
    pos += body.length;
  }
  const xrefStart = pos;
  let xref = "xref\n0 8\n0000000000 65535 f \n";
  for (let num = 1; num <= 7; num += 1) {
    xref += `${String(offsets.get(num)).padStart(10, "0")} 00000 n \n`;
  }
  parts.push(Buffer.from(xref, "latin1"));
  const idHex = pdfHex(idBytes);
  const trailer =
    `trailer\n<< /Size 8 /Root 1 0 R /Info 6 0 R /Encrypt 7 0 R /ID [${idHex} ${idHex}] >>\n` +
    `startxref\n${String(xrefStart)}\n%%EOF\n`;
  return {
    bytes: Buffer.concat([...parts, Buffer.from(trailer, "latin1")]),
    key,
    o,
    u,
    p: P,
    idBytes,
    plainContent,
  };
}

/** Decrypt one object's stream/strings for the self-check. */
export function rc4ObjectDecrypt(bytes, objNum, { key }) {
  return rc4(objectKey(key, objNum), bytes);
}

/* ---------------------------------------------------------------------- */
/* PNG (for the image-only negative)                                       */
/* ---------------------------------------------------------------------- */

/** Hand-rolled PNG: 64x64, 8-bit grayscale deterministic gradient. */
export function buildGradientPng() {
  const width = 64;
  const height = 64;
  const raw = Buffer.alloc(height * (1 + width));
  for (let y = 0; y < height; y += 1) {
    const rowStart = y * (1 + width);
    raw[rowStart] = 0; // PNG filter type None
    for (let x = 0; x < width; x += 1) {
      raw[rowStart + 1 + x] = (x * 4 + y * 2) & 0xff;
    }
  }
  const idat = deflateSync(raw, { level: 9 });
  const chunk = (type, data) => {
    const len = Buffer.alloc(4);
    len.writeUInt32BE(data.length, 0);
    const typeBuf = Buffer.from(type, "latin1");
    const crc = Buffer.alloc(4);
    crc.writeUInt32BE(crc32(Buffer.concat([typeBuf, data])), 0);
    return Buffer.concat([len, typeBuf, data, crc]);
  };
  const ihdr = Buffer.alloc(13);
  ihdr.writeUInt32BE(width, 0);
  ihdr.writeUInt32BE(height, 4);
  ihdr[8] = 8; // bit depth
  ihdr[9] = 0; // color type: grayscale
  const png = Buffer.concat([
    Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]),
    chunk("IHDR", ihdr),
    chunk("IDAT", idat),
    chunk("IEND", Buffer.alloc(0)),
  ]);
  return { png, idat, width, height };
}

/** The image-only negative: one page, one XObject, zero text operators. */
export function buildImageOnlyNegative() {
  const { idat } = buildGradientPng();
  const doc = new PdfDoc();
  doc.add("<< /Type /Catalog /Pages 2 0 R >>"); // 1
  doc.add("<< /Type /Pages /Kids [5 0 R] /Count 1 >>"); // 2
  const imageNum = doc.addStream(
    "/Type /XObject /Subtype /Image /Width 64 /Height 64 /ColorSpace /DeviceGray /BitsPerComponent 8 " +
    "/DecodeParms << /Predictor 15 /Colors 1 /BitsPerComponent 8 /Columns 64 >>",
    idat,
    { flate: true },
  ); // 3
  const contentNum = doc.addStream("", Buffer.from("q\n595.28 0 0 841.89 0 0 cm\n/Im0 Do\nQ\n", "latin1")); // 4
  doc.add(
    `<< /Type /Page /Parent 2 0 R /MediaBox [0 0 595.28 841.89] ` +
    `/Resources << /XObject << /Im0 ${String(imageNum)} 0 R >> >> /Contents ${String(contentNum)} 0 R >>`,
  ); // 5
  const infoNum = doc.add(
    `<< /Title ${pdfLiteral(Buffer.from("TreeAI negative: image-only page", "latin1"))} /Producer (TreeAI D4 PDF fixture generator d4-pdf-v1) ` +
    `/CreationDate (${doc.fixedDate}) /ModDate (${doc.fixedDate}) >>`,
  );
  return doc.serialize(1, infoNum);
}

/** The zero-text negative: a valid page with an empty content stream. */
export function buildZeroTextNegative() {
  const doc = new PdfDoc();
  doc.add("<< /Type /Catalog /Pages 2 0 R >>"); // 1
  doc.add("<< /Type /Pages /Kids [4 0 R] /Count 1 >>"); // 2
  const contentNum = doc.addStream("", Buffer.alloc(0)); // 3
  doc.add(
    `<< /Type /Page /Parent 2 0 R /MediaBox [0 0 595.28 841.89] /Resources << >> /Contents ${String(contentNum)} 0 R >>`,
  ); // 4
  const infoNum = doc.add(
    `<< /Title ${pdfLiteral(Buffer.from("TreeAI negative: empty content stream", "latin1"))} /Producer (TreeAI D4 PDF fixture generator d4-pdf-v1) ` +
    `/CreationDate (${doc.fixedDate}) /ModDate (${doc.fixedDate}) >>`,
  );
  return doc.serialize(1, infoNum);
}

/** The corrupt negative: truncate a valid text PDF and append garbage. */
export function buildCorruptNegative(basePdfBytes) {
  assert(basePdfBytes.length > 2000, "base PDF too small to truncate meaningfully");
  const xrefAt = basePdfBytes.lastIndexOf(Buffer.from("xref\n0 ", "latin1"));
  assert(xrefAt > 400, "could not locate the xref table in the base PDF");
  const truncated = basePdfBytes.subarray(0, Math.floor(xrefAt * 0.7));
  const garbage = pseudoRandomBytes(0x5eed1, 512);
  return Buffer.concat([truncated, garbage]);
}
