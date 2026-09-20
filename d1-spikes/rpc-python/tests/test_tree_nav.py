"""Tree/navigation probe tests against the fake pi server (no real model):

- the PASS path scripts the full branch lifecycle (trunk -> fork ->
  navigate probes -> switch back -> clone -> since-cursor) and proves the
  findings/conclusion are collected from protocol data;
- the append-only evidence contract: events seq continues across runs,
  one result line per run, never rewritten;
- the BLOCKED_CREDENTIALS path appends a BLOCKED record without
  fabricating a PASS and without spawning pi;
- a rejected fork command produces a structured FAIL whose last events
  and error still land in the append-only evidence;
- CLI exit codes for the tree-nav subcommand follow the shared contract.

The in-place navigation probes (navigate_tree / navigateTree) are
answered by the fake's default unknown-command rejection, exactly like
the real pi 0.85.1 does -- the probe must record the rejection as the
capability-gap evidence instead of failing.

The fake never writes session files, so each run's --session-dir is
pre-seeded host-side (the workdir the probe creates via tempfile is
pinned with mock.patch) and the get_state responses point at those
files: this exercises both the switch-back isfile check and the
phase-7 session-dir listing without touching any real home directory.
"""

from __future__ import annotations

import json
import os
import stat
import sys
import unittest
from unittest import mock

sys.path.insert(0, os.path.join(os.path.dirname(os.path.abspath(__file__)),
                                "..", "src"))

from pi_rpc_probe import cli  # noqa: E402
from pi_rpc_probe.evidence import BLOCKED_CREDENTIALS  # noqa: E402
from pi_rpc_probe.scenarios import ProbeConfig  # noqa: E402
from pi_rpc_probe.tree_nav import (  # noqa: E402
    EVENTS_FILENAME,
    RESULTS_FILENAME,
    SCENARIO_ID,
    run_tree_nav,
)

sys.path.insert(0, os.path.dirname(os.path.abspath(__file__)))
from helpers import fake_pi_argv, resp, streaming_flow, tmpdir  # noqa: E402


def _node(eid, parent, children=None):
    return {
        "entry": {"type": "message", "id": eid, "parentId": parent,
                  "message": {"role": "user", "content": "msg-%s" % eid}},
        "children": children or [],
    }


def _entry(eid, parent, role, text):
    return {"type": "message", "id": eid, "parentId": parent,
            "message": {"role": role, "content": text}}


TRUNK_TREE = [_node("e1", None, [
    _node("e2", "e1", [_node("e3", "e2", [_node("e4", "e3")])]),
])]
FORK_TREE = [_node("e1", None, [_node("e2", "e1")])]
FORK_TREE_AFTER = [_node("e1", None, [
    _node("e2", "e1", [_node("e5", "e2")]),
])]
CLONE_TREE = [_node("e1", None, [
    _node("e2", "e1", [_node("e3", "e2", [
        _node("e4", "e3", [_node("e6", "e4", [_node("e7", "e6")])]),
    ])]),
])]

TEXT_P1 = "Remember this trunk code word: TRUNK-ONE-41. Reply with " \
          "exactly: OK1"
TEXT_P2 = "Now also remember a second code word: TRUNK-TWO-42. Reply " \
          "with exactly: OK2"

TRUNK_ENTRIES = [
    _entry("e1", None, "user", TEXT_P1),
    _entry("e2", "e1", "assistant", "OK1"),
    _entry("e3", "e2", "user", TEXT_P2),
    _entry("e4", "e3", "assistant", "OK2"),
]
CLONE_ENTRIES = TRUNK_ENTRIES + [
    _entry("e6", "e4", "user", "Reply with exactly: BACK-ON-TRUNK"),
    _entry("e7", "e6", "assistant", "BACK-ON-TRUNK"),
]

