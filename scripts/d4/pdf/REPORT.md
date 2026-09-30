# D4-0 PDF fixture generator — run report

生成器：`scripts/d4/gen-pdf-fixtures.mjs`（零 npm 依赖；node:fs / node:crypto /
node:zlib / node:path / node:os / node:child_process）。本报告的每一项声明都来自
2026-09-30 在本机（macOS 26.6.2, Node v24.21.0）实际执行的命令，命令与输出摘录
见各节。

产出（34 个文件，全部确定性可复现）：

```
tests/fixtures/d4/b1-import/pdf/pdf-01..12.pdf + pdf-01..12.expected.json
tests/fixtures/d4/b1-import/pdf-registry.json
tests/fixtures/d4/b1-import/negative/neg-pdf-{encrypted,corrupt,image-only,zero-text}.{pdf,json}
tests/fixtures/d4/b2-anchors/pdf-selections.json
```

规范（d4-pdf-v1）钉死的阅读顺序（`scripts/d4/pdf/layout.mjs` 为唯一实现，
生成侧与提取侧共用同一函数，不允许私有复刻）：按 x 把行聚成栏带（相邻 x 差
> 40pt 开新带；双栏页先整栏左、后整栏右），带内自上而下（PDF y 递减），同 y
按 x 升序、再按内容流顺序；页眉页脚只是普通行。页文本 = 行以 "\n" 连接；除末
页外每页块以 "\n" 结尾；全程不做任何 Unicode 归一化。

## 1. Fixture 清单（12 个 B1 文字层 PDF）

命令：`node scripts/d4/gen-pdf-fixtures.mjs`（完整输出见 §6）

| id | 页数 | PDF 字节 | SHA-256 | canonicalText UTF-16 单元 | coverage |
|---|---|---|---|---|---|
| pdf-01 | 2 | 105408 | 38a0715233f29d8d20d391d87fc8c6c6e2fff7bd7421f7e95e8f999178259ae1 | 1109 | zh |
| pdf-02 | 2 | 6025 | d0e118356be60a2ba83f548f93f5bea9627695e279490eb821f55a70d43c2d0e | 3270 | en |
| pdf-03 | 2 | 79677 | e8396d2dc3129f2c9c38c539aae957031dfbac67b8dfebb5094d913727634a76 | 1864 | zh,en |
| pdf-04 | 2 | 76269 | b2edc22d823e7fe02438bf90d8f33fec51e919b1469f591b9a27871d76ec7b05 | 1528 | code |
| pdf-05 | 2 | 111511 | d6ffe011b6472b0424f7cb3bffbaeab785f14cb16ba45537e35802b0a10f3d60 | 1277 | repeated-words,zh |
| pdf-06 | 2 | 148082 | 9e2f59211a32afc52c0b0b402597272309664b79cd695e0018935eb97f0d7366 | 1815 | two-column |
| pdf-07 | 4 | 159585 | 43276e510384695a5809276d2dbb364e60bf2fc921d3e9f6be06912ba6656357 | 2643 | header-footer |
| pdf-08 | 10 | 281716 | 6a8e377c133de12ad118537d26b019765deb7a141cc0b4dcae3e4a726ce821e5 | 9239 | multipage |
| pdf-09 | 2 | 181196 | 9bc87c5b8da04fd2c1630592a4656149073df91f0d2c78cf3d41e6834d34e0eb | 1019 | combining,full-width |
| pdf-10 | 2 | 59824 | 677d8de5a1a8472b2232959f6080929179603ab95ed6ae909c5363006857e9dd | 1487 | fonts |
| pdf-11 | 30 | 173479 | 3f3dc889b0d6349f0e629873c478ba2248bbc74cd1a7986bf8def17b0019f23f | 3775 | long-tail,zh |
| pdf-12 | 2 | 220500 | e7de6a440b2b6d29b357b97805caa87cdbe0eff6a28ffcd00094a11d1cac7991 | 958 | unicode,astral |

负例（4 个，registry 中 `outcome: rejected`）：

