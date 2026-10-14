/** PDF page frames, native canvas rendering, text geometry and bounded lazy page layers. Instance-owned state and dependencies. */
import { isElementNode } from "../dom.js";

export function createMaterialPdfView(deps) {

  /** PDF 懒渲染提前量（px）：页框落在 [视口顶 - 该值, 视口底 + 该值] 才渲染
      文本层；远页保持占位（charter §3.2：可见页先行渲染）。 */
  const PDF_PAGE_RENDER_OVERSCAN_PX = 1200;

  /** PDF 懒渲染的几何未知回落（滚动容器 clientHeight 为 0——脚本桩/未布局）：
      只渲染前导若干页，绝不在几何不明时整册渲染。 */
  const PDF_LEADING_RENDER_PAGES = 6;

  let pdfjsModulePromise = null;


  /**
   * PDF 页框（charter §3.2「真实页 + 可选中文本层」）：块即页——页框是
   * #mat-blocks 的定位单元（data-block-id / data-start / data-end /
   * data-page；滚动定位/窗口裁剪/阅读位置都以页框为对象）。页头标识
   * （「Page N」）在文本层**之外**——文本层 .material-block 的 textContent
   * 与页块文本字节相等（选区偏移换算的事实源，绝不混入页头文字）。文本层
   * 初始为占位（未渲染态），由 updatePdfPageRendering 按可见性填充。
   */
  function createPdfPageFrame(entry) {
    const frame = deps.document.createElement("div");
    frame.className = "pdf-page-frame";
    frame.dataset.blockId = entry.block.blockId;
    frame.dataset.start = String(entry.block.start);
    frame.dataset.end = String(entry.block.end);
    const page = typeof entry.block.page === "number" ? entry.block.page : null;
    if (page !== null) frame.dataset.page = String(page);
    const head = deps.document.createElement("div");
    head.className = "pdf-page-head";
    head.textContent = page === null ? entry.block.blockId : `Page ${String(page)}`;
    const canvas = deps.document.createElement("canvas");
    canvas.className = "pdf-page-canvas";
    canvas.setAttribute("aria-label", page === null ? "PDF page" : `PDF page ${String(page)}`);
    canvas.dataset.rendered = "false";
    // Reserve the parser's page geometry before async PDF.js paint changes intrinsic canvas size.
    // Source jumps and restored reading positions must not drift when an earlier page finishes painting.
    const geometry = entry.block.geometry;
    if (geometry !== undefined && geometry !== null &&
        Number.isFinite(geometry.pageWidth) && geometry.pageWidth > 0 &&
        Number.isFinite(geometry.pageHeight) && geometry.pageHeight > 0) {
      canvas.style.aspectRatio = `${String(geometry.pageWidth)} / ${String(geometry.pageHeight)}`;
    }
    const textLayer = deps.document.createElement("div");
    textLayer.className = "material-block pdf-page-text";
    textLayer.dataset.blockId = entry.block.blockId;
    textLayer.dataset.start = String(entry.block.start);
    textLayer.dataset.end = String(entry.block.end);
    if (page !== null) textLayer.dataset.page = String(page);
    textLayer.dataset.rendered = "false";
    textLayer.append(pdfPagePendingPlaceholder(page));
    frame.append(head, canvas, textLayer);
    return frame;
  }


  function pdfPageCanvas(frame) {
    for (const child of frame.children) {
      if (isElementNode(child) && child.classList.contains("pdf-page-canvas")) return child;
    }
    return null;
  }


  async function ensurePdfDocument(reader) {
    if (reader.pdfDocument !== null) return reader.pdfDocument;
    if (reader.pdfLoading !== null) return reader.pdfLoading;
    const url =
      `/api/trees/${encodeURIComponent(reader.treeId)}/materials/${encodeURIComponent(reader.materialId)}` +
      `/versions/${encodeURIComponent(reader.versionId)}/file`;
    reader.pdfLoading = (async () => {
      const pdfjs = await import("/vendor/pdfjs/pdf.mjs");
      pdfjs.GlobalWorkerOptions.workerSrc = "/vendor/pdfjs/pdf.worker.mjs";
      const loadingTask = pdfjs.getDocument({
        url,
        cMapUrl: "/vendor/pdfjs/cmaps/",
        cMapPacked: true,
        standardFontDataUrl: "/vendor/pdfjs/standard_fonts/",
      });
      const documentProxy = await loadingTask.promise;
      if (deps.state.materialReader === reader) reader.pdfDocument = documentProxy;
      return documentProxy;
    })();
    try {
      return await reader.pdfLoading;
    } catch (error) {
      reader.pdfError = String(error && error.message ? error.message : error);
      throw error;
    } finally {
      reader.pdfLoading = null;
    }
  }


  async function renderPdfOriginalPage(frame, entry, reader) {
    const pageNumber = typeof entry.block.page === "number" ? entry.block.page : null;
    const canvas = pdfPageCanvas(frame);
    if (pageNumber === null || canvas === null || canvas.dataset.rendered === "true") return;
    if (reader.pdfRenderTasks.has(frame)) return;
    try {
      const documentProxy = await ensurePdfDocument(reader);
      if (deps.state.materialReader !== reader) return;
      const page = await documentProxy.getPage(pageNumber);
      const viewport = page.getViewport({ scale: 1.25 });
      const context = canvas.getContext("2d");
      if (context === null) throw new Error("PDF canvas 2D context is unavailable");
      canvas.width = Math.ceil(viewport.width);
      canvas.height = Math.ceil(viewport.height);
      canvas.style.aspectRatio = `${String(viewport.width)} / ${String(viewport.height)}`;
      const renderTask = page.render({ canvasContext: context, viewport });
      reader.pdfRenderTasks.set(frame, renderTask);
      let timeoutId = null;
      try {
        await Promise.race([
          renderTask.promise,
          new Promise((_, reject) => {
            timeoutId = deps.window.setTimeout(() => reject(new Error("PDF page rendering timed out")), 8000);
          }),
        ]);
      } finally {
        if (timeoutId !== null) deps.window.clearTimeout(timeoutId);
      }
      canvas.dataset.rendered = "true";
      layoutPdfGeometryTextLayer(frame, entry);
    } catch (error) {
      reader.pdfError = String(error && error.message ? error.message : error);
      const task = reader.pdfRenderTasks.get(frame);
      task?.cancel?.();
      showNativePdfFallback(frame, reader);
    } finally {
      reader.pdfRenderTasks.delete(frame);
    }
  }


  function showNativePdfFallback(frame, reader) {
    const canvas = pdfPageCanvas(frame);
    if (canvas !== null) canvas.hidden = true;
    const textLayer = pdfPageTextLayer(frame);
    if (textLayer !== null) textLayer.hidden = true;
    let fallback = null;
    for (const child of frame.children) {
      if (isElementNode(child) && child.classList.contains("pdf-native-fallback")) fallback = child;
    }
    if (fallback !== null) return;
    fallback = deps.document.createElement("iframe");
    fallback.className = "pdf-native-fallback";
    fallback.title = "Native PDF page fallback";
    fallback.src =
      `/api/trees/${encodeURIComponent(reader.treeId)}/materials/${encodeURIComponent(reader.materialId)}` +
      `/versions/${encodeURIComponent(reader.versionId)}/file#page=${frame.dataset.page ?? "1"}`;
    frame.append(fallback);
  }

  function layoutPdfGeometryTextLayer(frame, entry) {
    const textLayer = pdfPageTextLayer(frame);
    const geometry = entry.block.geometry;
    if (textLayer === null || geometry === undefined || geometry === null) return;
    textLayer.style.width = "100%";
    textLayer.style.height = "100%";
    for (const child of textLayer.children) {
      if (!isElementNode(child) || !child.classList.contains("pdf-line")) continue;
      const start = Number(child.dataset.start ?? "-1");
      const line = geometry.lines.find((candidate) => candidate.start === start);
      if (line === undefined) continue;
      const fontSize = line.fontSize ?? 12;
      child.style.left = `${String((line.x / geometry.pageWidth) * 100)}%`;
      child.style.top = `${String(((geometry.pageHeight - line.y - fontSize) / geometry.pageHeight) * 100)}%`;
      child.style.fontSize = `${String(fontSize)}px`;
    }
  }

  /** 未渲染页的占位说明（远页不渲染文本——绝不含正文文字）。 */
  function pdfPagePendingPlaceholder(page) {
    const pending = deps.document.createElement("div");
    pending.className = "pdf-page-pending";
    pending.textContent =
      page === null
        ? "this page is off-screen — its text renders when scrolled into view"
        : `page ${String(page)} is off-screen — its text renders when scrolled into view`;
    return pending;
  }


  /** 渲染页文本层（幂等；返回是否本次真正填充）。canonical offsets are retained
      on every line; geometry is only a visual projection and never an anchor source. */
  function renderPdfPageText(frame, entry) {
    const textLayer = pdfPageTextLayer(frame);
    if (textLayer === null) return false;
    if (textLayer.dataset.rendered === "true") return false;
    textLayer.replaceChildren();
    const geometry = entry.block.geometry;
    if (geometry !== undefined && geometry !== null && geometry.lines.length > 0) {
      textLayer.classList.add("pdf-geometry-text");
      for (const line of geometry.lines) {
        const span = deps.document.createElement("span");
        span.className = "pdf-line";
        span.dataset.start = String(line.start);
        span.dataset.end = String(line.end);
        span.textContent = entry.text.slice(line.start, line.end);
        textLayer.append(span);
        if (line.end < entry.text.length) textLayer.append(deps.document.createTextNode("\n"));
      }
    } else {
      const lines = entry.text.split("\n");
      for (let i = 0; i < lines.length; i += 1) {
        if (lines[i] !== "") {
          const line = deps.document.createElement("span");
          line.className = "pdf-line";
          line.textContent = lines[i];
          textLayer.append(line);
        }
        if (i < lines.length - 1) textLayer.append(deps.document.createTextNode("\n"));
      }
    }
    textLayer.dataset.rendered = "true";
    const reader = deps.state.materialReader;
    if (reader !== null) void renderPdfOriginalPage(frame, entry, reader);
    return true;
  }


  /** PDF 懒渲染：只把可见页及 overscan 页交给原始页面渲染与文字层。 */
  function updatePdfPageRendering(reader) {
    if (reader === null || !deps.materialReaderIsPdf(reader)) return;
    const blocksEl = deps.document.getElementById("mat-blocks");
    if (blocksEl === null) return;
    const frames = [];
    for (const child of blocksEl.children) {
      if (isElementNode(child) && child.classList.contains("pdf-page-frame")) frames.push(child);
    }
    if (frames.length === 0) return;
    const clientHeight = typeof blocksEl.clientHeight === "number" ? blocksEl.clientHeight : 0;
    const base = typeof blocksEl.offsetTop === "number" ? blocksEl.offsetTop : 0;
    if (clientHeight <= 0) {
      /* 几何未知：只渲染前导若干页（有界），其余卸回占位。 */
      for (let i = 0; i < frames.length; i += 1) {
        const entry = reader.blocks.find((candidate) => candidate.block.blockId === frames[i].dataset.blockId);
        if (entry === undefined) continue;
        if (i < PDF_LEADING_RENDER_PAGES) renderPdfPageText(frames[i], entry);
        else unrenderPdfPageText(frames[i]);
      }
      return;
    }
    const from = blocksEl.scrollTop - PDF_PAGE_RENDER_OVERSCAN_PX;
    const to = blocksEl.scrollTop + clientHeight + PDF_PAGE_RENDER_OVERSCAN_PX;
    for (let pass = 0; pass < 8; pass += 1) {
      let renderedThisPass = 0;
      for (const frame of frames) {
        const entry = reader.blocks.find((candidate) => candidate.block.blockId === frame.dataset.blockId);
        if (entry === undefined) continue;
        const top = (typeof frame.offsetTop === "number" ? frame.offsetTop : 0) - base;
        const height = typeof frame.offsetHeight === "number" ? frame.offsetHeight : 0;
        const near = top + height >= from && top <= to;
        if (near) {
          if (renderPdfPageText(frame, entry)) renderedThisPass += 1;
        } else {
          unrenderPdfPageText(frame);
        }
      }
      if (renderedThisPass === 0) break;
    }
  }


  /** 页框内的文本层元素（.material-block——选区换算的定位元素）。 */
  function pdfPageTextLayer(frame) {
    for (const child of frame.children) {
      if (isElementNode(child) && child.classList.contains("material-block")) return child;
    }
    return null;
  }


  /** 定位元素直接渲染（阅读位置/搜索跳转的 scrollIntoView 目标可能是页框：
      跳转目标即已可见——渲染其文本层）。 */
  function renderPdfPageTextIn(element) {
    if (element === null || !isElementNode(element) || !element.classList.contains("pdf-page-frame")) return;
    const reader = deps.state.materialReader;
    if (reader === null) return;
    const entry = reader.blocks.find((candidate) => candidate.block.blockId === element.dataset.blockId);
    if (entry !== undefined) renderPdfPageText(element, entry);
  }


  /** 卸载窗外页文本层（回占位）：记住渲染时高度（min-height 保滚动几何——
      setAttribute("style") 兼容真实 DOM 与脚本桩）。 */
  function unrenderPdfPageText(frame) {
    const textLayer = pdfPageTextLayer(frame);
    if (textLayer === null || textLayer.dataset.rendered !== "true") return;
    const reader = deps.state.materialReader;
    reader?.pdfRenderTasks.get(frame)?.cancel?.();
    reader?.pdfRenderTasks.delete(frame);
    const height = typeof frame.offsetHeight === "number" ? frame.offsetHeight : 0;
    const page = frame.dataset.page !== undefined ? Number(frame.dataset.page) : null;
    if (height > 0) frame.setAttribute("style", `min-height: ${String(height)}px;`);
    textLayer.replaceChildren(pdfPagePendingPlaceholder(page));
    textLayer.classList.remove("pdf-geometry-text");
    textLayer.dataset.rendered = "false";
    const canvas = pdfPageCanvas(frame);
    if (canvas !== null && canvas.dataset.rendered === "true") {
      canvas.width = 0;
      canvas.height = 0;
      canvas.dataset.rendered = "false";
    }
  }

  return {
    updatePdfPageRendering,
    renderPdfPageTextIn,
    createPdfPageFrame,
  };
}
