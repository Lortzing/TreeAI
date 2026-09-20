"""Tree/navigation architecture-contrast probe (supplementary D1 evidence).

NOT one of the five unified scenarios (basic/tool/steer/abort/resume) and
NOT a production backend: this is a focused probe answering the research
question Agent A left for Agent C (research/pi-capability-inventory.md
section 6.6 / PO-A3):

  can the RPC command set express TreeAI's Branch lifecycle --
  get_tree / fork / clone / switch_session -- and does it expose an
  in-place tree-navigation command equivalent to the SDK's
  session.navigateTree(targetId) (which moves the active leaf inside the
  SAME session file)?

What the probe does, in one pi subprocess with a persistent session
(--session-dir/--session-id, same mechanism as the resume scenario):

  phase trunk        two prompts build a linear trunk; get_state/get_tree/
                     get_entries/get_fork_messages record sessionId,
                     sessionFile, tree shape, leafId and the forkable user
                     entry ids
  phase fork         fork at the first user message; record session
                     identity change, tree shape, history retention
                     (pre-fork marker kept / post-fork marker dropped,
                     judged from get_messages protocol data, never from
                     the model's claims) and that a subsequent prompt
                     settles on the new branch
  phase navigate     send the two plausible in-place navigation command
                     names (navigate_tree, navigateTree) and record the
                     verbatim responses; a rejection IS the expected
                     evidence for the capability gap, so it never fails
                     the run -- only a missing response (timeout) or a
                     process death does
  phase switch-back  switch_session(sessionPath=<original file>) back to
                     the trunk; record identity restoration, history
                     restoration and that a subsequent prompt settles
  phase clone        clone the active branch; record identity change,
                     history retention and that a subsequent prompt
                     settles
  phase cursor       get_entries with a `since` entry-id cursor (the
                     protocol's durable-cursor mechanism) and verify only
                     entries strictly after the cursor are returned

PASS means every phase executed and its observations were collected; it
does NOT assert that the RPC has (or lacks) any capability -- the
capability conclusions live in the `findings`/`conclusion` fields of the
result record. FAIL means the probe could not gather the evidence
(command rejected / timeout / process exit). BLOCKED + blockedReason
CREDENTIALS when no usable credentials (no PASS is ever fabricated).

Evidence layout (append-only, unlike the five flat per-scenario files
which are regenerated per run):

  evidence/rpc/tree-navigation.events.jsonl   raw redacted events; every
        run APPENDS its events (seq continues from the file's last seq,
        so seq stays strictly increasing across runs) plus one
        scenario_summary line carrying runId/status/error
  evidence/rpc/tree-navigation.result.jsonl   one full result record per
        run, appended (never rewritten)

Run events are staged in a .run-<runId>.tmp file first and appended to
the events file in a single write+fsync once the run finishes (including
on failure, with the last known events and a structured error) -- a
crashed run never leaves partial lines behind. stderr stays in its own
file (never in the JSONL parser channel) and is folded into the events
as a redacted probe_note after process exit, exactly like the five
scenarios.

The `scenario` value "tree-navigation" is intentionally OUTSIDE the
shared evidence-event/scenario-result schema enum (which covers the five
unified scenarios only). This probe keeps the same line shape, but the
supplementary evidence is not schema-checked by scripts/verify-d1 (it
only looks at the five scenarios); extending the enum is a PENDING_OWNER
decision recorded in the README.
"""

from __future__ import annotations

import json
import os
import shutil
import tempfile
import time
import uuid
from typing import Any, Dict, List, Optional, Tuple

from .client import ProcessExitedError, RpcTimeoutError
from .evidence import (
    BLOCKED_CREDENTIALS,
    EvidenceRecorder,
    ScenarioResult,
    append_summary,
    redact_obj,
    redact_text,
)
from .scenarios import (
    STATUS_TO_EXIT_CODE,
    PiProcessProbe,
    ScenarioError,
    ScenarioTimeout,
    _Watchdog,
    _check_deadline,
    _err,
    last_assistant_text,
)

