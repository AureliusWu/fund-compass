import re
from pathlib import Path

import yaml


ROOT = Path(__file__).resolve().parents[2]
WORKFLOWS = ROOT / ".github" / "workflows"
AUTO_COMMIT_WORKFLOWS = (
    "calibrate-strategy.yml",
    "enrich-holdings.yml",
    "enrich-managers.yml",
    "fund-universe.yml",
    "overseas-accuracy.yml",
)


def workflow(name: str) -> str:
    return (WORKFLOWS / name).read_text(encoding="utf-8")


def test_ci_is_the_only_release_orchestrator() -> None:
    ci = workflow("ci.yml")
    deploy = workflow("deploy.yml")
    smoke = workflow("post-deploy-smoke.yml")

    assert "workflow_dispatch:" in ci
    assert "target_sha:" in ci
    assert "uses: ./.github/workflows/deploy.yml" in ci
    assert "needs: [resolve, backend, frontend, worker]" in ci
    assert "uses: ./.github/workflows/post-deploy-smoke.yml" in ci
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


def test_ci_validates_and_checks_out_one_exact_sha() -> None:
    ci = workflow("ci.yml")

    assert "target_sha must be a full 40-character commit SHA" in ci
    assert '[[ "$target_sha" == "$remote_sha" ]]' in ci
    assert "refusing to release a non-HEAD main commit" in ci
    assert ci.count("ref: ${{ needs.resolve.outputs.target_sha }}") == 3
    assert "target_sha: ${{ needs.resolve.outputs.target_sha }}" in ci


def test_generated_data_writers_are_serial_and_dispatch_ci_once() -> None:
    for name in AUTO_COMMIT_WORKFLOWS:
        source = workflow(name)
        assert "group: scheduled-data-main" in source, name
        assert "queue: max" in source, name
        assert "cancel-in-progress: true" not in source, name
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


def test_post_deploy_smoke_verifies_exact_api_and_complete_static_data() -> None:
    source = workflow("post-deploy-smoke.yml")

    assert 'git merge-base --is-ancestor "$deployment_commit" "$EXPECTED_SHA"' in source
    assert 'git diff --quiet "$deployment_commit" "$EXPECTED_SHA" -- backend render.yaml' in source
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
    assert 'if (( 10#$expected_major >= 8 )); then' in source
    assert '.database.persistence != "ephemeral"' in source
    assert '.database.durable == true' in source
    assert '.database.persistence == "ephemeral" and .database.durable == false' in source
    assert '.build_sha == $sha' in source
    assert 'git diff --quiet "$worker_deployment_sha" "$EXPECTED_SHA" -- worker' in source
    assert '[[ "$worker_source_matches" == "true" ]]' in source
    assert '.runtime.last_cron_build_sha == $sha' in source
    assert 'Worker natural schedule: NOT_RUN' in source
    assert '待下一个自然窗口验证' in source


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
    source = workflow("overseas-accuracy.yml")

    assert "python tools/export_v8_overseas_evidence.py" in source
    assert "backend/data/overseas-evidence.json" in source
    assert source.index("python tools/audit_overseas_accuracy.py") < source.index(
        "python tools/export_v8_overseas_evidence.py"
    )
    assert source.index("python tools/export_v8_overseas_evidence.py") < source.index(
        "git status --porcelain"
    )


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
