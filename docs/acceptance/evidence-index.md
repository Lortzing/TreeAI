# R6 evidence lookup (read-only, pre-acceptance)

Current evidence is not cleared. R6 §10 only authorizes raw artifact deletion **after** all D3, signed W1 v3, terminology, D4, real Pi, target-platform installers, Mac owner signoff and independent trials pass on the same final SHA.

For an exact candidate checkout, generate a local locator outside the repository:

```sh
node scripts/evidence-index.mjs --out /tmp/treeai-evidence-index.json
```

The JSON groups tracked `evidence/{d2,d3,d4,terminology}/...` entries by run ID, lists paths and SHA-256 of already-tracked small `result.json`, `summary.json`, `checks.json`, `manifest.json`, `environment.json` marker files. It does not open or copy transcripts/screenshots, evaluate acceptance status or delete anything. The `sourceCommit` binds the locator to a checkout, **not** to the run that produced an old artifact; the run's own recorded SHA must be checked independently. Filenames and hashes are directory navigation only, not proof of PASS.

For meaning and original provenance use [D2](../../evidence/d2/README.md), [D3](../../evidence/d3/README.md), [D4](../../evidence/d4/README.md) and [current gates](status.md). D3 signoff requires the full original acceptance script and owner signature; D4 B8 requires physical target-platform execution. Historical failure records remain intact.

After total acceptance, create a separate reviewable deletion inventory mapping each raw artifact to a retained final run ID, manifest/hash, environment, test denominators, relevant failure summary and repro command. Then update verifiers and references before removing redundant raw files. Never use this locator to silently replace substantive evidence with an empty directory.