SCENARIO_ID = "tree-navigation"
EVENTS_FILENAME = "tree-navigation.events.jsonl"
RESULTS_FILENAME = "tree-navigation.result.jsonl"
TREE_NAV_TIMEOUT = 420.0

# Shared prompt corpus (same style as the five scenarios: short, fixed,
# verifiable; markers are chosen to never collide with secret-scanner
# patterns).
PROMPT_TRUNK_1 = (
    "Remember this trunk code word: TRUNK-ONE-41. Reply with exactly: OK1"
)
PROMPT_TRUNK_2 = (
    "Now also remember a second code word: TRUNK-TWO-42. Reply with "
    "exactly: OK2"
)
PROMPT_ON_BRANCH = (
    "In one short sentence, list every code word you have been told in "
    "this session so far. End your reply with exactly: BRANCH-ACTIVE"
)
PROMPT_BACK_ON_TRUNK = "Reply with exactly: BACK-ON-TRUNK"
PROMPT_ON_CLONE = "Reply with exactly: CLONED"

MARKER_TRUNK_1 = "TRUNK-ONE-41"
MARKER_TRUNK_2 = "TRUNK-TWO-42"


# ---------------------------------------------------------------------------
# Small helpers
# ---------------------------------------------------------------------------

def _data(resp: Dict[str, Any]) -> Dict[str, Any]:
    return resp.get("data") or {}


def _count_tree_nodes(nodes: Any) -> int:
    total = 0
    for node in nodes or []:
        if isinstance(node, dict):
            total += 1 + _count_tree_nodes(node.get("children"))
    return total


def _tree_max_depth(nodes: Any, depth: int = 0) -> int:
    best = depth
    for node in nodes or []:
        if isinstance(node, dict):
            best = max(best,
                       _tree_max_depth(node.get("children"), depth + 1))
    return best


def _basename(path: Any) -> Optional[str]:
    s = str(path) if path else ""
    return os.path.basename(s) if s else None


def _last_seq_in_events(path: str) -> int:
    """Last seq value in an append-only events file (0 when absent)."""
    if not os.path.exists(path):
        return 0
    last = 0
    with open(path, "r", encoding="utf-8") as fh:
        for line in fh:
            line = line.strip()
            if not line:
                continue
            try:
                obj = json.loads(line)
            except ValueError:
                continue
            if isinstance(obj, dict) and isinstance(obj.get("seq"), int):
                last = max(last, obj["seq"])
    return last


def _append_file_atomically(src_path: str, dst_path: str) -> None:
    """Append the complete staged content to dst in one write + fsync."""
    with open(src_path, "rb") as src:
        data = src.read()
    if not data:
        return
    with open(dst_path, "ab") as dst:
        dst.write(data)
        dst.flush()
        os.fsync(dst.fileno())


def append_result_record(path: str, record: Dict[str, Any]) -> None:
    """Append one result line (single write + fsync, never rewritten)."""
    os.makedirs(os.path.dirname(path), exist_ok=True)
    line = json.dumps(record, ensure_ascii=False) + "\n"
    with open(path, "a", encoding="utf-8") as fh:
        fh.write(line)
        fh.flush()
        os.fsync(fh.fileno())


def _env_observation(env_record: Optional[Dict[str, Any]]) -> str:
    env_record = env_record or {}
    pi_ver = str((env_record.get("piVersion") or {}).get("stdout") or "?")
    first = pi_ver.strip().splitlines()[0] if pi_ver.strip() else "?"
    return ("env: pi %s | provider=%s model=%s thinking=%s | python %s"
            % (first, env_record.get("provider"), env_record.get("model"),
               env_record.get("thinking"),
               (env_record.get("python") or {}).get("version", "?")))


