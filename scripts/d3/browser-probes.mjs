import { createBrowserToolSetup } from "./browser-tool-setup.mjs";
import { createBrowserToolDeny } from "./browser-tool-deny.mjs";
import { createBrowserModelError } from "./browser-model-error.mjs";
import { createBrowserDeepSelection } from "./browser-deep-selection.mjs";
/** Browser probe composition Instance-owned state and dependencies. */

export function createBrowserProbes(deps) {

  const browserToolSetup = createBrowserToolSetup({
    get assert() { return deps.assert; },
    get CLI() { return deps.CLI; },
    get chrome() { return deps.chrome; },
    get killStudioAndWait() { return deps.killStudioAndWait; },
    get startStudio() { return deps.startStudio; },
    get sc() { return deps.sc; },
    get navigate() { return deps.navigate; },
    get studio() { return deps.studio; },
    get sleep() { return deps.sleep; },
    get physicalPath() { return deps.physicalPath; },
    get isPathWithin() { return deps.isPathWithin; },
    get api() { return deps.api; },
    get click() { return deps.click; },
    get waitForJs() { return deps.waitForJs; },
    get walkFiles() { return deps.walkFiles; },
    get resetErrorSurfaces() { return deps.resetErrorSurfaces; },
    get probeAssistantTurnCount() { return deps.probeAssistantTurnCount; },
    get sendTrunkPrompt() { return deps.sendTrunkPrompt; },
    get waitForProbeOutcome() { return deps.waitForProbeOutcome; },
    get failureErrorCode() { return deps.failureErrorCode; },
    get truncate() { return deps.truncate; },
    get sanitizeText() { return deps.sanitizeText; },
    get tpPath() { return deps.tpPath; },
    get evalJs() { return deps.evalJs; },
    get snap() { return deps.snap; },
  });

  const { stepToolPolicyBoot, stepToolPolicyAllowRead } = browserToolSetup;

  const browserToolDeny = createBrowserToolDeny({
    get sc() { return deps.sc; },
    get assert() { return deps.assert; },
    get resetErrorSurfaces() { return deps.resetErrorSurfaces; },
    get probeTurnCounts() { return deps.probeTurnCounts; },
    get probeAssistantTurnCount() { return deps.probeAssistantTurnCount; },
    get chrome() { return deps.chrome; },
    get sendTrunkPrompt() { return deps.sendTrunkPrompt; },
    get waitForProbeOutcome() { return deps.waitForProbeOutcome; },
    get CLI() { return deps.CLI; },
    get failureErrorCode() { return deps.failureErrorCode; },
    get truncate() { return deps.truncate; },
    get sanitizeText() { return deps.sanitizeText; },
    get waitForJs() { return deps.waitForJs; },
    get evalJs() { return deps.evalJs; },
    get snap() { return deps.snap; },
    get api() { return deps.api; },
    get tpPath() { return deps.tpPath; },
    get click() { return deps.click; },
    get walkFiles() { return deps.walkFiles; },
    get physicalPath() { return deps.physicalPath; },
    get pageSummaryExpression() { return deps.pageSummaryExpression; },
  });

  const { stepToolPolicyDenyFailClosed, stepToolPolicyDenyProvenance, stepToolPolicyCanaryNeverRead } = browserToolDeny;

  const browserModelError = createBrowserModelError({
    get chrome() { return deps.chrome; },
    get sendTrunkPrompt() { return deps.sendTrunkPrompt; },
    get SCENARIO() { return deps.SCENARIO; },
    get waitForJs() { return deps.waitForJs; },
    get CLI() { return deps.CLI; },
    get snap() { return deps.snap; },
    get assert() { return deps.assert; },
    get truncate() { return deps.truncate; },
    get evalJs() { return deps.evalJs; },
    get waitForAnswerMarkers() { return deps.waitForAnswerMarkers; },
    get MODE() { return deps.MODE; },
    get sc() { return deps.sc; },
    get api() { return deps.api; },
    get click() { return deps.click; },
    get studio() { return deps.studio; },
    get sleep() { return deps.sleep; },
    get sanitizeText() { return deps.sanitizeText; },
    get MISCONFIG_BASE_URL() { return deps.MISCONFIG_BASE_URL; },
    get killStudioAndWait() { return deps.killStudioAndWait; },
    get startStudio() { return deps.startStudio; },
    get navigate() { return deps.navigate; },
    get probeAssistantTurnCount() { return deps.probeAssistantTurnCount; },
    get waitForProbeOutcome() { return deps.waitForProbeOutcome; },
    get failureErrorCode() { return deps.failureErrorCode; },
    get resetErrorSurfaces() { return deps.resetErrorSurfaces; },
  });

  const { stepModelErrorEcho, stepModelErrorRealPi } = browserModelError;

  const browserDeepSelection = createBrowserDeepSelection({
    get api() { return deps.api; },
    get assert() { return deps.assert; },
    get click() { return deps.click; },
    get waitForJs() { return deps.waitForJs; },
    get sc() { return deps.sc; },
    get DEEP_ASKS() { return deps.DEEP_ASKS; },
    get resetErrorSurfaces() { return deps.resetErrorSurfaces; },
    get probeAssistantTurnCount() { return deps.probeAssistantTurnCount; },
    get chrome() { return deps.chrome; },
    get sendTrunkPrompt() { return deps.sendTrunkPrompt; },
    get waitForProbeOutcome() { return deps.waitForProbeOutcome; },
    get CLI() { return deps.CLI; },
    get failureErrorCode() { return deps.failureErrorCode; },
    get truncate() { return deps.truncate; },
    get sanitizeText() { return deps.sanitizeText; },
    get DEEP_MIN_ANSWER_CHARS() { return deps.DEEP_MIN_ANSWER_CHARS; },
    get evalJs() { return deps.evalJs; },
    get MODE() { return deps.MODE; },
    get dragSelect() { return deps.dragSelect; },
    get snap() { return deps.snap; },
    get sendPanelPrompt() { return deps.sendPanelPrompt; },
    get waitForAnswerMarkers() { return deps.waitForAnswerMarkers; },
    get DEEP_BLOCKS() { return deps.DEEP_BLOCKS; },
    get deepLongExpectation() { return deps.deepLongExpectation; },
    get DEEP_LATE_PHRASE() { return deps.DEEP_LATE_PHRASE; },
    get deepDuplicateExpectation() { return deps.deepDuplicateExpectation; },
    get DEEP_DUP_WORD() { return deps.DEEP_DUP_WORD; },
    get deepCrossLineExpectation() { return deps.deepCrossLineExpectation; },
  });

  const { stepSelectionDeepLong, stepSelectionDeepDuplicate, stepSelectionDeepCrossLine } = browserDeepSelection;

  return {
    stepSelectionDeepLong,
    stepSelectionDeepDuplicate,
    stepSelectionDeepCrossLine,
    stepModelErrorRealPi,
    stepToolPolicyBoot,
    stepToolPolicyAllowRead,
    stepToolPolicyDenyFailClosed,
    stepToolPolicyDenyProvenance,
    stepToolPolicyCanaryNeverRead,
    stepModelErrorEcho,
  };
}
