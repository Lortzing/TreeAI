/** transport ownership for terminology-probes.mjs; compatibility entrypoint remains one level above. */

/** Fetch Request 阶段观测（只观测不改动：continueRequest 放行）——PUT 载荷
 *  核验的事实源（应用自身 fetch 的请求体，非探针伪造）。 */
export async function withObservedRequests(ctx, urlPattern, fn) {
  const observed = [];
  const handle = { active: true };
  const listener = (params) => {
    if (!handle.active) return;
    observed.push({
      url: params.request.url,
      method: params.request.method,
      postData: typeof params.request.postData === "string" ? params.request.postData : null,
    });
    void ctx.cdpSend("Fetch.continueRequest", { requestId: params.requestId }).catch(() => { /* 尽力而为 */ });
  };
  ctx.cdpOn("Fetch.requestPaused", listener);
  await ctx.cdpSend("Fetch.enable", { patterns: [{ urlPattern, requestStage: "Request" }] });
  try {
    const value = await fn();
    return { value, observed };
  } finally {
    handle.active = false;
    try {
      await ctx.cdpSend("Fetch.disable");
    } catch {
      /* 尽力而为 */
    }
  }
}

/** 响应丢失注入（b3 同款语义）：Response 阶段 failRequest——请求已到服务端
 *  并完整处理，仅响应被丢弃（「服务端已成功、客户端未见」）。 */
export async function withDroppedResponses(ctx, urlPattern, fn) {
  const handle = { active: true, dropped: 0 };
  const listener = (params) => {
    if (!handle.active) return;
    if (params.responseStatusCode !== undefined || params.responseError !== undefined) {
      handle.dropped += 1;
      void ctx.cdpSend("Fetch.failRequest", { requestId: params.requestId, errorReason: "ConnectionReset" }).catch(() => { /* 尽力而为 */ });
      return;
    }
    void ctx.cdpSend("Fetch.continueRequest", { requestId: params.requestId }).catch(() => { /* 尽力而为 */ });
  };
  ctx.cdpOn("Fetch.requestPaused", listener);
  await ctx.cdpSend("Fetch.enable", { patterns: [{ urlPattern, requestStage: "Response" }] });
  try {
    const value = await fn();
    return { value, dropped: handle.dropped };
  } finally {
    handle.active = false;
    try {
      await ctx.cdpSend("Fetch.disable");
    } catch {
      /* 尽力而为 */
    }
  }
}