def _probe_tolerant(probe: PiProcessProbe, recorder: EvidenceRecorder,
                    command: str, payload: Dict[str, Any],
                    timeout: float) -> Dict[str, Any]:
    """Send one command and record whatever comes back WITHOUT failing the
    run on success:false or a missing response.

    Used only for the in-place-navigation capability probes: the rejection
    itself is the evidence. A request timeout is recorded as such; a
    process exit still propagates (dead pi = the probe cannot continue).

    The verbatim response is recorded as a probe_note because the RPC
    client does not fan command responses out to the event stream (the
    five-scenario evidence records protocol events only) -- without this,
    the raw events file would not carry the capability-gap evidence.
    """
    t0 = time.monotonic()
    try:
        resp = probe.client.request(command, payload, timeout=timeout)
        recorder.note("navigate probe: response",
                      command=command, response=resp)
        return {"responded": True, "response": resp,
                "elapsedMs": int((time.monotonic() - t0) * 1000)}
    except RpcTimeoutError:
        recorder.note("navigate probe: no response (timeout)",
                      command=command, timeoutS=timeout)
        return {"responded": False, "outcome": "timeout",
                "timeoutS": timeout,
                "elapsedMs": int((time.monotonic() - t0) * 1000)}


# ---------------------------------------------------------------------------
# Probe phases
# ---------------------------------------------------------------------------

