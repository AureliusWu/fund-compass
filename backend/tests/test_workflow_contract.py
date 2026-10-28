import ast
import re
from pathlib import Path

import pytest
import yaml


ROOT = Path(__file__).resolve().parents[2]
WORKFLOWS = ROOT / ".github" / "workflows"
AUTO_COMMIT_WORKFLOWS = (
    "enrich-holdings.yml",
    "enrich-managers.yml",
    "fund-universe.yml",
    "overseas-accuracy.yml",
)


def workflow(name: str) -> str:
    return (WORKFLOWS / name).read_text(encoding="utf-8")


def _ci_job_condition(condition: str, *, enabled: str, event: str, ref: str, formal: bool) -> bool:
    """Evaluate only the fixed boolean/string subset used by these job guards."""
    assert condition.startswith("${{ ") and condition.endswith(" }}")
    context = {
        "vars.AUTO_DEPLOY_ENABLED": enabled,
        "github.event_name": event,
        "github.ref": ref,
        "inputs.formal_release": formal,
    }
    expression = condition[4:-3]
    expression = re.sub(
        r"\b(?:vars\.AUTO_DEPLOY_ENABLED|github\.event_name|github\.ref|inputs\.formal_release)\b",
        # GitHub string equality is case-insensitive; variables are strings,
        # and a missing repository variable is the empty string.
        lambda match: repr(context[match[0]].casefold())
        if isinstance(context[match[0]], str) else repr(context[match[0]]),
        expression,
    )
    expression = re.sub(r"!(?!=)", "not ", expression.replace("&&", " and ").replace("||", " or "))
    tree = ast.parse(expression.strip(), mode="eval")

    def evaluate(node: ast.AST) -> bool | str:
        if isinstance(node, ast.Constant) and type(node.value) in (bool, str):
            return node.value
        if isinstance(node, ast.UnaryOp) and isinstance(node.op, ast.Not):
            return not evaluate(node.operand)
        if isinstance(node, ast.BoolOp):
            values = [bool(evaluate(value)) for value in node.values]
            if isinstance(node.op, ast.And):
                return all(values)
            if isinstance(node.op, ast.Or):
                return any(values)
        if isinstance(node, ast.Compare) and len(node.ops) == len(node.comparators) == 1:
            left, right = evaluate(node.left), evaluate(node.comparators[0])
            if isinstance(node.ops[0], ast.Eq):
                return left == right
            if isinstance(node.ops[0], ast.NotEq):
                return left != right
        raise AssertionError(f"unsupported CI guard expression: {ast.dump(node)}")

    result = evaluate(tree.body)
    assert type(result) is bool
    return result


def _function(tree: ast.AST, name: str) -> ast.FunctionDef:
    matches = [node for node in ast.walk(tree) if isinstance(node, ast.FunctionDef) and node.name == name]
    assert len(matches) == 1, name
    return matches[0]


def _assignment(tree: ast.AST, name: str) -> ast.expr:
    matches = [node.value for node in tree.body if isinstance(node, ast.Assign)
               and any(isinstance(target, ast.Name) and target.id == name for target in node.targets)]
    assert len(matches) == 1, name
    return matches[0]


def _calls(tree: ast.AST, name: str) -> list[ast.Call]:
    return sorted((node for node in ast.walk(tree) if isinstance(node, ast.Call)
                   and ast.unparse(node.func) == name), key=lambda node: (node.lineno, node.col_offset))


def _expression(node: ast.AST, expected: str) -> None:
    assert ast.dump(node, include_attributes=False) == ast.dump(
        ast.parse(expected, mode="eval").body, include_attributes=False
    )


def _git_commands(tree: ast.AST, command: str) -> list[ast.Call]:
    matches = []
    for node in _calls(tree, "_command"):
        if not node.args or not isinstance(node.args[0], ast.Constant) or node.args[0].value != "git":
            continue
        offset = 1
        while (offset < len(node.args) and isinstance(node.args[offset], ast.Constant)
               and node.args[offset].value == "-c"):
            offset += 2
        if offset < len(node.args) and isinstance(node.args[offset], ast.Constant) and node.args[offset].value == command:
            matches.append(node)
    return matches


def _overseas_runner() -> ast.Module:
    """Inspect the real entrypoint without importing providers or running Git."""
    return ast.parse((ROOT / "tools" / "record_overseas_ops.py").read_text(encoding="utf-8"))


def _overseas_job() -> dict:
    parsed = yaml.safe_load(workflow("overseas-accuracy.yml"))
    assert parsed["permissions"] == {"contents": "write", "actions": "write"}
    job = parsed["jobs"]["ledger"]
    run_steps = [step for step in job["steps"] if "run" in step]
    assert len(run_steps) == 1
    runner = run_steps[0]
    assert runner["shell"] == "bash"
    assert "continue-on-error" not in runner and "if" not in runner
    assert [line.strip() for line in runner["run"].splitlines() if line.strip()] == [
        'git config user.name "github-actions[bot]"',
        'git config user.email "github-actions[bot]@users.noreply.github.com"',
        "python tools/record_overseas_ops.py",
    ]
    return job


