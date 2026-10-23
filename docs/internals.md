# Internals

How the player reproduces the game's story playback, and what is still missing. The playback logic comes from reverse-engineering the game's il2cpp binary (`UnityFramework`), checked against in-game captures. Values serialized in prefabs (UI sizes, animation curves, colours) come from the game's resources.

## Modules

```
src/
├─ index.ts              public API
├─ PjskPlayer.ts         the embeddable player: PIXI app and DOM layers, loading, events, scaling
├─ style.css             styles of every DOM layer on the stage (1280×720 stage px, injected)
└─ scenario/
   ├─ types.ts           ScenarioSceneData types, game enums, side positions
   ├─ resolver.ts        asset URL rules (AssetResolver)
   ├─ files.ts           handed-in files and the load count
   ├─ hosts.ts           fallback hosts: which host a file loads from, failure rules, HEAD probes
   ├─ net.ts             fetches with timeouts and retries (through hosts.ts)
   ├─ preload.ts         preload: every file a scenario uses, downloaded into the HTTP cache
   ├─ live2d.ts          loads Cubism Core and the Live2D plugin on demand
   ├─ assets.ts          CharacterModel: Live2D loading, lip-sync, eye blink, breath, held facials
   ├─ stage.ts           background and character positions, appear / move / shake, camera
   ├─ camera.ts          camera / shake / wipes / blur / DOTween easings, hologram filter, ambient colours
   ├─ dialogue.ts        talk window (DOM: typewriter, continue mark, AUTO / SKIP sign)
   ├─ effects.ts         full-screen effect layers (colour fades, telop, side wipes, place, movie,
   │                     full-screen text, choices)
   ├─ particles.ts       particle runtime (subset of Unity Shuriken + UI Image / Animator)
   ├─ audio.ts           BGM crossfades, SE and voice clips fetched ahead (Web Audio; the analyser drives lip-sync), gesture unlock
   ├─ player.ts          ★ timeline engine and action handlers, jumps, fast-forward
   ├─ clock.ts           per-player clock every wait and tween goes through
   ├─ menu.ts            the ⋯ story menu (ScenarioMenu)
   ├─ labels.ts          UI strings (zh / ja / en)
   ├─ sprites.ts         game UI sprite loading with built-in SVG stand-ins
   └─ script.ts          scriptLines(): the transcript
server/                  asset server (Vite plugin + standalone CORS server)
web/                     preview site (Vue 3 + shadcn-vue)
fonts/                   Source Han Sans JP Bold / Medium (SIL OFL)
tools/fx_convert.py      converts AssetRipper-exported effect / background prefabs to effect.json
```

## Timeline engine (player.ts)

The game runs all snippets **in parallel**, not one awaited after another. Restored from the coroutines of `Sekai.ScenarioPlayer`:

- An **in-flight set**, `executeSnippets`. For each snippet `PlayCore`:
  1. passes the **consumer-side barrier** `WaitOtherFinished`: with `ProgressBehavior == Now` it goes out the frame after the snippet before it; with `== WaitFinished` it waits frame by frame until the in-flight set is empty;
  2. adds the snippet to the set;
  3. starts it with `Execute(handler)` in parallel, **without awaiting**;
  4. increments sequenceId.

  There is a ~10-frame pause at the start, and `WaitAllFinished` drains the set at the end.
- Each action consumes its own `Delay` when it starts (`WaitDelaySnippet`, accumulating deltaTime), counted from dispatch; with no delay the action still starts a frame after dispatch. **A delay never blocks the barrier.**
- **When each action calls `FinishSnippet` (leaves the set) sets the whole rhythm:**

| Action | FinishSnippet |
|---|---|
| Sound | at once (SE / BGM play on asynchronously and never hold anything up) |
| Talk | when the talk window closes (auto-advance or tap) |
| CharacterMotion | at once (the motion plays asynchronously) |
| CharacterLayout | after the appear / move / hide / shake animation |
| SpecialEffect | per type, see `handleSpecialEffect` |

Keep this model when changing handlers. Every wait and tween must go through `clock.ts` (`sleep` / `tween` / `playClip`); otherwise fast-forward doesn't speed it up and old coroutines keep changing the stage after a jump. Before changing the stage across an `await`, check `clock.epoch` (stage) or `gen` (player).

