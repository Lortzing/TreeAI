/** Read actual paged DOM history, then restore the reader's original page/focus. */
export async function readConversationRounds(ctx, selector) {
  return ctx.evalJs(`(async () => {
    const container = document.querySelector(${JSON.stringify(selector)});
    if (!container) throw new Error('Conversation container is missing');
    const panelVisible = document.getElementById('branch-panel')?.hidden === false;
    if (panelVisible !== (${JSON.stringify(selector)} === '#panel-conversation')) throw new Error('Conversation does not own the active pager');
    const position = () => Number((document.getElementById('round-position')?.textContent ?? '').split('/')[0].trim()) || 0;
    const total = Number((document.getElementById('round-position')?.textContent ?? '').split('/')[1]?.trim()) || 0;
    const previous = document.getElementById('round-previous'), next = document.getElementById('round-next');
    const original = position(), scrollTop = container.scrollTop, focused = document.activeElement;
    const turns = new Map();
    const settle = () => new Promise(resolve => setTimeout(resolve, 0));
    const step = async (button) => { const before = position(); button.click(); await settle(); if (position() === before) throw new Error('Round navigation did not advance'); };
    const read = () => { for (const [index, turn] of [...container.querySelectorAll('.turn:not(#streaming-turn)')].entries()) turns.set(turn.dataset.turnId ?? position() + ':' + index, turn.dataset.turnText ?? turn.textContent); };
    try {
      if (previous && next && total > 0) {
        for (let n=0; !previous.disabled && n<total; n++) await step(previous);
        for (let n=0; n<total; n++) { read(); if (next.disabled) break; await step(next); }
      } else read();
    } finally {
      if (previous && next) {
        for (let n=0; position()>original && !previous.disabled && n<total; n++) await step(previous);
        for (let n=0; position()<original && !next.disabled && n<total; n++) await step(next);
      }
      container.scrollTop = scrollTop;
      if (focused?.isConnected && document.activeElement!==focused) focused.focus({preventScroll:true});
    }
    return { text: [...turns.values()].join('\\n'), turnIds: [...turns.keys()], pages: total };
  })()`);
}
export async function waitForConversationHistory(ctx, selector, markers, { timeoutMs = 12000, label = 'conversation history' } = {}) {
  const deadline = Date.now() + timeoutMs;
  for (;;) {
    const history = await readConversationRounds(ctx, selector);
    if (markers.every(marker => history.text.includes(marker))) return history;
    if (Date.now() >= deadline) throw new Error(`timeout (${timeoutMs}ms) waiting for: ${label}`);
    await new Promise(resolve => setTimeout(resolve, 120));
  }
}