TRUNK_MESSAGES = [
    {"role": "user", "content": TEXT_P1},
    {"role": "assistant", "content": "OK1"},
    {"role": "user", "content": TEXT_P2},
    {"role": "assistant", "content": "OK2"},
]
FORK_MESSAGES = [
    {"role": "user", "content": TEXT_P1},
    {"role": "assistant", "content": "OK1"},
]


def _state(sid, sfile):
    return resp("get_state", data={"sessionId": sid, "sessionFile": sfile,
                                   "isStreaming": False})


def _make_session_files(workdir):
    """Pre-seed <workdir>/sessions with the files the fake will report.

    The probe pins its --session-dir to <workdir>/sessions (via the
    tempfile patch in _run_once), so these files satisfy both the
    switch-back isfile check and the phase-7 host-side listing.
    """
    sdir = os.path.join(workdir, "sessions")
    os.makedirs(sdir, exist_ok=True)
    files = {}
    for name in ("trunk", "fork", "clone"):
        files[name] = os.path.join(sdir, "%s.jsonl" % name)
        with open(files[name], "w", encoding="utf-8") as fh:
            fh.write("{\"type\":\"header\"}\n")
    return sdir, files


def _full_spec(d, session_files, tag):
    """Fake pi spec implementing the scripted branch lifecycle.

    Handler entries are consumed per command name in call order via a
    per-run counterFile, matching the probe's deterministic sequence:
      prompt x5, get_state x4, get_tree x5, get_entries x3,
      get_messages x3, fork, switch_session, clone, get_fork_messages;
      navigate_tree / navigateTree hit the fake's default
      unknown-command rejection (success=false), like the real pi.
    """
    return {
        "counterFile": os.path.join(d, "counter-%s.json" % tag),
        "handlers": {
            "prompt": [
                {"emit": streaming_flow("OK1")},
                {"emit": streaming_flow("OK2")},
                {"emit": streaming_flow("TRUNK-ONE-41 BRANCH-ACTIVE")},
                {"emit": streaming_flow("BACK-ON-TRUNK")},
                {"emit": streaming_flow("CLONED")},
            ],
            "get_state": [
                {"emit": [_state("tree-trunk-0001",
                                 session_files["trunk"])]},
                {"emit": [_state("tree-fork-0002",
                                 session_files["fork"])]},
                {"emit": [_state("tree-trunk-0001",
                                 session_files["trunk"])]},
                {"emit": [_state("tree-clone-0003",
                                 session_files["clone"])]},
            ],
            "get_tree": [
                {"emit": [resp("get_tree", data={
                    "tree": TRUNK_TREE, "leafId": "e4"})]},
                {"emit": [resp("get_tree", data={
                    "tree": FORK_TREE, "leafId": "e2"})]},
                {"emit": [resp("get_tree", data={
                    "tree": FORK_TREE_AFTER, "leafId": "e5"})]},
                {"emit": [resp("get_tree", data={
                    "tree": TRUNK_TREE, "leafId": "e4"})]},
                {"emit": [resp("get_tree", data={
                    "tree": CLONE_TREE, "leafId": "e7"})]},
            ],
            "get_entries": [
                # phase 1 trunk snapshot (4 entries)
                {"emit": [resp("get_entries", data={
                    "entries": TRUNK_ENTRIES, "leafId": "e4"})]},
                # phase 6 full snapshot on the clone (6 entries)
                {"emit": [resp("get_entries", data={
                    "entries": CLONE_ENTRIES, "leafId": "e7"})]},
                # phase 6 since-cursor answer: strictly after e3
                {"emit": [resp("get_entries", data={
                    "entries": CLONE_ENTRIES[3:], "leafId": "e7"})]},
            ],
            "get_fork_messages": [{"emit": [resp("get_fork_messages", data={
                "messages": [
                    {"entryId": "e1", "text": TEXT_P1},
                    {"entryId": "e3", "text": TEXT_P2},
                ]})]}],
            "get_messages": [
                # on the fork: pre-fork history only
                {"emit": [resp("get_messages",
                               data={"messages": FORK_MESSAGES})]},
                # back on the trunk: full trunk history
                {"emit": [resp("get_messages",
                               data={"messages": TRUNK_MESSAGES})]},
                # on the clone: full trunk history
                {"emit": [resp("get_messages",
                               data={"messages": TRUNK_MESSAGES})]},
            ],
            "fork": [{"emit": [resp("fork", data={
                "text": TEXT_P1, "cancelled": False})]}],
            "switch_session": [{"emit": [resp("switch_session", data={
                "cancelled": False})]}],
            "clone": [{"emit": [resp("clone", data={
                "cancelled": False})]}],
        },
    }


