# Review quality benchmark

Runs Diffowl against a fixed subset of the [withmartian/code-review-benchmark](https://github.com/withmartian/code-review-benchmark) offline set and scores it with that project's judge, so results are comparable with the commercial tools already in their `benchmark_data.json`.

The subset is 15 PRs, 3 per source repo (sentry, grafana, keycloak, discourse, cal.com), each with at least one Critical or High golden comment. `prs.json` lists them.

## Run

```sh
git clone https://github.com/withmartian/code-review-benchmark /tmp/crb
cp scripts/benchmark/env.example scripts/benchmark/env.sh   # fill in, gitignored
source scripts/benchmark/env.sh
npm run build

node scripts/benchmark/fetch-prs.mjs                 # diffs + checkouts at PR head (about 2.5 GB)
DIFFOWL_CONCURRENCY=4 DIFFOWL_RUN_TAG=-run1 \
  node scripts/benchmark/run-and-convert.mjs --golden /tmp/crb/offline/golden_comments
```

`run-and-convert.mjs` reviews each PR with the CLI, using the checkout as the role workspace (`--repository`), caches one report per PR under `reports<tag>/`, and writes `results<tag>/benchmark_data.json` in the shape the martian pipeline reads. Material findings and advisory suggestions are both emitted, tagged `kind`, so material-only scoring is a filter. Reruns skip PRs that already have a report; delete a report to redo it.

Flags: `--no-checkout` on fetch for a diff-only run. `DIFFOWL_POLICY` to point at another policy. `DIFFOWL_DEBUG_PROVIDER=1` prints role tool calls and structured outputs to stderr.

Expect 2 to 10 minutes per PR with a repository workspace. `policy.json` sets `reviewTimeoutSeconds` to 1500 for that reason. Keep concurrency at 4 or below against a single provider endpoint.

## Judge

Merge the Diffowl reviews into the martian data and run their steps 2 to 4:

```sh
cd /tmp/crb/offline && uv sync && cp .env.example .env    # judge key
python3 - <<'EOF'
import json
orig=json.load(open('results/benchmark_data.json'))
ours=json.load(open('<repo>/scripts/benchmark/results-run1/benchmark_data.json'))
for u,e in ours.items():
    orig[u]['reviews']=[r for r in orig[u]['reviews'] if r['tool']!='diffowl']+e['reviews']
json.dump(orig,open('results/benchmark_data.json','w'),indent=2)
EOF
for t in diffowl coderabbit greptile qodo-v2 augment bugbot; do
  uv run python -m code_review_benchmark.step2_extract_comments --tool $t
  uv run python -m code_review_benchmark.step2_5_dedup_candidates --tool $t
  uv run python -m code_review_benchmark.step3_judge_comments --tool $t --dedup-groups results/<judge>/dedup_groups.json
done
```

Re-judge the comparison tools with the same judge model; the numbers shipped in the martian repo were produced by other judges and are not directly comparable. Then restrict every tool to the 15 URLs in `prs.json` before comparing.

## Files

- `prs.json`: the subset.
- `policy.json`: benchmark policy, all roles on one model, no validation commands.
- `fetch-prs.mjs`, `run-and-convert.mjs`: the runner.
- `tuning-set.json`: golden comments next to what Diffowl said, split into material true positives, demoted Critical/High, missed Critical/High, and false positives. Regenerate after a prompt change.
- `inputs/`, `checkouts/`, `reports*/`, `results*/`, `run*.log`, `env.sh`: gitignored.

## Results (2026-09-05)

Same 15 PRs, every tool's published review re-judged under `gpt-5.6-sol`, all comments counted:

| tool                         | precision | recall | F1    | Crit+High found (of 40) | comments/PR |
| ---------------------------- | --------- | ------ | ----- | ----------------------- | ----------- |
| qodo-v2                      | 60.0%     | 62.5%  | 61.2% | 29                      | 5.0         |
| augment                      | 62.1%     | 56.9%  | 59.4% | 27                      | 4.4         |
| diffowl, material only       | 60.9%     | 54.2%  | 57.4% | 30                      | 4.3         |
| bugbot                       | 65.4%     | 47.2%  | 54.8% | 24                      | 3.5         |
| diffowl, material + advisory | 34.4%     | 72.2%  | 46.6% | 32                      | 10.1        |
| devin                        | 67.6%     | 34.7%  | 45.9% | 18                      | 2.5         |
| copilot-v2                   | 34.6%     | 61.1%  | 44.2% | 27                      | 8.5         |
| claude-code                  | 52.2%     | 33.3%  | 40.7% | 16                      | 3.1         |
| greptile                     | 43.6%     | 33.3%  | 37.8% | 18                      | 3.7         |
| coderabbit                   | 24.9%     | 66.7%  | 36.2% | 26                      | 12.9        |

Diffowl ran all three roles on one Anthropic Claude model with a repository checkout as the workspace and no validation commands. Material findings are what the Action publishes as review threads; advisories default to a collapsed block. n=15 on a static dataset: treat ranks within about 5 F1 points as noise.

What moved the numbers, in order: a repository workspace (recall 68% to 74%); a shared materiality definition in the reviewer, challenger, and verifier prompts (material Critical/High recall 15/40 to 24/40, zero `clean` outcomes on PRs with a Critical or High golden, advisories 98 to 57); and scoring material findings alone (precision 34% to 61%). Remaining gaps: 12 Critical/High goldens the model never finds, and about 22 material findings outside the golden set that need a manual read.
