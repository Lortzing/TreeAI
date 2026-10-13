/** errors ownership for pdf-parser.ts; compatibility entrypoint remains one level above. */

/* ------------------------------------------------------------------ */
/* 内部错误分类（top-level 统一映射为拒绝原因码）                        */
/* ------------------------------------------------------------------ */

/** 结构损坏（不可继续解析）。 */
export class PdfCorruptError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "PdfCorruptError";
  }
}

/** 加密文档（trailer /Encrypt）。 */
export class PdfEncryptedError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "PdfEncryptedError";
  }
}

/** 能力边界之外的特征（诚实说明，不猜文本）。 */
export class PdfUnsupportedError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "PdfUnsupportedError";
  }
}
