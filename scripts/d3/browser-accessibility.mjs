
/** browser-accessibility original runner scenarios/helpers Instance-owned state and dependencies. */

export function createBrowserAccessibility(deps) {

  async function phaseAccessibility() {

    /* ---- A7 无障碍语义与真实计算样式 ---- */

    await deps.runCheck("a11y-semantics", async () => {
      /* 错误横幅：role=alert + tabindex=0（W2 §2.4）。 */
      const bannerAttrs = await deps.evalJs(
        "(() => { const b = document.getElementById('error-banner'); return { role: b.getAttribute('role'), tabIndex: b.tabIndex }; })()",
      );
      deps.assert(bannerAttrs.role === "alert", `error banner role is ${String(bannerAttrs.role)}`);
      deps.assert(bannerAttrs.tabIndex === 0, `error banner tabIndex is ${String(bannerAttrs.tabIndex)} (expected 0, Tab-reachable)`);
      /* 抽屉 Esc 关闭（W2 键盘焦点行）。 */
      await deps.click("#source-drawer-toggle");
      await deps.waitForJs("document.getElementById('source-drawer') !== null && !document.getElementById('source-drawer').hidden", 10_000, "drawer open");
      const drawerExpanded = await deps.evalJs("document.getElementById('source-drawer-toggle').getAttribute('aria-expanded')");
      deps.assert(drawerExpanded === "true", `drawer toggle aria-expanded is ${String(drawerExpanded)} while open`);
      await deps.chrome.cdp.send("Input.dispatchKeyEvent", { type: "keyDown", key: "Escape", code: "Escape", windowsVirtualKeyCode: 27 });
      await deps.chrome.cdp.send("Input.dispatchKeyEvent", { type: "keyUp", key: "Escape", code: "Escape", windowsVirtualKeyCode: 27 });
      await deps.waitForJs("document.getElementById('source-drawer') === null || document.getElementById('source-drawer').hidden", 10_000, "drawer closed via Esc");
      /* Esc 关闭后焦点还原给触发元素（W2 键盘焦点行）。 */
      const focusAfterEsc = await deps.evalJs("document.activeElement === null ? null : document.activeElement.id");
      deps.assert(focusAfterEsc === "source-drawer-toggle", `focus after drawer Esc is #${String(focusAfterEsc)} (expected source-drawer-toggle)`);
      /* aria-expanded 由下次渲染对齐 state.drawerOpen——等待翻转而非立即读。 */
      await deps.waitForJs("document.getElementById('source-drawer-toggle').getAttribute('aria-expanded') === 'false'", 3_000, "drawer aria-expanded false after Esc");
      /* 侧栏开合的 aria-expanded（窄窗抽屉语义在 narrow-window-layout 检查）。 */
      const panelAnchor = await deps.evalJs("(() => { const el = document.getElementById('panel-anchor-context'); return el === null ? null : el.getAttribute('tabindex'); })()");
      deps.assert(panelAnchor === "-1", `panel anchor context tabindex is ${String(panelAnchor)} (expected -1, programmatically focusable)`);
      await deps.snap("a11y-semantics");
      return { detail: "error banner role=alert + Tab-reachable; drawer aria-expanded both ways + Esc closes; panel anchor context programmatically focusable" };
    });

    await deps.runCheck("narrow-window-layout", async () => {
      try {
      await deps.chrome.cdp.send("Emulation.setDeviceMetricsOverride", {
        width: deps.NARROW_VIEWPORT.width,
        height: deps.NARROW_VIEWPORT.height,
        deviceScaleFactor: 1,
        mobile: false,
      });
      await deps.sleep(200);
      const toggleVisible = await deps.evalJs(
        "(() => { const el = document.getElementById('sidebar-toggle'); const cs = getComputedStyle(el); " +
          "const mql = window.matchMedia('(max-width: 719px)'); " +
          "const detail = getComputedStyle(document.getElementById('run-detail')); " +
          "const detailElement = document.getElementById('run-detail'); const disclosure = detailElement.closest('details'); " +
          "return { display: cs.display, narrow: mql.matches, runDetailDisplay: detail.display, runDetailVisible: (!disclosure || disclosure.open) && detailElement.getClientRects().length > 0 }; })()",
      );
      deps.assert(toggleVisible.narrow === true, "viewport 480px did not match the narrow media query (max-width 719px)");
      deps.assert(toggleVisible.display !== "none", `sidebar toggle hidden in narrow viewport (display ${String(toggleVisible.display)})`);
      deps.assert(toggleVisible.runDetailVisible === false, `#run-detail not hidden in narrow viewport (display ${String(toggleVisible.runDetailDisplay)})`);
      /* 侧栏开合（aria 语义 + body class）。 */
      await deps.click("#sidebar-toggle");
      const openState = await deps.evalJs(
        "(() => { return { expanded: document.getElementById('sidebar-toggle').getAttribute('aria-expanded'), open: document.body.classList.contains('sidebar-open') }; })()",
      );
      deps.assert(openState.expanded === "true" && openState.open === true, `sidebar did not open in narrow viewport: ${JSON.stringify(openState)}`);
      await deps.click("#sidebar-toggle");
      /* 窄窗来源抽屉：自底部上滑（drawer-up-* 关键帧，进入窗口 ~240ms 内
         可捕获 animationName）；结构证据 = 抽屉占满窄窗全宽。 */
      await deps.click("#source-drawer-toggle");
      const narrowDrawer = await deps.waitForJs(
        "(() => { const el = document.getElementById('source-drawer'); if (el === null || el.hidden) return false; " +
          "const cs = getComputedStyle(el); if (cs.animationName !== 'none' && cs.animationName !== '') return { animationName: cs.animationName, width: cs.width }; " +
          "return cs.width !== '' && Number.parseFloat(cs.width) >= 470 ? { animationName: 'none', width: cs.width } : false; })()",
        3_000,
        "narrow drawer settles (bottom-up animation or full-width structural form)",
      );
      await deps.waitForJs("document.getElementById('source-drawer') !== null && !document.getElementById('source-drawer').hidden", 10_000, "narrow drawer open");
      const narrowWidth = Number.parseFloat(narrowDrawer.width);
      deps.assert(narrowWidth >= deps.NARROW_VIEWPORT.width - 10, `narrow drawer not full-width: ${String(narrowDrawer.width)}`);
      deps.assert(narrowDrawer.animationName === "none" || /drawer-up/i.test(String(narrowDrawer.animationName)),
        `narrow drawer animation is not the bottom-up form: ${JSON.stringify(narrowDrawer)}`);
      await deps.snap("narrow-window");
      /* 窄窗抽屉（fixed 全幅）仍保有 Esc 关闭路径的覆盖（W2 逐层键盘语义；
         鼠标关闭路径 #drawer-close 的浏览器面覆盖在 return-flow）。 */
      await deps.pressKey("Escape", "Escape", 27);
      await deps.waitForJs("document.getElementById('source-drawer') === null || document.getElementById('source-drawer').hidden", 10_000, "narrow drawer closed via Esc");
      /* 还原宽窗：右侧滑入（panel-in / translateX），宽度远小于全宽。 */
      await deps.chrome.cdp.send("Emulation.setDeviceMetricsOverride", {
        width: deps.VIEWPORT.width,
        height: deps.VIEWPORT.height,
        deviceScaleFactor: 1,
        mobile: false,
      });
      await deps.sleep(200);
      await deps.click("#source-drawer-toggle");
      await deps.waitForJs("document.getElementById('source-drawer') !== null && !document.getElementById('source-drawer').hidden", 10_000, "wide drawer open");
      const wideDrawer = await deps.evalJs(
        "(() => { const el = document.getElementById('source-drawer'); const cs = getComputedStyle(el); " +
          "return { animationName: cs.animationName, width: cs.width, left: cs.left, right: cs.right }; })()",
      );
      await deps.pressKey("Escape", "Escape", 27);
      await deps.waitForJs("document.getElementById('source-drawer') === null || document.getElementById('source-drawer').hidden", 10_000, "wide drawer closed via Esc");
      const wideWidth = Number.parseFloat(wideDrawer.width);
      deps.assert(wideWidth < deps.VIEWPORT.width * 0.6, `wide drawer unexpectedly near-full-width: ${JSON.stringify(wideDrawer)}`);
      deps.assert(!/drawer-up/i.test(String(wideDrawer.animationName)), `wide drawer uses the bottom-up form: ${JSON.stringify(wideDrawer)}`);
      return { detail: `480px viewport: toggle visible, #run-detail hidden, sidebar open/close aria ok; drawer full-width ${String(narrowDrawer.width)}${narrowDrawer.animationName === "none" ? "" : ` (${String(narrowDrawer.animationName)})`} in narrow vs right-side ${String(wideDrawer.width)} in wide` };
      } finally {
        await deps.chrome.cdp.send("Emulation.setDeviceMetricsOverride", {
          width: deps.VIEWPORT.width, height: deps.VIEWPORT.height, deviceScaleFactor: 1, mobile: false,
        });
        await deps.pressKey("Escape", "Escape", 27);
      }
    });

    await deps.runCheck("reduced-motion", async () => {
      await deps.chrome.cdp.send("Emulation.setEmulatedMedia", { features: [{ name: "prefers-reduced-motion", value: "reduce" }] });
      await deps.sleep(150);
      const motion = await deps.evalJs(
        `(() => {
          const mql = window.matchMedia('(prefers-reduced-motion: reduce)');
          /* 全局规则：* { animation-duration: 0.01ms !important; transition-duration: 0.01ms !important }。 */
          const probe = document.querySelector('.turn.assistant .delivery') ?? document.querySelector('.turn.return .delivery') ?? document.querySelector('.turn.assistant') ?? document.body;
          const cs = getComputedStyle(probe);
          return { reduced: mql.matches, animationDuration: cs.animationDuration, transitionDuration: cs.transitionDuration, scrollBehavior: getComputedStyle(document.documentElement).scrollBehavior };
        })()`,
      );
      deps.assert(motion.reduced === true, "setEmulatedMedia did not flip prefers-reduced-motion");
      /* Chromium 将 0.01ms 序列化为 "0.00001s"——按毫秒数值比较。 */
      const durationMs = (value) => {
        const parsed = Number.parseFloat(String(value));
        return String(value).endsWith("ms") ? parsed : parsed * 1000;
      };
      deps.assert(durationMs(motion.animationDuration) <= 0.02, `computed animation-duration under reduce is ${String(motion.animationDuration)} (expected ≤0.02ms)`);
      deps.assert(durationMs(motion.transitionDuration) <= 0.02, `computed transition-duration under reduce is ${String(motion.transitionDuration)} (expected ≤0.02ms)`);
      await deps.snap("reduced-motion");
      await deps.chrome.cdp.send("Emulation.setEmulatedMedia", { features: [{ name: "prefers-reduced-motion", value: "" }] });
      await deps.sleep(150);
      const normal = await deps.evalJs(
        `(() => { const probe = document.querySelector('.turn.assistant .delivery') ?? document.querySelector('.turn.return .delivery') ?? document.querySelector('.turn.assistant') ?? document.body; return { reduced: window.matchMedia('(prefers-reduced-motion: reduce)').matches, animationDuration: getComputedStyle(probe).animationDuration }; })()`,
      );
      deps.assert(normal.reduced === false, "prefers-reduced-motion did not reset");
      return { detail: `prefers-reduced-motion honored in the real browser (computed animation/transition-duration collapse to 0.01ms; reset back to ${String(normal.animationDuration)})` };
    });
  }

  return {
    phaseAccessibility,
  };
}
