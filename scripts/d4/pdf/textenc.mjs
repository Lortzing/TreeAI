/**
 * D4 PDF fixture generator — WinAnsiEncoding tables + base-14 font metrics.
 *
 * Base-14 Latin text uses non-embedded Type1 fonts (Helvetica, Courier) with
 * /WinAnsiEncoding. The tables here make encoding/decoding and width-based
 * line wrapping exact and dependency-free.
 */

/** WinAnsiEncoding: byte -> Unicode string (PDF 1.7 Annex D.2). */
const WIN_ANSI_EXTRAS = {
  0x80: "€", 0x82: "‚", 0x83: "ƒ", 0x84: "„", 0x85: "…",
  0x86: "†", 0x87: "‡", 0x88: "ˆ", 0x89: "‰", 0x8A: "Š",
  0x8B: "‹", 0x8C: "Œ", 0x8E: "Ž", 0x91: "‘", 0x92: "’",
  0x93: "“", 0x94: "”", 0x95: "•", 0x96: "–", 0x97: "—",
  0x98: "˜", 0x99: "™", 0x9A: "š", 0x9B: "›", 0x9C: "œ",
  0x9E: "ž", 0x9F: "Ÿ",
};

export const WIN_ANSI_BYTE_TO_TEXT = (() => {
  const map = new Map();
  for (let b = 0x20; b <= 0x7e; b += 1) map.set(b, String.fromCharCode(b));
  for (let b = 0xa1; b <= 0xff; b += 1) {
    if (b === 0xad) continue; // soft hyphen: WinAnsi leaves 0xad undefined
    map.set(b, String.fromCharCode(b));
  }
  for (const [b, text] of Object.entries(WIN_ANSI_EXTRAS)) map.set(Number(b), text);
  return map;
})();

export const WIN_ANSI_TEXT_TO_BYTE = (() => {
  const map = new Map();
  for (const [b, text] of WIN_ANSI_BYTE_TO_TEXT) if (!map.has(text)) map.set(text, b);
  return map;
})();

export function winAnsiEncode(text) {
  const out = [];
  for (const ch of text) {
    const b = WIN_ANSI_TEXT_TO_BYTE.get(ch);
    if (b === undefined) {
      throw new Error(`character ${JSON.stringify(ch)} (U+${ch.codePointAt(0).toString(16)}) is not WinAnsi-encodable`);
    }
    out.push(b);
  }
  return Buffer.from(out);
}

export function winAnsiDecode(bytes) {
  let out = "";
  for (const b of bytes) {
    const text = WIN_ANSI_BYTE_TO_TEXT.get(b);
    if (text === undefined) throw new Error(`byte 0x${b.toString(16)} has no WinAnsi mapping`);
    out += text;
  }
  return out;
}

/** Helvetica AFM advance widths (1000 units/em) for the WinAnsi charset. */
export const HELVETICA_WIDTHS = (() => {
  const w = new Map();
  const ascii = {
    " ": 278, "!": 278, '"': 355, "#": 556, "$": 556, "%": 889, "&": 667, "'": 191,
    "(": 333, ")": 333, "*": 389, "+": 584, ",": 278, "-": 333, ".": 278, "/": 278,
    "0": 556, "1": 556, "2": 556, "3": 556, "4": 556, "5": 556, "6": 556, "7": 556,
    "8": 556, "9": 556, ":": 278, ";": 278, "<": 584, "=": 584, ">": 584, "?": 556,
    "@": 1015, A: 667, B: 667, C: 722, D: 722, E: 667, F: 611, G: 778, H: 722,
    I: 278, J: 500, K: 667, L: 556, M: 833, N: 722, O: 778, P: 667, Q: 778, R: 722,
    S: 667, T: 611, U: 722, V: 667, W: 944, X: 667, Y: 667, Z: 611, "[": 278,
    "\\": 278, "]": 278, "^": 469, _: 556, "`": 333, a: 556, b: 556, c: 500,
    d: 556, e: 556, f: 278, g: 556, h: 556, i: 222, j: 222, k: 500, l: 222,
    m: 833, n: 556, o: 556, p: 556, q: 556, r: 333, s: 500, t: 278, u: 556,
    v: 500, w: 722, x: 500, y: 500, z: 500, "{": 334, "|": 260, "}": 334, "~": 584,
  };
  for (const [ch, width] of Object.entries(ascii)) w.set(ch, width);
  // Latin-1 supplement + the WinAnsi specials (Helvetica AFM values).
  const latin1 = {
    " ": 278, "¡": 333, "¢": 556, "£": 556, "¤": 556, "¥": 556,
    "¦": 260, "§": 556, "¨": 556, "©": 737, "ª": 370, "«": 556,
    "¬": 584, "­": 333, "®": 737, "¯": 556, "°": 584, "±": 584,
    "²": 333, "³": 333, "´": 333, "µ": 556, "¶": 556, "·": 278,
    "¸": 333, "¹": 333, "º": 365, "»": 556, "¼": 834, "½": 834,
    "¾": 834, "¿": 556, "À": 667, "Á": 667, "Â": 667, "Ã": 667,
    "Ä": 667, "Å": 667, "Æ": 1000, "Ç": 722, "È": 667, "É": 667,
    "Ê": 667, "Ë": 667, "Ì": 278, "Í": 278, "Î": 278, "Ï": 278,
    "Ð": 722, "Ñ": 722, "Ò": 778, "Ó": 778, "Ô": 778, "Õ": 778,
    "Ö": 778, "×": 584, "Ø": 778, "Ù": 722, "Ú": 722, "Û": 722,
    "Ü": 722, "Ý": 667, "Þ": 667, "ß": 611, "à": 556, "á": 556,
    "â": 556, "ã": 556, "ä": 556, "å": 556, "æ": 889, "ç": 500,
    "è": 556, "é": 556, "ê": 556, "ë": 556, "ì": 278, "í": 278,
    "î": 278, "ï": 278, "ð": 556, "ñ": 556, "ò": 556, "ó": 556,
    "ô": 556, "õ": 556, "ö": 556, "÷": 584, "ø": 611, "ù": 556,
    "ú": 556, "û": 556, "ü": 556, "ý": 500, "þ": 556, "ÿ": 500,
    "‚": 222, "„": 556, "†": 584, "‡": 584, "…": 1000,
    "‘": 222, "’": 222, "“": 333, "”": 333, "•": 350,
    "–": 556, "—": 1000, "‹": 333, "›": 333, "€": 556,
  };
  for (const [ch, width] of Object.entries(latin1)) w.set(ch, width);
  return w;
})();

