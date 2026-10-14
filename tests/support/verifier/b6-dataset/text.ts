/** text owner; frozen probe bodies and order preserved. */

import { DeterministicRng } from "../../../../apps/studio/src/nav/deterministic-rng.ts";
import { B6_SEED } from './policy.ts';


/* ------------------------------------------------------------------ */
/* 词表与句式模板（中英混排真实感学习笔记；全部 BMP、Songti 可覆盖）      */
/* ------------------------------------------------------------------ */

export const TOPICS_ZH = [
  "贝叶斯推断", "光合作用", "唐代诗歌意象", "城市交通规划", "量子纠缠",
  "统计机器翻译", "古罗马道路", "湿地生态系统", "神经可塑性", "文艺复兴透视法",
  "算法复杂度", "板块构造", "茶汤风味化学", "明代漕运", "概率图模型",
  "宋代货币史", "湿地碳循环", "机器学习评估", "古文献校勘", "河口泥沙输运",
] as const;


export const TOPICS_EN = [
  "Bayesian inference", "photosynthesis", "Tang poetry imagery", "urban transit",
  "quantum entanglement", "statistical machine translation", "Roman roads",
  "wetland ecosystems", "neural plasticity", "Renaissance perspective",
  "algorithm complexity", "plate tectonics", "tea flavor chemistry",
  "Ming grain transport", "probabilistic graphical models", "Song dynasty coinage",
  "wetland carbon cycling", "model evaluation", "textual criticism", "estuary sediment",
] as const;


export const ASPECTS_ZH = [
  "入门路径", "核心疑问", "对比实验", "历史脉络", "常见误解", "延伸问题",
  "实践笔记", "关键反例", "复习要点", "方法论辨析", "适用边界", "证据等级",
] as const;


export const VERBS = ["建立", "检验", "记录", "对比", "拆解", "复核", "归纳", "追问"] as const;

export const OBJECTS_ZH = [
  "主干问题", "边界条件", "反例清单", "证据链", "前提假设", "术语定义",
  "量级估计", "失败模式", "复习间隔", "交叉验证",
] as const;


/** 单句模板（确定性句式族；单位量级 20–70）。 */
export function sentence(rng: DeterministicRng): string {
  const zh = rng.pick(TOPICS_ZH);
  const en = rng.pick(TOPICS_EN);
  const aspect = rng.pick(ASPECTS_ZH);
  const verb = rng.pick(VERBS);
  const obj = rng.pick(OBJECTS_ZH);
  switch (rng.int(0, 7)) {
    case 0:
      return `学习${zh}时，${aspect}要求先${verb}${obj}，再谈细节；${en} gives the same lesson from another angle.`;
    case 1:
      return `${zh}的${aspect}里最常见的误解，是把相关当因果；复习时应专门准备一个反例并写清它推翻的是哪一步。`;
    case 2:
      return `对照${en}的表述回看${zh}：两套语言各自强调什么、省略什么，正是${aspect}要回答的问题。`;
    case 3:
      return `笔记先${verb}${obj}，再把${zh}的${aspect}放回主干；细节只有挂在主干上才留得住。`;
    case 4:
      return `把${aspect}写成问题而不是结论：${zh}在什么条件下成立？证据来自哪类${obj}？`;
    case 5:
      return `间隔复习${zh}：第一次只核对${obj}是否仍然成立，第二次才展开${aspect}的细节推导。`;
    case 6:
      return `${en} literature treats this as settled; the interesting question for ${zh} is where its ${aspect} breaks.`;
    default:
      return `凡引入新术语，先写一句话定义再${verb}${obj}——${zh}的${aspect}尤其如此。`;
  }
}


/** 段落（3–5 句；句式模板单句 ≤~95 单元，段落因此 ≤~475 单元）。 */
export function paragraph(rng: DeterministicRng, sentenceCount: number): string {
  const parts: string[] = [];
  for (let i = 0; i < sentenceCount; i += 1) parts.push(sentence(rng));
  return parts.join("");
}


/** 标定文本：精确 remaining 单元的确定性收尾（重复短语裁到精确长度）。 */
export const CALIBRATION_FILLER = "把每一步的依据写回主干问题，边界条件逐一列清；";

export function calibrationText(seedStep: string, remaining: number): string {
  if (remaining < 8) {
    // 极短余量：以「要点 + 数字」短语填满（仍为非空行）。
    return `要点${String(remaining).padStart(2, "0")}`.slice(0, remaining);
  }
  const rng = DeterministicRng.forStep(B6_SEED, seedStep);
  let text = `${rng.pick(TOPICS_ZH)}的收束：`;
  while (text.length + CALIBRATION_FILLER.length <= remaining) text += CALIBRATION_FILLER;
  if (text.length < remaining) {
    text += CALIBRATION_FILLER.slice(0, remaining - text.length);
  }
  return text.slice(0, remaining);
}


/** 唯一 needle（模板永不产出；跨语料唯一性由不变量复核）。 */
export function b6Needle(materialIndex: number): string {
  return `【针标B6-${String(materialIndex).padStart(3, "0")}】`;
}


export function pad(value: number, width: number): string {
  return String(value).padStart(width, "0");
}
