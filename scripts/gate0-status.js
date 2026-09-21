#!/usr/bin/env node
/**
 * TreeAI D2 — Gate 0 placeholder for not-yet-implemented verification
 * commands (Integrator-owned).
 *
 * These npm script entries must EXIST from Gate 0 (task book, Gate 0
 * Integrator task 3), but the implementations they will eventually invoke
 * do not exist yet. This placeholder prints an explicit NOT_IMPLEMENTED
 * message and exits non-zero so a missing implementation can never be
 * mistaken for a pass.
 *
 * Exit code 3 follows the D2 verifier convention: "no FAIL, but BLOCKED or
 * NOT_RUN present" — i.e. an honest, loud not-done signal.
 *
 * Supersession plan (Integrator will repoint the root package.json entries):
 *   - test / test:integration: wired to the module test suites (Wave 1+)
 *   - verify:d2 / verify:d2:live: wired to Agent F's scripts/verify-d2*
 */

const MESSAGES = {
  "test":
    "No unit-test runner is wired up yet. Module unit tests arrive with " +
    "Wave 1 (Agent A contract type tests during Gate 0, then Agents B-E " +
    "module suites).",
  "test:integration":
    "Integration tests are a Wave 2 / Gate 2 deliverable driven by " +
    "apps/runtime-smoke. Nothing to run at Gate 0.",
  "verify:d2":
    "The offline D2 verifier (scripts/verify-d2) is Agent F's deliverable " +
    "(tests, schemas, CI). Not implemented at Gate 0.",
  "verify:d2:live":
    "Live credentialed verification (verify:d2:live) runs only in a " +
    "controlled, owner-approved credential environment (Gate 2 / owner " +
    "gate). Not implemented at Gate 0.",
};

const command = process.argv[2] ?? "(unspecified)";
const detail = MESSAGES[command] ?? "No implementation has been wired up yet.";

console.log(`[${command}] NOT_IMPLEMENTED (Gate 0 placeholder).`);
console.log(`[${command}] ${detail}`);
console.log(
  `[${command}] This exit is a deliberate, explicit failure — it must not be ` +
    `reported as PASS. Exiting with code 3 (NOT_RUN without FAIL).`,
);
process.exit(3);