def _assert_overseas_publication_contract() -> None:
    _overseas_job()
    tree = _overseas_runner()
    financial = _function(tree, "_publish_financial")
    operations = _function(tree, "_publish_ops")
    push_once = _function(tree, "_push_once")
    dispatch = _function(tree, "_dispatch")
    run = _function(tree, "run")
    assert ast.literal_eval(_assignment(tree, "FINANCIAL")) == {
        "ledger_sha256": "frontend/public/data/overseas-accuracy.json",
        "audit_sha256": "frontend/public/data/overseas-audit.json",
        "models_sha256": "frontend/src/data/overseas-models.json",
        "evidence_sha256": "backend/data/overseas-evidence.json",
    }
    assert ast.literal_eval(_assignment(tree, "OPS_REF")) == "refs/heads/ops/overseas-run-journal"
    assert ast.literal_eval(_assignment(tree, "OPS_PATH")) == "docs/operations/overseas-run-journal.json"

    # Financial publication must bind the exact confirmed main commit and all
    # four bytes, not dispatch an unqualified branch tip or a later ops commit.
    _expression(financial.body[0].test, "_head() != source or _remote_head() != source")
    staging = _calls(financial, "_stage_only")
    assert len(staging) == 1
    _expression(staging[0], "_stage_only(tuple(FINANCIAL.values()))")
    commits = _git_commands(financial, "commit")
    pushes = _calls(financial, "_push_once")
    assert len(commits) == len(pushes) == 1
    _expression(pushes[0], '_push_once("refs/heads/main", source, commit)')
    assert commits[0].lineno < pushes[0].lineno
    digest_calls = _calls(financial, "_digests_in_tree")
    assert len(digest_calls) == 2
    _expression(digest_calls[0], "_digests_in_tree(commit)")
    _expression(digest_calls[1], "_digests_in_tree(source)")
    assert commits[0].lineno < digest_calls[0].lineno < pushes[0].lineno
    post_push = [node for node in financial.body if isinstance(node, ast.If)
                 and node.lineno > pushes[0].lineno]
    assert len(post_push) == 1
    _expression(post_push[0].test, "_remote_head() != commit")
    _expression(financial.body[-1].value, '{"commit_sha": commit, **digests}')
    dispatches = _calls(dispatch, "_command")
    assert len(dispatches) == 1
    _expression(dispatches[0], '_command("gh", "workflow", "run", "ci.yml", "--ref", '
                '"main", "-f", f"target_sha={commit}")')
    assert len(_calls(tree, "_dispatch")) == 1
    _expression(_calls(run, "_publish_financial")[0], '_publish_financial(identity["source_sha"])')
    _expression(_calls(run, "_dispatch")[0], '_dispatch(published["commit_sha"])')
    dispatch_guards = [node for node in ast.walk(run) if isinstance(node, ast.If)
                       and any(child is _calls(run, "_dispatch")[0] for child in ast.walk(node))]
    assert any(ast.dump(node.test) == ast.dump(ast.parse("published is not None", mode="eval").body)
               for node in dispatch_guards)

    # The journal writes an independent, code-free tree to its own fixed ref,
    # not HEAD/index/main, and cannot dispatch CI for a later ops commit.
    ops_commands = _calls(operations, "_command")
    assert [node.args[1].value for node in ops_commands] == [
        "hash-object", "mktree", "mktree", "mktree", "commit-tree",
    ]
    _expression(ops_commands[0], '_command("git", "hash-object", "-w", "--stdin", stdin=raw)')
    _expression(_assignment(operations, "parents"), '("-p", prior_tip) if prior_tip is not None else ()')
    assert len(_calls(operations, "_push_once")) == 1
    _expression(_calls(operations, "_push_once")[0], "_push_once(OPS_REF, prior_tip, commit)")
    tree_stdin = [next(keyword.value for keyword in command.keywords if keyword.arg == "stdin")
                  for command in _git_commands(operations, "mktree")]
    for actual, expected in zip(tree_stdin, (
        '(f"100644 blob {blob}\\toverseas-run-journal.json\\n").encode("ascii")',
        '(f"040000 tree {operations}\\toperations\\n").encode("ascii")',
        '(f"040000 tree {docs}\\tdocs\\n").encode("ascii")',
    )):
        _expression(actual, expected)
    assert len(_calls(tree, "_push_once")) == 2
    assert len(_git_commands(tree, "push")) == len(_calls(push_once, "_command")) == 1
    _expression(_git_commands(push_once, "push")[0],
                '_command("git", "-c", "core.hooksPath=" + str(ROOT / "tools" / "overseas-hooks"), '
                '"push", "origin", f"{commit}:{ref}", env=env)')
    env_updates = _calls(push_once, "env.update")
    assert len(env_updates) == 1
    _expression(env_updates[0], 'env.update({"OVERSEAS_PUSH_REF": ref, '
                '"OVERSEAS_PUSH_OLD": expected_old or "0" * 40, "OVERSEAS_PUSH_NEW": commit})')
    operation_checks = [ast.dump(node.test) for node in operations.body if isinstance(node, ast.If)]
    for expected in (
        "_head() != base or _remote_head() != base",
        "_remote_ops_head() != prior_tip",
        "_head() != base or _remote_head() != base or _remote_ops_head() != prior_tip",
        "_remote_ops_head() != commit or _head() != base or _remote_head() != base",
    ):
        assert ast.dump(ast.parse(expected, mode="eval").body) in operation_checks
    for publisher in (financial, operations, push_once):
        assert not any(_git_commands(node, "push") or _calls(node, "_push_once") for node in ast.walk(publisher)
                       if isinstance(node, (ast.For, ast.AsyncFor, ast.While)))
        assert not any(_git_commands(publisher, forbidden)
                       for forbidden in ("reset", "rebase", "checkout", "switch"))
    _expression(_assignment(run, "base"), 'published["commit_sha"] if published else identity["source_sha"]')
    _expression(_calls(run, "_publish_ops")[0], "_publish_ops(base, prior_ops_tip, raw)")
    assert _calls(run, "_dispatch")[0].lineno < _calls(run, "_publish_ops")[0].lineno