def _make_config(d, spec):
    argv = fake_pi_argv(spec, d)
    return ProbeConfig(
        pi_bin=argv,
        provider="fake-provider",
        model="fake-model",
        evidence_dir=os.path.join(d, "evidence"),
        request_timeout=10.0,
        scenario_timeouts={SCENARIO_ID: 60.0},
    )


ENV_RECORD = {
    "piVersion": {"stdout": "9.9"},
    "provider": "fake-provider",
    "model": "fake-model",
    "thinking": "off",
    "python": {"version": "3.x"},
}


def _run_once(d, tag, mutate=None, ready=True, block_reason="",
              env_record=None):
    """One scripted run with the probe's workdir pinned to a pre-seeded
    directory (so the fake-reported session files really exist and the
    phase-7 listing sees them)."""
    workdir = os.path.join(d, "wd-%s" % tag)
    _sdir, session_files = _make_session_files(workdir)
    spec = _full_spec(d, session_files, tag)
    if mutate:
        mutate(spec)
    config = _make_config(d, spec)
    with mock.patch("tempfile.mkdtemp", return_value=workdir):
        return run_tree_nav(config, ready=ready, block_reason=block_reason,
                            env_record=env_record)


class TestTreeNavPass(unittest.TestCase):
    def test_pass_with_fake(self):
        d = tmpdir()
        record = _run_once(d, "pass", env_record=ENV_RECORD)
        self.assertEqual(record["status"], "PASS",
                         json.dumps(record.get("error"), ensure_ascii=False))
        self.assertEqual(record["exitCode"], 0)
        self.assertEqual(record["scenario"], SCENARIO_ID)
        self.assertEqual(record["probe"], "tree-nav")
        self.assertTrue(record["runId"])

        f = record["findings"]
        # trunk: populated tree, forkable entries
        self.assertEqual(f["trunk"]["treeNodes"], 4)
        self.assertEqual(f["trunk"]["leafId"], "e4")
        self.assertEqual(f["trunk"]["entryCount"], 4)
        self.assertEqual(len(f["trunk"]["forkableUserMessages"]), 2)
        # fork: new session identity, pre-fork history kept, post-fork
        # history dropped, branch prompt settled, leaf moved on
        self.assertEqual(f["fork"]["entryIdUsed"], "e1")
        self.assertTrue(f["fork"]["sessionIdChanged"])
        self.assertTrue(f["fork"]["sessionFileChanged"])
        self.assertTrue(f["fork"]["returnedTextHasTrunkOneMarker"])
        self.assertTrue(f["fork"]["historyKeptPreForkMarker"])
        self.assertTrue(f["fork"]["postForkHistoryDroppedMarker"])
        self.assertTrue(f["fork"]["promptAfterForkSettled"])
        self.assertTrue(f["fork"]["leafMovedAfterPrompt"])
        self.assertEqual(f["fork"]["leafIdAfterFork"], "e2")
        self.assertEqual(f["fork"]["leafIdAfterBranchPrompt"], "e5")
        # in-place navigation: both names answered with a rejection --
        # the expected capability-gap evidence, NOT a failure
        nav = f["inPlaceNavigation"]
        self.assertFalse(nav["sdkNavigateTreeEquivalentFound"])
        for name in ("navigate_tree", "navigateTree"):
            r = nav["probedCommands"][name]
            self.assertTrue(r["responded"], name)
            self.assertIsNotNone(r["response"], name)
            self.assertIs(r["response"].get("success"), False, name)
            self.assertIn("navigate", str(r["response"].get("error")))
        # switch back: original session restored with full trunk history
        self.assertTrue(f["switchBack"]["sessionIdRestoredToTrunk"])
        self.assertTrue(f["switchBack"]["trunkHistoryRestored"])
        self.assertTrue(f["switchBack"]["promptAfterSwitchSettled"])
        self.assertNotIn("originalFileMissing", f["switchBack"])
        # clone: new session, history kept, prompt settled
        self.assertTrue(f["clone"]["sessionIdChanged"])
        self.assertTrue(f["clone"]["historyKept"])
        self.assertTrue(f["clone"]["promptAfterCloneSettled"])
        # durable cursor: only entries strictly after the cursor returned
        cur = f["durableCursor"]
        self.assertEqual(cur["cursorEntryId"], "e3")
        self.assertEqual(cur["entriesAfterCursor"], 3)
        self.assertEqual(cur["totalEntries"], 6)
        self.assertTrue(cur["strictlyAfterCursor"])
        # session artifacts observed host-side (pre-seeded workdir)
        self.assertEqual(len(f["sessionFilesAfterRun"]), 3)
        # no "fewer session files" limitation with 3 files present
        self.assertFalse(any("fewer session files" in lim
                             for lim in record["limitations"]))
        # conclusion summarizes the branch lifecycle
        self.assertIn("fork -> new session", record["conclusion"])
        self.assertIn("in-place navigateTree equivalent found=False",
                      record["conclusion"])
        self.assertIn("session files in --session-dir after run: 3",
                      record["conclusion"])
        # baseline recorded from the environment record
        self.assertEqual(record["baseline"]["piVersion"], "9.9")

        # evidence: append-only events file with seq from 1, result line
        self.assertEqual(
            [os.path.basename(p) for p in record["evidenceFiles"]],
            [EVENTS_FILENAME])
        out = os.path.join(d, "evidence")
        ev = os.path.join(out, EVENTS_FILENAME)
        self.assertTrue(os.path.isfile(ev))
        lines = [json.loads(x) for x in open(ev, encoding="utf-8")
                 if x.strip()]
        self.assertEqual(lines[0]["seq"], 1)
        seqs = [ln["seq"] for ln in lines]
        self.assertEqual(seqs, sorted(seqs))
        self.assertEqual(len(set(seqs)), len(seqs))  # strictly increasing
        self.assertTrue(all(ln["scenario"] == SCENARIO_ID for ln in lines))
        self.assertTrue(all(ln["implementation"] == "rpc-python"
                            for ln in lines))
        summaries = [ln for ln in lines
                     if ln["piEventType"] == "scenario_summary"]
        self.assertEqual(len(summaries), 1)
        self.assertEqual(summaries[0]["payload"]["status"], "PASS")
        self.assertIn("runId", summaries[0]["payload"]["extra"])
        # navigate probe responses are in the raw events (gap evidence)
        raw = json.dumps(lines)
        self.assertIn("navigate_tree", raw)
        self.assertIn("navigateTree", raw)

        res = os.path.join(out, RESULTS_FILENAME)
        result_lines = [json.loads(x) for x in open(res, encoding="utf-8")
                        if x.strip()]
        self.assertEqual(len(result_lines), 1)
        self.assertEqual(result_lines[0]["status"], "PASS")
        self.assertEqual(result_lines[0]["exitCode"], 0)
        self.assertEqual(result_lines[0]["runId"], record["runId"])
        # the model answer texts are recorded as soft observations
        self.assertTrue(any("promptSettled=True" in o
                            for o in record["observations"]))
        self.assertTrue(any(o.startswith("env:") for o
                            in record["observations"]))

    def test_events_append_only_across_runs(self):
        d = tmpdir()
        rec1 = _run_once(d, "run1", env_record=ENV_RECORD)
        self.assertEqual(rec1["status"], "PASS")
        rec2 = _run_once(d, "run2", env_record=ENV_RECORD)
        self.assertEqual(rec2["status"], "PASS", rec2.get("error"))

        out = os.path.join(d, "evidence")
        ev = os.path.join(out, EVENTS_FILENAME)
        lines = [json.loads(x) for x in open(ev, encoding="utf-8")
                 if x.strip()]
        seqs = [ln["seq"] for ln in lines]
        self.assertEqual(seqs[0], 1)
        self.assertEqual(seqs, sorted(seqs))
        self.assertEqual(len(set(seqs)), len(seqs))
        # two runs -> two summary lines, each tagged with its runId
        summaries = [ln for ln in lines
                     if ln["piEventType"] == "scenario_summary"]
        self.assertEqual(len(summaries), 2)
        run_ids = {s["payload"]["extra"]["runId"] for s in summaries}
        self.assertEqual(len(run_ids), 2)
        self.assertNotEqual(rec1["runId"], rec2["runId"])
        # summaries appear in run order, and run 2's own events sit
        # between the two summaries (staged first, summarized after)
        self.assertEqual([s["seq"] for s in summaries],
                         sorted(s["seq"] for s in summaries))
        self.assertGreater(summaries[1]["seq"], summaries[0]["seq"] + 1)
        # result file: one appended line per run, first never rewritten
        res = os.path.join(out, RESULTS_FILENAME)
        result_lines = [json.loads(x) for x in open(res, encoding="utf-8")
                        if x.strip()]
        self.assertEqual(len(result_lines), 2)
        self.assertEqual([r["runId"] for r in result_lines],
                         [rec1["runId"], rec2["runId"]])
        # no .tmp staging files left behind
        leftovers = [n for n in os.listdir(out) if ".tmp" in n]
        self.assertEqual(leftovers, [])