| id | 字节 | SHA-256 | reason |
|---|---|---|---|
| neg-pdf-encrypted | 1573 | aa1e5d7d7c830a7745acb0fbf031eddb0d30d96cd39cb7ccfc70167527f2e835 | encrypted |
| neg-pdf-corrupt | 2690 | 280d3e0e86115b1df5aa49252bddf658b5098b0ee9aa1dec50fdafffa0931a0c | corrupt |
| neg-pdf-image-only | 1432 | 393893a42f14bc673deba3badf3595173c22c40354f1c23874962f5960c5cab8 | no-text-layer |
| neg-pdf-zero-text | 736 | 4856f664423c15e6c92bb38c0975d1068bf1d754d5ad33ef06867b0f46d9fd74 | no-text-layer |

登记文件哈希：`b1-import/pdf-registry.json` =
`0ed511b9a904252b791ee55c8da0bf0d9e0d7d4c5e7417a3bed5f9068d67868d`；
`b2-anchors/pdf-selections.json` =
`2ea2408d3f99cddadc840fe22e836485954cc6a199152a5bad1dc96bc18a68b3`。
（`scripts/d4/pdf/run-summary.json` 保存了同一数据的机器可读版。）

内容为真实中英双语编程/学习笔记（递归、闭包、算法手记、编码样本等），无占位
文本；页数在生成时被断言（pdf-08 恰 10 页、pdf-11 恰 30 页等），重复词
pdf-05 中「递归」出现 18 次、跨两页分布。

## 2. 字体与子集

Latin 文本：base-14 Type1（Helvetica / Helvetica-Bold / Courier）+
WinAnsiEncoding，不嵌入（宽度表来自标准 AFM，逐字符断言）。

CJK 文本：/Type0 + /Identity-H + /CIDFontType2，FontFile2 为**系统字体的手工
子集**（保留原始 glyph ID、/CIDToGIDMap /Identity；稀疏 glyf/loca（未用槽位
为零长条目）；maxp.numGlyphs 截断为 maxUsedGid+1；hmtx 按源语义复制；cmap 重
建（BMP 走 format 4 常量 delta 段合并，含非 BMP 码位时加 (3,10) format 12）；
head/hhea/maxp 复制；cvt/fpgm/prep 源字体存在则带上；表校验和与
head.checkSumAdjustment 正确计算）。每个 CID 字体都带 ToUnicode CMap
（bfchar：GID→UTF-16BE）与按源 hmtx 计算的 W 数组。

字体来源（任务指定的首选 + 如实记录的回落）：

| 角色 | 文件 | 用途 |
|---|---|---|
| songti | /System/Library/Fonts/Supplemental/Songti.ttc（子字体 0，TTC 头解析取首个） | 10 个 fixture 的主 CJK 字体（任务钉定） |
| stheiti | /System/Library/Fonts/STHeiti Light.ttc（子字体 0） | pdf-09 组合字符、pdf-12 扩展区/代理对：Songti #0 **没有**组合记号（U+0300–036F 全部 gid 0）、没有扩展 A/B、没有 U+3007 |
| arialu | /System/Library/Fonts/Supplemental/Arial Unicode.ttf | pdf-12 的 U+FFFD（探测到的唯一有该字形的系统字体） |

回落说明：Hiragino Sans GB 是 CFF 轮廓（非 TrueType），不能作 CIDFontType2 嵌
入，未采用。Songti 可用且用作主字体；两个特殊 fixture 因覆盖缺口改用 STHeiti
Light / Arial Unicode，属于如实适配（见「限制」）。

子集体积（raw = 子集 TTF 字节数；embedded = PDF 内 Flate 压缩后的 FontFile2 字节数）：

| fixture | 字体 | 码位数 | 字形数（含组件） | raw | embedded |
|---|---|---|---|---|---|
| pdf-01 | SongtiSC | 365 | 366 | 157028 B | 92214 B |
| pdf-03 | SongtiSC | 270 | 271 | 117496 B | 68091 B |
| pdf-04 | SongtiSC | 265 | 266 | 112152 B | 64760 B |
| pdf-05 | SongtiSC | 387 | 388 | 159372 B | 97266 B |
| pdf-06 | SongtiSC | 497 | 498 | 209732 B | 128028 B |
| pdf-07 | SongtiSC | 535 | 536 | 217352 B | 135385 B |
| pdf-08 | SongtiSC | 877 | 878 | 350376 B | 223314 B |
| pdf-09 | STHeitiLight | 215 | 216 | 523560 B | 122106 B |
| pdf-09 | SongtiSC | 198 | 199 | 81164 B | 44282 B |
| pdf-10 | SongtiSC | 201 | 202 | 93224 B | 50034 B |
| pdf-11 | SongtiSC | 546 | 547 | 219876 B | 136456 B |
| pdf-12 | STHeitiLight | 266 | 267 | 564072 B | 145739 B |
| pdf-12 | ArialUnicode | 64 | 67（含 2 个复合字形及其组件） | 250904 B | 61543 B |

