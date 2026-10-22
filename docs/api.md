# Library API

The player is a framework-free TypeScript library: give it a container element and an asset base URL, then hand it scenarios. It mounts a canvas, the talk window, effect layers, the story menu and a start button into the container, and scales them to the container's width (the stage is always 1280×720 inside).

## Install

It isn't published to npm. Install it from GitHub; `dist/lib` is built on install:

```bash
npm i github:Team-Haruki/sekai-scenario-player pixi.js@^7.4
```

The installed package is named `pjsk-scenario-player`, which is what the imports below use. `pixi.js` v7 is a peer dependency, shared with your app. You can also clone the repository, run `npm run build:lib` and copy `dist/lib/` into your project.

## Minimal example

```ts
import { createPlayer } from "pjsk-scenario-player";

const player = createPlayer("#stage", { assets: "https://your-cdn.example/pjsk/" });
await player.load("event_107_01"); // ScenarioId → <assets>/scenario/event_107_01.json
```

```html
<div id="stage" style="width: 960px"></div>
```

There is no CSS to import: the styles are injected when the first player is created.

### Fonts and UI sprites

The talk window uses the Source Han Sans files from this repository's `fonts/`, loaded from `<assets>/fonts/`; the bundled asset server provides them. With a bundler you can reference the package's copies instead:

```ts
import bold from "pjsk-scenario-player/fonts/SourceHanSansJP-Bold.otf?url";
import medium from "pjsk-scenario-player/fonts/SourceHanSansJP-Medium.otf?url";

createPlayer(el, { assets, fonts: { name: bold, body: medium } });
```

Missing game UI sprites (`<assets>/ui/`) are replaced by built-in SVG stand-ins automatically.

### Live2D Cubism Core

Cubism Core is licensed under Live2D's proprietary license and can't be bundled. When the first model loads and the page has no `window.Live2DCubismCore` yet, the player loads it from Live2D's CDN (`DEFAULT_CUBISM_CORE_URL`). To host it yourself, pass `cubismCoreUrl` or include it with a `<script>` tag first. Read [Live2D's license terms](https://www.live2d.com/eula/live2d-proprietary-software-license-agreement_en.html) before shipping it.

## `createPlayer(container, options)` / `new PjskPlayer(container, options)`

| Option | Type | Default | Description |
|---|---|---|---|
| `assets` | `string \| AssetResolver` | — | Asset base URL (layout: [assets.md](assets.md)) or a full resolver |
| `models` | `ModelManifest \| () => Promise<ModelManifest>` | `<assets>/model_manifest.json` | CostumeType → model files |
| `autoplay` | `boolean \| "auto"` | `"auto"` | Start playing once loaded. `"auto"` does so when the browser allows sound without a click and shows the start button otherwise; `false` always shows the button |
| `auto` | `boolean` | `true` | Auto-advance lines (the menu's Auto) |
| `locale` | `"zh" \| "ja" \| "en"` | `"zh"` | Language of the start overlay and the menu (`ja` is the game's own text) |
| `labels` | `{ start?, loading?, menu? }` | — | Override individual strings |
| `menu` | `boolean` | `true` | Show the ⋯ story menu |
| `fonts` | `false \| { name?, body? }` | Source Han Sans Bold / Medium from `<assets>/fonts/` | Talk window font URLs: `name` for the name plate, `body` for lines. `false` registers none and uses system fonts |
| `cubismCoreUrl` | `string` | Live2D's CDN | Where to load Cubism Core from if the page hasn't |
| `resolution` | `number` | `min(devicePixelRatio, 2)` | Canvas resolution |

### Methods

| Method | Description |
|---|---|
| `load(scenario, { autoplay? })` | Load a scenario in place of the current one: a `ScenarioSceneData` object, a ScenarioId (fetched through `assets.scenario()`), or a URL (starting with `http(s):`, `/`, `.` or `blob:`). Resolves once playback starts or the start button shows |
| `play()` | Start the loaded scenario. Call it from a user gesture when the browser blocked autoplay |
| `jumpTo(index)` | Restart at snippet `index`, with the stage rebuilt as it was at that point |
| `advance()` | Same as tapping the stage: finish typing, or advance a line waiting for input |
| `setAuto(on)` / `setFast(on)` / `setUiHidden(on)` | Auto / fast-forward / hide the UI |
| `setLogActive(on)` | Light up the menu's Log button (the host owns the log it opens) |
| `stop()` | Stop and unload the current scenario |
| `destroy()` | Destroy the player and remove its DOM |
| `on(type, fn)` / `off(type, fn)` | Subscribe to events; `on` returns an unsubscribe function |

Read-only properties: `scenario`, `auto`, `fast`, `uiHidden`, `assets` (the resolver), `root` (the player's root element).

### Events

| Event | Payload | When |
|---|---|---|
| `load` | `{ scenario }` | The scenario was fetched and its stage built (models may still be loading) |
| `play` | `{ scenario }` | Models are loaded; playback starts |
| `progress` | `{ index, total }` | Snippet `index` started (also after a jump) |
| `end` | `{ scenario }` | Playback reached the end |
| `error` | `{ error }` | The scenario or the model manifest failed to load |
| `mode` | `{ auto, fast, uiHidden }` | A mode changed (from the menu or the API) |
| `log` | `{}` | The menu's Log button was pressed |

### Size

The root element, `.pjsk-player`, is `100%` wide with a 16:9 aspect ratio, so size the container:

```css
#stage { width: min(100%, 1280px); }
```

If you give `.pjsk-player` another height, the stage is centred and letterboxed.

## Asset resolution

`createAssetResolver(base, overrides?)` returns the default resolver. Override only what differs, for example voices on another CDN:

```ts
import { createAssetResolver, createPlayer } from "pjsk-scenario-player";

const assets = createAssetResolver("https://cdn.example/pjsk/", {
  voice: (scenarioId, voiceId) => `https://voice.example/${scenarioId}/${voiceId}.mp3`,
});
createPlayer(el, { assets });
```

Every `AssetResolver` member returns a URL string: `scenario(id)`, `modelManifest()`, `model(entry)`, `motion(entry, kind, name)`, `bgm(id)`, `se(id)`, `voice(scenarioId, voiceId)`, `background(id)`, `movie(name)`, `fx(path)`, `ui(path)`, `font(file)`.

## Transcript

`scriptLines(scenario)` returns the readable lines of a scenario (talk and telop captions) in timeline order, for a talk log or transcript:

```ts
import { scriptLines } from "pjsk-scenario-player";

for (const line of scriptLines(player.scenario!)) {
  // { index, kind: "talk" | "telop", name, body, character2dId?, voiceId? }
}
// clicking a line: player.jumpTo(line.index)
// the current line: the last one whose index is <= the progress event's index
```

## In a framework

The player only touches the container you give it, so in any framework you create it on mount and destroy it on unmount. In Vue:

```vue
<script setup lang="ts">
import { onBeforeUnmount, onMounted, ref } from "vue";
import { type PjskPlayer, createPlayer } from "pjsk-scenario-player";

const el = ref<HTMLElement>();
let player: PjskPlayer | undefined;
onMounted(() => {
  player = createPlayer(el.value!, { assets: "/assets/" });
  void player.load("event_107_01");
});
onBeforeUnmount(() => player?.destroy());
</script>

<template><div ref="el" /></template>
```

The preview site is the complete example: `web/src/App.vue`.

## Types

`ScenarioSceneData`, its related types and the enums (`Action`, `LayoutType`, `SpecialEffectType`, `SoundPlayMode` …) are exported from the package entry. Enum names follow the game binary's spelling, including `LayoutType.Apper`.
