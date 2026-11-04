# Stage 1 browser QA scripts

Playwright scripts used for Stage 1 (Poker Core QA). They drive the real app in Chromium and use the real engine in Node as the oracle. They are **not** part of `npm test` or CI, because they need running servers and a browser.

## Requirements

- `npm ci` (the project's own dependencies).
- Playwright with Chromium available **globally**. Playwright is intentionally not a project dependency. The scripts load it with `createRequire`, so a global install (`npm i -g playwright`, then `npx playwright install chromium`) or a pre-installed copy works.
- Node ≥ 22.18 (built-in TypeScript type stripping; `--experimental-transform-types` is passed below).

## Run

```bash
npx vite --port 5173 --strictPort
```

```bash
npx tsx server/index.ts
```

The first command serves the app; keep it running in its own terminal. The second runs the local table server, which is only needed for `regress-bug-s1-01.mts`. Then run any script from the repository root:

```bash
node --experimental-transform-types --import ./docs/qa/browser/register.mjs docs/qa/browser/<script>.mts [args]
```

`CARDIFY_URL` overrides the app address (default `http://localhost:5173/`).

| Script | Checks | Pass condition |
| --- | --- | --- |
| `regress-bug-s1-01.mts` | BUG-S1-01 (dead action controls after an undelivered tap, a reconnect, or a server refusal), BUG-S1-02 (stale "reconnecting" line), BUG-S1-04 (fractional slider amount with an odd big blind) | `10 passed, 0 failed`, exit 0. Before the fixes: 6 failed. |
| `solo-ui.mts [turns]` | P15/P16 in solo: the dock matches `getLegalActions` on every hero turn; double clicks/keys commit exactly one action; slider presets give whole amounts in range; pause, leave/continue and restart during a pending bot timer are inert | `"findings": 0`, no page errors, exit 0 |
| `shots.mts <dir> [--fixed]` | Screenshots of the start screen and solo table (iPhone 13, 1280×800). `--fixed` uses one seeded saved game, so builds can be compared | — |
| `compare.mts <before> <after>` | Pixel comparison of two `shots.mts --fixed` folders | `0 … pixels differ` for every image, exit 0 |
| `s02-reachability.mts` | Whether an odd big blind in the shipped blind table could ever produce a fractional slider stop | informational |

### Visual preservation, step by step

Compare **production builds** (`vite build` + `vite preview`), not two dev servers. A dev server started from a copy whose `node_modules` is a symlink refuses to serve the font files, so that copy falls back to system fonts and every image differs.

```bash
git archive <base-commit> | tar -x -C /path/to/before && ln -s "$PWD/node_modules" /path/to/before/node_modules
```

```bash
(cd /path/to/before && npx vite build --outDir /path/to/dist-before --emptyOutDir)
```

```bash
npx vite build --outDir /path/to/dist-after --emptyOutDir
```

Serve each with `npx vite preview --outDir <dist> --port <port>`, run `shots.mts <dir> --fixed` against each (via `CARDIFY_URL`), then run `compare.mts`.

## Files

- `register.mjs`, `resolve-ts.mjs` — Node module hook so the engine's extensionless TypeScript imports resolve.
- `lib.mts` — Playwright loader, shared constants, a small pass/fail collector.
