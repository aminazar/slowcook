# rewo agent-worker run — slowcook gap ledger

> The primary deliverable of the worker programme
> (docs/plans/rewo-agent-workers.md §4). Rewo progress is how we generate
> evidence; this file is the evidence. One entry per slowcook defect the run
> exposes. Every outcome cites the ARTIFACT (trace file, PR, gate output) —
> never a log line alone.

Entry format:

```
## G<n> — <one-line symptom>
- **surfaced by**: <agent / worker pass / trace path>
- **precondition**: <the named check that failed, if any>
- **root cause**: <the slowcook defect, not the rewo symptom>
- **fix**: <commit / PR>
- **verified**: <artifact that proves the fix, and how>
```

---

_No entries yet. W0 (dry-run worker) shipped; the ledger opens when passes
start running on the box._
