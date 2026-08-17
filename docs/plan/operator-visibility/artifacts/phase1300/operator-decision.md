# Phase 1300 — operator decision recorded (round 1292)

**This document supersedes sections 4 and 5 of `scope-ruling.md`** on the question of who decides the §9.6 canvas-cost choice and whether an answer exists: both sections were briefed before Konrad's answer landed and either describe the choice as escalated-and-pending or give a default for the case where he has not answered. Neither condition holds. He answered on 2026-08-17. This file is the binding record of that answer for phase 1300's planner.

---

## 1. The decision, quoted

Source: `docs/plan/operator-visibility/15-ui-v3-phases.md`, section "OPERATOR DECISION — 2026-08-17, canvas first-open cost (binding, Konrad)", lines 5–22, commit `e8df4e6` ("docs(operator-decision): Konrad accepts 190ms canvas first-open — options (a)/(c) closed").

> The r1250 steward escalated the canvas "190 ms on first open" to Konrad: Excalidraw registers
> ~230 fonts on mount, and Blink answers by relaying the whole `/desktop` document (8,416 layout
> objects). Options offered: (a) keep the canvas editor mounted+hidden after first open,
> (c) virtualise/cap the chat transcript so the document is small, (d) accept the cost.
>
> **Konrad's answer: (d) — 190 ms once per page load is acceptable.**
>
> Consequences, binding on every later round:
> - **Option (c) is CLOSED.** No transcript virtualisation, capping, or windowing may be
>   undertaken to buy canvas-open time. The transcript is what Konrad reads every day; it is
>   not to be restructured for a 190 ms one-off. If virtualisation is ever proposed again it
>   needs a NEW justification and a fresh operator decision — not this one.
> - **Option (a) is CLOSED for this reason.** Keeping a hidden editor mounted is not to be
>   built as a canvas-open optimisation. (It may still be considered if some other requirement
>   independently demands it.)
> - **Round 1300 keeps only the hover work**: profile the v3 panel, confirm hover is clean, record
>   numbers. Canvas first-open is **not a defect** and must not be re-opened as one. Do not
>   regress it either — 190 ms first open is the accepted ceiling, not a licence to grow.
> - A measurement showing canvas-open cost is a *note*, not a finding. Reviewers must not raise it.

---

## 2. CANCELLED — do not propose, plan, or undertake

- **Transcript virtualisation / capping / windowing** of the chat transcript (option c) — closed by the decision above, no new justification exists.
- **Keeping a hidden Excalidraw editor mounted** after first open (option a) — closed by the decision above.
- **Font pre-warming** (option b) — never separately open; `docs/plan/artifacts/phase800/canvas-perf.md` §9.6 shows it collapses into (a), so it is closed for the same reason as (a).

## 3. BINDING on phase 1300 and every later round

- The canvas first-open cost is **ACCEPTED**, not a defect. No builder or reviewer in phase 1300 may raise it as a finding.
- **~190 ms is the accepted ceiling, not a target to hit or a licence to grow.** A later round that regresses first-open cost above this ceiling is the one thing that would reopen this question — matching it or staying under it requires no action and no report.
- **U31 is CLOSED, not MET.** No measurement exists after the decision and none is owed. Do not write "met," "achieved," or "target reached" for U31 anywhere in this project's docs — write closed-as-accepted, with the number (~190 ms) and Konrad's decision as the reason. `docs/plan/artifacts/phase800/README.md` §4 already carries this same closure language for U31, dated 2026-08-17.
- Do not write "pending Konrad" anywhere in this project's docs for the canvas question. Nothing about it is pending.

## 4. SURVIVES unchanged from `scope-ruling.md`

- **Section 2** (DoD #3): closes on the panel's own numbers — the three not-yet-written perf docs (baseline, findings, after — see `scope-ruling.md` §2 for their exact paths and status, not repeated here since they don't exist yet) read from the committed hover-measurement artifacts across `docs/plan/artifacts/phase400/`, `phase500/`, `phase600/`, `phase700/`, and `phase900/`. This document does not touch that ruling.
- **Section 3** (§9.7 lead): `docs/plan/artifacts/phase800/canvas-perf.md` §9.7 remains the one open hover-adjacent lead — a `PseudoClass` invalidation-count anomaly not yet mechanically explained. If the round-1291 probe traces it to one of this project's own `:hover` selectors, the fix is a **selector change**, nothing larger. This document does not touch that ruling either.

---

## 5. Provenance

Commands run to confirm the commit and corpus section exist:

```
$ git log --oneline -1 e8df4e6
e8df4e6 docs(operator-decision): Konrad accepts 190ms canvas first-open — options (a)/(c) closed

$ git merge-base --is-ancestor e8df4e6 HEAD && echo IN-HEAD
IN-HEAD

$ sed -n '1,40p' docs/plan/operator-visibility/15-ui-v3-phases.md
# 15 — UI v3 Phases (rounds 300–900)
[...]
## OPERATOR DECISION — 2026-08-17, canvas first-open cost (binding, Konrad)
[... section confirmed present at line 5, full text quoted in §1 above ...]
```

Cross-checked against `docs/plan/artifacts/phase800/README.md` §4 (lines 336–341), which independently carries the same "CLOSED 2026-08-17 by operator decision" language for U31, citing the same commit.

This document changed no application code, started no server, and ran no browser.