**Jump** (`jumpTo`): bump the clock epoch so old coroutines are dropped, replay the state of snippets `[0, target)` to rebuild the stage (background, BGM, layout mode, fades, who stands where, motions / facials, effects), then continue from the target.

**Fast-forward** (早送り): text appears at once, no voice, each line holds 0.5 s, and every other wait, fade and move runs at `FAST_SCALE`.

## Implemented

- **Talk (1)**: 0.06 s per character; typing waits out the 0.2 s window fade-in whenever the window opens (the first line, and the line after a `WhenFinishCloseWindow` one).
  - Auto (`ShowWords_d__95`): without a voice, 2.0 s after typing. With one: if it already ended when typing ends, 2.0 s; otherwise wait for it to end (30 s at most), then 0.5 s more.
  - Auto, voiced lines only (`ScenarioPlayer.CheckAutoModeTalkNext`): the page also waits until no `CharacterLayout` snippet is in flight and every shown character's body motion has ended, then 0.5 s more. A short line over a 2.6 s motion holds about 3.1 s; a `ChangeMotion` that starts late in the line holds it past the voice.
  - Manual: the first tap finishes typing, the second advances and cuts the voice.
  - Closing the window flushes pending ChangeMotions and stops the voice.
  - Timed motions: with `MotionChangeFrom == PlayTime`, they fire at `TimingSyncValue` seconds.
- **CharacterLayout (2)**:
  - `Apper`: 0.1 s fade-in, and the snippet finishes with the fade, ~0.134 s after dispatch in a game trace; a slide to `SideTo` runs on without gating. An empty `CostumeType` reuses the current model; all costumes are preloaded, and each is drawn once off-screen as it loads so its first fade doesn't wait on texture upload and shader compiles.
  - `Hide`: 0.1 s fade-out after 0.075 s (`timeMultiplierInSkipMode`, 0.5, × 0.15 s), from `SideFrom` when set; sliding out to `SideTo`, the fade starts 0.5 × move − 0.1 s in. The model is kept.
  - A model fades as one image: the game draws it to a render texture and fades the `RawImage` (`Live2DModelView.FadeOpacity`, linear), so the stage puts the opacity on an `AlphaFilter`, not on the model's own alpha (that fades each part separately and overlaps show through).
  - `Move`: 0.5 s (normal) / 0.33 s (fast) / 0.75 s (slow).
  - `ShakeX/Y`; slide-in when `SideFrom ≠ SideTo`.
- **CharacterMotion (4)**: switches motion / facial from `LayoutData`, at once and without blocking. A new body motion always takes over the one playing (`ChangeMotion` → `ChangeMotionCore`); the same motion restarts with a 0.125 s blend, others blend over 0.5 s.
- **SpecialEffect (6)**:
  - black / white fades, SEKAI transitions (including the 3rd anniversary version);
  - telop, place info, full-screen text, two-way choice;
  - background change (including the animated parts of prefab backgrounds);
  - screen and window shake; flashback / sepia tones, ambient colour, camera blur, background blur;
  - camera move / zoom, dolly zoom, side wipes in all eight directions;
  - character shaders (hologram / monitor / blur), particle effect play / stop, movies.
- **Sound (7)**:
  - `CrossFade` / `Stack`: BGM crossfades over Duration; SE plays after a Duration delay.
  - `SpecialSePlay`: plays an SE at the snippet's Volume.
  - `BgmVolume`.