/** Courier is monospaced at 600 units. */
export const COURIER_WIDTH = 600;

/** Helvetica-Bold AFM advance widths (1000 units/em) — ASCII + punctuation.
 *  Used only for short pre-measured heading lines. */
export const HELVETICA_BOLD_WIDTHS = (() => {
  const w = new Map();
  const ascii = {
    " ": 278, "!": 333, '"': 474, "#": 556, "$": 556, "%": 889, "&": 722, "'": 238,
    "(": 333, ")": 333, "*": 389, "+": 584, ",": 278, "-": 333, ".": 278, "/": 278,
    "0": 556, "1": 556, "2": 556, "3": 556, "4": 556, "5": 556, "6": 556, "7": 556,
    "8": 556, "9": 556, ":": 333, ";": 333, "<": 584, "=": 584, ">": 584, "?": 611,
    "@": 975, A: 722, B: 722, C: 722, D: 722, E: 667, F: 611, G: 778, H: 722,
    I: 278, J: 556, K: 722, L: 611, M: 833, N: 722, O: 778, P: 667, Q: 778, R: 722,
    S: 667, T: 611, U: 722, V: 667, W: 944, X: 667, Y: 667, Z: 611, "[": 333,
    "\\": 278, "]": 333, "^": 584, "_": 556, "`": 333, a: 556, b: 611, c: 556,
    d: 611, e: 556, f: 333, g: 611, h: 611, i: 278, j: 278, k: 556, l: 278,
    m: 889, n: 611, o: 611, p: 611, q: 611, r: 389, s: 556, t: 333, u: 611,
    v: 556, w: 778, x: 556, y: 556, z: 500, "{": 389, "|": 280, "}": 389, "~": 584,
  };
  for (const [ch, width] of Object.entries(ascii)) w.set(ch, width);
  return w;
})();

/** Advance width (1000 units/em) of one character in a base-14 font. */
export function base14CharWidth(font, ch) {
  if (font === "Courier") return COURIER_WIDTH;
  if (font === "Helvetica") {
    const w = HELVETICA_WIDTHS.get(ch);
    if (w === undefined) throw new Error(`no Helvetica width for ${JSON.stringify(ch)}`);
    return w;
  }
  if (font === "Helvetica-Bold") {
    const w = HELVETICA_BOLD_WIDTHS.get(ch);
    if (w === undefined) throw new Error(`no Helvetica-Bold width for ${JSON.stringify(ch)}`);
    return w;
  }
  throw new Error(`no width table for base font ${font}`);
}

/** Does a one-byte WinAnsi code exist for this character? */
export function isWinAnsiEncodable(text) {
  for (const ch of text) {
    if (!WIN_ANSI_TEXT_TO_BYTE.has(ch)) return false;
  }
  return true;
}
