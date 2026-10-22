# AGENTS.md

The single source of truth for AI agents and collaborators in this repository. User docs: [README.md](README.md). Library API: [docs/api.md](docs/api.md). Asset layout: [docs/assets.md](docs/assets.md). Playback logic and reverse-engineering sources: [docs/internals.md](docs/internals.md). Contribution rules: [CONTRIBUTING.md](CONTRIBUTING.md).

## What this repository is

A browser replica of Project SEKAI's story player. It reads the game's `ScenarioSceneData` JSON and plays it on the game's timeline rules with PIXI.js v7 and `@sekai-world/pixi-live2d-display-mulmotion` (Cubism 4). The playback logic is reverse-engineered from the game's il2cpp binary; the goal is frame-accurate parity with the game.

Three parts:

- `src/`: the embeddable library (`createPlayer` / `PjskPlayer`), framework-free. Not published to npm; installed with `npm i github:Team-Haruki/sekai-scenario-player` (`prepare` builds `dist/lib`). The package name stays `pjsk-scenario-player`.
- `server/`: the asset server. `asset-tree.ts` is a framework-free handler, `vite-plugin.ts` mounts it at `/assets/` in the dev server, `cli.ts` is the standalone CORS server.
- `web/`: the preview site (Vue 3 + shadcn-vue + Tailwind v4), using the library through the alias `pjsk-scenario-player → src/index.ts`.

Stack: Vite 6, TypeScript 5.7 (`strict`). Node ≥ 22.18 (Node runs `server/*.ts` directly).

## Repository layout

```
src/index.ts             public exports
src/PjskPlayer.ts        the embeddable player: PIXI app, DOM layers, load/play/jumpTo, events, scaling,
                         style and font injection
src/style.css            stage DOM layer styles (classes prefixed pjsk-, images via --pjsk-img-* variables),
                         injected with ?inline
src/scenario/            the engine (see docs/internals.md, "Modules")
fonts/                   Source Han Sans JP Bold / Medium (SIL OFL, standing in for the game's Rodin EB / DB);
                         the asset server serves them at <mount>/fonts/
server/                  asset-tree.ts / vite-plugin.ts / cli.ts
web/                     preview site: vite.config.ts, src/App.vue, src/components/*.vue,
                         src/components/ui/ (shadcn-vue components)
web/public/samples/      the original sample scenario (the only scenario JSON in the repository)
tools/fx_convert.py      AssetRipper-exported scenario/effect and background prefabs → fx/<name>/effect.json
assets/                  local game assets (git-ignored), mounted at /assets/ by the dev server
docs/                    api / assets / internals
```

## Commands

```bash
npm install
npm run dev          # preview site at http://localhost:5173; /assets/ = ./assets + an optional asset tree
SEKAI_ASSET_ROOT=/path/to/jp-assets SEKAI_MASTER_DIR=/path/to/master npm run dev
npm run typecheck    # library + server/ + preview site (vue-tsc)
npm run build        # dist/lib (ESM + d.ts) and dist/site
node server/cli.ts --root … --master … [--staged assets] [--port 5174]
```

There are no tests and no linter yet. Run at least `npm run typecheck` after a change. To check a change visually, use the headless Chrome screenshot command in docs/internals.md ("Pitfalls").

## Conventions

- Every asset URL goes through `AssetResolver` (`src/scenario/resolver.ts`); never hard-code paths in the engine. A new CSS background image goes into `CSS_IMAGES` in `PjskPlayer.ts` and is used as `var(--pjsk-img-…)`.
- Game UI sprites load through `UiSprites.bind()` (`src/scenario/sprites.ts`), which swaps in a built-in SVG when a sprite fails to load. A new sprite needs a stand-in too.
- Load the Live2D plugin only through `getLive2D()` in `src/scenario/live2d.ts`. The `cubism4` entry requires `window.Live2DCubismCore` at import time and the package root requires the Cubism 2 runtime; `assets.ts` may only `import type` from it.
- The clock is a per-player `Clock` instance that `PjskPlayer` hands to Stage / DialogueBox / Effects / ScenarioPlayer. Timeline waits and tweens use `this.clock.sleep` / `tween` / `playClip`; check `clock.epoch` (stage) or `gen` (player) before changing the stage across an `await`.
- Drive tweens and waits with `setTimeout`, never `requestAnimationFrame`: rAF doesn't advance under headless Chrome's `--virtual-time-budget`.
- The timeline is parallel: snippets start without being awaited, and the rhythm comes from each action's `FinishSnippet` timing and the `ProgressBehavior == WaitFinished` barrier.
- Game enum names follow the binary's spelling, typos included (`LayoutType.Apper`). Don't "fix" them.
- Code in `server/` must run under Node's type stripping: imports carry the `.ts` extension; no parameter properties, `enum` or `namespace`.
- `web/src/components/ui/` comes from the shadcn-vue registry (new-york-v4, icons from `@lucide/vue`). The shadcn-vue CLI can't read its config in this layout; fetch new components from `https://shadcn-vue.com/r/styles/new-york-v4/<name>.json` and change `from "cn"` to `@/lib/utils`.
- Keep game assets, the game's fonts and full game scenario JSON out of the repository; the sample scenario must be original writing. The Source Han Sans files in `fonts/` stay the unmodified upstream files (the SIL OFL requires renaming modified versions): don't convert or subset them.
- Public repository: no internal infrastructure in code, docs, commits or release notes (hostnames, node names, private IPs, server paths).