- **CharacterLayoutMode (8)**: switches between the two- and three-character layouts, re-placing and re-scaling characters.
- **Positions**: anchored X on the 1920-wide reference canvas: ±360 in the two-character layout, ±576 in the three-character one, ±1779 for the off-screen slots; scales 1.0 / 0.9. From `ScenarioCharacterLayoutMap.Initialize`.
- **Live2D details** (from `Live2DVoice` / `Live2DEyeBlinkController` / `Live2DModel.LateUpdate`):
  - Lip-sync: `rms·pow(rms+1, 1.75)`, 0 below 0.06, otherwise clamped to [0.2, 1], smoothed per frame and **set** on `ParamMouthOpenY`. Every character owns the parameter; non-speakers are driven to 0.
  - Eye blink: the `|sin|` curve at 10 rad/s.
  - Breath: only `ParamBreath`, with a 3.0 s cycle.
  - Held facials: see [Live2D runtime](#live2d-runtime).

## Not implemented yet

- `Selectable (5)` branching choices and `InputName (3)` name input.
- SpecialEffect `MusicVideo` (the 3D live scene); `ChangeCardStill` / `ChangeBackgroundStill` (no-ops in 6.8.1).
- Sound modes 5 / 6 (`BgmAisacVolume` / `BgmAisacIndex`, currently no-ops). Mode 3 `Stop` stops an SE in the game; SE instances aren't tracked here, so it does nothing.
- `DepthType` / `Layer` depth order.
- Speakers without a Live2D model (クラスメイト and so on) show no portrait.
- Some constants (shake strength, blink interval, breath strength …) are serialized in prefabs rather than the binary and use reasonable approximations.

## Live2D runtime

Live2D is rendered by `pixi-live2d-display-mulmotion` (maintained by Sekai-World and also used by sekai-viewer). It bundles a fork of the official Cubism Web Framework R7 and adds parallel motion managers, "jump to the last frame" and an external audio analyser. The closed-source Cubism Core is loaded by the page separately; that layer can't be replaced.

The patches in `assets.ts` cover where this stack differs from the game:

- **Held facials**: PJSK's facial and body motion files are marked `Meta.Loop: true`, but the official Web Framework's `CubismMotion.create()` deliberately ignores the flag (the line is commented out), so a motion plays once and ends. That is the official framework's behaviour; using the official SDK would not change it. For now the facial's parameters are parsed and re-applied every frame; the cleaner fix is calling `setIsLoop(true)` on the loaded `CubismMotion`.
- **Eye blink**: the library only blinks through the model3 `EyeBlink` group, which is empty in PJSK models, so the game's `|sin|` curve is driven here.
- **Breath**: the library's default breath sways the head and body; it is cleared and only `ParamBreath` is driven.
- **Lip-sync**: the library's mouth curve isn't the game's; the `Live2DVoice` curve is computed and set directly.
- **Motion priority**: the library's `MotionState` turns a `NORMAL` motion away while another is playing, and a motion that is already current away at any priority. The game interrupts and restarts, so motions start at `FORCE` and a current one is released first.

## Pitfalls

- Import from the `@sekai-world/pixi-live2d-display-mulmotion/cubism4` entry. The package root requires the Cubism 2 runtime, and the `cubism4` entry requires `window.Live2DCubismCore` at import time, so `live2d.ts` loads Core first and then imports the plugin dynamically.
- Drive tweens and waits with `setTimeout`, not `requestAnimationFrame`: under headless Chrome's `--virtual-time-budget` rAF doesn't advance and an `await` hangs forever.
- Load backgrounds with `PIXI.Texture.fromURL` behind a timeout; don't block the timeline on `await PIXI.Assets.load`. `PIXI.Texture.from(url)` starts the load itself and its rejection is never handled, so a missing image becomes an unhandled error.
- A costume's files load side by side: the Live2D runtime, the motion and facial clips and the physics are fetched while the model3, moc and textures load (`fetchAhead` in `live2d.ts` hands them to the library's loader).
- On iOS every `<audio>` element and the audio context must first be started inside a user gesture; a later `play()` outside one is refused. Keep long-lived elements and prime them in a tap rather than creating one per clip.
- Pass `{ autoHitTest: false, autoFocus: false }` to `Live2DModel.from`.
- Headless Chrome screenshots for checking a change:

  ```bash
  chrome --headless=new --use-angle=swiftshader --enable-unsafe-swiftshader \
    --autoplay-policy=no-user-gesture-required --virtual-time-budget=15000 --screenshot <url>
  ```

  Headless Chrome has no audio output, so the voice analyser reads 0; check lip-sync and blinking in a real browser.

## Reverse-engineering sources (main functions)

- `Sekai.ScenarioPlayer`: PlayCore / WaitOtherFinished / WaitDelaySnippet / FinishSnippet / the SnippetAction coroutines.
- Positions: `ScenarioCharacterLayoutMap.Initialize`, `ScenarioModelView.MoveToSideHorizontal` / `UpdateCurrentScale`.
- Effects: `SnippetActionSpecialEffect`.
- Live2D: `Sekai.Live2D.Live2DVoice` (LipSync / UpdateParam), `Live2DEyeBlinkController.PlayAutoMode`, `Live2DModel.LateUpdate` + `SetBreathCycle`.
- Talk window: `TalkWindow.SetWordsInfo` + `ShowWords`, `SetTalkCharacterLipSyncMode`, `TalkMotionChangeSyncVoiceTime`.