def test_ci_is_the_only_release_orchestrator() -> None:
    ci = workflow("ci.yml")
    deploy = workflow("deploy.yml")
    smoke = workflow("post-deploy-smoke.yml")

    assert "workflow_dispatch:" in ci
    assert "target_sha:" in ci
    assert "formal_release:" in ci
    assert "uses: ./.github/workflows/deploy.yml" in ci
    assert "needs: [resolve, backend, frontend, worker]" in ci
    assert ci.count("uses: ./.github/workflows/post-deploy-smoke.yml") == 2
    assert "needs: [resolve, deploy]" in ci
    assert ci.count("github.event_name != 'pull_request'") == 2
    assert "github.ref == 'refs/heads/main'" in ci

    for reusable in (deploy, smoke):
        assert "workflow_call:" in reusable
        assert "workflow_run:" not in reusable
        assert "workflow_dispatch:" not in reusable
        assert "required: true" in reusable
        assert "ref: ${{ inputs.target_sha }}" in reusable
    assert "dist/release.json" in deploy
    assert "deployed_commit" in smoke
    assert "dist/release.json" in deploy
    assert "release.json?release=" in smoke
    assert 'deployed_commit" == "${{ inputs.target_sha }}"' in smoke
    assert "enforce_persistence:" in smoke
    assert "default: true" in smoke
    assert "formal_release_status:" in smoke
    assert "formal_release_status=blocked" in smoke
    assert "formal_release_eligible" not in smoke
    assert not re.search(r"if:\s*\$\{\{[^\n]*formal_release_status\s*\}\}", ci + smoke)
    assert "CANDIDATE_ONLY (not a release)" in smoke
    assert "FORMAL_RELEASE_AUDIT (fail closed)" in smoke
    assert "enforce_persistence: false" in ci
    assert "enforce_persistence: true" in ci
    assert "formal_smoke:" in ci
    assert "candidate_smoke:" in ci
    assert "formal_smoke:" in ci[ci.index("candidate_smoke:") :]


def test_ci_validates_and_checks_out_one_exact_sha() -> None:
    ci = workflow("ci.yml")

    assert "target_sha must be a full 40-character commit SHA" in ci
    assert 'EVENT_REF: ${{ github.ref }}' in ci
    assert '[[ "$EVENT_REF" == "refs/heads/main" ]]' in ci
    assert "release workflows must run from refs/heads/main" in ci
    assert '[[ "$target_sha" == "$remote_sha" ]]' in ci
    assert "refusing to release a non-HEAD main commit" in ci
    assert ci.count("ref: ${{ needs.resolve.outputs.target_sha }}") == 3
    assert "target_sha: ${{ needs.resolve.outputs.target_sha }}" in ci


def test_auto_deployment_hold_is_persistent_and_does_not_skip_quality_or_formal_gates() -> None:
    jobs = yaml.safe_load(workflow("ci.yml"))["jobs"]
    candidate_condition = (
        "${{ vars.AUTO_DEPLOY_ENABLED == 'true' && github.event_name != 'pull_request' "
        "&& github.ref == 'refs/heads/main' "
        "&& !(github.event_name == 'workflow_dispatch' && inputs.formal_release) }}"
    )
    for name in ("deploy", "candidate_smoke"):
        assert jobs[name]["if"] == candidate_condition, name
        assert jobs[name].get("continue-on-error", False) is False, name
    assert jobs["deploy"]["needs"] == ["resolve", "backend", "frontend", "worker"]
    assert jobs["candidate_smoke"]["needs"] == ["resolve", "deploy"]
    assert jobs["candidate_smoke"]["with"]["enforce_persistence"] is False
    for name in ("resolve", "backend", "frontend", "worker"):
        assert jobs[name].get("if") is None, name
        assert jobs[name].get("continue-on-error", False) is False, name
    assert jobs["formal_smoke"]["if"] == (
        "${{ github.event_name == 'workflow_dispatch' "
        "&& github.ref == 'refs/heads/main' && inputs.formal_release }}"
    )
    assert jobs["formal_smoke"]["needs"] == ["resolve", "backend", "frontend", "worker"]
    assert jobs["formal_smoke"]["with"]["enforce_persistence"] is True


