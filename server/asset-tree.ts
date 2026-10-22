// Serve a local asset-updater export tree (+ an optional staged folder) in the
// layout the player expects (docs/assets.md). Used by the Vite dev server
// (server/vite-plugin.ts) and the standalone CORS server (server/cli.ts).
//
// Paths are relative to wherever the handler is mounted:
//   catalog.json                     story browser data built from master
//   scenario/<id>.json               scenario located via the catalog index
//   model_manifest.json              staged manifest + every costume in the tree
//   models/<dir>/...                 startapp/live2d/model/<dir>/... (.physics3.json → .physics3)
//   motions/...                      startapp/live2d/motion/... (case-insensitive,
//                                    then the costume's own motions/ folders)
//   sound/voice/<scenario>/<v>.mp3   per-scenario voice folders
//   sound/{bgm,se}/<id>.mp3          scenario BGM / SE
//   background/<id>.png              scenario backgrounds
//   movie/<name>.mp4                 scenario movie, with Range support
//   images/<path>.png                images for the story browser (logos, thumbnails)
// Anything in the staged folder wins (fx/ and ui/ only come from there);
// fonts/ falls back to the Source Han Sans files shipped in this repo.

import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import type { IncomingMessage, ServerResponse } from "node:http";

const TYPES: Record<string, string> = {
  ".json": "application/json; charset=utf-8",
  ".model3": "application/json; charset=utf-8",
  ".physics3": "application/json; charset=utf-8",
  ".png": "image/png",
  ".jpg": "image/jpeg",
  ".webp": "image/webp",
  ".mp3": "audio/mpeg",
  ".mp4": "video/mp4",
  ".otf": "font/otf",
  ".ttf": "font/ttf",
  ".woff2": "font/woff2",
};

type Json = any; // master data rows

const EMPTY_PHYSICS = JSON.stringify({
  Version: 3,
  Meta: { PhysicsSettingCount: 0, TotalInputCount: 0, TotalOutputCount: 0, VertexCount: 0,
    EffectiveForces: { Gravity: { X: 0, Y: -1 }, Wind: { X: 0, Y: 0 } }, PhysicsDictionary: [] },
  PhysicsSettings: [],
});

export interface AssetTreeOptions {
  /** asset-updater export root (holds startapp/ and ondemand/). */
  root?: string;
  /** master data JSON directory (for catalog.json). */
  master?: string;
  /** folder already in the player's layout; its files take precedence. */
  staged?: string;
}

// the repo's fonts/ (Source Han Sans), served as <mount>/fonts/* when not staged
const BUNDLED_FONTS = fileURLToPath(new URL("../fonts", import.meta.url));

export type Handler = (req: IncomingMessage, res: ServerResponse, next: () => void) => void;

export function assetHandler(o: AssetTreeOptions): Handler {
  const tree = o.root ? new LiveTree(o.root, o.master) : undefined;
  const staged = o.staged ? path.resolve(o.staged) : undefined;
  return (req, res, next) => {
    const url = new URL(req.url || "/", "http://x");
    const rel = decodeURIComponent(url.pathname).replace(/^\/+/, "");
    const stagedFile = staged && safeJoin(staged, rel);
    if (rel !== "model_manifest.json" && stagedFile && isFile(stagedFile)) return sendFile(req, res, stagedFile);
    const font = rel.startsWith("fonts/") && safeJoin(BUNDLED_FONTS, rel.slice("fonts/".length));
    if (font && isFile(font)) return sendFile(req, res, font);
    if (!tree) {
      if (rel === "model_manifest.json" && stagedFile && isFile(stagedFile)) return sendFile(req, res, stagedFile);
      return next();
    }
    let file: string | null | undefined;
    try {
      if (rel === "catalog.json") return send(res, ".json", tree.getCatalog().json);
      if (rel === "model_manifest.json") return send(res, ".json", JSON.stringify(tree.getManifest(stagedFile || "")));
      file = tree.resolve(rel);
    } catch (e) {
      res.statusCode = 500;
      return res.end(String(e));
    }
    if (file === undefined) return next();
    // some model versions ship without physics: serve an empty rig
    if (!file && /^models\/.+\.physics3\.json$/.test(rel)) return send(res, ".json", EMPTY_PHYSICS);
    if (!file) {
      res.statusCode = 404;
      return res.end();
    }
    sendFile(req, res, file);
  };
}

