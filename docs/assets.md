# Asset layout

The player ships no game assets. It reads everything from one **asset base URL** (the `assets` option), at the relative paths below. You can:

- arrange your files in this layout and serve them from any static host or CDN (with CORS, see the end of this page);
- run the bundled asset server, `server/cli.ts`, which serves an asset-updater export tree as is;
- or pass your own rules to `createAssetResolver(base, overrides)` to map onto a different URL scheme (see [api.md](api.md#asset-resolution)).

## Layout

```
<assets>/
├─ model_manifest.json                       CostumeType → model files (format below)
├─ scenario/<ScenarioId>.json                scenario (ScenarioSceneData), used by player.load("<ScenarioId>")
├─ models/<…>/<costume>/<file>.model3        model (path = manifest modelDir + modelFile;
│                                            textures and physics resolve relative to it)
├─ motions/<motionDir>/<motionBase>/
│   ├─ motion/<MotionName>.motion3.json      body motions
│   └─ facial/<FacialName>.motion3.json      facial expressions
├─ sound/
│   ├─ bgm/<Bgm>.mp3
│   ├─ se/<Se>.mp3
│   └─ voice/<ScenarioId>/<VoiceId>.mp3
├─ background/<id>.png
├─ movie/<name>.mp4                          SpecialEffect Movie
├─ fx/                                       particle / prefab effects (from tools/fx_convert.py, optional)
│   ├─ <effect>/effect.json + textures
│   └─ bg/index.json, bg/<background>/effect.json
├─ ui/                                       game UI sprites (optional, cosmetic only)
└─ fonts/SourceHanSansJP-{Bold,Medium}.otf   talk window fonts (optional; shipped in this repo's fonts/,
                                             served by the asset server)
```

Characters need `model_manifest.json`, the models and the motions. Anything else that is missing is skipped and playback continues.

### model_manifest.json

```json
{
  "10an_normal": {
    "modelDir": "models/v1/main/10_an/10an_normal",
    "modelFile": "10an_normal_3.0_t05.model3",
    "motionDir": "v1/main/10_an",
    "motionBase": "10an_motion_base"
  }
}
```

- Keys are the scenario's `CostumeType`.
- `modelDir` is relative to the asset base.
- Motions are looked up under `motionDir/motionBase`; all costumes of a character share one motion library.

The asset server generates this file by scanning the whole tree: each costume gets the `*_motion_base` whose name is its longest prefix (`v2_15nene_casual` → `v2_15nene_motion_base`). You can also skip the file and pass the manifest object through the `models` option.

### ui/

All of these are optional. The player probes each sprite once and replaces any that fail to load with a built-in SVG stand-in (menu, buttons, continue mark, wipe transitions), so the UI keeps working.

| File | Used for |
|---|---|
| `serif_note.png` | talk window "tap to continue" note |
| `menu/menu_circle.png` `menu/menu_dots.png` `menu/close.png` `menu/btn.png` | the ⋯ story menu |
| `menu/ic_{bookmark,auto,consecutive,skip,fast,hide,log}.png` | menu icons |
| `scenario/tex_transition_{left,top}.png` | side wipe transitions |
| `scenario/btn_round_h80_wh.png` | choice buttons |
| `scenario/holo.png` | noise texture of the hologram character filter |
| `chr_ts/map.json` + `chr_ts/chr_ts_*.png` | transcript icons in the preview site (`Character2dId → file`); the player itself doesn't use them |

These come from the game's `ScenarioAtlas` and related resources; extract them from your own game client.

### fonts/

The game sets the talk window in FOT-RodinNTLG Pro EB (names) and DB (lines), a commercial font that can't be redistributed. The player uses Source Han Sans JP Bold and Medium instead, shipped in this repository's `fonts/` under the SIL Open Font License 1.1 (`fonts/LICENSE.txt`).

- The asset server serves these two files when the staged folder has no `fonts/`.
- On your own CDN, copy them to `<assets>/fonts/` or point the `fonts` option at them (see [api.md](api.md)).
- To use another typeface, replace the files or set the `fonts` option.

The files are the Japanese subset (SubsetOTF JP); characters only used in Simplified Chinese fall back to the system font.

### fx/

Particle effects (`PlayScenarioEffect`, the SEKAI transitions, hologram particles) and the animated parts of prefab backgrounds are Unity prefabs and need converting first:

```bash
pip install -r tools/requirements.txt
FX_RAW_DIR=<raw scenario/effect bundles> python3 -I tools/fx_convert.py <AssetRipper Assets export> <assets>/fx
```

See the header of `tools/fx_convert.py` for details. Without `fx/` these effects don't show; everything else plays.

## The asset server

If you have a jp asset tree exported by asset-updater or a similar tool (with `startapp/` and `ondemand/` at its root), you don't need to rearrange anything:

```bash
node server/cli.ts --root /path/to/jp-assets --master /path/to/master --port 5174
```

- `--root`: the asset tree. Scenarios, models, motions, voices, BGM, SE, backgrounds and movies are found at the game's own paths. Motion names match case-insensitively, falling back to the costume's own `motions/` folder.
- `--master`: the master data JSON folder, used to build `catalog.json` (the preview site's story browser). Optional.
- `--staged`: a folder already in the layout above. Its files win; `fx/` and `ui/` only come from there, and `fonts/` falls back to the bundled Source Han Sans.
- It listens on `127.0.0.1` and answers with `Access-Control-Allow-Origin: *`, so a hosted copy of the preview site can use `http://localhost:5174/` directly.

It needs Node.js 22.18 or later (it runs the TypeScript sources directly).

In development, `npm run dev` mounts the same handler at `/assets/`. The git-ignored `assets/` folder at the repository root is its staged folder; set `SEKAI_ASSET_ROOT` / `SEKAI_MASTER_DIR` to add a whole asset tree.

## CORS

When assets are served from another origin than the page, the server must send `Access-Control-Allow-Origin`:

- model textures are uploaded as WebGL textures;
- BGM plays from `<audio crossorigin="anonymous">` elements;
- voices and SEs are fetched and decoded for Web Audio (lip-sync reads the voice's waveform);
- fonts require CORS by the CSS specification.

Without it, models, BGM, voices, SEs and fonts fail to load.

## Copyright

These assets belong to SEGA, Colorful Palette, Crypton Future Media and other rights holders. Don't commit them to this repository or publish them; `.gitignore` already excludes `/assets/`.