class TestTreeNavFailures(unittest.TestCase):
    def test_blocked_credentials(self):
        d = tmpdir()
        config = _make_config(d, {"handlers": {}})
        record = run_tree_nav(config, ready=False,
                              block_reason="provider auth invalid")
        self.assertEqual(record["status"], "BLOCKED")
        self.assertEqual(record["error"]["kind"], BLOCKED_CREDENTIALS)
        self.assertIn("provider auth invalid", record["error"]["message"])
        self.assertEqual(record["blockedReason"], "CREDENTIALS")
        self.assertEqual(record["exitCode"], 2)
        # nothing was spawned: no events, no fabricated evidence
        self.assertEqual(record["evidenceFiles"], [])
        self.assertFalse(os.path.exists(
            os.path.join(config.evidence_dir, EVENTS_FILENAME)))
        # the BLOCKED record itself is appended to the result history
        res = os.path.join(config.evidence_dir, RESULTS_FILENAME)
        result_lines = [json.loads(x) for x in open(res, encoding="utf-8")
                        if x.strip()]
        self.assertEqual(len(result_lines), 1)
        self.assertEqual(result_lines[0]["status"], "BLOCKED")
        self.assertEqual(result_lines[0]["blockedReason"], "CREDENTIALS")

    def test_fail_when_fork_rejected(self):
        d = tmpdir()

        def reject_fork(spec):
            spec["handlers"]["fork"] = [{"emit": [resp(
                "fork", success=False, error="no such entry")]}]

        record = _run_once(d, "forkfail", mutate=reject_fork,
                           env_record=ENV_RECORD)
        self.assertEqual(record["status"], "FAIL")
        self.assertEqual(record["error"]["kind"], "command")
        self.assertIn("fork", record["error"]["message"])
        self.assertEqual(record["exitCode"], 1)
        # fork findings were never collected...
        self.assertNotIn("fork", record["findings"])
        # ...but the trunk phase findings are still in the record
        self.assertIn("trunk", record["findings"])
        # last known events + structured error still appended
        out = os.path.join(d, "evidence")
        ev = os.path.join(out, EVENTS_FILENAME)
        lines = [json.loads(x) for x in open(ev, encoding="utf-8")
                 if x.strip()]
        self.assertGreater(len(lines), 5)
        last = lines[-1]
        self.assertEqual(last["piEventType"], "scenario_summary")
        self.assertEqual(last["payload"]["status"], "FAIL")
        self.assertIn("message", last["payload"]["error"])
        # the failed run still appended its result line
        res = os.path.join(out, RESULTS_FILENAME)
        result_lines = [json.loads(x) for x in open(res, encoding="utf-8")
                        if x.strip()]
        self.assertEqual(len(result_lines), 1)
        self.assertEqual(result_lines[0]["status"], "FAIL")