function safeJoin(base: string, rel: string) {
  const p = path.resolve(base, rel);
  return p.startsWith(base + path.sep) ? p : null; // no traversal
}
function isFile(p: string) {
  return fs.existsSync(p) && fs.statSync(p).isFile();
}

function sendFile(req: IncomingMessage, res: ServerResponse, file: string) {
  res.setHeader("Content-Type", TYPES[path.extname(file)] ?? "application/octet-stream");
  res.setHeader("Cache-Control", "max-age=3600");
  res.setHeader("Accept-Ranges", "bytes");
  const size = fs.statSync(file).size;
  const range = /^bytes=(\d*)-(\d*)$/.exec(req.headers.range || "");
  if (range) {
    const start = range[1] ? +range[1] : Math.max(0, size - +range[2]);
    const end = range[1] && range[2] ? Math.min(+range[2], size - 1) : size - 1;
    res.statusCode = 206;
    res.setHeader("Content-Range", `bytes ${start}-${end}/${size}`);
    res.setHeader("Content-Length", String(end - start + 1));
    return void fs.createReadStream(file, { start, end }).pipe(res);
  }
  res.setHeader("Content-Length", String(size));
  fs.createReadStream(file).pipe(res);
}

class LiveTree {
  private catalog?: { json: string; index: Map<string, string> };
  private manifest?: Record<string, unknown>;
  private seIndex?: Map<string, string>;

  private root: string;
  private master?: string;

  constructor(root: string, master?: string) {
    this.root = root;
    this.master = master;
  }

  private abs(rel: string) {
    const p = path.resolve(this.root, rel);
    return p.startsWith(path.resolve(this.root) + path.sep) ? p : null; // no traversal
  }
  private first(...rels: string[]) {
    for (const r of rels) {
      const p = this.abs(r);
      if (p && fs.existsSync(p) && fs.statSync(p).isFile()) return p;
    }
    return null;
  }
  private readMaster(name: string): Json[] {
    if (!this.master) return [];
    try {
      return JSON.parse(fs.readFileSync(path.join(this.master, `${name}.json`), "utf8"));
    } catch {
      return [];
    }
  }

  // `rel` → a file in the tree, null = not found, undefined = not ours
  resolve(rel: string): string | null | undefined {
    let m: RegExpMatchArray | null;
    if ((m = rel.match(/^scenario\/([\w.-]+)\.json$/))) return this.getCatalog().index.get(m[1]) ?? this.findScenario(m[1]);
    if ((m = rel.match(/^models\/(.+)$/))) {
      const r = `startapp/live2d/model/${m[1]}`;
      return this.first(r, r.replace(/\.physics3\.json$/, ".physics3"));
    }
    if ((m = rel.match(/^motions\/(.+)$/))) return this.motion(m[1]);
    if ((m = rel.match(/^sound\/voice\/([\w.-]+)\/([\w.-]+\.mp3)$/)))
      return this.first(
        `ondemand/sound/scenario/voice/${m[1]}/${m[2]}`,
        `ondemand/sound/card_scenario/voice/${m[1]}/${m[2]}`,
        `startapp/sound/scenario/voice/${m[1]}/${m[2]}`,
      );
    if ((m = rel.match(/^sound\/bgm\/([\w.-]+)\.mp3$/)))
      return this.first(`ondemand/sound/scenario/bgm/${m[1]}/${m[1]}.mp3`, `startapp/sound/scenario/bgm/${m[1]}/${m[1]}.mp3`);
    if ((m = rel.match(/^sound\/se\/([\w.-]+)\.mp3$/))) return this.getSe().get(m[1]) ?? null;
    if ((m = rel.match(/^background\/([\w.-]+)\.png$/)))
      return this.first(
        `ondemand/scenario/background/${m[1]}/${m[1]}.png`,
        `startapp/scenario/background/${m[1]}/${m[1]}.png`,
        // prefab backgrounds (ScenarioBGData): the base image
        `ondemand/scenario/background/${m[1]}/scenariobgdata.assets/texture2d/${m[1]}.png`,
      );
    if ((m = rel.match(/^images\/(.+\.png)$/))) return this.first(`ondemand/${m[1]}`, `startapp/${m[1]}`);
    if ((m = rel.match(/^movie\/([\w.-]+)\.mp4$/))) {
      for (const d of [`ondemand/scenario/movie/${m[1]}`, `ondemand/movie/${m[1]}`]) {
        const dir = this.abs(d);
        const mp4 = dir && fs.existsSync(dir) ? fs.readdirSync(dir).find((f) => f.endsWith(".mp4")) : undefined;
        if (mp4) return path.join(dir!, mp4);
      }
      return null;
    }
    return undefined;
  }

