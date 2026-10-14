# R0–R7 migration audit scope

Use `audit-refactor-boundaries.mjs --base <commit>` for literal imports and original static scenarios, `audit:studio-assets` for exact native HTTP/CSS/package inclusion, and `audit:computed-paths` for executable resources and test discovery. None is behavioral or human acceptance.

The computed-path report resolves import-meta URLs and literal root-relative `join`/`resolve` calls. Its regressions catch a Worker URL stranded by a directory move and a quoted discovery glob pointing to no tests. Generated build outputs, optional provider configuration and variable recipes require execution. Every unresolved expression is included in the JSON report.

| Dynamic owner | Required evidence |
| --- | --- |
| Installer output directory and `packages/<pkg>` loop | Actual package build and complete bundle smoke; layout verifies all launcher modules and recursively includes product source/public assets |
| Evidence locator `resolve(ROOT,path)` | R6 grouping/hash tests plus full tracked-path index; it reads markers, never deletes raw evidence |
| D3 record input `join(ROOT,relativePath)` | Record command guards/schema/scanner; only explicitly selected records are accepted |
| Evaluator `eval-set-${split}.json` | Complete dev and frozen Echo, set integrity/one-shot lock selfcheck; real-model quality and annotations remain separate |
| D4 foundation entrypoint loop | Original `entrypoints-d4` check tests every registered command/file |
| D2 package/source/package-json loops | Original complete production typecheck, unit tests and pinned-Pi verifier checks |
| D4 selftest dated evidence path | Original independent failure/control injections; append-only evidence |
| D3 CLI parameterized entry | CLI tests cover all three current runner/evaluator entries without booting providers |

The main baseline static test count is 794; it is a declaration denominator, not a count of loop-expanded Node tests or browser checks. Frozen B1/B2/B4/B6/B9 and terminology set hashes remain their own denominators. Native browser and complete original suites provide execution coverage. Do not remove failed cases or equate Echo with real Pi.

Inventory size warnings are review inputs. Existing test entrypoints retain complete assertions and suite-specific harness behavior; shared primitives were extracted without imposing one DOM variant. Historical reports, signed product contracts and literal fixture content are retained for authority and traceability. The inventory does not create permanent implementation-size exceptions or authorize deleting evidence.

Final evidence must identify the full tested code SHA, command, exit code, applicable check counts and exclusions. A documentation/evidence-only successor must say which code SHA it records. Sandbox/network/credential failures remain failures or blockers; physical installations, owner Mac signoff, independent participant trials and quality annotation cannot be replaced by automated checks.
