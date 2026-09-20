"""Command-line entry for the D1 RPC probe.

Subcommands:
  env-check     record environment facts (versions, provider readiness)
  run           run one or all of the five unified scenarios
  crash-probe   verify pi subprocess cleanup after a host crash
  tree-nav      tree/navigation architecture-contrast probe
                (supplementary; NOT one of the five unified scenarios)

Evidence layout (shared contract, d1-spikes/schemas/README.md):
  <out>/<scenario>.events.jsonl      raw redacted events, one file/scenario
  <out>/<scenario>.result.json       structured result, one file/scenario
  <out>/environment-rpc-python.json  environment record (this probe only)
  <out>/crash-probe.json             host-crash cleanup observations
  <out>/tree-navigation.events.jsonl append-only tree/navigation raw
        events (seq continues across runs; supplementary probe)
  <out>/tree-navigation.result.jsonl append-only tree/navigation result
        records, one line per run (supplementary probe)
result.json exitCode is the probe CLI exit code (0 PASS / 1 FAIL /
2 BLOCKED / 3 NOT_RUN), matching what a third party re-running `command`
observes; pi subprocess exit codes are recorded as observations.

Overall exit codes (same contract):
  0 = every requested item PASS
  1 = at least one FAIL
  2 = no FAIL but at least one BLOCKED
  3 = no FAIL/BLOCKED but at least one NOT_RUN
"""

from __future__ import annotations

import argparse
import json
import os
import subprocess
import sys
from typing import Any, Dict, List, Optional

from . import __version__
from .crash_probe import run_crash_probe
from .envcheck import check_environment, write_environment_record
from .evidence import BLOCKED_CREDENTIALS, redact_text
from .scenarios import SCENARIOS, ProbeConfig, run_scenario
from .tree_nav import (SCENARIO_ID as TREE_NAV_SCENARIO_ID, TREE_NAV_TIMEOUT,
                       run_tree_nav)

# Local machine's configured pi provider/model at D1 time. These are NOT an
# architecture decision: final model/provider baseline is PENDING_OWNER and
# must be aligned with Agent B (sdk-node) before SDK/RPC comparison counts.
# D1 observation (evidence/rpc/observation-copycopy-403.json): provider
# tal-token-plan-copy-copy passes `pi auth check` and works in print mode
# but returns 403 for every model under --mode rpc; the sibling provider
# below works in both modes, so it is the default for real scenario runs.
DEFAULT_PROVIDER = os.environ.get("TREEAI_D1_PROVIDER",
                                  "tal-token-plan-06c64a09")
DEFAULT_MODEL = os.environ.get("TREEAI_D1_MODEL", "deepseek-v4.1-flash")

_D1_ROOT = os.environ.get(
    "TREEAI_D1_ROOT",
    os.path.abspath(os.path.join(os.path.dirname(__file__),
                                 "..", "..", "..")),
)
DEFAULT_EVIDENCE_DIR = os.path.join(_D1_ROOT, "evidence", "rpc")
DEFAULT_FIXTURE_DIR = os.path.join(_D1_ROOT, "fixtures")
DEFAULT_SCRIPTS_DIR = os.path.join(_D1_ROOT, "scripts")
LOCAL_FIXTURE_DIR = os.path.join(
    os.path.dirname(__file__), "..", "..", "fixtures"
)

SCENARIO_TIMEOUTS = {
    "basic": 300.0,
    "tool": 300.0,
    "steer": 240.0,
    "abort": 150.0,
    "resume": 420.0,
}

EXIT_OK = 0
EXIT_FAIL = 1
EXIT_BLOCKED = 2
EXIT_NOT_RUN = 3