  // Motion / facial clip. Scenarios name clips with mixed case ("…tiltheadB")
  // while the export is lower-case, and costume-only clips (BuildModelData
  // AdditionalMotionData) live in the costume's own motions/ folder.
  private motion(rel: string) {
    const exact = this.first(`startapp/live2d/motion/${rel}`);
    if (exact) return exact;
    const dir = path.dirname(rel);
    const name = path.basename(rel).toLowerCase();
    const hit = this.listing(`startapp/live2d/motion/${dir}`).get(name);
    if (hit) return hit;
    // <motionDir>/<base>/motion/<clip> → model/<motionDir>/*/motions/<clip>
    const mm = rel.match(/^(.+)\/[^/]+_motion_base\/motion\/[^/]+$/);
    if (!mm) return null;
    const charDir = this.abs(`startapp/live2d/model/${mm[1]}`);
    if (!charDir || !fs.existsSync(charDir)) return null;
    for (const costume of fs.readdirSync(charDir)) {
      const h = this.listing(`startapp/live2d/model/${mm[1]}/${costume}/motions`).get(name);
      if (h) return h;
    }
    return null;
  }
  private listings = new Map<string, Map<string, string>>();
  private listing(rel: string) {
    let l = this.listings.get(rel);
    if (!l) {
      l = new Map();
      const d = this.abs(rel);
      if (d && fs.existsSync(d)) for (const f of fs.readdirSync(d)) l.set(f.toLowerCase(), path.join(d, f));
      this.listings.set(rel, l);
    }
    return l;
  }

  // Scenarios the master data doesn't list (newer than the local master):
  // find <id>.json in the usual scenario folders.
  private scenarioIndex?: Map<string, string>;
  private findScenario(id: string) {
    if (!this.scenarioIndex) {
      this.scenarioIndex = new Map();
      const add = (dir: string) => {
        if (!fs.existsSync(dir)) return;
        for (const f of fs.readdirSync(dir)) if (f.endsWith(".json")) this.scenarioIndex!.set(f.slice(0, -5), path.join(dir, f));
      };
      const ev = path.join(this.root, "ondemand/event_story");
      if (fs.existsSync(ev)) for (const b of fs.readdirSync(ev)) add(path.join(ev, b, "scenario"));
      for (const top of ["startapp/scenario/unitstory", "startapp/scenario/special", "startapp/character/member"]) {
        const d = path.join(this.root, top);
        if (fs.existsSync(d)) for (const b of fs.readdirSync(d)) add(path.join(d, b));
      }
    }
    return this.scenarioIndex.get(id) ?? null;
  }