## Git commits

All commit subjects follow:

```text
[Type] Short description starting with capital letter
```

| Type | Usage |
|---|---|
| `[Feat]` | New feature or capability |
| `[Fix]` | Bug fix |
| `[Perf]` | Performance improvement |
| `[Chore]` | Maintenance, refactoring, dependency, build or CI changes |
| `[Docs]` | Documentation-only changes |

- Imperative mood, capitalized, no trailing period, about 70 characters at most.
- Agent attribution uses the standard `Co-authored-by:` trailer in the commit body, separated from the subject by a blank line (e.g. `Co-authored-by: Claude Opus 5.5 <noreply@anthropic.com>`, substituting the actual model).
- Commits are signed (the maintainers sign with GPG). When building a commit with plumbing such as `git commit-tree`, pass `-S`; it doesn't pick up `commit.gpgsign`.
- Work on a branch and merge into `main` through a PR. `main` has no branch protection, so check that **CI OK** is green before merging.
- Version bumps (`version` in `package.json`): **patch** for `[Fix]`, **minor** for `[Feat]`, **major** for breaking changes. `[Chore]` / `[Docs]` normally don't bump; one bump per batch is enough.

## GitHub Actions workflows

Workflows reuse the shared workflows in [seiunx-dev/ci-templates](https://github.com/seiunx-dev/ci-templates) (`@v1`); the files in `.github/workflows` are thin callers. Reuse the templates first; add a custom job only when a template genuinely cannot do it, with a comment saying why, and fix template gaps upstream.

- `ci.yml` (`CI`): main pushes, PRs to main, manual dispatch. `Web` (`node-ci.yml`: `npm ci --ignore-scripts`, typecheck, build), `Workflow lint` (`actionlint.yml`), and `CI OK`, the aggregate job and the only check to require.
- `Sonar` in `ci.yml` uses `sonar.yml` after `Web`, with the organization `SONAR_TOKEN` secret. Scan upload is included in `CI OK`; the quality gate is reported separately. Automatic analysis in SonarQube Cloud is disabled. No coverage artifacts are produced yet, and template-pin rule suppression is disabled.
- `release.yml` (`Release`): `v*` tags (dry run on manual dispatch). `release-gate.yml` checks the tag against `package.json` and waits for `CI OK`; a custom `Pack` job runs `npm pack` (the templates have no npm pack job); `gh-release.yml` publishes the tarball with the notes in `docs/releases/<tag>.md`. Flow: bump `version` in a PR → merge → tag `v<version>` on main.
- `pages.yml` (`Pages`): `pages.yml` template; builds `dist/site` on every run, deploys to GitHub Pages on pushes to main. The template sets up bun only; the npm build uses the runner image's Node.
- Dependabot (`.github/dependabot.yml`): weekly npm and GitHub Actions updates with the `[Chore] ` prefix. PixiJS stays on v7 (the Live2D plugin targets it).
- Keep `permissions` minimal; pin third-party actions in custom steps to a full SHA.

## Release notes

Release notes follow the org standard in [seiunx-dev/ci-templates/RELEASE_NOTES.md](https://github.com/seiunx-dev/ci-templates/blob/main/RELEASE_NOTES.md) and are written in English.

- Title every release with the tag only, for example `v0.1.0`.
- Publish tags with an `-alpha`, `-beta` or `-rc` suffix as pre-releases and every other tag as a regular release; every tag gets a release.
- Omit empty sections, and end every item with its PR number `(#123)`, or the short commit SHA when there is no PR.
- No workflow publishes releases here; if a release is created with GitHub's auto-generated notes, rewrite them to the standard right after it is published.