@pytest.mark.parametrize("job_name", ("deploy", "candidate_smoke"))
@pytest.mark.parametrize("enabled,opted_in", (
    ("", False), ("false", False), ("False", False), ("0", False), ("1", False),
    ("yes", False), ("null", False), (" true", False), ("true ", False),
    ("true\n", False), ("true", True), ("TRUE", True), ("True", True),
))
@pytest.mark.parametrize("event,ref,formal,candidate", (
    ("push", "refs/heads/main", False, True),
    ("push", "refs/heads/main", True, True),  # Dispatch-only input cannot select formal on push.
    ("workflow_dispatch", "refs/heads/main", False, True),  # Includes generated-data dispatches.
    ("workflow_dispatch", "refs/heads/main", True, False),
    ("pull_request", "refs/heads/main", False, False),
    ("pull_request", "refs/pull/4/merge", False, False),
    ("push", "refs/heads/feature", False, False),
    ("workflow_dispatch", "refs/heads/feature", False, False),
))
def test_auto_deployment_requires_explicit_opt_in_on_every_main_run(
    job_name: str, enabled: str, opted_in: bool, event: str, ref: str, formal: bool, candidate: bool,
) -> None:
    condition = yaml.safe_load(workflow("ci.yml"))["jobs"][job_name]["if"]
    assert _ci_job_condition(condition, enabled=enabled, event=event, ref=ref, formal=formal) is (
        opted_in and candidate
    )


@pytest.mark.parametrize("enabled", ("", "false", "true"))
@pytest.mark.parametrize("event,ref,formal,expected", (
    ("workflow_dispatch", "refs/heads/main", True, True),
    ("workflow_dispatch", "refs/heads/main", False, False),
    ("workflow_dispatch", "refs/heads/feature", True, False),
    ("push", "refs/heads/main", True, False),
    ("pull_request", "refs/heads/main", True, False),
))
def test_formal_persistence_audit_is_independent_of_auto_deployment_hold(
    enabled: str, event: str, ref: str, formal: bool, expected: bool,
) -> None:
    condition = yaml.safe_load(workflow("ci.yml"))["jobs"]["formal_smoke"]["if"]
    assert _ci_job_condition(condition, enabled=enabled, event=event, ref=ref, formal=formal) is expected


def test_ci_runs_dependency_and_runtime_contract_gates() -> None:
    ci = workflow("ci.yml")

    assert "pip check" in ci
    assert "pytest" in ci
    assert "npm run type-check" in ci
    assert "npm run test" in ci
    assert "npm run build" in ci
    assert "npm run check" in ci
    assert "npx wrangler deploy --dry-run" in ci


def test_ci_audits_the_complete_toolchain_and_blocks_release_on_failure() -> None:
    jobs = yaml.safe_load(workflow("ci.yml"))["jobs"]
    for name, final_check in (("frontend", "npm run build"), ("worker", "npx wrangler deploy --dry-run")):
        job = jobs[name]
        assert job.get("continue-on-error", False) is False, name
        assert job.get("if") is None, name
        audits = [(index, step) for index, step in enumerate(job["steps"])
                  if step.get("name") == "Audit dependency advisories"]
        assert len(audits) == 1, name
        index, audit = audits[0]
        assert audit.get("if") is None, name
        assert audit.get("continue-on-error", False) is False, name
        assert audit["timeout-minutes"] == 2, name
        # A standalone command must propagate npm's advisory/network exit code.
        # Explicit dev inclusion keeps Vite/Vitest/Wrangler in the audited tree.
        assert audit["run"] == (
            "npm audit --json --include=dev --audit-level=moderate "
            "--registry=https://registry.npmjs.org --fetch-retries=0 --fetch-timeout=20000"
        ), name
        for prerequisite in ("npm ci --include=dev", final_check):
            checks = [position for position, step in enumerate(job["steps"]) if step.get("run") == prerequisite]
            assert len(checks) == 1 and checks[0] < index, (name, prerequisite)
    # Both regular deployment and formal validation depend on these jobs.
    for release in ("deploy", "formal_smoke"):
        assert {"frontend", "worker"} <= set(jobs[release]["needs"]), release


def test_frontend_deploy_requires_an_explicit_public_api_endpoint() -> None:
    deploy = workflow("deploy.yml")
    index = (ROOT / "frontend" / "index.html").read_text(encoding="utf-8")

    endpoint_gate = "- name: Verify production API endpoint"
    build_step = "- run: npm run build"
    assert endpoint_gate in deploy
    assert deploy.index(endpoint_gate) < deploy.index(build_step)
    assert 'test -n "${VITE_API_BASE:-}"' in deploy
    assert '/api|./api|../api|http://*' in deploy
    assert '[[ "$VITE_API_BASE" =~ ^https://[^/?#[:space:]]+/api$ ]]' in deploy
    assert "未设时为空" not in deploy
    assert "前端回退 /api" not in deploy
    assert "fund-compass-api.onrender.com" not in index


