/** R1 material selection controller: canonical UTF-16 grapheme-safe range snapping. */
/**
 * 图素簇边界集（B2 无效类别 inv-05/06/07 的前端镜像）：Intl.Segmenter
 * granularity "grapheme"（与服务端 range-resolver 同一判定）；无
 * Segmenter 的环境退化为仅代理对边界（组合序列无法判定——如实边界，
 * 现代浏览器/Node 24 均有 Segmenter）。块文本量级小，按需构建不缓存。
 */
const MATERIAL_GRAPHEME_SEGMENTER =
  typeof Intl !== "undefined" && typeof Intl.Segmenter === "function"
    ? new Intl.Segmenter(undefined, { granularity: "grapheme" })
    : null;

function graphemeBoundarySet(text) {
  const boundaries = new Set([0]);
  if (MATERIAL_GRAPHEME_SEGMENTER !== null) {
    let position = 0;
    for (const segment of MATERIAL_GRAPHEME_SEGMENTER.segment(text)) {
      position += segment.segment.length;
      boundaries.add(position);
    }
    return boundaries;
  }
  for (let i = 0; i < text.length; i += 1) {
    const code = text.charCodeAt(i);
    if (code >= 0xd800 && code <= 0xdbff) {
      const next = i + 1 < text.length ? text.charCodeAt(i + 1) : 0;
      if (next >= 0xdc00 && next <= 0xdfff) {
        boundaries.add(i + 2); /* 代理对中间 (i+1) 不可劈 */
        i += 1;
        continue;
      }
    }
    boundaries.add(i + 1);
  }
  return boundaries;
}

/**
 * 字素安全吸附（charter §3.2）：选区边界落在字素簇内（代理对中间、组合
 * 字符与基字符之间、emoji/ZWJ 序列内部）时**向外**吸附到整簇边界——载荷
 * 绝不劈开一个簇；吸附后的摘录即块文本切片（canonicalText 对应切片）。
 * 吸附后为空（理论不可达：进入时选区非空）→ null。
 */
export function clampToGraphemeBoundaries(text, start, end) {
  const boundaries = graphemeBoundarySet(text);
  let snapped = false;
  let safeStart = start;
  let safeEnd = end;
  if (!boundaries.has(safeStart)) {
    safeStart = snapBoundaryDown(boundaries, safeStart);
    snapped = true;
  }
  if (!boundaries.has(safeEnd)) {
    safeEnd = snapBoundaryUp(boundaries, safeEnd, text.length);
    snapped = true;
  }
  if (safeStart >= safeEnd) return null;
  return { start: safeStart, end: safeEnd, snapped };
}

function snapBoundaryDown(boundaries, position) {
  let best = 0;
  for (const boundary of boundaries) {
    if (boundary < position && boundary > best) best = boundary;
  }
  return best;
}

function snapBoundaryUp(boundaries, position, max) {
  let best = max;
  for (const boundary of boundaries) {
    if (boundary > position && boundary < best) best = boundary;
  }
  return best;
}
