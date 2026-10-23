# PJSK Scenario Player

A browser replica of the story player in *Project SEKAI COLORFUL STAGE! feat. Hatsune Miku*. Give it a scenario JSON (the game's `ScenarioSceneData`) and it plays it the way the game does: Live2D characters, dialogue, voice, BGM, and the screen effects, all on the game's timeline rules.

[中文](README.zh-CN.md)

- **Close to the game.** The timeline, positioning, lip-sync and fades come from reverse-engineering the game binary, checked against in-game captures.
- **Embeddable.** A framework-free TypeScript library you can drop into any front end.
- **No assets included.** Neither the repository nor the preview site ships game assets; they come from your own server.

## Quick start

Requires Node.js 22.18 or later.

```bash
git clone https://github.com/Team-Haruki/sekai-scenario-player.git
cd sekai-scenario-player
npm install
npm run dev            # preview site at http://localhost:5173
```

Without an asset source the preview plays the bundled sample (text and transitions only). To play real episodes, set up assets.

## Assets

The player reads everything from one **asset base URL** with a fixed layout ([docs/assets.md](docs/assets.md)). If you have an asset-updater export tree, the bundled server serves it as is:

```bash
node server/cli.ts --root /path/to/jp-assets --master /path/to/master
# → http://localhost:5174/ (with CORS)
```

Enter `http://localhost:5174/` in the preview site's asset settings. In development you can also run `SEKAI_ASSET_ROOT=… SEKAI_MASTER_DIR=… npm run dev`, or put already-arranged files in the git-ignored `assets/` folder, which the dev server mounts at `/assets/`.

## Use it as a library

It isn't published to npm; install from GitHub:

```bash
npm i github:Team-Haruki/sekai-scenario-player pixi.js@^7.4
```

```ts
import { createPlayer } from "pjsk-scenario-player";

const player = createPlayer("#stage", { assets: "http://localhost:5174/" });
player.on("progress", ({ index, total }) => console.log(index, "/", total));
await player.load("event_107_01");
```

Options, methods, events and custom asset resolvers: [docs/api.md](docs/api.md).

## Preview site

`web/` is the preview site, built with Vue 3 and shadcn-vue. It is also the reference integration. It has:

- a story browser (main, event, card, special and area stories), with unit filters and search;
- a searchable transcript that jumps on click;
- opening a local JSON by file picker or drag and drop;
- asset source settings;
- dark mode and a mobile layout.

`npm run build:web` outputs a static site to `dist/site/`. The included GitHub Pages workflow deploys it. The deployed site holds only the player and the sample; visitors connect their own asset server, and links can carry it with `?assets=<url>&scenario=<id>`. `?src=<url>` plays a scenario JSON from a URL, `?view=player` shows the player alone, filling the window, with no story list or transcript (for links and embeds), and `?preload` downloads every file of an episode before it plays.

## Status

The actions and effects used by main, event and card stories are implemented. Still missing:

- branching choices (Selectable) and name input;
- music video playback;
- some sound modes;
- character depth order.

See [docs/internals.md](docs/internals.md). If playback differs from the game, please open an issue with the scenario ID and the line.

## Commands

| Command | What it does |
|---|---|
| `npm run dev` | Preview site dev server |
| `npm run typecheck` | Type-check the library, the server and the preview site |
| `npm run build` | Build the library (`dist/lib`) and the preview site (`dist/site`) |
| `npm run serve:assets -- --root …` | Start the standalone asset server |

## Contributing

See [CONTRIBUTING.md](CONTRIBUTING.md).

## License and disclaimer

The code is released under the [MIT license](LICENSE).

This is an unofficial fan project, not affiliated with SEGA, Colorful Palette or Crypton Future Media. All game content — characters, stories, models, music, images and fonts — belongs to its respective owners. This repository neither contains nor distributes any of it; please don't commit or publish game assets here.

The talk window uses Adobe's [Source Han Sans](https://github.com/adobe-fonts/source-han-sans) (SIL Open Font License 1.1, in `fonts/`) in place of the commercial font the game uses.

Live2D rendering uses [pixi-live2d-display-mulmotion](https://github.com/Sekai-World/pixi-live2d-display) (MIT) and Live2D Cubism Core. Cubism Core is provided by Live2D Inc. under its [proprietary software license](https://www.live2d.com/eula/live2d-proprietary-software-license-agreement_en.html) and is not included in this repository.
