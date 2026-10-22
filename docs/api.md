# Library API

The player is a framework-free TypeScript library: give it a container element and an asset base URL, then hand it scenarios. It mounts a canvas, the talk window, effect layers, the story menu and a start button into the container, and scales them to the container's width (the stage is always 1280×720 inside).

## Install

It isn't published to npm. Install it from GitHub; `dist/lib` is built on install:

```bash
npm i github:Team-Haruki/sekai-scenario-player pixi.js@^7.4
```

Each release also attaches a built tarball, for package managers that don't run a git dependency's build (Bun, for one):

```bash
npm i https://github.com/Team-Haruki/sekai-scenario-player/releases/download/v0.3.1/pjsk-scenario-player-0.3.1.tgz
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

For Chinese or Korean text, call `setTextScript("zh" | "ko")`. The talk window then uses `--pjsk-font-zh-name` / `--pjsk-font-zh-body` (or the `-ko-` pair), which default to the system CJK faces. To use your own, register them (for example `FontFace` slices with `unicodeRange`) and put them first:

```css
.pjsk-player { --pjsk-font-zh-name: "MyHanSans", "PingFang SC", sans-serif; --pjsk-font-zh-body: "MyHanSans", "PingFang SC", sans-serif; }
```

### Autoplay and voices

Voices and SEs are fetched a few lines ahead, decoded and played through Web Audio, so a voice starts with its line and lip-sync follows its waveform. iOS Safari allows sound only from an `<audio>` element or audio context started inside a user gesture, so once a scenario is loaded every tap or key press anywhere (the start button's included) starts the context and primes the BGM players; auto mode then needs no further taps.

Browsers may also let `<audio>` play before the first gesture while keeping Web Audio suspended. Until the context runs, the player plays voices from an `<audio>` element and mouths follow a synthetic level instead of the waveform.

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
| `labels` | `{ start?, loading?, models?, files?, menu? }` | — | Override individual strings (`models` and `files` prefix the loading counts) |
| `menu` | `boolean \| MenuItem[]` | `DEFAULT_MENU` | The ⋯ story menu: `false` hides it, a list picks its buttons. `DEFAULT_MENU` is fullscreen, auto, mute, fast, hide, log; `GAME_MENU` is the game's own panel (bookmark, consecutive and skip only look like the game) |
| `muted` | `boolean` | `false` | Start muted |
| `voice` | `boolean` | `true` | Play the voices |
| `textScript` | `"ja" \| "latin" \| "zh" \| "ko"` | `"ja"` | Script of the text being shown, for its fonts (see `setTextScript`) |
| `fonts` | `false \| { name?, body? }` | Source Han Sans Bold / Medium from `<assets>/fonts/` | Talk window font URLs: `name` for the name plate, `body` for lines. `false` registers none and uses system fonts |
| `cubismCoreUrl` | `string` | Live2D's CDN | Where to load Cubism Core from if the page hasn't |
| `resolution` | `number` | `min(devicePixelRatio, 2)` | Canvas resolution |

### Methods

| Method | Description |
|---|---|
| `load(scenario, { autoplay?, context?, files? })` | Load a scenario in place of the current one: a `ScenarioSceneData` object, a ScenarioId (fetched through `assets.scenario()`), or a URL (starting with `http(s):`, `/`, `.` or `blob:`). `context` reaches every per-episode resolver call as `ctx.data`. `files` are this scenario's files the host already has (see [Handing files in](#handing-files-in)), dropped at the next load. Resolves once playback starts or the start button shows |
| `play()` | Start the loaded scenario. Call it from a user gesture when the browser blocked autoplay |
| `jumpTo(index)` | Restart at snippet `index`, with the stage rebuilt as it was at that point |
| `advance()` | Same as tapping the stage: finish typing, or advance a line waiting for input |
| `setAuto(on)` / `setFast(on)` / `setUiHidden(on)` | Auto / fast-forward / hide the UI |
| `setLogActive(on)` | Light up the menu's Log button (the host owns the log it opens) |
| `setMuted(on)` | Silence BGM, SE and voices; lip-sync keeps following the voice |
| `setVoice(on)` | Play the voices or not; without them lines advance on the no-voice timing. Takes effect from the next line |
| `setFullscreen(on)` / `toggleFullscreen()` | Fullscreen on the player, locked to landscape where the browser allows. Where pages can't go fullscreen (iPhone Safari) the player covers the viewport instead, turned sideways while the phone is held upright; Escape leaves it |
| `setTextScript(script)` | The script of the text being shown. `"zh"` / `"ko"` switch the talk window, telops and captions to the `--pjsk-font-zh-*` / `--pjsk-font-ko-*` families with bold names and medium lines |
| `setLabels({ start?, loading?, models?, files?, menu? })` | Change the start overlay and menu text |
| `showLoading()` / `showMessage(text)` / `hideOverlay()` | Drive the overlay over the stage while the host prepares something itself, or to show its own error |
| `setProgress({ loaded, total, label?, bytes? } \| null)` | Drive the loading bar yourself (after `showLoading()`), e.g. while you download files to hand in. `bytes: true` shows the numbers in MB. `null`, or the next `load()`, gives the bar back to the player |
| `provideFiles(files)` / `clearFiles(urls?)` | Hand in files the host already has, or forget them (all when `urls` is omitted); see [Handing files in](#handing-files-in) |
| `stop()` | Stop and unload the current scenario |
| `destroy()` | Destroy the player and remove its DOM |
| `on(type, fn)` / `off(type, fn)` | Subscribe to events; `on` returns an unsubscribe function |

Read-only properties: `scenario`, `auto`, `fast`, `uiHidden`, `muted`, `voice`, `fullscreen`, `assets` (the resolver), `root` (the player's root element).

### Events

| Event | Payload | When |
|---|---|---|
| `load` | `{ scenario }` | The scenario was fetched and its stage built (models may still be loading) |
| `loading` | `{ loaded, total, required, requiredLoaded, failed, files }` | Loading moved on: a costume finished loading, failed or timed out, or files arrived (at most once a frame). Playback waits only for the `required` costumes; `failed` lists costumes that won't show. `files` is `{ started, done, bytes, provided }` for every file this load asked for: the scenario, models, motions, textures, the first voice. `started` grows as loading finds more files, and `provided` counts the ones handed in |
| `play` | `{ scenario }` | The first costumes are loaded; playback starts |
| `progress` | `{ index, total }` | Snippet `index` started (also after a jump) |
| `end` | `{ scenario }` | Playback reached the end |
| `error` | `{ error }` | The scenario or the model manifest failed to load |
| `mode` | `{ auto, fast, uiHidden, muted, voice, fullscreen }` | A mode changed (from the menu, a tap or the API) |
| `log` | `{}` | The menu's Log button was pressed |

### Size

The root element, `.pjsk-player`, is `100%` wide with a 16:9 aspect ratio, so size the container:

```css
#stage { width: min(100%, 1280px); }
```

If you give `.pjsk-player` another height, the stage is centred and letterboxed.

## Loading

The player doesn't wait for every model before it starts.

- **What it waits for:** the costumes on stage before the third line of dialogue, and the first line's voice (5 s at most). Under the spinner the bar follows those costumes, and the text counts them, the files loaded of those asked for, and the MB so far.
- **The rest** load while the episode plays, three at a time.
- **Time limits and retries:** nothing waits forever.
  - JSON fetches (scenario, manifest, model3, motions, facials, physics) time out after 15 s, a model's moc and textures after 60 s; each is retried twice (network errors and 5xx).
  - A costume that fails to load is retried once.
  - A costume that takes longer than 30 s is given up on. It is still used if it arrives later.
  - An appearance waits at most 12 s for a costume that is still loading. Otherwise that appearance is skipped and the timeline carries on.

## Handing files in

A host that downloads a scenario's files itself (from an archive, its own cache, a service worker) can hand them to the player as `Blob`s, keyed by the URL the resolver gives for each. The player then reads them instead of making the request. Keys may be relative; they resolve against the page.

```ts
player.showLoading();
const files = new Map<string, Blob>();
for (const [i, url] of urls.entries()) {
  files.set(url, await (await fetch(url)).blob());
  player.setProgress({ label: "Downloading", loaded: i + 1, total: urls.length });
}
await player.load("event_145_07", { files }); // or player.provideFiles(files), kept until clearFiles()
```

- Every file a scenario loads is looked up: the scenario, the manifest, a model's model3 and the moc, textures and physics it names (by their URL relative to the model3), motions and facials, backgrounds, voices, SEs, BGM, movies and effects.
- Whatever isn't handed in is fetched as usual.
- Fonts and UI sprites are read when the player is created, before files can be handed in. Point `fonts` and the resolver's `ui()` at your copies (`blob:` URLs work).
- `load({ files })` holds the files until the next load. `provideFiles()` holds them until `clearFiles()` or `destroy()`.
- The registry is shared by the players on a page.

## Asset resolution

`createAssetResolver(base, overrides?)` returns the default resolver. Override only what differs, for example voices on another CDN:

```ts
import { createAssetResolver, createPlayer } from "pjsk-scenario-player";