def test_generated_data_writers_are_serial_and_dispatch_ci_once() -> None:
    for name in AUTO_COMMIT_WORKFLOWS:
        source = workflow(name)
        assert "group: scheduled-data-main" in source, name
        assert "queue: max" in source, name
        assert "cancel-in-progress: true" not in source, name
        assert "actions: write" in source, name
        if name == "overseas-accuracy.yml":
            _assert_overseas_publication_contract()
            continue
        assert source.count("gh workflow run ci.yml") == 1, name
        assert "if gh workflow run ci.yml" in source, name
        assert '-f target_sha="$commit_sha"' in source, name
        assert "dispatched=false" in source, name
        assert '[[ "$dispatched" == "true" ]]' in source, name
        assert source.count("for attempt in 1 2 3; do") >= 2, name
        assert "git rev-parse HEAD" in source, name
        assert "git push origin HEAD:main" in source, name
        assert "base_sha=$(git rev-parse HEAD^)" in source, name
        assert '[[ "$remote_sha" == "$base_sha" ]]' in source, name
        assert "main changed while data was generated" in source, name
        assert "git rebase origin/main" not in source, name
        assert "actions: write" in source, name


def test_generated_data_writers_do_not_delegate_git_state() -> None:
    combined = "\n".join(workflow(name) for name in AUTO_COMMIT_WORKFLOWS)

    assert "git-auto-commit-action" not in combined
    assert not re.search(r"gh workflow run ci\.yml --ref main\s*$", combined, re.MULTILINE)


def test_calibration_workflows_are_candidate_only() -> None:
    for name in ("calibrate-strategy.yml", "overseas-accuracy.yml"):
        source = workflow(name)
        assert "auto_promote" not in source.lower()
        assert "AUTO_PROMOTE" not in source

    for name in ("calibrate_strategy.py", "calibrate_overseas.py"):
        source = (ROOT / "tools" / name).read_text(encoding="utf-8")
        assert "AUTO_PROMOTE" not in source
        assert "explicit_admin_only" in source


def test_private_calibration_is_bounded_and_never_published() -> None:
    source = workflow("calibrate-strategy.yml")

    assert "contents: read" in source
    assert "contents: write" not in source
    assert "actions: write" not in source
    assert "id: calibration" in source
    assert "CALIBRATION_OUTCOME_ATTEMPTS: '3'" in source
    assert "CALIBRATION_OUTCOME_TIMEOUT_SECONDS: '45'" in source
    assert "CALIBRATION_OUTCOME_TOTAL_BUDGET_SECONDS: '150'" in source
    assert "CALIBRATION_OUTCOME_RETRY_AFTER_MAX_SECONDS: '15'" in source
    assert "CALIBRATION_OUTCOME_MAX_RESPONSE_BYTES: '8388608'" in source
    assert "CALIBRATION_ALLOW_INSECURE_LOOPBACK" not in source
    assert "if: always()" in source
    assert "BLOCKED_PRIVATE_SINK_REQUIRED" in source
    assert "private_output_published: false" in source
    assert "actions/upload-artifact" not in source
    assert "git add" not in source
    assert "git commit" not in source
    assert "git push" not in source
    assert "gh workflow run" not in source
    assert "frontend/public/data/strategy-calibration.json" not in source
    assert "backend/data/strategy-params.json" not in source


def test_enrichment_branches_preserve_good_artifacts_then_report_any_failure() -> None:
    source = workflow("enrich-holdings.yml")
    assert source.count("continue-on-error: true") == 3
    for step_id, outcome in (
        ("holdings", "HOLDINGS_OUTCOME"),
        ("valuation", "VALUATION_OUTCOME"),
        ("screener", "SCREENER_OUTCOME"),
    ):
        assert f"id: {step_id}" in source
        assert f"{outcome}: ${{{{ steps.{step_id}.outcome }}}}" in source
        assert f'[[ "${outcome}" == "success" ]] || failed=true' in source
    assert source.index("- name: 提交数据") < source.index("- name: 报告富集分支失败")
    assert '[[ "$failed" == "false" ]] || {' in source


def test_manual_notification_workflows_have_read_only_repository_access() -> None:
    assert "contents: read" in workflow("manual-estimate-push.yml")
    assert "contents: write" not in workflow("manual-estimate-push.yml")
    assert "contents: read" in workflow("notify.yml")


def test_manual_signal_notification_requires_explicit_gist_id() -> None:
    source = workflow("notify.yml")
    script = (ROOT / "tools" / "notify.py").read_text(encoding="utf-8")

    assert "GIST_ID: ${{ secrets.GIST_ID }}" in source
    assert 'GIST_ID = os.environ.get("GIST_ID"' in script
    assert "find_gist_id" not in script
    assert "/gists?per_page" not in script


