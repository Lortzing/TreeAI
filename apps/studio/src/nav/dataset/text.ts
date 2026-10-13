/** text ownership for b9-dataset.ts; compatibility entrypoint remains one level above. */
import type {
  DeterministicRng,
} from "../deterministic-rng.ts";
import {
  ASPECTS_ZH,
  LONG_FILLER,
  LONGTITLE_BUILD_TARGET,
  TOPICS_EN,
  TOPICS_ZH,
} from "./policy.ts";

/** 普通节点标题：主题×侧面×句式（6 种，中英混排）。 */
export function nodeTitle(rng: DeterministicRng, seq: number): string {
  const zh = rng.pick(TOPICS_ZH);
  const en = rng.pick(TOPICS_EN);
  const aspect = rng.pick(ASPECTS_ZH);
  switch (rng.int(0, 5)) {
    case 0:
      return `${zh}的${aspect}`;
    case 1:
      return `${en} — ${aspect}`;
    case 2:
      return `关于${zh}的${aspect}（${en}）`;
    case 3:
      return `Notes on ${en}: ${aspect}`;
    case 4:
      return `${aspect}·${zh}·第${seq}问`;
    default:
      return `${zh} × ${en}：${aspect}`;
  }
}

/** 特殊树 trunk 标题（即树标题）：模板派生的中英混排固定句式。 */
export function specialTreeTitle(nameZh: string, nameEn: string): string {
  return `B9 特殊树·${nameZh}（${nameEn}）`;
}

/** 长标题：构造到 ≥240 UTF-16 单元（规格下限 200，留 20% 余量）。 */
export function longTitle(rng: DeterministicRng, treeId: string, seq: number): string {
  const head = `长标题节点 ${treeId} 第${seq}号 Long-title node ${String(seq)}: `;
  let body = `围绕${rng.pick(TOPICS_ZH)}与${rng.pick(TOPICS_EN)}的${rng.pick(ASPECTS_ZH)}展开。`;
  while (head.length + body.length < LONGTITLE_BUILD_TARGET) {
    body += LONG_FILLER;
  }
  return head + body;
}

/** Turn 来源锚点的回答文本（作为 source 的分支的 assistant Turn 全文）。 */
export function answerTextFor(rng: DeterministicRng, forTitle: string): string {
  const topic = rng.pick(TOPICS_ZH);
  const en = rng.pick(TOPICS_EN);
  let text = `关于「${forTitle}」的回答：${topic}与${en}的要点在于先建立主干再收集细节。`;
  text += "先给出结论的适用边界，再列证据与反例，最后回到原问题的表述检验是否已经回答完整。";
  text += `补充：${topic}里最常见的误解是把相关当因果，复习时应专门准备至少一个反例并写清它推翻的是哪一步。`;
  return text;
}

/* ------------------------------------------------------------------ */
/* 码点安全区间（选区不落在代理对中间；防御性——本数据集正文为 BMP）       */
/* ------------------------------------------------------------------ */

export function isLowSurrogate(code: number): boolean {
  return code >= 0xdc00 && code <= 0xdfff;
}

/** 在 text 内取长度约 length 的半开区间，边界移出代理对中间。 */
export function codePointSafeRange(text: string, start: number, length: number): { start: number; end: number } {
  const maxStart = Math.max(0, text.length - length - 1);
  let s = Math.min(Math.max(0, start), maxStart);
  let e = Math.min(text.length, s + length);
  while (s > 0 && isLowSurrogate(text.charCodeAt(s))) s += 1;
  while (e < text.length && isLowSurrogate(text.charCodeAt(e))) e += 1;
  return { start: s, end: e };
}