def _add_common(ap: argparse.ArgumentParser) -> None:
    ap.add_argument("--pi-bin", default=os.environ.get("PI_BIN", "pi"))
    ap.add_argument("--provider", default=DEFAULT_PROVIDER)
    ap.add_argument("--model", default=DEFAULT_MODEL)
    ap.add_argument("--thinking", default="off",
                    choices=("off", "minimal", "low", "medium", "high"))
    ap.add_argument("--out", default=DEFAULT_EVIDENCE_DIR,
                    help="evidence output directory (default: "
                         "d1-spikes/evidence/rpc)")
    ap.add_argument("--fixture-dir", default=None,
                    help="fixture source dir (default: shared d1-spikes/"
                         "fixtures if present, else local fallback)")
    ap.add_argument("--run-dir", default=None,
                    help="use an existing make-run-dir output for the tool "
                         "scenario (fixture copy + writable work dir); the "
                         "caller owns its deletion")
    ap.add_argument("--request-timeout", type=float, default=120.0)
    ap.add_argument("--timeout-factor", type=float, default=1.0,
                    help="multiplies every scenario total timeout")


def build_parser() -> argparse.ArgumentParser:
    p = argparse.ArgumentParser(
        prog="pi_rpc_probe",
        description="D1 spike: drive `pi --mode rpc` as a subprocess "
                    "(disposable probe, not a production backend)",
    )
    p.add_argument("--version", action="version",
                   version="pi_rpc_probe %s" % __version__)
    sub = p.add_subparsers(dest="cmd", required=True)

    pe = sub.add_parser("env-check", help="record environment facts")
    _add_common(pe)

    pr = sub.add_parser("run", help="run scenarios")
    _add_common(pr)
    pr.add_argument("--scenario", action="append", required=False,
                    choices=list(SCENARIOS) + ["all"],
                    help="scenario to run (repeatable); default: all")

    pc = sub.add_parser("crash-probe",
                        help="pi cleanup after host crash (SIGKILL driver)")
    _add_common(pc)

    pt = sub.add_parser(
        "tree-nav",
        help="tree/navigation architecture probe: get_tree/fork/clone/"
             "switch_session vs the SDK navigateTree capability "
             "(supplementary; NOT one of the five unified scenarios)")
    _add_common(pt)
    return p


def _resolve_fixture_dir(explicit: Optional[str]) -> str:
    if explicit:
        return os.path.abspath(explicit)
    if os.path.isdir(DEFAULT_FIXTURE_DIR):
        return DEFAULT_FIXTURE_DIR
    return os.path.abspath(LOCAL_FIXTURE_DIR)


def _make_config(args: argparse.Namespace,
                 run_dir: str = "") -> ProbeConfig:
    timeouts = {
        name: base * args.timeout_factor
        for name, base in SCENARIO_TIMEOUTS.items()
    }
    return ProbeConfig(
        pi_bin=args.pi_bin,
        provider=args.provider,
        model=args.model,
        thinking=args.thinking,
        evidence_dir=args.out,
        fixture_dir=_resolve_fixture_dir(args.fixture_dir),
        request_timeout=args.request_timeout,
        scenario_timeouts=timeouts,
        d1_root=_D1_ROOT,
        run_dir=run_dir,
    )


def _env_observation(args: argparse.Namespace,
                     env_record: Dict[str, Any]) -> str:
    """Compact, replayable env facts appended to every result."""
    pi_ver = (env_record.get("piVersion", {}) or {}).get("stdout", "?")
    return ("env: pi %s | provider=%s model=%s thinking=%s | python %s"
            % (pi_ver.strip().splitlines()[0] if pi_ver.strip() else "?",
               args.provider, args.model, args.thinking,
               env_record.get("python", {}).get("version", "?")))


def _make_run_dir() -> str:
    """Create a make-run-dir temp copy of the shared fixtures (Agent D)."""
    script = os.path.join(DEFAULT_SCRIPTS_DIR, "make-run-dir")
    if not os.path.isfile(script):
        raise FileNotFoundError("make-run-dir not found at %s" % script)
    cp = subprocess.run(["bash", script], capture_output=True, text=True,
                        timeout=120)
    if cp.returncode != 0:
        raise RuntimeError("make-run-dir failed: %s" % cp.stderr.strip())
    return cp.stdout.strip().splitlines()[-1]