体积说明（如实）：「每个子集 < 200 KB」的目标在**嵌入式（Flate 压缩后）**尺寸
上除 pdf-08 外全部达标（其余单个子集 ≤ 146 KB）。pdf-08 的 Songti 子集
embedded 223 KB——它携带全集最大的字符清单（877 码位），如需压到 200 KB 以下
只能删内容。STHeiti/ArialU 子集 raw 很大（≈0.5 MB）是「保留原始 glyph ID」钉
定策略的固有代价：numGlyphs≈52000 导致 loca（4 B/槽）与 hmtx 各约 207 KB，但
其中绝大部分是零/常量，Flate 后压缩比 ≈4:1（见上表 embedded 列）。子集表构成
经核验：Songti 子集 = `cmap glyf head hhea hmtx loca maxp`（源字体无
cvt/fpgm/prep，如实不带）；STHeiti/ArialU 子集含 `cvt fpgm prep`（源自源字
体，如实带上）。复合字形通路由 ArialUnicode 子集真实行使（64 码位 → 67 字
形）。

## 3. 星面（astral）覆盖的答案

**有，且为真实覆盖。** 探测结论（生成前用 node 直读各字体 cmap）：

- Songti.ttc 子字体 0：cmap 只有 format 4（BMP）；U+20000/U+2A6A2 等 Ext-B 全
  部无字形，组合记号、U+3400（扩展 A）、U+3007、U+FFFD 亦无。
- STHeiti Light.ttc 子字体 0：cmap 含 format 12，覆盖大量 CJK 扩展 B（如
  U+2000B 𠀋、U+20016 𠀖、U+2002A 𠀪、U+20032 𠀲、U+20046 𠁆、U+20040 𠁀
  …）、扩展 A（U+3400、U+3405、U+3499、U+34DF、U+4DB5）、U+3007、U+F8FF，
  以及组合记号（U+0301/0308/030A/0323 等）。
- Arial Unicode.ttf：有 U+FFFD（及 U+FFFC、U+FD3E）与组合记号；无 Ext-B。

因此 pdf-12 用 STHeiti 承载 17 个互不重叠的扩展 B 字符（UTF-16 中各占一对代理
项，canonicalText 与选区真实行使代理对偏移数学）＋扩展 A 样例，U+FFFD 行由
Arial Unicode 渲染；registry 的 coverage 如实声明 `unicode,astral`。**不冒领的
部分**：代理区紧邻的 U+D7FF 与 U+E000 在本机所有候选系统字体中都没有字形（逐
一探测过 Songti×8、STHeiti、Hiragino、ArialU），pdf-12 正文亦如实写明这一点；
代理对语义由 Ext-B 字符承担，BMP 末端语义由 U+FFFD 承担。astral/代理对的完整
口径由 Markdown 集补充（本报告不代其声明）。

## 4. 自检结果（生成器每次运行都执行，失败即拒绝写盘）

命令：`node scripts/d4/gen-pdf-fixtures.mjs`（含渲染冒烟）／
`node scripts/d4/gen-pdf-fixtures.mjs --no-render`（跳过）。

1. **往返提取（核心真值断言）**：`scripts/d4/pdf/extract.mjs` 重新解析刚生成
   的每个 PDF（xref、对象、页树、内容流、ToUnicode/WinAnsi 反查、钉死阅读顺
   序），逐页断言与 expected 一致——
   `round-trip: 12/12 fixtures extract to their expected canonicalText exactly`
   （含结构校验：每个 xref 偏移确实指向其 `N 0 obj` 头）。
2. **确定性**：进程内完整构建两次并逐字节比对——
   `determinism: 34/34 files byte-identical across two in-process builds`；
   另做文件级双生成比对（§5）。
