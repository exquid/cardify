# Release checklist (Stage 6)

Prepared in the overnight run. The table lists what is **already evidenced** on branch `claude/youthful-pascal-rmmfom` and what still needs **you**. A production deploy needs your separate approval: merging to `main` auto-deploys Render (table server) and Vercel (site).

| # | Check | Status | Evidence / how | Owner |
| --- | --- | --- | --- | --- |
| 1 | Static checks | ✅ | `npm run check`: typecheck (client + server), lint, 172 tests in 18 files, build | done |
| 2 | Poker rules and accounting | ✅ | Stage 1 report: P01–P17 matrix, 2,072 generated hands, payout oracle | done |
| 3 | Multiplayer | ✅ local | Stage 2 report: room recovery, two-human tests, `stage2-online.mts` 8/8 | done |
| 4 | Durak rules | ✅ | 16 fixtures + 500 generated games; `durak-ui.mts` 21/21 | done |
| 5 | Cross-game regression | ✅ | Poker table pixel-identical to the redesign commit (`compare.mts`); `regress-bug-s1-01.mts` 10/10; `solo-ui.mts` 0 findings | done |
| 6 | Real devices | ⬜ | 10 minutes on iPhone Safari and one Android Chrome: solo poker, Durak, a private table between two phones, Wi-Fi off/on during your turn | **you** |
| 7 | Accessibility | 🟡 | Buttons and cards have labels, keyboard shortcuts (poker F/C/R/A/N, Durak T/D) and a polite live region. Not done: screen-reader pass with VoiceOver; Durak table cards are only partly keyboard-operable (Tab/Enter on open attack cards works, hand cards are buttons) | **you** / follow-up |
| 8 | Performance | 🟡 | Bundle ≈ 97 KB JS (31 KB gzip) + 60 KB CSS before Durak; Durak adds a few KB. No profiling on low-end phones | follow-up |
| 9 | Dependency / security review | ✅ / note | `npm audit --omit=dev`: **0** vulnerabilities in shipped code. Dev-only: 7 moderate (`minimatch` inside `typescript-eslint`); the fix needs a breaking `--force` upgrade, so it was **not** applied | **you** decide on the lint-tool upgrade |
| 10 | Secrets | ✅ | No secrets in the repo; `.env.production` holds only the public table-server URL | done |
| 11 | Environment validation | ⬜ | After merge: `https://<render>/health` = `ok`; `ALLOWED_ORIGINS` contains the Vercel domain; open a table from the deployed site | **you** |
| 12 | Observability | 🟡 | Server logs room create/close, refused origins and step failures (`[room …] scheduled step failed`, `closed after repeated failures`). No metrics or alerting | follow-up |
| 13 | Backup / rollback | 🟡 | Stateless deploys: roll back by reverting the merge commit (Vercel "Promote previous deployment", Render "Rollback"). Tables live in memory, so a rollback ends running games | **you** |
| 14 | Staged rollout | ⬜ | Suggested: merge → watch the Render log and the Vercel preview for 15 minutes → share with 2–3 friends → then announce | **you** |

## Known limitations to accept or schedule

- Online tables are in memory: a deploy or restart ends running games, and the free Render tier sleeps after about 15 minutes idle.
- Durak is solo-only for now (no online Durak).
- Profiles and stats are local to one browser; there are no accounts.
- Bots are heuristic in both games.

## Rollback in one line

Revert the merge commit on `main` and push. Vercel and Render redeploy the previous version automatically.
