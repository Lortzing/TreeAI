import { join } from "node:path";
import { writeFileSync } from "node:fs";
/** browser-input runner operations with the original shared run state Instance-owned state and dependencies. */

export function createBrowserInput(deps) {

  /* ------------------------------------------------------------------ */
  /* CDP 驱动助手（真实输入事件 + DOM 断言）                              */
  /* ------------------------------------------------------------------ */

  async function evalJs(expression, timeoutMs = deps.CDP_SEND_TIMEOUT_MS) {
    const result = await deps.chrome.cdp.send(
      "Runtime.evaluate",
      { expression, returnByValue: true, awaitPromise: true },
      timeoutMs,
    );
    if (result.exceptionDetails !== undefined) {
      const detail = result.exceptionDetails.exception?.description ?? result.exceptionDetails.text;
      throw new Error(`page evaluate failed: ${deps.truncate(detail ?? "unknown", 400)}\n  at: ${deps.truncate(expression, 200)}`);
    }
    return result.result.value;
  }

  /** 轮询直到页面内表达式为真值（或超时）。 */
  async function waitForJs(expression, timeoutMs, label) {
    const deadline = Date.now() + timeoutMs;
    for (;;) {
      const value = await evalJs(expression);
      if (value) return value;
      if (Date.now() >= deadline) {
        throw new Error(`timeout (${String(timeoutMs)}ms) waiting for: ${label ?? expression}`);
      }
      await deps.sleep(80);
    }
  }

  /** 元素滚入视口并返回其视口坐标矩形（点击/拖选的落点基础）。 */
  async function rectInView(selector) {
    await evalJs(
      `(() => { const el = document.querySelector(${JSON.stringify(selector)}); ` +
        "if (el !== null && typeof el.scrollIntoView === 'function') el.scrollIntoView({ block: 'center' }); })()",
    );
    await deps.sleep(60); /* 等一帧滚动落位 */
    return evalJs(
      `(() => { const el = document.querySelector(${JSON.stringify(selector)}); ` +
        "if (el === null) return null; const r = el.getBoundingClientRect();" +
        "return { x: r.x, y: r.y, width: r.width, height: r.height, " +
        "visible: r.width > 0 && r.height > 0 && r.bottom > 0 && r.top < window.innerHeight }; })()",
    );
  }

  async function click(selector) {
    const rect = await rectInView(selector);
    deps.assert(rect !== null, `click target not found: ${selector}`);
    deps.assert(rect.visible, `click target not visible: ${selector}`);
    const x = rect.x + rect.width / 2;
    const y = rect.y + rect.height / 2;
    /* 覆盖层防护：点击点必须命中目标（或其子元素）——来源抽屉等 fixed
       覆盖层会把点击静默吞掉（真实用户同样点不到被盖住的按钮）。 */
    const hit = await evalJs(
      `(() => { const el = document.elementFromPoint(${String(x)}, ${String(y)}); ` +
      `const target = document.querySelector(${JSON.stringify(selector)}); ` +
      "return el !== null && target !== null && (el === target || target.contains(el)); })()",
    );
    deps.assert(hit === true, `click point of ${selector} is covered by another element (fixed overlay open?) — elementFromPoint mismatch`);
    await deps.chrome.cdp.send("Input.dispatchMouseEvent", { type: "mousePressed", x, y, button: "left", buttons: 1, clickCount: 1 });
    await deps.chrome.cdp.send("Input.dispatchMouseEvent", { type: "mouseReleased", x, y, button: "left", buttons: 0, clickCount: 1 });
    await deps.sleep(120); /* 事件处理 + 渲染落位 */
  }

  /** 真实键盘提交（Cmd/Ctrl+Enter）：app.js 的 keydown 监听路径。 */
  async function pressModifierEnter(modifier) {
    const modifiers = modifier === "meta" ? 4 : 2;
    const key = { key: "Enter", code: "Enter", windowsVirtualKeyCode: 13, nativeVirtualKeyCode: 13, modifiers };
    await deps.chrome.cdp.send("Input.dispatchKeyEvent", { type: "keyDown", ...key });
    await deps.chrome.cdp.send("Input.dispatchKeyEvent", { type: "keyUp", ...key });
    await deps.sleep(120);
  }

  /** 真实单键（Esc 逐层关闭等）：app.js 的 document keydown 监听路径。 */
  async function pressKey(key, code, windowsVirtualKeyCode) {
    await deps.chrome.cdp.send("Input.dispatchKeyEvent", { type: "keyDown", key, code, windowsVirtualKeyCode });
    await deps.chrome.cdp.send("Input.dispatchKeyEvent", { type: "keyUp", key, code, windowsVirtualKeyCode });
    await deps.sleep(200); /* 抽屉/面板收起的 170ms 退出动画窗口 */
  }

  /** 聚焦可编辑元素并注入文本（走浏览器原生输入管线，等价粘贴路径）。
   * replace=true 时先建立全选（textarea 上 setSelectionRange(0, len)——与
   * 用户 ⌘A 等价的选区），insertText 随后经原生编辑管线替换选区。
   * （失败 prompt 会把文本留在输入框，append 会把恢复 prompt 拼成
   * /fail… 前缀；Return 草稿框亦按 W1 预填上一答案——全选覆盖是唯一
   * 确定性路径。） */
  async function typeInto(selector, text, { replace = false } = {}) {
    const rect = await rectInView(selector);
    deps.assert(rect !== null, `type target not found: ${selector}`);
    deps.assert(rect.visible, `type target not visible: ${selector}`);
    await deps.chrome.cdp.send("Input.dispatchMouseEvent", { type: "mousePressed", x: rect.x + rect.width / 2, y: rect.y + rect.height / 2, button: "left", buttons: 1, clickCount: 1 });
    await deps.chrome.cdp.send("Input.dispatchMouseEvent", { type: "mouseReleased", x: rect.x + rect.width / 2, y: rect.y + rect.height / 2, button: "left", buttons: 0, clickCount: 1 });
    await deps.sleep(80);
    const focused = await evalJs(`document.activeElement !== null && document.activeElement.id === ${JSON.stringify(selector.replace(/^#/, ""))}`);
    deps.assert(focused === true, `type target did not take focus: ${selector}`);
    if (replace) {
      const selected = await evalJs(
        `(() => { const el = document.activeElement; el.setSelectionRange(0, el.value.length); ` +
        "return el.selectionStart === 0 && el.selectionEnd === el.value.length; })()",
      );
      deps.assert(selected === true, "replace-mode full selection did not take (setSelectionRange)");
      await deps.sleep(40);
    }
    /* 分块注入（A2 深选区相的 ~13k 字符 prompt）：insertText 走原生编辑
       管线逐块追加（IME 组合路径），末尾整值比对兜底——块边界行为异常即
       如实 FAIL，绝不静默截断。 */
    const CHUNK = 2000;
    for (let offset = 0; offset < text.length; offset += CHUNK) {
      await deps.chrome.cdp.send("Input.insertText", { text: text.slice(offset, offset + CHUNK) });
      await deps.sleep(30);
    }
    await deps.sleep(80);
    const value = await evalJs(`document.activeElement === null ? null : document.activeElement.value`);
    deps.assert(value === text, `typed text mismatch (got ${deps.truncate(String(value), 80)})`);
  }

  /**
   * 真实拖选：在元素的正文文本节点上按字符偏移 [from,to) 建立原生选区
   * （mousePressed → mouseMoved 序列 → mouseReleased），浏览器原生完成
   * Selection；元素自身的 mouseup 处理器随后读取 window.getSelection()
   * 计算 {start,end,text} 偏移（W1 §1.1 绝对偏移路径）。
   *
   * 落点精度（A2 深选区相所需的精确 [from,to) 语义）：按压点取 from 处
   * 字符盒左缘内 1px（最近字符边界 = 偏移 from），释放点取 to-1 处字符盒
   * 右缘内 1px（最近字符边界 = 偏移 to）——真实拖选以字符粒度落位，偏移
   * 即精确命中。长答案（数千字符、数百渲染行）的目标字符常在首屏之外
   * （scrollIntoView 整元素居中放不下）：把 [from,to] 区间中点滚到滚动层
   * 视口中央（先内层滚动容器、无则文档滚动——**长对话下本产品实际滚动的
   * 是文档**：#app 为 min-height 而非 height，#conversation 的 min-height:
   * auto 链被放开、内部滚动容器不启用；跑批器按实况滚动，该产品布局
   * 发现随 scrolledBy 事实登入检查 detail，由 owner 裁决），再以滚动后的
   * 坐标取矩形并派发真实鼠标事件（getBoundingClientRect 为视口相对值，
   * scrollTop 同步改后强制布局即为终值）。场景文本须保证 from 与 to-1 落
   * 在可见字符上（避开换行符与行缘空白——pre-wrap 下其字符盒不可靠）。
   */
  async function dragSelect(selector, from, to) {
    const points = await evalJs(
      `(() => {
        const el = document.querySelector(${JSON.stringify(selector)});
        if (el === null) return null;
        el.scrollIntoView({ block: 'center' });
        /* 只统计 <br> 之前的正文文本节点（其后是按钮与提示，不属于答案文本）。 */
        const walker = [];
        for (const node of el.childNodes) {
          if (node.nodeType === Node.ELEMENT_NODE && node.tagName === 'BR') break;
          if (node.nodeType === Node.TEXT_NODE) walker.push(node);
          if (node.nodeType === Node.ELEMENT_NODE && node.tagName === 'MARK') {
            for (const inner of node.childNodes) if (inner.nodeType === Node.TEXT_NODE) walker.push(inner);
          }
        }
        if (walker.length === 0) return null;
        const total = walker.reduce((n, node) => n + node.textContent.length, 0);
        const clamp = (i) => Math.max(0, Math.min(i, total));
        /* 偏移 → 字符盒：[i, i+1) 的 Range 矩形即第 i 个字符的渲染盒。 */
        const charBox = (target) => {
          const t = Math.max(0, target);
          let acc = 0;
          for (const node of walker) {
            const len = node.textContent.length;
            if (t < acc + len) {
              const range = document.createRange();
              range.setStart(node, t - acc);
              range.setEnd(node, t - acc + 1);
              const boxes = range.getClientRects();
              if (boxes.length > 0) return boxes[boxes.length - 1];
              return range.getBoundingClientRect();
            }
            acc += len;
          }
          return null;
        };
        let fromBox = charBox(clamp(${String(from)}));
        let toBox = charBox(clamp(${String(to)}) - 1);
        if (fromBox === null || toBox === null) return null;
        /* 目标区滚入安全视口带：从内层滚动容器向外找（无内层可滚则文档
           滚动——见函数头的产品布局注记），把区间中点滚到该层视口中央；
           逐层最多 3 轮（内层滚到头仍出带 → 下一轮向外层找）。
           v1.3.1：安全带以目标最近的滚动容器的可视矩形为准，并与窗口带
           取交（限高骨架下 #conversation 的可视带远小于窗口——上沿顶栏、
           下沿 composer；仅按窗口带判断时，位于容器裁剪沿之下的字符盒会
           被误判为已入带，拖选落点落到 composer 上，原生选区逃出答案
           turn，武装失败——2026-09-30 视觉重构波真实模型跨行深选区场景
           实录，回放见该波记录）。 */
        const clipRect = (() => {
          let node = el.parentElement;
          while (node !== null && node !== document.body) {
            const cs = getComputedStyle(node);
            if (/(auto|scroll|overlay)/.test(cs.overflowY) && node.scrollHeight > node.clientHeight) {
              return node.getBoundingClientRect();
            }
            node = node.parentElement;
          }
          return null;
        })();
        const bandTop = clipRect === null ? 80 : Math.max(80, clipRect.top + 24);
        const bandBottom = clipRect === null ? window.innerHeight - 80 : Math.min(window.innerHeight - 80, clipRect.bottom - 24);
        const inBand = () => Math.min(fromBox.top, toBox.top) >= bandTop && Math.max(fromBox.bottom, toBox.bottom) <= bandBottom;
        let searchFrom = el.parentElement;
        let scrolledBy = "none";
        for (let pass = 0; pass < 3 && !inBand(); pass += 1) {
          let scroller = searchFrom;
          while (scroller !== null) {
            const cs = getComputedStyle(scroller);
            if (/(auto|scroll|overlay)/.test(cs.overflowY) && scroller.scrollHeight > scroller.clientHeight) break;
            scroller = scroller.parentElement;
          }
          if (scroller === null) {
            const doc = document.scrollingElement;
            if (doc !== null && doc.scrollHeight > doc.clientHeight) scroller = doc;
          }
          if (scroller === null) break;
          scrolledBy = scroller === document.scrollingElement ? "document" : "container";
          const centerViewportY = scroller === document.scrollingElement
            ? window.innerHeight / 2
            : scroller.getBoundingClientRect().top + scroller.clientHeight / 2;
          const midY = (Math.min(fromBox.top, toBox.top) + Math.max(fromBox.bottom, toBox.bottom)) / 2;
          scroller.scrollTop += midY - centerViewportY;
          searchFrom = scroller === document.scrollingElement ? null : scroller.parentElement;
          const scrolledFrom = charBox(clamp(${String(from)}));
          const scrolledTo = charBox(clamp(${String(to)}) - 1);
          if (scrolledFrom === null || scrolledTo === null) break;
          fromBox = scrolledFrom;
          toBox = scrolledTo;
        }
        const inset = (box) => Math.min(1, box.width / 2);
        return {
          from: { x: fromBox.left + inset(fromBox), y: fromBox.top + fromBox.height / 2 },
          to: { x: toBox.right - inset(toBox), y: toBox.top + toBox.height / 2 },
          total,
          fromTop: fromBox.top,
          toTop: toBox.top,
          scrolledBy,
        };
      })()`,
    );
    deps.assert(points !== null, `dragSelect target has no selectable text: ${selector}`);
    await deps.sleep(60);
    const a = points.from;
    const b = points.to;
    await deps.chrome.cdp.send("Input.dispatchMouseEvent", { type: "mousePressed", x: a.x, y: a.y, button: "left", buttons: 1, clickCount: 1 });
    const steps = 8;
    for (let i = 1; i <= steps; i += 1) {
      await deps.chrome.cdp.send("Input.dispatchMouseEvent", {
        type: "mouseMoved",
        x: a.x + ((b.x - a.x) * i) / steps,
        y: a.y + ((b.y - a.y) * i) / steps,
        button: "left",
        buttons: 1,
      });
      await deps.sleep(15);
    }
    await deps.chrome.cdp.send("Input.dispatchMouseEvent", { type: "mouseReleased", x: b.x, y: b.y, button: "left", buttons: 0, clickCount: 1 });
    await deps.sleep(150); /* mouseup 处理器同步偏移计算 */
    return points;
  }

  async function navigate(url) {
    const loaded = new Promise((resolve) => deps.chrome.cdp.on("Page.loadEventFired", resolve));
    await deps.chrome.cdp.send("Page.navigate", { url });
    await Promise.race([loaded, deps.sleep(10_000)]);
    await waitForJs("document.readyState === 'complete'", 10_000, "document readyState complete");
    await deps.sleep(250); /* app.js 启动流程（refreshTrees/openTree/focus）落位 */
  }

  async function screenshot(name) {
    deps.chrome.screenshotSeq += 1;
    const result = await deps.chrome.cdp.send("Page.captureScreenshot", { format: "jpeg", quality: 70 });
    const file = join(deps.sc.artifactsDir, `${String(deps.chrome.screenshotSeq).padStart(2, "0")}-${name}.jpg`);
    writeFileSync(file, Buffer.from(result.data, "base64"));
    return file;
  }

  return {
    evalJs,
    screenshot,
    waitForJs,
    typeInto,
    pressModifierEnter,
    click,
    navigate,
    dragSelect,
    pressKey,
  };
}