3. **选区真值**：30 项的 start/end/excerpt/blockId 全部由 canonicalText 计算
   并断言（slice 全等、块包含、类别谓词：cross-line 必含 "\n"、long-tail 必在
   末 20%、repeat-word-2nd 必须 occurrence ≥ 2、two-column-left/right 的命中
   行 x 落在对应栏带、header/footer 命中行 y 位置正确）。类别计数：
   `{"zh":3,"cross-line":4,"en":2,"repeat-word-2nd":5,"code":2,"two-column-left":1,"two-column-right":1,"header":1,"footer":1,"multipage":1,"long-tail":4,"unicode":4,"fonts":1}`
   （全部 ≥ 项目书 B2 要求：repeat-word-2nd ≥4、cross-line ≥3、long-tail ≥3、
   unicode ≥2）。locator 构成：text-occurrence 28 + utf16-range 2。
4. **负例行为**：
   `negatives: encrypted -> "encrypted: trailer carries /Encrypt (…)"; corrupt -> "assert failed: no startxref/%%EOF at end of file (…)"; image-only/zero-text -> zero text lines`。
   加密负例的真实性另有专检：RC4 解密 object 4 的流后与明文内容流逐字节全等
   （算法 3.2/3.3/3.5，V2/R3/128-bit，空用户口令，对象密钥 = MD5(key+objnum
   低 3 字节+gen 低 2 字节) 截取）。
5. **PNG 负例素材**：手工 PNG（zlib + 自实现 CRC32）64×64 灰度渐变，
   `sips -g pixelWidth -g pixelHeight -g format` 读回 =
   `pixelWidth: 64 / pixelHeight: 64 / format: png`（428 B，
   sha256 22115e96…8d1f41）。

## 5. 独立验证（生成器之外，实际执行过的命令）

**文件级双生成确定性**（两份完整生成 + shasum 比对）：

```
$ rm -rf /tmp/d4-det-a /tmp/d4-det-b
$ node scripts/d4/gen-pdf-fixtures.mjs --no-render --out /tmp/d4-det-a   # → OK: all self-checks passed.
$ node scripts/d4/gen-pdf-fixtures.mjs --no-render --out /tmp/d4-det-b   # → OK: all self-checks passed.
$ (cd /tmp/d4-det-a && find . -type f | sort | xargs shasum -a 256) > /tmp/d4-det-a.shasum
$ (cd /tmp/d4-det-b && …同上…) > /tmp/d4-det-b.shasum
$ diff /tmp/d4-det-a.shasum /tmp/d4-det-b.shasum && echo OK
DETERMINISM OK: two full generations byte-identical (34 files)
# 与仓内 tests/fixtures/d4 的 34 个 PDF 侧文件亦逐字节一致
# （diff 仅显示本报告范围外的既有文件 README.md、b6-scale/、b9-nav/）
```

**Chrome 渲染冒烟**（生成器内置，`scripts/d4/pdf/render-smoke.mjs`，零依赖 CDP
客户端沿用 `scripts/run-d3-browser.mjs` 的启动/WebSocket 手法；自实现 PNG 解码
+像素统计，对照 about:blank 空白对照）：

```
render smoke: pass — 3/3 PDFs rendered non-blank in headless Chrome
  (pixel-ink check vs about:blank control)
  pdf-01.pdf ok  darkFraction 0.3954  stdDev 99.5   (control 0.00000 / 0.00)
  pdf-06.pdf ok  darkFraction 0.4360  stdDev 99.9   (control 0.00000 / 0.00)
  pdf-12.pdf ok  darkFraction 0.3520  stdDev 98.7   (control 0.00000 / 0.00)
```

**Apple CoreGraphics + Vision OCR（第二/第三方渲染面，macOS 独立复核）**：
`sips` 渲染 PDF 首页（其 PNG 带 alpha，需转 jpeg 拍平），
`swift scripts/d4/pdf/probe-ocr.swift`（Vision 框架，zh-Hans+en-US）：

- pdf-01（Songti 子集）OCR 开头（逐字命中正文，标点被 OCR 吞属正常噪声）：
  `递归学习笔记 / 递归是一种把大问题分解成同构小问题的思考方式写递归函数时最重要的不是立 / 刻追踪每一层调用…`