def test_backend_consumers_never_fall_back_to_the_old_free_api() -> None:
    calibration = workflow("calibrate-strategy.yml")
    notification = workflow("notify.yml")
    overseas = workflow("overseas-accuracy.yml")
    overseas_tool = (ROOT / "tools" / "overseas_accuracy.py").read_text(encoding="utf-8")
    notification_tool = (ROOT / "tools" / "notify.py").read_text(encoding="utf-8")
    runner_tool = (ROOT / "tools" / "record_overseas_ops.py").read_text(encoding="utf-8")

    assert "FUND_API_BASE: ${{ secrets.FUND_API_BASE }}" in calibration
    assert "secrets.FUND_API_BASE ||" not in calibration
    assert "API_BASE: ${{ vars.VITE_API_BASE }}" in notification
    assert "vars.VITE_API_BASE ||" not in notification
    assert 'test -n "$API_BASE"' in notification
    assert "FUND_API_BASE: ${{ secrets.FUND_API_BASE }}" in overseas
    assert "secrets.FUND_API_BASE ||" not in overseas
    assert "fund-compass-api.onrender.com" not in overseas_tool
    assert "fund-compass-api.onrender.com" not in notification_tool
    assert "fund-compass-api.onrender.com" not in runner_tool
    job = _overseas_job()
    assert job["env"]["FUND_API_BASE"] == "${{ secrets.FUND_API_BASE }}"
    produce = _function(_function(_overseas_runner(), "run"), "produce")
    assert len(produce.body) == 2 and isinstance(produce.body[0], ast.If)
    required_api = produce.body[0]
    _expression(required_api.test, 'not os.environ.get("FUND_API_BASE", "").strip()')
    assert len(required_api.body) == 1 and isinstance(required_api.body[0], ast.Raise)
    assert not required_api.orelse
    _expression(required_api.body[0].exc, 'OpsError("producer_failed")')
    assert isinstance(produce.body[1], ast.Return)
    _expression(produce.body[1].value, 'producer.run_pipeline(now=start, run_mode=identity["mode"])')
    producer_tree = ast.parse(overseas_tool)
    _expression(_assignment(producer_tree, "FUND_API_BASE"),
                'normalize_api_base(os.environ.get("FUND_API_BASE"))')


def test_post_deploy_smoke_verifies_exact_api_and_complete_static_data() -> None:
    source = workflow("post-deploy-smoke.yml")

    assert 'git merge-base --is-ancestor "$deployment_commit" "$EXPECTED_SHA"' in source
    assert (
        'git diff --quiet "$deployment_commit" "$EXPECTED_SHA" -- '
        'backend render.yaml'
    ) in source
    assert 'backend_source_matches=true' in source
    assert '.universe_ready == true' in source
    assert '.universe >= 1000' in source
    assert 'verify_chunks("screener", "funds", "c", 1000)' in source
    assert 'verify_chunks("managers", "managers", "id", 1000)' in source
    assert 'hashlib.sha256(raw).hexdigest() == expected' in source
    assert 'len(rows) == manifest["total"]' in source
    assert 'len(identities) == len(set(identities))' in source
    assert 'load_json(f"enrich/{code}.json")' in source
    assert 'valuation.get("schema_version") == 2' in source
    assert 'coverage.get("core_returned") == len(core)' in source
    assert 'fund-universe.meta.json' in source
    assert 'fund-universe.json.gz' in source
    assert 'gzip.decompress(compressed)' in source
    assert 'digest == meta["sha256"]' in source
    assert 'len(funds) == meta["fund_count"]' in source
    assert 'codes == sorted(codes)' in source
    assert 'len(codes) == len(set(codes))' in source
    assert "valuation_age_days = (beijing_today - valuation_date).days" in source
    assert "assert valuation_age_days >= 0" in source
    assert "Index valuation stale" in source
    assert ".index_valuation.age_days <= .index_valuation.max_age_days" in source
    assert ".index_valuation.usable == false" in source
    assert ".index_valuation.stale == true" in source
    assert 'python tools/persistence_gate.py --expected-version "$EXPECTED_VERSION"' in source
    assert '< "$RUNNER_TEMP/fund-compass-final-health.json"' in source
    assert '.build_sha == $sha' in source
    assert 'git diff --quiet "$worker_deployment_sha" "$EXPECTED_SHA" -- worker' in source
    assert '[[ "$worker_source_matches" == "true" ]]' in source
    assert '.runtime.last_cron_build_sha == $sha' in source
    assert 'Worker natural schedule: NOT_RUN' in source
    assert '待下一个自然窗口验证' in source
    assert '.kind == "intraday_estimate"' in source
    assert '.kind == "qdii_next_nav_estimate"' in source
    assert '.kind == "holdings_model"' in source
    assert '.kind == "official_nav"' in source
    assert '.estimate_nav == null' in source
    assert '.estimate_change == null' in source
    assert '(.nav_date | test("^[0-9]{4}-[0-9]{2}-[0-9]{2}$"))' in source
    assert '.value_date == .nav_date' in source
    assert '.source_time == .nav_date' in source
    assert '.kind == "unavailable"' in source
    assert '.value_nav == null' in source
    assert '.target_nav_date == null' in source
    assert 'and (.est_nav | type) == "number"' not in source
    assert 'and (.est_change | type) == "number"' not in source


