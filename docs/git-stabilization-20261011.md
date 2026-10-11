# Git stabilization — 2026-10-11

AIWF maintenance ticket: `TKT-DGGP`.

## Diagnosis and retained code

`master` at `259bef1` had an unfinished merge of `origin/master` at `fd29f14`: one local commit and 15 upstream commits diverged from `ba28543`. `src/asker.ts` still contained conflict markers. The working version of `src/actor.ts` had also lost upstream runtime token-budget support and local tool-failure metrics, although Git still retained both complete parents.

Reconstructed both parents with Git's three-way merge and applied bounded repairs through AIWF `preview_change` and `apply_change`, checking fingerprints and original hashes. The result retains provider timeout policy, runtime token budgets and reconciliation, execution locality and cost reporting, and categorized tool-failure metrics. Also corrected a fetch mock to supply Bun's required `preconnect` property so all-files typechecking passes.

## Cleanup evidence

- `backup/pre-actor-repair-20261002-094023` (`fd0779a`) and `recovery/canonical-llm-utils` (`d2c1e3f`) were ancestors of `master` and deleted with `git branch -d`.
- [Closed PR #5](https://github.com/dharmax/llm-utils/pull/5) explicitly says its OpenAI Responses changes were ported to master and its stale `.mts` branch must not be merged. Tip `a296824` is retained as `archive/openai-responses-api-20261011`.
- [Closed PR #7](https://github.com/dharmax/llm-utils/pull/7) explicitly says the overbroad verified-pipeline rewrite was superseded by merged PR #8 and must not be merged. Tip `5a98a88` is retained as `archive/verified-task-pipeline-20260921-20261011`.
- The obsolete `pre-recovery bun.lock` stash was removed from the stash queue, with its complete commit `3e5051b` retained by local tag `archive/pre-recovery-lockfile-20261011`. Its old dependency changes were not reapplied.

The two historical feature tags are published before their remote branches are removed. `master` remains the sole active branch. No force-push or history rewrite is needed.

## Validation and recovery

- Full `bun test` passed through AIWF triage; graph evidence updated 23 test artifacts. Live Ollama tests remain opt-in and were not requested.
- `bun run typecheck` and `bun run typecheck:all` passed.
- `bun run build` passed; Node imported the built Asker, LLMActor, LLMSession and LLMPipeline exports.
- The corrected adapter mock passed its focused test run through AIWF triage.
- `git diff --check` passed.

A verified full-history recovery bundle was saved at `/tmp/llm-utils-before-stabilize-20261011.bundle`, together with working/index patches and the lockfile stash patch. The archive tags retain the unique historical commits independently of these temporary files.
