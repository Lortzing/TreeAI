/** Studio policy ownership; public compatibility exports remain in ../service.ts. */

export const NO_POLICY_DECISIONS_REASON =
  "no tool policy decisions observed in this process; the default Studio wiring runs prompts with an empty tool allowlist";

/** 用户 turn 上的新探索标记（产品事实：不冒充旧会话恢复——转录可审）。 */
export const NEW_EXPLORATION_TURN_PREFIX =
  "[new exploration from saved content — the previous session was not restored]";
