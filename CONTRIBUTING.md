# Contributing

Issues and pull requests are welcome. This page covers what to know before you start. The repository follows the shared Team-Haruki conventions for commits, CI and releases, summarized below.

## Setup

```bash
npm install
npm run dev          # preview site + the /assets/ mount
npm run typecheck    # run before every commit
npm run build
```

You need Node.js 22.18 or later. See [docs/assets.md](docs/assets.md) for setting up assets.

## Code layout

- `src/`: the library, with no framework dependency. The public API is exported from `src/index.ts` only.
- `server/`: the asset server, using only Node built-ins. Node runs it directly, so imports carry the `.ts` extension and the code avoids TypeScript syntax that needs compiling (parameter properties, `enum`, `namespace`).
- `web/`: the preview site (Vue 3 + shadcn-vue + Tailwind v4). `web/src/components/ui/` holds components pulled from the shadcn-vue registry; avoid editing them by hand.

See [docs/internals.md](docs/internals.md) for the timeline model and implementation notes.

## Changing playback behaviour

- The goal is to match the game. Say in the PR what the change is based on: the reverse-engineered function, the prefab field, or an in-game capture you compared against.
- Keep the timeline's parallel model: snippets are started without awaiting; the rhythm comes from each action's `FinishSnippet` timing and the `WaitFinished` barrier.
- Every wait and tween goes through `Clock` (`sleep` / `tween` / `playClip`); don't use `requestAnimationFrame`.
- Game enum names follow the binary's spelling, typos included (`LayoutType.Apper`). Don't "fix" them.

## What not to commit

- Game assets of any kind: models, motions, voices, BGM, backgrounds, UI sprites, the game's fonts, or full game scenario JSON. The only scenario in the repository is the original sample in `web/public/samples/`.
- Screenshots and recordings belong in issue or PR comments, not in the repository.
- Generated output: `dist/`, coverage, test results.
- The Source Han Sans files in `fonts/` stay the unmodified upstream files (the SIL OFL requires renaming modified versions), so don't convert or subset them.

## Commits

Commit subjects follow `[Type] Short description`:

| Type | Use for |
|---|---|
| `[Feat]` | a new feature or capability |
| `[Fix]` | a bug fix |
| `[Perf]` | a performance improvement |
| `[Chore]` | maintenance, refactoring, dependencies, build and CI |
| `[Docs]` | documentation-only changes |

- Imperative mood, starting with a capital letter, no trailing period, about 70 characters at most: `[Fix] Keep facials held after a jump`.
- When an agent writes the commit, add a `Co-authored-by:` trailer naming it, separated from the subject by a blank line.
- Work on a branch and merge into `main` through a pull request once **CI OK** is green.

## CI

`.github/workflows/` holds thin callers of the shared workflows in [seiunx-dev/ci-templates](https://github.com/seiunx-dev/ci-templates) (`@v1`):

- `ci.yml`: install, typecheck and build through `node-ci.yml`, workflow lint through `actionlint.yml`, and the **CI OK** aggregate job, the only check to require.
- `pages.yml`: builds the preview site on every run and deploys it to GitHub Pages from `main`.

SonarQube Cloud analysis runs through `sonar.yml` in CI after the web checks, using
the organization's `SONAR_TOKEN` secret and `sonar-project.properties`. Disable
SonarQube Cloud automatic analysis to avoid duplicate/conflicting scans. Fork and
Dependabot PRs skip the scan because they cannot access the secret. The repository
does not yet produce coverage reports. The scan upload participates in **CI OK**;
SonarQube Cloud reports the quality gate separately without suppressing findings.

Reuse a template first. Add a custom job or step only when no template can do it, keep it in the caller and comment why; template bugs and gaps are fixed upstream in ci-templates. Dependabot opens weekly `[Chore]` PRs for npm and GitHub Actions.

## Versions and releases

- `version` in `package.json` follows semver: **patch** for `[Fix]`, **minor** for `[Feat]`, **major** for breaking changes. `[Chore]` and `[Docs]` normally don't bump it; one bump per batch of commits is enough.
- Tag releases `v<version>`. Release notes follow the org standard, [RELEASE_NOTES.md](https://github.com/seiunx-dev/ci-templates/blob/main/RELEASE_NOTES.md): English, the tag as the title, `-alpha` / `-beta` / `-rc` tags as pre-releases, a PR number or short SHA after every item, and no internal infrastructure details.
