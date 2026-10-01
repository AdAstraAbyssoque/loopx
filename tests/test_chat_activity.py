from __future__ import annotations

import re
from pathlib import Path

from loopx.chat_activity import (
    COMMAND_VERBS,
    REASONING_UPDATE_INTERVAL_SEC,
    STEP_KINDS,
    STEP_STATES,
    CodexActivitySteps,
)


class _Clock:
    def __init__(self) -> None:
        self.now = 100.0

    def __call__(self) -> float:
        return self.now


def _command(command: str, actions: list[dict] | None = None, **extra) -> dict:
    return {"type": "commandExecution", "id": "exec-1", "command": command,
            "commandActions": actions or [{"type": "unknown", "command": command}], **extra}


def test_command_step_names_the_intent_and_keeps_the_full_command_behind_details():
    steps = CodexActivitySteps(protected_paths=["/work/project"])
    item = _command(
        "/bin/zsh -lc \"rg -n owner /work/project/docs | head\"",
        [{"type": "search", "command": "rg -n owner /work/project/docs", "query": "owner", "path": "/work/project/docs"}],
        status="inProgress",
    )
    running = steps.started(item)
    assert running == {"id": "exec-1", "kind": "command", "state": "running", "verb": "search",
                       "title": "owner", "detail": "rg -n owner docs | head"}
    done = steps.completed({**item, "status": "completed", "exitCode": 0, "durationMs": 42})
    assert (done["state"], done["exit_code"], done["duration_ms"]) == ("completed", 0, 42)


def test_paths_outside_the_project_stay_withheld():
    title = CodexActivitySteps(protected_paths=["/work/project"]).started(_command("diff /work/project/a.md /home/other/b.md"))["title"]
    assert title == "diff a.md [local-path]"
    assert CodexActivitySteps(protected_paths=["/work/project/"]).started(_command("cd /work/project && ls"))["title"] == "cd . && ls"


def test_unparsed_command_shows_the_unwrapped_command_itself():
    step = CodexActivitySteps().started(_command("bash -lc 'npm run build && npm test'"))
    assert (step["verb"], step["title"]) == ("run", "npm run build && npm test")
    assert "detail" not in step, "A short command needs no second copy"


def test_failed_items_are_failed_steps_not_completions():
    steps = CodexActivitySteps()
    assert steps.completed({**_command("false"), "status": "completed", "exitCode": 1})["state"] == "failed"
    assert steps.completed({"type": "mcpToolCall", "id": "t", "server": "s", "tool": "x", "status": "failed"})["state"] == "failed"
    assert steps.completed({"type": "dynamicToolCall", "id": "d", "tool": "x", "success": False})["state"] == "failed"
    assert steps.completed({"type": "fileChange", "id": "f", "changes": [], "status": "declined"})["state"] == "failed"


def test_credentials_in_commands_are_masked_before_replay():
    title = CodexActivitySteps().started(_command(
        "curl -H 'Authorization: Bearer abc.def' --api-key=k123 https://x.test?q=1 "
        "&& GH_TOKEN=ghp_abcdefghijklmnop123 gh pr list --password hunter2 sk-proj-abcdefghijklmnop"
    ))["title"]
    for secret in ("abc.def", "k123", "ghp_abcdefghijklmnop123", "hunter2", "sk-proj-abcdefghijklmnop"):
        assert secret not in title
    assert "gh pr list" in title and "https://x.test" in title


def test_tools_searches_and_file_changes_carry_names_not_payloads():
    steps = CodexActivitySteps(protected_paths=["/work/project"])
    tool = steps.started({"type": "mcpToolCall", "id": "t1", "server": "loopx", "tool": "todo_list",
                          "arguments": {"secret": "do-not-show"}, "status": "inProgress"})
    assert tool == {"id": "t1", "kind": "tool", "state": "running", "title": "loopx · todo_list"}
    search = steps.started({"type": "webSearch", "id": "w1", "query": "release owner policy"})
    assert search["title"] == "release owner policy"
    files = steps.completed({"type": "fileChange", "id": "f1", "status": "completed", "changes": [
        {"path": "/work/project/a.md", "kind": {"type": "update"}, "diff": "+secret line"},
        {"path": "/work/project/b.md", "kind": {"type": "add"}, "diff": "+other"}]})
    assert (files["title"], files["count"], files["detail"]) == ("a.md", 2, "a.md\nb.md")
    assert "secret" not in str(files) and "do-not-show" not in str(tool)


