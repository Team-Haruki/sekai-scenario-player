// Game UI sprites (menu, talk window marks, transitions) with drawn
// stand-ins. The real sprites come from the game client and most hosts won't
// have them, so every sprite is probed once; if it doesn't load, a built-in
// SVG of the same size and role takes its place. Masks (dots, icons) are drawn
// black-on-transparent: only their alpha matters.

import { fileUrl } from "./files";

const svg = (w: number, h: number, body: string) =>
  "data:image/svg+xml," +
  encodeURIComponent(`<svg xmlns="http://www.w3.org/2000/svg" width="${w}" height="${h}" viewBox="0 0 ${w} ${h}">${body}</svg>`);

const INK = "rgb(68,68,102)";
const SHADOW = `fill="rgb(0,0,34)" fill-opacity=".14"`;

const FALLBACKS: Record<string, string> = {
  // btn_circle_h80: white disc with a soft drop shadow (96x96)
  "menu/menu_circle.png": svg(96, 96, `<circle cx="48" cy="51" r="40" ${SHADOW}/><circle cx="48" cy="48" r="40" fill="#fff"/>`),
  "menu/menu_dots.png": svg(52, 12, `<circle cx="6" cy="6" r="6"/><circle cx="26" cy="6" r="6"/><circle cx="46" cy="6" r="6"/>`),
  "menu/close.png": svg(
    44,
    44,
    `<circle cx="22" cy="22" r="21" fill="#fff"/><path d="M14 14 30 30M30 14 14 30" stroke="${INK}" stroke-width="4.5" stroke-linecap="round"/>`,
  ),
  // btn_round_r16, sliced 27px (border-image: 27 fill / 18px)
  "menu/btn.png": svg(64, 64, `<rect x="4" y="7" width="56" height="54" rx="16" ${SHADOW}/><rect x="4" y="4" width="56" height="54" rx="16" fill="#fff"/>`),
  "menu/ic_bookmark.png": svg(32, 36, `<path d="M5 2h22a2 2 0 0 1 2 2v31L16 27 3 35V4a2 2 0 0 1 2-2z"/>`),
  "menu/ic_auto.png": svg(32, 36, `<path d="M6 4 30 18 6 32z"/>`),
  "menu/ic_consecutive.png": svg(
    48,
    34,
    `<path d="M38 17a14 14 0 1 1-4.1-9.9" fill="none" stroke="#000" stroke-width="5" stroke-linecap="round"/><path d="M30 2l11 1-2 11z"/><path d="M19 11l10 6-10 6z"/>`,
  ),
  "menu/ic_skip.png": svg(48, 32, `<path d="M6 3 32 16 6 29z"/><rect x="35" y="3" width="7" height="26" rx="2"/>`),
  "menu/ic_fast.png": svg(48, 32, `<path d="M3 3 24 16 3 29z"/><path d="M24 3 45 16 24 29z"/>`),
  "menu/ic_hide.png": svg(
    58,
    32,
    `<path d="M4 16C11 6 19 3 29 3s18 3 25 13c-7 10-15 13-25 13S11 26 4 16z" fill="none" stroke="#000" stroke-width="4"/><circle cx="29" cy="16" r="6"/><path d="M10 29 48 3" stroke="#000" stroke-width="4" stroke-linecap="round"/>`,
  ),
  "menu/ic_log.png": svg(
    52,
    32,
    `<circle cx="5" cy="5" r="4"/><circle cx="5" cy="16" r="4"/><circle cx="5" cy="27" r="4"/><rect x="14" y="2" width="36" height="6" rx="3"/><rect x="14" y="13" width="36" height="6" rx="3"/><rect x="14" y="24" width="36" height="6" rx="3"/>`,
  ),
  // TalkWindow EndSign: teal eighth note (50x44)
  "serif_note.png": svg(
    50,
    44,
    `<path d="M22 6l18-5v8l-14 4v20a8 7 0 1 1-4-6.1z" fill="rgb(51,204,187)" stroke="#fff" stroke-width="2.5" stroke-linejoin="round"/>`,
  ),
  // side fade feather strips (512x512, repeated): black on the panel's side
  "scenario/tex_transition_left.png": svg(
    512,
    512,
    `<defs><linearGradient id="g"><stop offset="0" stop-opacity="0"/><stop offset="1"/></linearGradient></defs><rect width="512" height="512" fill="url(#g)"/>`,
  ),
  "scenario/tex_transition_top.png": svg(
    512,
    512,
    `<defs><linearGradient id="g" x2="0" y2="1"><stop offset="0" stop-opacity="0"/><stop offset="1"/></linearGradient></defs><rect width="512" height="512" fill="url(#g)"/>`,
  ),
  // btn_round_h80_wh: white pill, sliced 51px left/right
  "scenario/btn_round_h80_wh.png": svg(102, 80, `<rect width="102" height="80" rx="40" fill="#fff"/>`),
};

export class UiSprites {
  private probes = new Map<string, Promise<boolean>>();

  constructor(private resolve: (path: string) => string) {}

  // apply(url) with the game sprite now, and again with the stand-in if it fails to load
  bind(path: string, apply: (url: string) => void) {
    const url = fileUrl(this.resolve(path));
    apply(url);
    const fallback = FALLBACKS[path];
    if (fallback) void this.probe(url).then((ok) => ok || apply(fallback));
  }

  private probe(url: string) {
    let p = this.probes.get(url);
    if (!p) {
      p = new Promise((resolve) => {
        const img = new Image();
        img.onload = () => resolve(img.naturalWidth > 0);
        img.onerror = () => resolve(false);
        img.src = url;
      });
      this.probes.set(url, p);
    }
    return p;
  }
}