  // Every costume directory in the tree (any dir holding a .model3: main
  // costumes sit at v*/main/<char>/<costume>, sub characters at v*/sub/<costume>,
  // collabo ones up to v2/collabo/egg/<n>/<costume>),
  // merged over the staged manifest. The motion library is the *_motion_base
  // whose name is the longest prefix of the costume ("v2_15nene_casual" →
  // v2/main/15_nene/v2_15nene_motion_base, "sub_sakaki02" → v1/sub/sub_sakaki_motion_base).
  getManifest(stagedPath: string) {
    if (!this.manifest) {
      const lib = path.join(this.root, "startapp/live2d");
      const bases: [string, string][] = []; // [prefix, motionDir]
      for (const [rel] of walkAll(path.join(lib, "motion"), 4))
        if (rel.endsWith("_motion_base")) {
          const name = path.basename(rel);
          bases.push([name.slice(0, -"_motion_base".length), path.dirname(rel)]);
        }
      bases.sort((x, y) => y[0].length - x[0].length);
      const out: Record<string, unknown> = {};
      for (const [rel, dir] of walkAll(path.join(lib, "model"), 5)) {
        const model3 = fs.readdirSync(dir).find((f) => f.endsWith(".model3"));
        if (!model3) continue;
        const costume = path.basename(rel);
        // a v2 costume without its own library falls back to the v1 one
        const base =
          bases.find(([prefix]) => costume.startsWith(prefix)) ??
          bases.find(([prefix]) => costume.replace(/^v2_/, "").startsWith(prefix));
        if (!base) continue;
        out[costume] = {
          modelDir: `models/${rel}`,
          modelFile: model3,
          motionDir: base[1],
          motionBase: `${base[0]}_motion_base`,
          charFolder: path.basename(path.dirname(rel)),
        };
      }
      this.manifest = out;
    }
    let staged = {};
    try {
      staged = JSON.parse(fs.readFileSync(stagedPath, "utf8"));
    } catch {
      /* none staged */
    }
    return { ...this.manifest, ...staged };
  }

  private getSe() {
    if (!this.seIndex) {
      this.seIndex = new Map();
      // event-specific SEs: event_story/<bundle>/scenario_se/<se>.mp3
      const ev = path.join(this.root, "ondemand/event_story");
      if (fs.existsSync(ev))
        for (const b of fs.readdirSync(ev)) {
          const d = path.join(ev, b, "scenario_se");
          if (fs.existsSync(d))
            for (const f of fs.readdirSync(d)) if (f.endsWith(".mp3")) this.seIndex.set(f.slice(0, -4), path.join(d, f));
        }
      for (const top of ["startapp", "ondemand"]) {
        const base = path.join(this.root, top, "sound/scenario/se");
        if (!fs.existsSync(base)) continue;
        for (const pack of fs.readdirSync(base)) {
          const d = path.join(base, pack);
          if (!fs.statSync(d).isDirectory()) continue;
          for (const f of fs.readdirSync(d))
            if (f.endsWith(".mp3") && !this.seIndex.has(f.slice(0, -4))) this.seIndex.set(f.slice(0, -4), path.join(d, f));
        }
      }
    }
    return this.seIndex;
  }