def test_user_and_answer_items_are_not_steps():
    steps = CodexActivitySteps()
    for item in ({"type": "userMessage", "id": "u"}, {"type": "agentMessage", "id": "m", "text": "hi"},
                 {"type": "futureItem", "id": "z"}, None, "text"):
        assert steps.started(item) is None and steps.completed(item) is None


def test_reasoning_streams_throttled_and_prefers_the_model_summary():
    clock = _Clock()
    steps = CodexActivitySteps(clock=clock)
    assert steps.started({"type": "reasoning", "id": "rs_1", "summary": [], "content": []}) == {
        "id": "rs_1", "kind": "reasoning", "state": "running", "title": ""}
    assert steps.reasoning_delta("rs_1", "Checking", summary=False, index=0) is None, "No single-token flash"
    clock.now += REASONING_UPDATE_INTERVAL_SEC
    first = steps.reasoning_delta("rs_1", " the owner", summary=False, index=0)
    assert (first["title"], first["detail"]) == ("Checking the owner", "Checking the owner")
    assert steps.reasoning_delta("rs_1", " list.\nThen compare. Done.", summary=False, index=0) is None
    steps.reasoning_delta("rs_1", "**Owner check**\n\nComparing release owners.", summary=True, index=0)
    clock.now += 2
    done = steps.completed({"type": "reasoning", "id": "rs_1", "summary": [], "content": []})
    assert (done["state"], done["title"], done["duration_ms"]) == ("completed", "Owner check", 3500)
    assert done["detail"] == "**Owner check**\n\nComparing release owners."


def test_reasoning_without_exposed_text_is_a_timed_step_only():
    clock = _Clock()
    steps = CodexActivitySteps(clock=clock)
    steps.started({"type": "reasoning", "id": "rs_2", "summary": [], "content": []})
    clock.now += 12
    assert steps.completed({"type": "reasoning", "id": "rs_2", "summary": [], "content": []}) == {
        "id": "rs_2", "kind": "reasoning", "state": "completed", "title": "", "duration_ms": 12000}


def test_step_ids_and_text_are_bounded():
    step = CodexActivitySteps().started(_command("echo " + "x" * 5000) | {"id": "bad id/" * 40})
    assert step["id"].startswith("step_") and len(step["id"]) == 21
    assert len(step["title"]) == 160 and len(step["detail"]) == 4000


def test_step_vocabulary_is_closed():
    steps = CodexActivitySteps()
    produced = [
        steps.started(_command("ls")),
        steps.started({"type": "reasoning", "id": "r"}),
        steps.started({"type": "mcpToolCall", "id": "t", "tool": "x"}),
        steps.started({"type": "webSearch", "id": "w", "query": "q"}),
        steps.completed({"type": "fileChange", "id": "f", "changes": []}),
    ]
    assert {step["kind"] for step in produced} == set(STEP_KINDS)
    assert all(step["state"] in STEP_STATES for step in produced)
    assert produced[0]["verb"] in COMMAND_VERBS


def test_dashboard_reader_mirrors_the_step_vocabulary():
    source = (Path(__file__).resolve().parents[1] / "apps/presentation/dashboard/src/data/turn-steps.ts").read_text()

    def mirrored(name: str) -> tuple[str, ...]:
        match = re.search(rf"export const {name} = \[([^\]]*)\] as const;", source)
        assert match, name
        return tuple(re.findall(r'"([^"]+)"', match.group(1)))

    assert mirrored("TURN_STEP_KINDS") == STEP_KINDS
    assert mirrored("TURN_STEP_STATES") == STEP_STATES
    assert mirrored("TURN_COMMAND_VERBS") == COMMAND_VERBS
