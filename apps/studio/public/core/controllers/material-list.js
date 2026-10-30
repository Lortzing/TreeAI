/** Tree-scoped material read-model epochs, list presentation and stable material button registry. Instance-owned state and dependencies. */

export function createMaterialListController(deps) {

  /** 材料读模型世代号（P1 同族纪律：写 state.materials 前双验证——请求树 +
      世代号；切树后迟到的旧树响应整包丢弃，绝不把 A 树的材料写进 B 树）。 */
  let materialsEpoch = 0;

  /** 材料列表按钮注册表（materialId → 按钮）：阅读器关闭的焦点还原目标。 */
  const materialListButtons = new Map();


  /** 材料列表三态渲染（侧栏 Materials 段；renderAll 与刷新路径共用幂等）。 */
  function renderMaterialsSection() {
    const section = deps.$("materials-section");
    const list = deps.$("material-list");
    materialListButtons.clear();
    if (deps.state.treeState === null || deps.state.currentTreeId === null) {
      section.hidden = true;
      list.replaceChildren();
      return;
    }
    section.hidden = false;
    const materials = deps.state.materials;
    const count = deps.$("reading-material-count");
    if (count) count.textContent = materials === null ? "…" : materials.ok ? String(materials.materials.length) : "!";
    if (materials === null) {
      list.replaceChildren(deps.mutedListItem("loading materials…"));
      return;
    }
    if (!materials.ok) {
      /* 拉取失败：常驻错误 + 重试（与树列表加载失败同款纪律——绝不折叠成
         空列表伪装成“无材料”）。 */
      const li = deps.document.createElement("li");
      li.className = "muted";
      li.append(deps.document.createTextNode(`materials failed to load — ${materials.error} `));
      const retry = deps.document.createElement("button");
      retry.className = "drawer-retry";
      retry.textContent = "Retry";
      retry.title = "Fetch the material list again";
      retry.addEventListener("click", () => void refreshMaterials());
      li.append(retry);
      list.replaceChildren(li);
      return;
    }
    if (materials.materials.length === 0) {
      list.replaceChildren(
        deps.mutedListItem(
          "导入 PDF 或 Markdown，围绕自己的材料展开思考。",
        ),
      );
      return;
    }
    const items = [];
    for (const entry of materials.materials) {
      const li = deps.document.createElement("li");
      const button = deps.document.createElement("button");
      button.dataset.materialId = entry.material.id;
      if (deps.state.materialReader !== null && deps.state.materialReader.materialId === entry.material.id) {
        button.classList.add("active");
      }
      const name = deps.document.createElement("span");
      name.textContent = entry.material.title;
      button.append(name, materialStatusMeta(entry.versions));
      button.title = `open ${entry.material.title} in the material reader`;
      button.addEventListener("click", () => {
        deps.closeSidebar(); /* 窄窗：选材料后收起侧栏抽屉（与树选择同一纪律） */
        if (deps.sessionUI.mode !== "chat") deps.setWorkspaceView("chat");
        void deps.openMaterial(entry.material.id, {
          trigger: { kind: "material-button", materialId: entry.material.id },
        });
      });
      materialListButtons.set(entry.material.id, button);
      li.append(button);
      items.push(li);
    }
    list.replaceChildren(...items);
  }


  /** 列表项状态行：以最新版本为列表事实（版本链在阅读器内完整呈现）；最新
      版本非 ready 时如实带原因码（截断保持列表安静，title 携全文），并标注
      仍有旧 ready 版本可读（绝不把失败伪装成可读，也绝不因失败隐藏旧版）。 */
  function materialStatusMeta(versions) {
    const meta = deps.document.createElement("span");
    meta.className = "material-meta";
    if (versions.length === 0) {
      meta.textContent = "no versions recorded";
      return meta;
    }
    const latest = versions[versions.length - 1];
    const status = deps.document.createElement("span");
    status.className = `material-status ${latest.parseStatus}`;
    if (typeof latest.parseError === "string" && latest.parseError !== "") {
      const reason =
        latest.parseError.length > 90 ? `${latest.parseError.slice(0, 90)}…` : latest.parseError;
      status.textContent = `${latest.parseStatus}: ${reason}`;
      status.title = latest.parseError;
    } else {
      status.textContent = latest.parseStatus;
    }
    meta.append(deps.document.createTextNode(`${latest.parserKind} · v${String(versions.length)} · `), status);
    if (latest.parseStatus !== "ready") {
      for (let i = versions.length - 2; i >= 0; i -= 1) {
        if (versions[i].parseStatus === "ready") {
          meta.append(deps.document.createTextNode(` · v${String(i + 1)} ready (older, readable)`));
          break;
        }
      }
    }
    return meta;
  }


  /** 材料列表拉取（开树/重试共用；三态 + 迟到丢弃守卫在写点）。 */
  async function refreshMaterials() {
    if (deps.state.currentTreeId === null) return;
    const treeId = deps.state.currentTreeId;
    const epoch = ++materialsEpoch;
    try {
      const payload = await deps.api(`/api/trees/${encodeURIComponent(treeId)}/materials`);
      if (epoch !== materialsEpoch || deps.state.currentTreeId !== treeId) return; /* 迟到丢弃 */
      deps.state.materials = { ok: true, materials: payload.materials };
    } catch (err) {
      if (epoch !== materialsEpoch || deps.state.currentTreeId !== treeId) return; /* 迟到丢弃 */
      deps.state.materials = { ok: false, error: String(err && err.message ? err.message : err) };
    }
    renderMaterialsSection();
    deps.renderSessionWorkspace?.();
  }

  return {
    renderMaterialsSection,
    materialListButtons,
    refreshMaterials,
  };
}