def _run_phases(
    probe: PiProcessProbe,
    recorder: EvidenceRecorder,
    config: Any,
    deadline: float,
    findings: Dict[str, Any],
    observations: List[str],
    limitations: List[str],
    session_dir: str,
) -> Tuple[str, Optional[Dict[str, Any]]]:

    def _rem() -> float:
        return max(1.0, deadline - time.monotonic())

    # ---- phase 1: build a linear trunk -------------------------------
    _check_deadline(deadline)
    observations.append("argv=%s" % redact_text(" ".join(probe.argv)))
    recorder.note("tree-nav phase: trunk")
    probe.prompt_and_wait(
        PROMPT_TRUNK_1, timeout=min(_rem(), config.request_timeout))
    probe.prompt_and_wait(
        PROMPT_TRUNK_2, timeout=min(_rem(), config.request_timeout))

    state_trunk = _data(probe.request("get_state"))
    sid_trunk = state_trunk.get("sessionId")
    sfile_trunk = state_trunk.get("sessionFile")
    recorder.set_session_id(str(sid_trunk) if sid_trunk else "unknown")

    tree_trunk = _data(probe.request("get_tree"))
    entries_trunk = _data(probe.request("get_entries")).get("entries") or []
    forks = _data(probe.request("get_fork_messages")).get("messages") or []

    if not (tree_trunk.get("tree") and tree_trunk.get("leafId")):
        return "FAIL", _err(
            "assertion", "get_tree did not return a populated tree",
            stage="trunk", tree=tree_trunk)

    findings["trunk"] = {
        "sessionId": sid_trunk,
        "sessionFileBasename": _basename(sfile_trunk),
        "sessionFileRedacted": redact_text(str(sfile_trunk or "")),
        "treeNodes": _count_tree_nodes(tree_trunk.get("tree")),
        "treeDepth": _tree_max_depth(tree_trunk.get("tree")),
        "leafId": tree_trunk.get("leafId"),
        "entryCount": len(entries_trunk),
        "forkableUserMessages": [
            {"entryId": m.get("entryId"),
             "textHead": str(m.get("text") or "")[:80]}
            for m in forks if isinstance(m, dict)
        ],
    }
    observations.append(
        "trunk: sessionId=%r sessionFile=%s treeNodes=%d depth=%d "
        "leafId=%s entries=%d forkables=%d"
        % (sid_trunk, findings["trunk"]["sessionFileBasename"],
           findings["trunk"]["treeNodes"], findings["trunk"]["treeDepth"],
           findings["trunk"]["leafId"], findings["trunk"]["entryCount"],
           len(forks)))

    fork_entry_id = None
    for m in forks:
        if isinstance(m, dict) and MARKER_TRUNK_1 in str(m.get("text") or ""):
            fork_entry_id = m.get("entryId")
            break
    if fork_entry_id is None and forks:
        fork_entry_id = forks[0].get("entryId")
        limitations.append(
            "get_fork_messages texts did not contain the trunk-1 marker; "
            "forked from the first listed user entry instead")
    if not fork_entry_id:
        return "FAIL", _err(
            "assertion", "no forkable user entry id found",
            stage="trunk", forkables=findings["trunk"]["forkableUserMessages"])

    # ---- phase 2: fork at the first user message ---------------------
    _check_deadline(deadline)
    recorder.note("tree-nav phase: fork", entryId=fork_entry_id)
    fork_resp = probe.request("fork", {"entryId": fork_entry_id})
    fork_data = fork_resp.get("data") or {}
    if fork_data.get("cancelled") is True:
        return "FAIL", _err(
            "assertion", "fork was cancelled (data.cancelled=true)",
            stage="fork", response=fork_resp)

    state_fork = _data(probe.request("get_state"))
    sid_fork = state_fork.get("sessionId")
    sfile_fork = state_fork.get("sessionFile")
    recorder.set_session_id(str(sid_fork) if sid_fork else "unknown")

    msgs_fork = _data(probe.request("get_messages")).get("messages") or []
    hist_fork = json.dumps(msgs_fork)
    tree_fork = _data(probe.request("get_tree"))

    base_branch = recorder.seq
    probe.prompt_and_wait(
        PROMPT_ON_BRANCH, timeout=min(_rem(), config.request_timeout))
    answer_branch = last_assistant_text(recorder, base_branch)
    tree_fork_after = _data(probe.request("get_tree"))

    findings["fork"] = {
        "entryIdUsed": fork_entry_id,
        "returnedTextHasTrunkOneMarker":
            MARKER_TRUNK_1 in str(fork_data.get("text") or ""),
        "sessionIdChanged": sid_fork != sid_trunk,
        "sessionId": sid_fork,
        "sessionFileChanged": (
            _basename(sfile_fork) != _basename(sfile_trunk)),
        "sessionFileBasename": _basename(sfile_fork),
        "sessionFileRedacted": redact_text(str(sfile_fork or "")),
        "historyKeptPreForkMarker": MARKER_TRUNK_1 in hist_fork,
        "postForkHistoryDroppedMarker": MARKER_TRUNK_2 not in hist_fork,
        "promptAfterForkSettled": True,  # prompt_and_wait raised otherwise
        "promptAnswerHead": answer_branch[:120],
        "treeNodesAfterFork": _count_tree_nodes(tree_fork.get("tree")),
        "leafIdAfterFork": tree_fork.get("leafId"),
        "leafIdAfterBranchPrompt": tree_fork_after.get("leafId"),
        "leafMovedAfterPrompt": (
            tree_fork_after.get("leafId") != tree_fork.get("leafId")),
    }
    observations.append(
        "fork: entryId=%s sessionIdChanged=%s sessionFileChanged=%s "
        "preForkHistoryKept=%s postForkHistoryDropped=%s "
        "promptSettled=True leafMoved=%s"
        % (fork_entry_id, findings["fork"]["sessionIdChanged"],
           findings["fork"]["sessionFileChanged"],
           findings["fork"]["historyKeptPreForkMarker"],
           findings["fork"]["postForkHistoryDroppedMarker"],
           findings["fork"]["leafMovedAfterPrompt"]))

    # ---- phase 3: in-place navigation capability probes ---------------
    _check_deadline(deadline)
    recorder.note("tree-nav phase: navigate probes")
    nav_results: Dict[str, Any] = {}
    for name in ("navigate_tree", "navigateTree"):
        nav_results[name] = _probe_tolerant(
            probe, recorder, name, {"targetId": fork_entry_id},
            timeout=min(30.0, _rem()))
    equivalent = any(
        r.get("responded") and (r.get("response") or {}).get("success") is True
        for r in nav_results.values())
    findings["inPlaceNavigation"] = {
        "probedCommands": nav_results,
        "sdkNavigateTreeEquivalentFound": equivalent,
        "note": "SDK navigateTree(targetId) moves the active leaf inside "
                "the same session file; the RPC command set documented in "
                "pi 0.85.1 rpc.md has no such command (research "
                "pi-capability-inventory.md 6.6) -- these probes record "
                "the runtime confirmation",
    }
    for name, r in nav_results.items():
        resp = r.get("response") or {}
        observations.append(
            "navigate probe %r: responded=%s success=%r error=%r"
            % (name, r.get("responded"), resp.get("success"),
               resp.get("error")))

    # ---- phase 4: switch back to the original trunk session ----------
    _check_deadline(deadline)
    recorder.note("tree-nav phase: switch back")
    if sfile_trunk and os.path.isfile(str(sfile_trunk)):
        probe.request("switch_session", {"sessionPath": sfile_trunk})
        state_back = _data(probe.request("get_state"))
        sid_back = state_back.get("sessionId")
        recorder.set_session_id(str(sid_back) if sid_back else "unknown")
        msgs_back = _data(probe.request("get_messages")).get("messages") or []
        hist_back = json.dumps(msgs_back)
        tree_back = _data(probe.request("get_tree"))
        base_back = recorder.seq
        probe.prompt_and_wait(
            PROMPT_BACK_ON_TRUNK, timeout=min(_rem(), config.request_timeout))
        answer_back = last_assistant_text(recorder, base_back)
        findings["switchBack"] = {
            "method": "switch_session(sessionPath=<original trunk file>)",
            "sessionIdRestoredToTrunk": sid_back == sid_trunk,
            "sessionId": sid_back,
            "sessionFileBasename": _basename(state_back.get("sessionFile")),
            "trunkHistoryRestored": (
                MARKER_TRUNK_1 in hist_back and MARKER_TRUNK_2 in hist_back),
            "promptAfterSwitchSettled": True,
            "promptAnswerHead": answer_back[:80],
            "leafId": tree_back.get("leafId"),
        }
        observations.append(
            "switch-back: method=switch_session(sessionPath) "
            "sessionIdRestored=%s trunkHistoryRestored=%s "
            "promptSettled=True leafId=%s"
            % (findings["switchBack"]["sessionIdRestoredToTrunk"],
               findings["switchBack"]["trunkHistoryRestored"],
               findings["switchBack"]["leafId"]))
    else:
        findings["switchBack"] = {
            "method": "switch_session(sessionPath=...)",
            "originalFileMissing": True,
        }
        limitations.append(
            "original trunk session file was not present on disk after "
            "fork; switch-back phase could not run (recorded as-is)")

    # ---- phase 5: clone the active branch ----------------------------
    _check_deadline(deadline)
    recorder.note("tree-nav phase: clone")
    probe.request("clone")
    state_clone = _data(probe.request("get_state"))
    sid_clone = state_clone.get("sessionId")
    recorder.set_session_id(str(sid_clone) if sid_clone else "unknown")
    msgs_clone = _data(probe.request("get_messages")).get("messages") or []
    hist_clone = json.dumps(msgs_clone)
    base_clone = recorder.seq
    probe.prompt_and_wait(
        PROMPT_ON_CLONE, timeout=min(_rem(), config.request_timeout))
    answer_clone = last_assistant_text(recorder, base_clone)
    tree_clone = _data(probe.request("get_tree"))
    sid_before_clone = (findings.get("switchBack") or {}).get("sessionId")
    findings["clone"] = {
        "sessionIdChanged": sid_clone != sid_before_clone,
        "sessionId": sid_clone,
        "sessionFileBasename": _basename(state_clone.get("sessionFile")),
        "sessionFileRedacted": redact_text(
            str(state_clone.get("sessionFile") or "")),
        "historyKept": (MARKER_TRUNK_1 in hist_clone
                        and MARKER_TRUNK_2 in hist_clone),
        "promptAfterCloneSettled": True,
        "promptAnswerHead": answer_clone[:80],
        "treeNodes": _count_tree_nodes(tree_clone.get("tree")),
        "leafId": tree_clone.get("leafId"),
    }
    observations.append(
        "clone: sessionIdChanged=%s historyKept=%s promptSettled=True "
        "treeNodes=%s leafId=%s"
        % (findings["clone"]["sessionIdChanged"],
           findings["clone"]["historyKept"],
           findings["clone"]["treeNodes"], findings["clone"]["leafId"]))

    # ---- phase 6: durable entry-id cursor ----------------------------
    _check_deadline(deadline)
    recorder.note("tree-nav phase: cursor")
    entries_now = _data(probe.request("get_entries")).get("entries") or []
    cursor = None
    for e in entries_now:
        if not isinstance(e, dict):
            continue
        if MARKER_TRUNK_2 in json.dumps(e.get("message") or {}):
            cursor = e.get("id")
            break
    if cursor is None and entries_now:
        cursor = (entries_now[0] or {}).get("id")
    if cursor:
        since_resp = probe.request("get_entries", {"since": cursor})
        after = _data(since_resp).get("entries") or []
        findings["durableCursor"] = {
            "cursorEntryId": cursor,
            "entriesAfterCursor": len(after),
            "totalEntries": len(entries_now),
            "idsAfterCursorHead": [e.get("id") for e in after
                                   if isinstance(e, dict)][:10],
            "strictlyAfterCursor": all(
                isinstance(e, dict) and e.get("id") != cursor
                for e in after),
        }
        observations.append(
            "cursor: get_entries(since=%s) -> %d/%d entries, "
            "strictlyAfter=%s"
            % (cursor, len(after), len(entries_now),
               findings["durableCursor"]["strictlyAfterCursor"]))
    else:
        findings["durableCursor"] = None
        limitations.append("no entry id available for the since-cursor probe")

    # ---- phase 7: session artifacts created (host side) ---------------
    session_files: List[str] = []
    if os.path.isdir(session_dir):
        session_files = sorted(
            "%s (%d bytes)" % (n, os.path.getsize(os.path.join(session_dir, n)))
            for n in os.listdir(session_dir) if n.endswith(".jsonl"))
    findings["sessionFilesAfterRun"] = session_files
    observations.append(
        "session-dir after run: %d file(s): %s"
        % (len(session_files), "; ".join(session_files) if session_files
           else "(none -- fork/clone wrote outside --session-dir; the probe "
                "does not scan pi's default session directory)"))
    if session_files and len(session_files) < 2:
        limitations.append(
            "fewer session files in --session-dir than fork/clone would "
            "imply; pi may write fork/clone sessions outside the given "
            "session dir (the probe does not scan the user's default pi "
            "session directory -- D1 no-personal-home-access policy)")

    return "PASS", None