def _cleanup_run_dir(run_dir: str) -> None:
    """Restore write perms (readonly/ was stripped) and delete the copy."""
    subprocess.run(["chmod", "-R", "u+w", run_dir], capture_output=True)
    subprocess.run(["rm", "-rf", run_dir], capture_output=True)


def _rel_or_redact(path: str) -> str:
    """Record paths d1-root-relative when inside the tree (replayable),
    redacted otherwise (D1 evidence must not carry absolute user paths)."""
    root = os.path.join(_D1_ROOT, "")
    if path.startswith(root):
        rel = path[len(root):]
        if not rel.startswith(".."):
            return rel
    return redact_text(path)


def cmd_env_check(args: argparse.Namespace) -> int:
    ready, record = check_environment(
        args.pi_bin, args.provider, args.model, d1_root=_D1_ROOT,
        thinking=args.thinking
    )
    record["probeDefaults"] = {
        "evidenceDir": _rel_or_redact(os.path.join(args.out, "")),
        "requestTimeout": args.request_timeout,
        "scenarioTimeouts": {
            k: v * args.timeout_factor
            for k, v in SCENARIO_TIMEOUTS.items()
        },
        "fixtureDirUsed": _rel_or_redact(
            _resolve_fixture_dir(args.fixture_dir)),
        "sharedFixturesPresent": os.path.isdir(DEFAULT_FIXTURE_DIR),
    }
    path = os.path.join(args.out, "environment-rpc-python.json")
    write_environment_record(path, record)
    print("environment record: %s" % path)
    print("credentialsReady: %s" % ready)
    if not ready:
        print("STATUS: BLOCKED_CREDENTIALS (scenarios will record BLOCKED)")
        return EXIT_BLOCKED
    return EXIT_OK


def cmd_run(args: argparse.Namespace) -> int:
    # tool scenario must operate on a make-run-dir copy of the shared
    # fixtures when they exist (fixtures/README.txt section 5)
    auto_run_dir = ""
    shared_present = os.path.isdir(
        os.path.join(_resolve_fixture_dir(args.fixture_dir), "numbers.json")
    ) and _resolve_fixture_dir(args.fixture_dir).startswith(_D1_ROOT)
    make_run_dir_exists = os.path.isfile(
        os.path.join(DEFAULT_SCRIPTS_DIR, "make-run-dir"))
    if not args.run_dir and shared_present and make_run_dir_exists:
        try:
            auto_run_dir = _make_run_dir()
            print("tool scenario run dir: %s" % auto_run_dir)
        except (RuntimeError, FileNotFoundError, subprocess.TimeoutExpired) \
                as exc:
            print("make-run-dir unavailable (%s); tool scenario will use "
                  "plain temp staging" % exc)

    config = _make_config(args, run_dir=args.run_dir or auto_run_dir)
    ready, env_record = check_environment(
        args.pi_bin, args.provider, args.model, d1_root=_D1_ROOT,
        thinking=args.thinking
    )
    env_path = os.path.join(config.evidence_dir,
                            "environment-rpc-python.json")
    write_environment_record(env_path, env_record)
    env_obs = _env_observation(args, env_record)

    names: List[str] = []
    for s in (args.scenario or ["all"]):
        if s == "all":
            names.extend(SCENARIOS)
        elif s not in names:
            names.append(s)

    statuses: Dict[str, str] = {}
    try:
        for name in names:
            result = run_scenario(
                name, config,
                ready=ready,
                block_reason=(env_record.get("liveCheck", {})
                              .get("detail")
                              or env_record.get("authCheck", {})
                              .get("stdout")
                              or "provider not ready (live RPC check "
                                 "failed)"),
            )
            statuses[name] = result.status
            result.observations.insert(0, env_obs)
            out_path = os.path.join(
                config.evidence_dir, "%s.result.json" % name
            )
            result.write(out_path)
            print("%-8s %-8s %6dms exit=%r evidence=%s"
                  % (name, result.status, result.duration_ms or 0,
                     result.exit_code, out_path))
            if result.error:
                print("         error: %s"
                      % json.dumps(result.error, ensure_ascii=False)[:300])
            for obs in result.observations[:6]:
                print("         obs: %s" % obs[:200])
    finally:
        if auto_run_dir:
            _cleanup_run_dir(auto_run_dir)

    print("summary: %s" % json.dumps(statuses))
    values = list(statuses.values())
    if "FAIL" in values:
        return EXIT_FAIL
    if "BLOCKED" in values:
        return EXIT_BLOCKED
    if "NOT_RUN" in values:
        return EXIT_NOT_RUN
    return EXIT_OK


