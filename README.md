# TreeAI

TreeAI is a local thinking workspace built on the Pi Agent SDK. Start with a question, branch from a specific source in a conversation or Markdown/PDF material, then explicitly Return useful findings to the main thread. Sources remain independently readable when the model session is no longer available.

**Status:** local Beta under development, not a completed cross-platform or human-accepted release. Saved conversations, terminology annotations, source selection, material search, hierarchical navigation, export/restore and Return have code paths; final-candidate gates remain independent.

- [Current acceptance status](docs/acceptance/status.md)
- [Documentation index](docs/index.md)
- [Product authority](docs/product/index.md)

## Run locally

Pinned: Node `24.21.0`, npm `11.19.0`.

```sh
npm ci
npm run build:deps --workspace @treeai/studio
npm run start --workspace @treeai/studio
```

Open `http://127.0.0.1:8787`. Default driver is offline Echo; no model key is required.

Set a persistent data directory and port:

```sh
npm run start --workspace @treeai/studio -- --data "/absolute/path/treeai-data" --port 8787
```

Saved product facts are in TreeAI storage; Pi sessions provide model continuation, not the only copy of your work.

## Real Pi (optional)

Supply an approved provider/model and a controlled agent directory. Provide the key via `TREEAI_STUDIO_API_KEY` in the environment, never in flags, code, screenshots or issues.

```sh
npm run start --workspace @treeai/studio -- \
  --driver pi --provider "<provider-id>" --model "<model-id>" \
  --data "/absolute/path/treeai-data" --agent-dir "/absolute/path/controlled-pi-agent"
```

Missing credentials or mismatched provider/model should fail explicitly. The Studio does not silently read `~/.pi`. Tools are disabled by default; the optional read-only tool policy requires explicit controlled configuration.

## Structure

| Path | Role |
| --- | --- |
| `apps/studio` | Native browser UI, loopback HTTP API, services |
| `apps/runtime-smoke` | Runtime integration checks |
| `packages/contracts` | SDK-independent TreeAI contracts |
| `packages/runtime-pi` | Pi SDK session and event adapter |
| `packages/persistence` | DB-backed product facts and transactions |
| `packages/tool-policy` | Tool authorization |
| `packages/event-journal` | Event/run journal |
| `scripts` and `tests` | Tests, verifiers, probes and installers |
| `docs` | Architecture, developer navigation, product rules and status |
| `evidence` | Acceptance evidence; cleanup only after whole-project acceptance |
| `d1-spikes` | Read-only D1 baseline and regression sources |

[Architecture](docs/architecture/overview.md) · [Task map](docs/development/task-map.md) · [Testing](docs/development/testing.md)

## Checks

```sh
npm run typecheck
npm test
npm run verify:d2
npm run verify:d2:selftest
npm run verify:d4
npm run verify:d4:selftest
```

Exit code `3` means a gated check is BLOCKED/NOT_RUN, not that the entire project passed. Real browser, real Pi, Mac signoff, participant trials and actual target-platform installer verification must be recorded on the final SHA.

To generate a reviewable tracked-file baseline without dumping it into agent context:

```sh
node scripts/repo-inventory.mjs --out /tmp/treeai-inventory.json
```

See [testing guidance](docs/development/testing.md) before moving or deleting code. In particular, moving a browser module also requires a static route and installer asset audit, and moving a test requires updating discovery.

## Installer targets

Planned targets: macOS Apple Silicon, Windows 11 x64, Ubuntu 24.04 x64. Availability and tested artifacts are tracked in [D4 status](docs/d4/D4-status.md); this README does not invent a download URL.

## Contributing

Read [AGENTS.md](AGENTS.md), [task map](docs/development/task-map.md), and the authoritative product rules before changing a cross-cutting boundary. Report issues with version, complete SHA, OS/browser, reproduction and sanitized errors. Do not attach API keys or full personal materials.

## License

MIT — [LICENSE](LICENSE).