class TestTreeNavCli(unittest.TestCase):
    def _wrapper(self, tmpdir, spec):
        argv = fake_pi_argv(spec, tmpdir)
        wrapper = os.path.join(tmpdir, "fake-pi-wrapper.sh")
        with open(wrapper, "w", encoding="utf-8") as fh:
            fh.write("#!/bin/sh\nexec %s \"%s\" \"%s\" \"$@\"\n"
                     % (json.dumps(argv[0]), argv[1], argv[2]))
        os.chmod(wrapper, os.stat(wrapper).st_mode | stat.S_IEXEC)
        return wrapper

    def test_tree_nav_pass_exits_zero(self):
        d = tmpdir()
        workdir = os.path.join(d, "wd-cli")
        _sdir, session_files = _make_session_files(workdir)
        spec = _full_spec(d, session_files, "cli")
        wrapper = self._wrapper(d, spec)
        out = os.path.join(d, "evidence")
        with mock.patch("pi_rpc_probe.cli.check_environment",
                        return_value=(True, ENV_RECORD)), \
             mock.patch("tempfile.mkdtemp", return_value=workdir):
            code = cli.main([
                "tree-nav",
                "--pi-bin", wrapper,
                "--provider", "fake-provider", "--model", "fake-model",
                "--out", out,
                "--request-timeout", "10",
            ])
        self.assertEqual(code, 0)
        res = os.path.join(out, RESULTS_FILENAME)
        self.assertTrue(os.path.isfile(res))
        record = json.loads(open(res, encoding="utf-8").read()
                            .splitlines()[-1])
        self.assertEqual(record["status"], "PASS")
        self.assertEqual(record["exitCode"], 0)
        self.assertTrue(record["command"])
        self.assertTrue(any(o.startswith("env:") for o
                            in record["observations"]))
        # the CLI also refreshed the environment record
        self.assertTrue(os.path.isfile(
            os.path.join(out, "environment-rpc-python.json")))

    def test_tree_nav_blocked_exits_two(self):
        d = tmpdir()
        out = os.path.join(d, "evidence")
        with mock.patch("pi_rpc_probe.cli.check_environment",
                        return_value=(False, {
                            "authCheck": {"stdout": "invalid"},
                            "liveCheck": {"detail": "403 denied"},
                            "python": {"version": "3.x"},
                            "piVersion": {"stdout": "9.9"},
                            "provider": "nope", "model": "nope",
                            "thinking": "off"})):
            code = cli.main([
                "tree-nav",
                "--pi-bin", "pi",
                "--provider", "nope", "--model", "nope",
                "--out", out,
            ])
        self.assertEqual(code, 2)
        res = os.path.join(out, RESULTS_FILENAME)
        record = json.loads(open(res, encoding="utf-8").read()
                            .splitlines()[-1])
        self.assertEqual(record["status"], "BLOCKED")
        self.assertEqual(record["blockedReason"], "CREDENTIALS")
        self.assertEqual(record["exitCode"], 2)


if __name__ == "__main__":
    unittest.main()