def test_post_deploy_smoke_runs_v8_persistence_gate_against_configured_api() -> None:
    source = workflow("post-deploy-smoke.yml")

    required_target = 'test -n "${FUND_API_BASE:-}"'
    normalized_target = 'api="${FUND_API_BASE%/}"'
    health_request = 'health=$(curl --fail --silent --show-error "$api/api/health" || true)'
    final_health = 'final_health="$RUNNER_TEMP/fund-compass-final-health.json"'
    persistence_gate = 'python tools/persistence_gate.py --expected-version "$EXPECTED_VERSION"'

    assert required_target in source
    assert normalized_target in source
    assert "api=${FUND_API_BASE:-" not in source
    assert source.index(required_target) < source.index(normalized_target)
    assert source.index(normalized_target) < source.index(health_request)
    assert source.index(health_request) < source.index(final_health)
    assert source.index(final_health) < source.index(persistence_gate)
    assert 'git merge-base --is-ancestor "$deployment_commit" "$EXPECTED_SHA"' in source
    assert 'git diff --quiet "$deployment_commit" "$EXPECTED_SHA" -- backend render.yaml' in source
    assert '[[ "$(git rev-parse origin/main)" == "$EXPECTED_SHA" ]]' in source
    assert "&audit=${GITHUB_RUN_ID}-${GITHUB_RUN_ATTEMPT}" in source
    assert '--header "Cache-Control: no-cache"' in source
    assert "final Pages deployment is not bound to the target SHA" in source
    assert "final storage response is not bound to the validated backend source" in source
    assert "if: ${{ inputs.enforce_persistence }}" in source
    assert "continue-on-error" not in source[source.index(persistence_gate) - 300:]
    assert "formal release requires cross-restart production write/read evidence" in source
    assert 'echo "formal_release_status=blocked" >> "$GITHUB_OUTPUT"' in source
    assert source.index(persistence_gate) < source.index(
        "formal release requires cross-restart production write/read evidence"
    )


def test_candidate_smoke_requires_turso_candidate_without_granting_release() -> None:
    source = workflow("post-deploy-smoke.yml")

    candidate_condition = "if: ${{ inputs.enforce_persistence == false }}"
    candidate_status = "CANDIDATE_ONLY / BLOCKED_FOR_FORMAL_RELEASE"
    formal_gate = 'python tools/persistence_gate.py --expected-version "$EXPECTED_VERSION"'

    assert candidate_condition in source
    assert '.database.engine == "libsql"' in source
    assert '.database.persistence == "turso_candidate"' in source
    assert ".database.durable == false" in source
    assert '((.database.engine == "sqlite"' not in source
    assert candidate_status in source
    assert "不得创建 v8.0.0 Tag 或 GitHub Release" in source
    assert source.index(candidate_condition) < source.index(formal_gate)


def test_post_deploy_smoke_finishes_compatibility_and_worker_checks_before_persistence_block() -> None:
    source = workflow("post-deploy-smoke.yml")

    compatibility_path = "/api/v2/fund/005844/decision"
    worker_contract = 'estimates=$(curl --fail --silent --show-error "$WORKER_BASE/estimates?codes=005844,018147")'
    persistence_gate = 'python tools/persistence_gate.py --expected-version "$EXPECTED_VERSION"'

    assert compatibility_path in source
    assert 'test "$owner_read_status" = "403"' in source
    assert "私人数据未公开" in source
    assert source.index(compatibility_path) < source.index(worker_contract)
    assert source.index(worker_contract) < source.index(persistence_gate)


def test_formal_release_runs_are_not_cancelled_by_candidate_runs() -> None:
    ci = workflow("ci.yml")
    smoke = workflow("post-deploy-smoke.yml")

    assert "'formal' || 'candidate'" in ci
    assert "cancel-in-progress: ${{ !(github.event_name == 'workflow_dispatch'" in ci
    assert "'formal' || 'candidate'" in smoke
    assert "cancel-in-progress: ${{ inputs.enforce_persistence == false }}" in smoke
    deploy_block = ci[ci.index("  deploy:") : ci.index("  candidate_smoke:")]
    formal_block = ci[ci.index("  formal_smoke:") :]
    assert "!inputs.formal_release" not in deploy_block
    assert "!(github.event_name == 'workflow_dispatch' && inputs.formal_release)" in deploy_block
    assert "uses: ./.github/workflows/deploy.yml" not in formal_block
    assert "enforce_persistence: true" in formal_block


def test_post_deploy_smoke_requires_frontend_worker_and_api_to_share_one_origin() -> None:
    source = workflow("post-deploy-smoke.yml")

    assert "VITE_API_BASE: ${{ vars.VITE_API_BASE }}" in source
    assert 'test -n "${VITE_API_BASE:-}"' in source
    assert '[[ "$frontend_api" == "$api/api" ]]' in source
    assert "worker_api=$(sed -n" in source
    assert 'worker/wrangler.toml FUND_API_BASE must equal the deployed API' in source