- pdf-02（Helvetica）：整段英文近乎逐字回读
  （`Recursion is a way of thinking about problems: solve a large instance by solving smaller instances…`）。
- pdf-12（STHeiti 扩展区）：正文与标题可读，扩展 B 生僻字 OCR 返回形近常用字
  （如 𠀋𠀖𠀪𠀲𠁆 →「丈共其修查」——超出 Vision 识别词表属预期；其中 𠁆 在
  pdf-12 页面 OCR 中曾被逐字识别出来），证明渲染出的是真实笔画而非空白/豆腐块。
- 大字号 STHeiti 探针（36pt 单行，正文「分解式组合字符：…」）OCR 中文部分逐字
  正确：`分解式组合字符：c af e、`；带组合记号的拉丁序列会让行级 OCR 断行
  （渲染与提取不受影响，见 §7 限制 2）。

**CoreText 字体装载复核**（从 pdf-01 提取 FontFile2 解压后交给
`swift scripts/d4/pdf/probe-font.swift`）：

```
CoreText descriptors: 1
loaded: font00000000306d297e glyphs: 5658 upem: 1000
```

（子集 TTF 被系统字体栈作为合法 TrueType 装载；numGlyphs=5658=maxUsedGid+1，
与稀疏策略一致。子集不带 name 表，CoreText 自动命名为 fontXXXX，不影响 PDF 嵌
入语义。）

## 6. 最后一次完整运行

```
$ node scripts/d4/gen-pdf-fixtures.mjs
D4 PDF fixture generator (d4-pdf-v1)
node v24.21.0; fonts: Songti.ttc, STHeiti Light.ttc, Arial Unicode.ttf
built 12 fixtures + 4 negatives + selections in 380ms
determinism: 34/34 files byte-identical across two in-process builds
round-trip: 12/12 fixtures extract to their expected canonicalText exactly
negatives: encrypted -> "encrypted: trailer carries /Encrypt (text-layer import must …";
            corrupt -> "assert failed: no startxref/%%EOF at end of file (truncated …";
            image-only/zero-text -> zero text lines
wrote 34 files under <repo>/tests/fixtures/d4
…（逐 fixture 的 round-trip 进度行，12/12 通过；清单表见 §1）…
selections: 30 items; categories: {…见 §4…}
render smoke: pass — 3/3 PDFs rendered non-blank in headless Chrome (pixel-ink check vs about:blank control)
OK: all self-checks passed.
```

## 7. 限制（如实）

1. **pdf-08 子集超 200 KB**：embedded 223 KB（877 码位，全集最大字符清单），
   其余子集 embedded ≤ 146 KB。raw TTF 尺寸（最高 564 KB）是「保留原始 glyph
   ID」策略的固有结果，PDF 内实际嵌入的是 Flate 压缩流。
2. **组合记号的渲染观感**：STHeiti 的组合记号按字形自身度量（零宽/负偏移）叠
   加，无 GPOS 标记定位；12pt 下 Apple Vision 行级 OCR 会被拆开的记号干扰。
   文本层的正确性（提取与选区）由往返断言逐字证明；渲染冒烟只声明「非空白、
   有真实笔画」。
3. **代理区紧邻码位（U+D7FF/U+E000）**：本机所有候选系统字体均无字形，样本
   未包含；代理对语义由扩展 B 字符承担（§3）。
4. **hinting**：源字体带 cvt/fpgm/prep 时如实复制（STHeiti/ArialU 子集含
   之）；Songti #0 本身没有这三张表。未做任何 hint 重建。
5. **渲染冒烟的口径**：Chrome 像素墨量 + Apple CoreGraphics 渲染 + Vision OCR
   三面证据，但不是人工逐屏签收口径；OCR 对 12pt 细笔画（STHeiti Light）与生
   僻扩展区字符的识别噪声已如实记录（§5）。
6. **生成器只保证自有输出形态**：提取器按「理解本生成器所需」的子集实现
   （经典 xref、一页树、未压缩或 Flate 流、Identity-H CID + Type1/WinAnsi），
   不是通用 PDF 解析器；未来 D4-1 解析器以 expected 真值为验收目标，不以本提
   取器的实现范围为上限。