const assets = createAssetResolver("https://cdn.example/pjsk/", {
  voice: (scenarioId, voiceId) => `https://voice.example/${scenarioId}/${voiceId}.mp3`,
});
createPlayer(el, { assets });
```

Members and what they return:

| Member | Returns |
|---|---|
| `scenario(id)`, `modelManifest()`, `fx(path)`, `ui(path)`, `font(file)` | a URL |
| `model(entry, ctx)` | the costume's `.model3` URL; textures and physics resolve relative to it |
| `physics?(entry, ctx)` | optional: a physics file to use instead of the model3's reference, or `null` to drop physics |
| `motion(entry, kind, name, ctx)` | a motion3 URL, or `null` when the costume has no such clip (it is skipped) |
| `bgm(id, ctx)`, `se(id, ctx)`, `voice(scenarioId, voiceId, ctx, info)`, `background(id, ctx)` | `AssetUrls`: one URL, or candidate URLs tried in order until one loads; `null` / `[]` skips the asset. `info.character2dId` is the speaker of a voice (absent for full-screen text), for trees that file voices by character |
| `movie(name, ctx)` | a URL, or `null` to skip the movie |

`ctx` is the episode being loaded, `{ scenario, data }`, where `data` is the `context` passed to `load()`. That lets a resolver depend on the episode, for example look in different folders for card stories:

```ts
const assets = createAssetResolver(base, {
  voice: (scenarioId, voiceId, ctx) => {
    const dirs = (ctx.data as { kind?: string })?.kind === "card" ? ["card_scenario", "scenario"] : ["scenario", "card_scenario"];
    return dirs.map((d) => `${base}${d}/voice/${scenarioId}/${voiceId}.mp3`);
  },
});
await player.load(scenarioId, { context: { kind: "card" } });
```

Manifest entries are passed to `model` / `motion` / `physics` as they are. The default resolver reads `modelDir`, `modelFile`, `motionDir` and `motionBase`; a host with its own rules can store whatever those rules need in the entries.

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
