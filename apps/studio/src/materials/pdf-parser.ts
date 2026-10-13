/**
 * d4-pdf-v1 PDF 文字层解析器（D4-1「材料存储和导入」，issue #8；
 * D4 契约 §1/§6 真值规则；charter §5 上限）。
 *
 * 职责：PDF 原始字节 → 规范文本 canonicalText + 每页块图 blocks。
 * 零 npm 依赖的纯 Node 实现（node:zlib 解 FlateDecode；其余手写），
 * 是 scripts/d4/pdf/extract.mjs + layout.mjs（冻结 fixture 波的参考
 * 往返提取器）的应用侧移植——**运行时不 import scripts/**（生成工具
 * 与应用自包含互不依赖）；两侧行为以 12 个冻结 fixture 的
 * *.expected.json 真值为共同裁决。
 *
 * 冻结规则（d4-pdf-v1，与 D4 契约 §6 一致）：
 *  1. 钉死阅读顺序（移植 layout.mjs orderPageLines，唯一实现）：
 *     - 「行」= 一次文字显示操作序列（Tj/TJ/'/"）；位置取 Tj 时刻文本
 *       矩阵的平移点（首字形原点）(x, y)；
 *     - 栏带：页内去重升序 x 值贪心聚带——x 超出当前带最大 x **超过
 *       40 PDF 点**开新带（双栏页先整栏左、后整栏右）；
 *     - 带严格从左到右；带内自上而下（PDF y 递减），同 y 按 x 升序、
 *       再按内容流顺序；页眉页脚只是普通行；
 *     - 页文本 = 行以 "\n" 连接；除末页外每页块以 "\n" 结尾；
 *     - 全程**无任何 Unicode 归一化**（分解式组合字符、星面代理对
 *       逐字保留，UTF-16 偏移按码元计）。
 *  2. blocks：blockId "page-N"（N 为 1-based 真实页码，空页不产生块
 *     但不占位）、kind "pdf-page"、start/end 为 canonicalText 内 UTF-16
 *     码元半开区间连续覆盖（首 0、末 = 长度）、page 1-based；
 *     canonicalText === blocks.map(b => b.text).join("")（构造性成立）。
 *  3. 拒绝（ok:false，原因码稳定，入 MaterialVersion.parseError 前缀）：
 *     - "encrypted"：trailer 携带 /Encrypt（加密件拒收，不尝试解密）；
 *     - "corrupt"：结构损坏（缺 %PDF- 头 / startxref/%%EOF、xref 错位、
 *       对象/trailer 形状破坏、流 /Length 失配、页树破坏、内容流操作
 *       数残缺、bfrange 数组值失配、未闭合内联图等）；
 *     - "no-text-layer"：全部页零文字显示操作（或拼得空文本）——
 *       纯图件/空内容流，绝不伪装成空 ready 文档；
 *     - "unsupported"：诚实能力边界（非 FlateDecode 流过滤器、
 *       非 Identity-H 的 Type0、无 ToUnicode 的 Type0、CID 无映射、
 *       非 WinAnsiEncoding 的 base Type1、其他字体子类型、
 *       xref 流/对象流等）——说明特征，不猜文本；
 *     - "pages-exceeded"：文本 PDF 超 200 页（charter §5，在解释任何
 *       内容流之前按页树页数拒绝）。
 *  4. 上限（charter §5，耗尽资源前拒绝）：页数上限经 options.maxPages
 *     注入（服务层共享 DEFAULT_MAX_PAGES = 200）；20 MiB 文件与
 *     100 万 UTF-16 单元上限在导入服务层（读体前 / 落库前）执行。
 *
 * 理解的 PDF 子集（与参考提取器一致的口径 + 少量标准泛化）：
 * 经典 xref 表（支持 /Prev 链；**不支持** xref 流/对象流）、未压缩或
 * FlateDecode 流（/Length 直数或间接引用）、可嵌套页树（页可继承
 * 父节点 /Resources）、Type0/Identity-H + ToUnicode（bfchar/bfrange，
 * bfrange 含顺序与**数组值**两种形态）与 base-14 Type1/WinAnsiEncoding
 * 字体、内容流文字操作 BT、ET、Tf、Td、TD、TL、T-star、Tm、Tj、TJ、
 * 单引号与双引号（其余操作符忽略；BI/ID/EI 内联图整段跳过——EI 判定
 * 为「前置空白 + 后随空白/分隔符」的通行启发式，无 /Length 时这是
 * 标准实践）。字体**惰性物化**：资源表只登记 名字 → 原始值，只有
 * 真正用于显示文字的字体（Tj/TJ/'/" 时的当前字体，且字节非空）才
 * 解析/校验——未用于显示的坏字体不拖垮整页。
 * 这是**应用解析器的诚实范围**，不是通用 PDF 规范实现；范围外特征
 * 一律按原因码拒绝，绝不静默产出猜测文本。
 */

/** Stable public PDF parser entrypoint. */
export {
  PDF_PARSER_KIND,
  PDF_PARSER_VERSION,
  DEFAULT_MAX_PAGES,
  PAGES_EXCEEDED_REASON,
} from "./pdf/policy.ts";
export type {
  PdfRejectionReason,
  PdfBlock,
  PdfParseSuccess,
  PdfParseRejection,
  PdfParseResult,
  PdfParseOptions,
  PageTextLine,
} from "./pdf/model.ts";
export {
  BAND_GAP,
  orderPageLines,
} from "./pdf/layout.ts";
export {
  parsePdfMaterial,
} from "./pdf/document.ts";
