# Evaluation Results

## Overall Scores

| System | Score | Avg Latency | Errors |
|--------|-------|-------------|--------|
| graph | 36.4% | 6635ms | 2 |
| sql | 0.0% | 0ms | 0 |
| sql-fts | 0.0% | 0ms | 0 |
| llm-only | 0.0% | 0ms | 0 |

## Scores by Question Type

| System | simple-lookup | multi-hop | temporal | cohort | reasoning | unanswerable |
|--------|------|------|------|------|------|------|
| graph | 0.0% | 0.0% | 36.4% | 0.0% | 0.0% | 0.0% |
| sql | 0.0% | 0.0% | 0.0% | 0.0% | 0.0% | 0.0% |
| sql-fts | 0.0% | 0.0% | 0.0% | 0.0% | 0.0% | 0.0% |
| llm-only | 0.0% | 0.0% | 0.0% | 0.0% | 0.0% | 0.0% |

## Scores by Domain

| System | absent-condition | cardiovascular | conditions | demographics | diabetes | general | guidelines | labs | medications | missing-data-type | non-existent-patient | procedures | providers | renal | respiratory | speculative | subjective | unanswerable-medical | unanswerable-non-medical |
|--------|------|------|------|------|------|------|------|------|------|------|------|------|------|------|------|------|------|------|------|
| graph | 0.0% | 0.0% | 0.0% | 0.0% | 36.4% | 0.0% | 0.0% | 0.0% | 0.0% | 0.0% | 0.0% | 0.0% | 0.0% | 0.0% | 0.0% | 0.0% | 0.0% | 0.0% | 0.0% |
| sql | 0.0% | 0.0% | 0.0% | 0.0% | 0.0% | 0.0% | 0.0% | 0.0% | 0.0% | 0.0% | 0.0% | 0.0% | 0.0% | 0.0% | 0.0% | 0.0% | 0.0% | 0.0% | 0.0% |
| sql-fts | 0.0% | 0.0% | 0.0% | 0.0% | 0.0% | 0.0% | 0.0% | 0.0% | 0.0% | 0.0% | 0.0% | 0.0% | 0.0% | 0.0% | 0.0% | 0.0% | 0.0% | 0.0% | 0.0% |
| llm-only | 0.0% | 0.0% | 0.0% | 0.0% | 0.0% | 0.0% | 0.0% | 0.0% | 0.0% | 0.0% | 0.0% | 0.0% | 0.0% | 0.0% | 0.0% | 0.0% | 0.0% | 0.0% | 0.0% |