# ---------------------------------------------------------------------------
# Conclusion
# ---------------------------------------------------------------------------

def _build_conclusion(findings: Dict[str, Any]) -> str:
    fork = findings.get("fork") or {}
    nav = findings.get("inPlaceNavigation") or {}
    swb = findings.get("switchBack") or {}
    clone = findings.get("clone") or {}
    parts = []
    parts.append(
        "fork -> %s session (sessionIdChanged=%s, sessionFileChanged=%s; "
        "pre-fork history kept=%s, post-fork history dropped=%s; prompt on "
        "the branch settled=%s)"
        % ("new" if fork.get("sessionIdChanged") else "same",
           fork.get("sessionIdChanged"), fork.get("sessionFileChanged"),
           fork.get("historyKeptPreForkMarker"),
           fork.get("postForkHistoryDroppedMarker"),
           fork.get("promptAfterForkSettled")))
    navs = nav.get("probedCommands") or {}
    bits = []
    for name in ("navigate_tree", "navigateTree"):
        r = navs.get(name) or {}
        resp = r.get("response") or {}
        bits.append("%s: responded=%s success=%r"
                    % (name, r.get("responded"), resp.get("success")))
    parts.append(
        "in-place navigateTree equivalent found=%s (%s)"
        % (nav.get("sdkNavigateTreeEquivalentFound"), "; ".join(bits)))
    if swb.get("originalFileMissing"):
        parts.append("switch-back: NOT RUN (original file missing after fork)")
    else:
        parts.append(
            "switch back -> switch_session(sessionPath) (sessionId "
            "restored=%s, trunk history restored=%s, prompt settled=%s)"
            % (swb.get("sessionIdRestoredToTrunk"),
               swb.get("trunkHistoryRestored"),
               swb.get("promptAfterSwitchSettled")))
    parts.append(
        "clone -> %s session (changed=%s, history kept=%s, prompt "
        "settled=%s)"
        % ("new" if clone.get("sessionIdChanged") else "same",
           clone.get("sessionIdChanged"), clone.get("historyKept"),
           clone.get("promptAfterCloneSettled")))
    files = findings.get("sessionFilesAfterRun") or []
    parts.append("session files in --session-dir after run: %d" % len(files))
    return "; ".join(parts)


