/** Material upload, parse polling, cancellation and import status recovery. Instance-owned state and dependencies. */

export function createMaterialImportController(deps) {
  // Keep the injected fetch callable unbound, matching the browser bootstrap contract.
  const fetch = deps.fetch;


  /* ------------------------------ D4-2 用户导入 UI（issue #8 owner P1） ------------------------------ */

  /**
   * 导入状态（模块级——导入跨列表重渲持续；HTML 里的静态导入行/状态行由
   * updateMaterialImportStatus 就地更新，renderMaterialsSection 只管列表）。
   * @type {null|{
   *   phase: "uploading"|"parsing"|"terminal"|"failed",
   *   filename: string,
   *   materialId: string|null,
   *   versionId: string|null,
   *   parseTaskId: string|null,
   *   dedup: boolean,
   *   inFlightStatus: "pending"|"parsing"|null,
   *   terminalStatus: "ready"|"failed"|"canceled"|"unsupported"|"rejected"|null,
   *   terminalError: string|null,
   *   dedupVersionLabel: string|null,
   *   error: string|null,
   *   uploadTreeId: string|null
   * }}
   */
  let materialImport = null;

  /** 解析轮询 timer（pending/parsing 期间每 1.5s 查一次 detail——服务端无
      推送，轮询是如实拿到终态的途径；终态/取消/失败即停）。 */
  let materialImportPollTimer = null;

  const MATERIAL_IMPORT_POLL_MS = 1500;


  /** 静态导入 UI 注册（真实文件选择器：input[type=file] 的 change 事件——
      浏览器原生对话框；同一文件可重复导入——每次处理后清空 input.value）。 */
  function registerMaterialImportUi() {
    const button = deps.$("material-import");
    const input = deps.$("material-import-input");
    button.addEventListener("click", () => {
      input.click();
    });
    input.addEventListener("change", () => {
      const file = input.files !== undefined && input.files !== null && input.files.length > 0 ? input.files[0] : null;
      /* 选同一文件再次导入是合法路径（重导即服务端去重——如实呈现）；清空
         value 让同名文件也能再次触发 change。 */
      input.value = "";
      if (file === null) return;
      void importMaterialFile(file);
    });
  }


  /** 导入入口（owner P1「真正的文件导入 UI」）：原始字节 + 文件名头——与
      D4-1 HTTP 面和浏览器探针同一语义（x-treeai-filename 百分号编码 +
      application/octet-stream + 原始字节 body）。中文/空格文件名经编码头
      原样到达。上传中一次一条（重复点击如实拒绝，不排队伪装）。 */
  async function importMaterialFile(file) {
    const treeId = deps.state.currentTreeId;
    if (treeId === null) return;
    if (materialImport !== null && materialImport.phase === "uploading") {
      materialImport = {
        ...materialImport,
        phase: "failed",
        error: "an import is already in flight — wait for it to finish before importing another file",
      };
      updateMaterialImportStatus();
      return;
    }
    const filename = typeof file.name === "string" ? file.name : "";
    materialImport = {
      phase: "uploading",
      filename,
      materialId: null,
      versionId: null,
      parseTaskId: null,
      dedup: false,
      inFlightStatus: null,
      terminalStatus: null,
      terminalError: null,
      dedupVersionLabel: null,
      error: null,
      uploadTreeId: treeId,
    };
    updateMaterialImportStatus();
    let bytes = null;
    try {
      bytes = typeof file.arrayBuffer === "function" ? await file.arrayBuffer() : null;
    } catch (err) {
      bytes = null;
      materialImport = { ...materialImport, phase: "failed", error: `reading the file failed — ${String(err && err.message ? err.message : err)}` };
    }
    if (bytes === null) {
      if (materialImport.phase !== "failed") {
        materialImport = { ...materialImport, phase: "failed", error: "the file could not be read in this browser" };
      }
      updateMaterialImportStatus();
      return;
    }
    try {
      const payload = await importMaterialViaHttp(treeId, filename, bytes);
      if (deps.state.currentTreeId !== treeId || materialImport === null || materialImport.phase !== "uploading") {
        return; /* 切树/状态被取代：迟到响应丢弃 */
      }
      if (payload.created !== true) {
        /* 同字节去重（D4-1 服务端语义）：如实「没有新版本」——绝不动声色地
           伪装成又一次成功导入。版本标签按列表事实换算（列表已刷新后查得）。 */
        await deps.refreshMaterials();
        const label = materialImportDedupVersionLabel(payload);
        materialImport = {
          phase: "terminal",
          filename,
          materialId: payload.material !== undefined && payload.material !== null ? String(payload.material.id) : null,
          versionId: payload.version !== undefined && payload.version !== null ? String(payload.version.id) : null,
          parseTaskId: null,
          dedup: true,
          inFlightStatus: null,
          terminalStatus: null,
          terminalError: null,
          dedupVersionLabel: label,
          error: null,
          uploadTreeId: treeId,
        };
        updateMaterialImportStatus();
        return;
      }
      materialImport = {
        phase: "parsing",
        filename,
        materialId: payload.material !== undefined && payload.material !== null ? String(payload.material.id) : null,
        versionId: payload.version !== undefined && payload.version !== null ? String(payload.version.id) : null,
        parseTaskId:
          payload.parseTaskId !== undefined && payload.parseTaskId !== null ? String(payload.parseTaskId) : null,
        dedup: false,
        inFlightStatus:
          payload.version !== undefined &&
          payload.version !== null &&
          (payload.version.parseStatus === "pending" || payload.version.parseStatus === "parsing")
            ? payload.version.parseStatus
            : null,
        terminalStatus: null,
        terminalError: null,
        dedupVersionLabel: null,
        error: null,
        uploadTreeId: treeId,
      };
      updateMaterialImportStatus();
      void deps.refreshMaterials();
      startMaterialImportPolling();
    } catch (err) {
      if (deps.state.currentTreeId !== treeId) return;
      materialImport = {
        ...materialImport,
        phase: "failed",
        error: String(err && err.message ? err.message : err),
      };
      updateMaterialImportStatus();
    }
  }


  /** 导入 HTTP（与 scripts/d4/browser/material-probes.mjs 的
      importMaterialViaHttp 同一头/字节语义——浏览器 UI 与探针走同一面）。 */
  async function importMaterialViaHttp(treeId, filename, bytes) {
    const response = await fetch(`/api/trees/${encodeURIComponent(treeId)}/materials`, {
      method: "POST",
      headers: { "x-treeai-filename": encodeURIComponent(filename), "content-type": "application/octet-stream" },
      body: bytes,
    });
    let payload = null;
    try {
      payload = await response.json();
    } catch {
      /* non-JSON error body */
    }
    if (!response.ok) {
      const message =
        payload !== null && payload.error !== undefined
          ? `${payload.error.code}: ${payload.error.message}`
          : `HTTP ${String(response.status)}`;
      const error = new Error(message);
      if (payload !== null && payload.error !== undefined && typeof payload.error.code === "string") {
        error.code = payload.error.code;
      }
      throw error;
    }
    return payload;
  }


  /** 去重消息的版本标签（v 序号——按导入响应的材料在当前列表中的版本链
      换算；列表未含该材料（异常）→ 如实退回 versionId 原文）。 */
  function materialImportDedupVersionLabel(payload) {
    const versionId = payload.version !== undefined && payload.version !== null ? String(payload.version.id) : null;
    if (versionId === null) return null;
    const materials = deps.state.materials !== null && deps.state.materials.ok ? deps.state.materials.materials : [];
    const entry = materials.find(
      (candidate) =>
        payload.material !== undefined &&
        payload.material !== null &&
        candidate.material.id === String(payload.material.id),
    );
    if (entry === undefined) return null;
    const index = entry.versions.findIndex((candidate) => candidate.id === versionId);
    return index < 0 ? null : `v${String(index + 1)}`;
  }


  /** 解析轮询（pending/parsing 的如实终态获取）。 */
  function startMaterialImportPolling() {
    stopMaterialImportPolling();
    materialImportPollTimer = deps.window.setInterval(() => {
      void pollMaterialImportStatus();
    }, MATERIAL_IMPORT_POLL_MS);
  }


  function stopMaterialImportPolling() {
    if (materialImportPollTimer !== null) {
      deps.window.clearInterval(materialImportPollTimer);
      materialImportPollTimer = null;
    }
  }


  /** 轮询/显式 Refresh 共用：拉 detail，按版本终态更新导入状态面。 */
  async function pollMaterialImportStatus() {
    const current = materialImport;
    if (current === null || current.phase !== "parsing") return;
    const treeId = deps.state.currentTreeId;
    if (treeId === null || current.materialId === null || current.uploadTreeId !== treeId) {
      stopMaterialImportPolling();
      return;
    }
    try {
      const detail = await deps.api(
        `/api/trees/${encodeURIComponent(treeId)}/materials/${encodeURIComponent(current.materialId)}`,
      );
      if (materialImport !== current || deps.state.currentTreeId !== treeId) return; /* 迟到丢弃 */
      const version =
        detail.versions.find((candidate) => candidate.id === current.versionId) ?? null;
      if (version === null) return; /* 版本不在链（异常）：保持轮询，下轮再查 */
      if (version.parseStatus === "pending" || version.parseStatus === "parsing") {
        materialImport = { ...current, inFlightStatus: version.parseStatus, terminalStatus: null, terminalError: null };
        updateMaterialImportStatus();
        return;
      }
      /* 终态：ready/failed/canceled/unsupported/rejected——原因逐字呈现。 */
      stopMaterialImportPolling();
      materialImport = {
        ...current,
        phase: "terminal",
        terminalStatus: version.parseStatus,
        terminalError:
          typeof version.parseError === "string" && version.parseError !== "" ? version.parseError : null,
      };
      updateMaterialImportStatus();
      void deps.refreshMaterials();
    } catch (err) {
      /* 轮询失败如实注记，保持轮询（解析事实未到，不伪装终态）。 */
      materialImport = { ...current, error: `checking the parse status failed — ${String(err && err.message ? err.message : err)}` };
      updateMaterialImportStatus();
    }
  }


  /** 取消在途解析（POST parse-tasks/:taskId/cancel——服务端行级仲裁：先落
      库者赢）。409（已终态）→ 立即查一次状态（终态如实呈现）。 */
  async function cancelMaterialImportParse() {
    const current = materialImport;
    if (current === null || current.phase !== "parsing" || current.parseTaskId === null) return;
    const treeId = deps.state.currentTreeId;
    if (treeId === null || current.materialId === null) return;
    try {
      await deps.api(
        `/api/trees/${encodeURIComponent(treeId)}/materials/${encodeURIComponent(current.materialId)}` +
          `/parse-tasks/${encodeURIComponent(current.parseTaskId)}/cancel`,
        "POST",
      );
    } catch (err) {
      if (err !== null && typeof err === "object" && err.code === "parse-task-not-cancelable") {
        /* 已终态（409）：立即刷新状态面——迟到点击如实落位。 */
        await pollMaterialImportStatus();
        return;
      }
      if (materialImport === current) {
        materialImport = { ...current, error: `canceling the parse failed — ${String(err && err.message ? err.message : err)}` };
        updateMaterialImportStatus();
      }
      return;
    }
    stopMaterialImportPolling();
    if (materialImport === null || materialImport.phase !== "parsing") return;
    materialImport = {
      ...materialImport,
      phase: "terminal",
      terminalStatus: "canceled",
      terminalError: null,
    };
    updateMaterialImportStatus();
    void deps.refreshMaterials();
  }


  /** 导入状态面（静态行 #material-import-status 就地更新；状态/原因/操作
      全部如实——pending/parsing/ready/failed/rejected/canceled/去重/上传失败）。 */
  function updateMaterialImportStatus() {
    const status = deps.document.getElementById("material-import-status");
    if (status === null) return;
    status.replaceChildren();
    const current = materialImport;
    if (current === null) return;
    const text = (content, extraClass = "") => {
      const span = deps.document.createElement("span");
      if (extraClass !== "") span.className = extraClass;
      span.textContent = content;
      status.append(span);
      return span;
    };
    const action = (label, title, onClick, className) => {
      const button = deps.document.createElement("button");
      button.className = className;
      button.textContent = label;
      button.title = title;
      button.addEventListener("click", onClick);
      status.append(button);
      return button;
    };
    if (current.phase === "uploading") {
      text(`importing “${current.filename}”…`, "mat-import-note");
      return;
    }
    if (current.phase === "parsing") {
      const statusPart = current.inFlightStatus === null ? "" : ` (server status: ${current.inFlightStatus})`;
      text(`“${current.filename}” imported — parsing${statusPart}…`, "mat-import-note");
      if (current.error !== null) text(` (${current.error})`, "mat-import-error");
      action(
        "Cancel parse",
        "Cancel the in-flight parse task (the version stays canceled; re-import the file to try again)",
        () => void cancelMaterialImportParse(),
        "mat-import-cancel",
      );
      action(
        "Check now",
        "Check the parse status immediately (also refreshes automatically)",
        () => void pollMaterialImportStatus(),
        "mat-import-refresh",
      );
      return;
    }
    if (current.phase === "failed") {
      text(`importing “${current.filename}” failed — ${current.error ?? "unknown error"}`, "mat-import-error");
      return;
    }
    /* terminal */
    if (current.dedup) {
      const label = current.dedupVersionLabel === null ? (current.versionId ?? "an existing version") : current.dedupVersionLabel;
      text(
        `“${current.filename}” was not imported again — these exact bytes are already ${label} of this material ` +
          "(the server reused the existing version; no new version was created)",
        "mat-import-note",
      );
      return;
    }
    if (current.terminalStatus === "ready") {
      text(`“${current.filename}” is ready — it is in the list below.`, "mat-import-note");
      if (current.materialId !== null) {
        action(
          "Open in reader",
          "Open the imported material in the material reader",
          () => {
            deps.closeSidebar();
            void deps.openMaterial(current.materialId, { trigger: { kind: "element", element: deps.$("material-import") } });
          },
          "mat-import-open",
        );
      }
      return;
    }
    if (current.terminalStatus === "canceled") {
      text(
        `the parse of “${current.filename}” was canceled — the version stays canceled (nothing is faked as parsed); ` +
          "import the file again to retry",
        "mat-import-error",
      );
      return;
    }
    if (current.terminalStatus !== null) {
      /* failed / unsupported / rejected：原因逐字（服务端 parseError 原文）。 */
      const reason = current.terminalError !== null ? ` — ${current.terminalError}` : "";
      text(
        `“${current.filename}” did not parse: ${current.terminalStatus}${reason}. ` +
          "The original file is kept as imported; an older ready version (if any) stays readable.",
        "mat-import-error",
      );
      return;
    }
    text(`import of “${current.filename}” finished.`, "mat-import-note");
  }


  /** 导入面复位（切树时调用：在途轮询停止、状态清空——不同树的导入事实
      不跨树残留）。 */
  function resetMaterialImport() {
    stopMaterialImportPolling();
    materialImport = null;
    updateMaterialImportStatus();
  }

  return {
    resetMaterialImport,
    registerMaterialImportUi,
  };
}
