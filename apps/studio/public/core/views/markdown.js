/** Lossless Markdown reader view. Styling must preserve exact source text and UTF-16 offsets. */
export function createMarkdownRenderer(document) {
/**
 * d4-md-v1 的**无损字面渲染**：块文本逐字映射进 DOM——markdown 语法字符
 * 全部保留在文本中（标题的 #、强调的 *、行内代码的反引号、链接的
 * [label](url) 全语法），只按行/语法片段施加样式。container.textContent
 * 与块文本字节相等（选区偏移换算的事实源），绝不把文本当 HTML 解析。
 * 行级：ATX 标题行 → 标题样式段；```/~~~ 围栏行翻转代码状态（围栏跨块
 * 时由调用方经 fenceOpen 携带——分块读取下逐块推进）；行间换行保留为
 * 独立文本节点（CSS pre-wrap 成行）。
 */
function renderMarkdownInto(container, text, fenceOpen) {
  const lines = text.split("\n");
  for (let i = 0; i < lines.length; i += 1) {
    const line = lines[i];
    const isLast = i === lines.length - 1;
    if (line === "") {
      /* 空行片（只可能是末尾切片——块内无空白行）：无内容，仅补换行。 */
      if (!isLast) container.append(document.createTextNode("\n"));
      continue;
    }
    if (fenceOpen) {
      container.append(codeLineSpan(line));
      if (/^(```|~~~)/.test(line)) fenceOpen = false; /* 收栏行本身也呈代码样式 */
    } else if (/^(```|~~~)/.test(line)) {
      container.append(codeLineSpan(line));
      fenceOpen = true;
    } else if (/^#{1,6}\s/.test(line) || /^#{1,6}$/.test(line)) {
      const marks = line.match(/^#+/);
      const span = document.createElement("span");
      span.className = `mat-h${String(Math.min(marks === null ? 1 : marks[0].length, 6))}`;
      span.textContent = line;
      container.append(span);
    } else {
      renderInlineMarkdownInto(container, line);
    }
    if (!isLast) container.append(document.createTextNode("\n"));
  }
  return fenceOpen;
}

/** 代码行片段（围栏行与围栏内行——等宽呈现，字符逐字保留）。 */
function codeLineSpan(line) {
  const span = document.createElement("span");
  span.className = "mat-code-line";
  span.textContent = line;
  return span;
}

/**
 * 行内无损渲染（最小安全集）：行内代码 `…`、强强调 **…** / __…__、弱强调
 * *…* / _…_、链接 [label](url)。只加样式不删字符；未闭合/不成对的标记按
 * 字面输出（宁可不渲染样式，绝不改写字节——样式误判只影响外观，映射
 * 恒成立）。_…_ 要求词边界（snake_case 不斜体）；链接不导航（阅读面保持
 * 位置与选区，语法字符全保留——B2 冻结集的链接摘录即含完整语法）。
 */
function renderInlineMarkdownInto(container, line) {
  let at = 0;
  while (at < line.length) {
    const found = nextInlineMarker(line, at);
    if (found === null) {
      container.append(document.createTextNode(line.slice(at)));
      return;
    }
    if (found.start > at) container.append(document.createTextNode(line.slice(at, found.start)));
    const span = document.createElement("span");
    span.className = found.kind;
    span.textContent = line.slice(found.start, found.end);
    if (found.kind === "mat-link") {
      span.title = "link (rendered verbatim — the reader keeps your position and does not navigate)";
    }
    container.append(span);
    at = found.end;
  }
}

/** 最早的完整行内标记（含标记本身）；无匹配返回 null。 */
function nextInlineMarker(line, from) {
  for (let p = from; p < line.length; p += 1) {
    const ch = line[p];
    if (ch === "`") {
      const close = line.indexOf("`", p + 1);
      if (close > p) return { start: p, end: close + 1, kind: "mat-code" };
      continue;
    }
    if (ch === "*" || ch === "_") {
      const double = line.slice(p, p + 2);
      if (double === "**" || double === "__") {
        const close = line.indexOf(double, p + 2);
        if (close > p) return { start: p, end: close + 2, kind: "mat-strong" };
        continue;
      }
      /* 单标记弱强调：_ 需词边界开/闭（snake_case 不斜体）；* 允许词内。 */
      if (ch === "_" && p > 0 && !/[\s([{'“「（《,.;:!?]/.test(line[p - 1])) continue;
      let close = -1;
      for (let q = p + 1; q < line.length; q += 1) {
        if (line[q] !== ch) continue;
        if (line.slice(q, q + 2) === double) continue;
        if (
          ch === "_" &&
          q < line.length - 1 &&
          !/[\s)\]}'”」》）,.;:!?]/.test(line[q + 1])
        ) {
          continue;
        }
        close = q;
        break;
      }
      if (close > p + 1) return { start: p, end: close + 1, kind: "mat-em" };
      continue;
    }
    if (ch === "[") {
      const labelEnd = line.indexOf("](", p + 1);
      if (labelEnd > p) {
        const urlEnd = line.indexOf(")", labelEnd + 2);
        if (urlEnd > labelEnd) return { start: p, end: urlEnd + 1, kind: "mat-link" };
      }
    }
  }
  return null;
}
  return { renderMarkdownInto };
}