def cmd_crash_probe(args: argparse.Namespace) -> int:
    config = _make_config(args)
    ready, _env = check_environment(
        args.pi_bin, args.provider, args.model, d1_root=_D1_ROOT,
        thinking=args.thinking
    )
    result = run_crash_probe(config, ready=ready)
    path = os.path.join(config.evidence_dir, "crash-probe.json")
    os.makedirs(config.evidence_dir, exist_ok=True)
    tmp = path + ".tmp"
    with open(tmp, "w", encoding="utf-8") as fh:
        json.dump(result, fh, ensure_ascii=False, indent=2)
        fh.write("\n")
    os.replace(tmp, path)
    print("crash probe: %s" % path)
    print("conclusion: %s" % result["conclusion"])
    return {
        "PASS": EXIT_OK,
        "FAIL": EXIT_FAIL,
        "NOT_RUN": EXIT_NOT_RUN,
    }.get(result["status"], EXIT_FAIL)


def cmd_tree_nav(args: argparse.Namespace) -> int:
    """Run the supplementary tree/navigation architecture probe.

    Same provider/model/thinking baseline as the five scenarios (shared
    defaults and check_environment); evidence is append-only:
    tree-navigation.events.jsonl (raw events, seq continues across runs)
    and tree-navigation.result.jsonl (one result record per run).
    """
    config = _make_config(args)
    config.scenario_timeouts[TREE_NAV_SCENARIO_ID] = (
        TREE_NAV_TIMEOUT * args.timeout_factor)
    ready, env_record = check_environment(
        args.pi_bin, args.provider, args.model, d1_root=_D1_ROOT,
        thinking=args.thinking
    )
    env_path = os.path.join(config.evidence_dir,
                            "environment-rpc-python.json")
    write_environment_record(env_path, env_record)
    record = run_tree_nav(
        config, ready=ready,
        block_reason=(env_record.get("liveCheck", {}).get("detail")
                      or env_record.get("authCheck", {}).get("stdout")
                      or "provider not ready (live RPC check failed)"),
        env_record=env_record,
    )
    print("tree-navigation: %s (runId=%s)"
          % (record["status"], record.get("runId")))
    for obs in record.get("observations", [])[:10]:
        print("         obs: %s" % obs[:220])
    if record.get("conclusion"):
        print("conclusion: %s" % record["conclusion"])
    if record.get("error"):
        print("error: %s" % json.dumps(record["error"],
                                       ensure_ascii=False)[:300])
    return record.get("exitCode", 1)


def main(argv: Optional[List[str]] = None) -> int:
    parser = build_parser()
    args = parser.parse_args(argv)
    if args.cmd == "env-check":
        return cmd_env_check(args)
    if args.cmd == "run":
        return cmd_run(args)
    if args.cmd == "crash-probe":
        return cmd_crash_probe(args)
    if args.cmd == "tree-nav":
        return cmd_tree_nav(args)
    parser.error("unknown command")  # pragma: no cover
    return 2  # pragma: no cover


if __name__ == "__main__":
    sys.exit(main())
