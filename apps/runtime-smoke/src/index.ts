/**
 * @treeai/runtime-smoke public surface (Integrator-owned Wave 2 app).
 *
 * The scenario and fake port are deliberately app-local: the fake simulates
 * the Pi SDK port seam for offline integration testing only and must never
 * be copied into packages/ (production code uses the real port).
 */

export { runWave2Scenario, type ScenarioReport } from "./scenario.ts";
export { SmokeSdkPort, type SmokePortBehavior } from "./fake-pi-port.ts";