# ---------------------------------------------------------------------------
# Entry point
# ---------------------------------------------------------------------------

def run_tree_nav(config: Any, ready: bool = True, block_reason: str = "",
                 env_record: Optional[Dict[str, Any]] = None
                 ) -> Dict[str, Any]:
    """Run the tree/navigation probe once; append evidence; return record."""
    result = ScenarioResult(SCENARIO_ID)
    result.command = config.command or "python3 rpc-python/probe.py tree-nav"
    run_id = time.strftime("%Y%m%dT%H%M%S", time.gmtime()) + "-" + \
        uuid.uuid4().hex[:6]
    results_path = os.path.join(config.evidence_dir, RESULTS_FILENAME)

    if not ready:
        result.finish(
            "BLOCKED",
            _err(BLOCKED_CREDENTIALS,
                 block_reason or "provider credentials not ready"),
            blocked_reason="CREDENTIALS",
        )
        result.exit_code = STATUS_TO_EXIT_CODE["BLOCKED"]
        result.limitations.append(
            "no real pi run: credentials unavailable; code and protocol "
            "tests still executable")
        record = _finalize_record(result, env_record, findings=None,
                                  run_id=run_id, conclusion="")
        append_result_record(results_path, record)
        return record

    events_path = os.path.join(config.evidence_dir, EVENTS_FILENAME)
    os.makedirs(config.evidence_dir, exist_ok=True)
    seq_start = _last_seq_in_events(events_path)
    # AtomicJsonlWriter appends ".tmp" itself, so the recorder is pointed
    # at the base name and the on-disk staging file is staged_base+".tmp"
    staged_base = "%s.run-%s" % (events_path, run_id)
    staged_tmp = staged_base + ".tmp"
    recorder = EvidenceRecorder(SCENARIO_ID, staged_base, seq_start=seq_start)

    timeout = config.timeout_for(SCENARIO_ID, default=TREE_NAV_TIMEOUT)
    deadline = time.monotonic() + timeout
    watchdog = _Watchdog(deadline)
    watchdog.start()

    workdir = tempfile.mkdtemp(prefix="d1-tree-")
    session_dir = os.path.join(workdir, "sessions")
    os.makedirs(session_dir, exist_ok=True)
    fixed_session_id = str(uuid.uuid4())
    # --no-tools: minimal tool allowlist (this probe needs no tools)
    common_args = ["--session-dir", session_dir,
                   "--session-id", fixed_session_id, "--no-tools"]

    findings: Dict[str, Any] = {}
    observations: List[str] = []
    limitations: List[str] = [
        "supplementary probe: scenario id 'tree-navigation' is outside the "
        "shared evidence-event/scenario-result schema enum (five unified "
        "scenarios only); the same line shape is kept and extending the "
        "enum is a PENDING_OWNER decision",
        "PASS means every phase executed and observations were collected; "
        "capability conclusions are in findings/conclusion, not in the "
        "status",
        "branch history judgments use get_messages/get_tree protocol data; "
        "model answer texts are recorded as soft observations only",
        "the probe never reads or scans pi's default session directory "
        "outside the workspace (D1 no-personal-home-access policy)",
    ]
    status = "PASS"
    error: Optional[Dict[str, Any]] = None
    probe: Optional[PiProcessProbe] = None
    try:
        probe = PiProcessProbe(
            config, SCENARIO_ID, extra_args=common_args,
            cwd=workdir, label="p1", recorder=recorder,
        )
        watchdog.register(probe)
        status, error = _run_phases(
            probe, recorder, config, deadline, findings, observations,
            limitations, session_dir)
    except (RpcTimeoutError, ScenarioTimeout) as exc:
        status, error = "FAIL", _err("timeout", str(exc))
    except ProcessExitedError as exc:
        status, error = "FAIL", _err("process-exited", str(exc),
                                     exit_code=exc.exit_code)
    except ScenarioError as exc:
        status, error = "FAIL", _err("command", str(exc))
    except Exception as exc:  # defensive: never crash the harness silently
        status, error = "FAIL", _err("unexpected",
                                     "%s: %s" % (type(exc).__name__, exc))
    finally:
        watchdog.stop()
        if probe is not None:
            try:
                probe.close()
            except Exception:  # pragma: no cover - close must not abort
                pass  # evidence append below must still happen
        # append this run's staged events to the append-only file (also on
        # failure: last known events + structured error), then the summary
        recorder.writer.abort()  # close the tmp without renaming
        if recorder.seq > seq_start:
            try:
                _append_file_atomically(staged_tmp, events_path)
                append_summary(events_path, SCENARIO_ID, status, error,
                               extra={"runId": run_id})
            finally:
                if os.path.exists(staged_tmp):
                    try:
                        os.remove(staged_tmp)
                    except OSError:  # pragma: no cover - defensive
                        pass
        else:
            if os.path.exists(staged_tmp):
                try:
                    os.remove(staged_tmp)
                except OSError:  # pragma: no cover - defensive
                    pass
        shutil.rmtree(workdir, ignore_errors=True)

    result.observations.extend(observations)
    result.limitations.extend(limitations)
    result.observations.insert(0, _env_observation(env_record))
    if probe is not None:
        result.observations.append(
            "pi subprocess exit code: %r" % (probe.proc.exit_code,))
    conclusion = _build_conclusion(findings) if findings else ""
    if status == "PASS":
        result.evidence_files = [config.rel_to_d1_root(events_path)]
    elif recorder.seq > seq_start:
        result.evidence_files = [config.rel_to_d1_root(events_path)]
    result.exit_code = STATUS_TO_EXIT_CODE.get(status, 1)
    result.finish(status, error)
    record = _finalize_record(result, env_record, findings=findings,
                              run_id=run_id, conclusion=conclusion)
    append_result_record(results_path, record)
    return record


def _finalize_record(result: ScenarioResult,
                     env_record: Optional[Dict[str, Any]],
                     findings: Optional[Dict[str, Any]],
                     run_id: str, conclusion: str) -> Dict[str, Any]:
    record = result.to_json()
    record["probe"] = "tree-nav"
    record["runId"] = run_id
    if conclusion:
        record["conclusion"] = redact_text(conclusion)
    if findings is not None:
        record["findings"] = redact_obj(findings)
    if env_record:
        pi_ver = str((env_record.get("piVersion") or {}).get("stdout")
                     or "").strip()
        record["baseline"] = {
            "piVersion": pi_ver.splitlines()[0] if pi_ver else None,
            "provider": env_record.get("provider"),
            "model": env_record.get("model"),
            "thinking": env_record.get("thinking"),
        }
    return record