def test_worker_deploy_injects_exact_clean_git_identity() -> None:
    package = (ROOT / "worker" / "package.json").read_text(encoding="utf-8")
    deploy = (ROOT / "worker" / "scripts" / "deploy.mjs").read_text(encoding="utf-8")

    assert '"deploy": "node scripts/deploy.mjs"' in package
    assert "status', '--porcelain=v1', '--untracked-files=all'" in deploy
    assert "rev-parse', '--verify', 'HEAD^{commit}'" in deploy
    assert "WORKER_BUILD_SHA:${JSON.stringify(normalized)}" in deploy
    assert "'--define'" in deploy


def test_fund_universe_workflow_verifies_real_generated_artifact() -> None:
    source = workflow("fund-universe.yml")

    assert "python tools/build_universe.py" in source
    assert "python tools/build_universe.py --verify" in source
    assert "tests/test_universe_artifact.py tests/test_build_universe_tool.py" in source
    assert source.index("python tools/build_universe.py --verify") < source.index("git status --porcelain")


def test_overseas_workflow_exports_the_audited_backend_evidence_artifact() -> None:
    job = _overseas_job()
    uploads = [step for step in job["steps"] if step.get("uses") == "actions/upload-artifact@v7"]
    assert len(uploads) == 1 and uploads[0]["if"] == "always()"
    runner_step = next(step for step in job["steps"] if "run" in step)
    assert job["steps"].index(runner_step) < job["steps"].index(uploads[0])
    assert uploads[0]["with"]["path"].splitlines() == [
        "frontend/public/data/overseas-accuracy.json", "frontend/public/data/overseas-audit.json",
        "frontend/src/data/overseas-models.json", "backend/data/overseas-evidence.json",
    ]
    tree = _overseas_runner()
    run = _function(tree, "run")
    stage_calls = _calls(run, "stage")
    expected_stages = ("producer", "calibration", "audit", "evidence", "publication", "ci_dispatch")
    assert ast.literal_eval(_assignment(tree, "STAGES")) == expected_stages
    assert tuple(node.args[0].value for node in stage_calls) == expected_stages
    for actual, expected in zip(stage_calls[:4], (
        'stage("producer", produce)', 'stage("calibration", calibrator.main)',
        'stage("audit", independent_audit)', 'stage("evidence", export)',
    )):
        _expression(actual, expected)
    audit = _function(run, "independent_audit")
    assert len(_calls(audit, "auditor.audit")) == 1
    _expression(_calls(audit, "auditor.audit")[0], "auditor.audit(ledger, registry, now=_now())")
    _expression(_calls(audit, "producer.write_json_atomic")[0],
                "producer.write_json_atomic(auditor.REPORT, report)")
    _expression(audit.body[-1].value, "_audit_receipt(report, context)")
    evidence_guards = [node for node in ast.walk(run) if isinstance(node, ast.If)
                       and any(child is stage_calls[3] for child in ast.walk(node))]
    assert any(ast.dump(node.test) == ast.dump(ast.parse(
        'stages["calibration"] == stages["audit"] == "succeeded"', mode="eval").body)
               for node in evidence_guards)
    export = _function(run, "export")
    _expression(_calls(export, "exporter.build_export")[0], "exporter.build_export(ledger)")
    _expression(_calls(export, "producer.write_json_atomic")[0],
                "producer.write_json_atomic(exporter.DEFAULT_OUTPUT, payload)")
    exporter = ast.parse((ROOT / "tools" / "export_v8_overseas_evidence.py").read_text(encoding="utf-8"))
    _expression(_assignment(exporter, "DEFAULT_OUTPUT"),
                'ROOT / "backend" / "data" / "overseas-evidence.json"')
    publication_guards = [node for node in ast.walk(run) if isinstance(node, ast.If)
                          and any(child is stage_calls[4] for child in ast.walk(node))]
    assert any(ast.dump(node.test) == ast.dump(ast.parse(
        'all(stages[key] == "succeeded" for key in STAGES[:4])', mode="eval").body)
               for node in publication_guards)
    assert stage_calls[2].lineno < stage_calls[3].lineno < stage_calls[4].lineno < stage_calls[5].lineno


def test_all_workflow_files_parse_as_yaml() -> None:
    for path in sorted(WORKFLOWS.glob("*.yml")):
        parsed = yaml.safe_load(path.read_text(encoding="utf-8"))
        assert isinstance(parsed, dict), path.name


def test_actions_use_node24_compatible_majors() -> None:
    combined = "\n".join(path.read_text(encoding="utf-8") for path in sorted(WORKFLOWS.glob("*.yml")))

    obsolete = (
        "actions/checkout@v4",
        "actions/setup-node@v4",
        "actions/setup-python@v5",
        "actions/upload-artifact@v4",
        "actions/upload-pages-artifact@v3",
        "actions/deploy-pages@v4",
    )
    current = (
        "actions/checkout@v7",
        "actions/setup-node@v7",
        "actions/setup-python@v7",
        "actions/upload-artifact@v7",
        "actions/upload-pages-artifact@v5",
        "actions/deploy-pages@v5",
    )

    for action in obsolete:
        assert action not in combined
    for action in current:
        assert action in combined