  // Story browser data, grouped the way the game's ストーリー screen is:
  // unit (main) stories, event stories, card stories, special stories, area talks.
  getCatalog() {
    if (this.catalog) return this.catalog;
    const index = new Map<string, string>();
    const has = (rels: string[], sid: string) => {
      const p = this.first(...rels);
      if (p) index.set(sid, p);
      return !!p;
    };
    const ep = (sid: string, rel: string | string[], extra: object) => ({
      sid,
      ok: has(typeof rel === "string" ? [rel] : rel, sid),
      ...extra,
    });

    const chars = new Map(this.readMaster("gameCharacters").map((c) => [c.id, c]));
    const charName = (id: number) => {
      const c = chars.get(id);
      return c ? `${c.firstName ?? ""}${c.givenName}` : `#${id}`;
    };

    const unit = this.readMaster("unitStories").map((u) => ({
      unit: u.unit,
      chapters: u.chapters.map((c: Json) => ({
        title: c.title,
        episodes: c.episodes.map((e: Json) =>
          ep(e.scenarioId, `startapp/scenario/unitstory/${c.assetbundleName}/${e.scenarioId}.json`, {
            no: e.episodeNoLabel,
            title: e.title,
            thumb: `story/episode_image/${c.assetbundleName}/${e.assetbundleName}.png`,
          }),
        ),
      })),
    }));

    const mainUnit = new Map<number, string>();
    for (const r of this.readMaster("eventStoryUnits"))
      if (r.eventStoryUnitRelation === "main") mainUnit.set(r.eventStoryId, r.unit);
    const events = new Map(this.readMaster("events").map((e) => [e.id, e]));
    const event = this.readMaster("eventStories")
      .map((s) => {
        const ev = events.get(s.eventId);
        return {
          id: s.eventId,
          title: ev?.name ?? `Event ${s.eventId}`,
          unit: mainUnit.get(s.id) ?? "none",
          at: ev?.startAt ?? 0,
          logo: `event/${s.assetbundleName}/logo/logo.png`,
          episodes: s.eventStoryEpisodes.map((e: Json) =>
            ep(e.scenarioId, `ondemand/event_story/${s.assetbundleName}/scenario/${e.scenarioId}.json`, {
              no: `第${e.episodeNo}話`,
              title: e.title,
              thumb: `event_story/${s.assetbundleName}/episode_image/${e.assetbundleName}.png`,
            }),
          ),
        };
      })
      .sort((a, b) => a.at - b.at || (a.id ?? 0) - (b.id ?? 0));

    const cardEps = new Map<number, Json[]>();
    for (const e of this.readMaster("cardEpisodes")) cardEps.set(e.cardId, [...(cardEps.get(e.cardId) ?? []), e]);
    const card = this.readMaster("cards")
      .filter((c) => cardEps.has(c.id))
      .map((c) => {
        const ch = chars.get(c.characterId);
        return {
          id: c.id,
          title: `【${c.prefix}】${charName(c.characterId)}`,
          unit: c.supportUnit && c.supportUnit !== "none" ? c.supportUnit : (ch?.unit ?? "none"),
          vsUnit: ch?.unit === "piapro" ? "piapro" : undefined,
          at: c.releaseAt,
          thumb: `thumbnail/chara/${c.assetbundleName}_normal.png`,
          episodes: cardEps
            .get(c.id)!
            .sort((a, b) => a.seq - b.seq)
            .map((e) =>
              ep(e.scenarioId, `startapp/character/member/${c.assetbundleName}/${e.scenarioId}.json`, {
                no: e.cardEpisodePartType === "second_part" ? "後編" : "前編",
                title: e.title,
              }),
            ),
        };
      })
      .sort((a, b) => a.at - b.at || (a.id ?? 0) - (b.id ?? 0));

    const special = this.readMaster("specialStories")
      .map((s) => ({
        id: s.id,
        title: s.title,
        at: s.startAt ?? 0,
        episodes: s.episodes.map((e: Json) =>
          // per-episode bundle dir (most), or the story's own (the opening)
          ep(e.scenarioId, [e.assetbundleName, s.assetbundleName].map((d) => `startapp/scenario/special/${d}/${e.scenarioId}.json`), {
            no: `${e.episodeNo}`,
            title: e.title,
          }),
        ),
      }))
      .sort((a, b) => a.at - b.at || (a.id ?? 0) - (b.id ?? 0));

    const areaNames = new Map(this.readMaster("areas").map((a) => [a.id, a.name]));
    const byArea = new Map<number, Json[]>();
    for (const a of this.readMaster("actionSets")) {
      if (!a.scenarioId) continue;
      const rel = `startapp/scenario/actionset/group${Math.floor(a.id / 100)}/${a.scenarioId}.json`;
      const list = byArea.get(a.areaId) ?? [];
      list.push(
        ep(a.scenarioId, rel, {
          no: `${a.id}`,
          title: (a.characterIds ?? []).map(charName).join("・"),
          chars: a.characterIds ?? [],
        }),
      );
      byArea.set(a.areaId, list);
    }
    const area = [...byArea].map(([id, episodes]) => ({ id, title: areaNames.get(id) ?? `Area ${id}`, episodes }));

    const units = Object.fromEntries([...chars].map(([id, c]) => [id, c.unit]));
    const json = JSON.stringify({ unit, event, card, special, area, units });
    this.catalog = { json, index };
    return this.catalog;
  }
}

function send(res: ServerResponse, ext: string, body: string) {
  res.setHeader("Content-Type", TYPES[ext]);
  res.end(body);
}

// [relative path, absolute dir] for every directory up to `depth` levels below base
function walkAll(base: string, depth: number): [string, string][] {
  const out: [string, string][] = [];
  let level: [string, string][] = [["", base]];
  for (let i = 0; i < depth && level.length; i++) {
    const next: [string, string][] = [];
    for (const [rel, dir] of level) {
      if (!fs.existsSync(dir)) continue;
      for (const d of fs.readdirSync(dir, { withFileTypes: true }))
        if (d.isDirectory()) next.push([rel ? `${rel}/${d.name}` : d.name, path.join(dir, d.name)]);
    }
    out.push(...next);
    level = next;
  }
  return out;
}
