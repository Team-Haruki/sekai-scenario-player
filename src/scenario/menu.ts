// Story menu — ScreenLayerScenario.prefab RightTop: the ⋯ button
// (UIPartsMenuButton) opens the ScenarioMenu panel. Values are the prefab's
// 1920x1080 reference rects mapped to the 1280x720 stage (x 2/3).
//
// The buttons are configurable. The game's panel is GAME_MENU (bookmark /
// consecutive / skip only look like the game, they do nothing here); the
// default swaps those for what a web player needs, fullscreen and mute. Wide
// buttons stack from the top (the first one above the rule, like bookmark),
// hide and log sit side by side below them. Labels come from labels.ts.

import type { MenuLabels } from "./labels";
import type { UiSprites } from "./sprites";

const S = 2 / 3; // reference px → stage px

export type MenuItem = "bookmark" | "auto" | "consecutive" | "skip" | "fast" | "mute" | "fullscreen" | "hide" | "log";
/** The game's own panel. */
export const GAME_MENU: readonly MenuItem[] = ["bookmark", "auto", "consecutive", "skip", "fast", "hide", "log"];
/** Every button does something. */
export const DEFAULT_MENU: readonly MenuItem[] = ["fullscreen", "auto", "mute", "fast", "hide", "log"];

export type MenuHandlers = Partial<Record<MenuItem, () => void>>;

// icons the game has no sprite for, drawn as masks like its icon sprites
const svgMask = (body: string) =>
  `data:image/svg+xml,${encodeURIComponent(`<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 24 24" fill="none" stroke="#000" stroke-width="2.6" stroke-linecap="round" stroke-linejoin="round">${body}</svg>`)}`;
const IC_FULLSCREEN = svgMask(`<path d="M3 9V3h6M21 9V3h-6M3 15v6h6M21 15v6h-6"/>`);
const IC_MUTE = svgMask(`<path d="M4 9h4l5-4v14l-5-4H4z" fill="#000"/><path d="M17 9l5 6M22 9l-5 6"/>`);

// Wide buttons (280x96): icon centred 77.4 left of the button centre; label
// centred in its rect (width 280 - inset, shifted by `tx`). `icon` is a game
// sprite name (menu/<icon>.png) or a data: URI.
const WIDE: Partial<Record<MenuItem, { icon: string; iw: number; ih: number; inset: number; tx: number; sp: number }>> = {
  bookmark: { icon: "ic_bookmark", iw: 32, ih: 36, inset: 184, tx: 12.2, sp: 0 },
  auto: { icon: "ic_auto", iw: 32, ih: 36, inset: 152, tx: 11.3, sp: -2 },
  consecutive: { icon: "ic_consecutive", iw: 48, ih: 34, inset: 152, tx: 27.2, sp: -2 },
  skip: { icon: "ic_skip", iw: 48, ih: 32, inset: 152, tx: 27.2, sp: -2 },
  fast: { icon: "ic_fast", iw: 48, ih: 32, inset: 152, tx: 11.6, sp: -2 },
  mute: { icon: IC_MUTE, iw: 38, ih: 34, inset: 152, tx: 11.3, sp: -2 },
  fullscreen: { icon: IC_FULLSCREEN, iw: 34, ih: 34, inset: 152, tx: 11.3, sp: -2 },
};
// Small buttons (136x112) at x ∓72 from the content centre.
const SMALL: Partial<Record<MenuItem, { cx: number; icon: string; iw: number; ih: number; ix: number }>> = {
  hide: { cx: 196 - 72, icon: "ic_hide", iw: 58, ih: 32, ix: 0 },
  log: { cx: 196 + 72, icon: "ic_log", iw: 52, ih: 32, ix: 1.6 },
};
// Game rows: the first wide button at 64, the rest from 195.7 every ~104.4
// (auto 195.7, consecutive 300.3, skip 404.2, fast 508.9), the small row
// 103.1 below the last; the panel ends 64 below the small row (788 in all).
const wideTop = (i: number) => (i === 0 ? 64 : 195.7 + (i - 1) * 104.4);

// labels are host strings going into innerHTML
const esc = (s: string) =>
  s.replace(/[&<>"]/g, (c) => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;" })[c]!);

const px = (v: number) => `${(v * S).toFixed(2)}px`;

export class ScenarioMenu {
  private button: HTMLElement;
  private panel: HTMLElement;
  private btns = new Map<MenuItem, HTMLElement>();

  constructor(
    parent: HTMLElement,
    h: MenuHandlers,
    sprites: UiSprites,
    labels: MenuLabels,
    items: readonly MenuItem[] = DEFAULT_MENU,
  ) {
    this.button = document.createElement("div");
    this.button.className = "pjsk-menu";
    parent.appendChild(this.button);

    this.panel = document.createElement("div");
    this.panel.className = "pjsk-menu-panel hidden";
    const icon = (name: string, w: number, h: number, extra = "") =>
      `<i class="pjsk-smp-ic" data-icon="${esc(name)}" style="width:${px(w)};height:${px(h)};${extra}"></i>`;
    const wide = items.filter((k) => WIDE[k]);
    const small = items.filter((k) => SMALL[k]);
    let html = `<div class="pjsk-smp-close"></div>`;
    if (wide.length > 1) html += `<div class="pjsk-smp-line"></div>`;
    wide.forEach((k, i) => {
      const b = WIDE[k]!;
      const tw = 280 - b.inset;
      html += `<div class="pjsk-smp-btn wide" data-k="${k}" style="top:${px(wideTop(i))}">
        ${icon(b.icon, b.iw, b.ih, `left:${px(140 - 77.4 - b.iw / 2)};top:${px(48 - b.ih / 2)}`)}
        <span style="left:${px(140 + b.tx - tw / 2)};width:${px(tw)};letter-spacing:${b.sp / 100}em">${esc(labels[k])}</span>
      </div>`;
    });
    const smallTop = wide.length ? wideTop(wide.length) - 1.3 : 64;
    for (const k of small) {
      const b = SMALL[k]!;
      html += `<div class="pjsk-smp-btn small" data-k="${k}" style="left:${px(b.cx - 68)};top:${px(smallTop)}">
        ${icon(b.icon, b.iw, b.ih, `left:${px(68 + b.ix - b.iw / 2)};top:${px(56 - 16 - b.ih / 2)}`)}
        <span>${esc(labels[k])}</span>
      </div>`;
    }
    const height = small.length ? smallTop + 176 : wide.length ? wideTop(wide.length - 1) + 96 + 72 : 128;
    this.panel.style.setProperty("--pjsk-menu-h", px(height));
    this.panel.innerHTML = html;
    parent.appendChild(this.panel);
    for (const el of this.panel.querySelectorAll<HTMLElement>(".pjsk-smp-btn")) this.btns.set(el.dataset.k as MenuItem, el);
    for (const el of this.panel.querySelectorAll<HTMLElement>(".pjsk-smp-ic")) {
      const name = el.dataset.icon!;
      const paint = (url: string) => (el.style.webkitMaskImage = el.style.maskImage = `url("${url}")`);
      if (name.startsWith("data:")) paint(name);
      else sprites.bind(`menu/${name}.png`, paint);
    }

    // menu clicks must not reach the stage (that would advance the story)
    const on = (el: Element, f: () => void) =>
      el.addEventListener("click", (e) => {
        e.stopPropagation();
        f();
      });
    on(this.button, () => this.open());
    on(this.panel.querySelector(".pjsk-smp-close")!, () => this.close());
    on(this.panel, () => {}); // swallow clicks on the panel background
    for (const [k, el] of this.btns)
      on(el, () => {
        if (k === "hide" || k === "fullscreen") this.close(); // the panel would cover what they show
        h[k]?.();
      });
  }

  // ac_scenario_menu Open / Close (clip_scenario_menu_open/close, 0.167s):
  // the panel grows from the top to its full height while Base/Content fades
  // in; the ⋯ button fades out. Close plays it backwards, then the button returns.
  private closing = 0;
  open() {
    this.closing++;
    this.panel.classList.remove("hidden", "closing");
    this.panel.classList.add("opening");
    this.button.classList.add("faded");
  }
  close() {
    if (this.panel.classList.contains("hidden")) return;
    const token = ++this.closing;
    this.panel.classList.remove("opening");
    this.panel.classList.add("closing");
    this.panel.addEventListener(
      "animationend",
      () => {
        if (token !== this.closing) return; // reopened meanwhile
        this.panel.classList.add("hidden");
        this.panel.classList.remove("closing");
        this.button.classList.remove("faded");
      },
      { once: true },
    );
  }

  // Toggle buttons turn pink (icon + label) while on.
  setState(s: Partial<Record<MenuItem, boolean>>) {
    for (const [k, on] of Object.entries(s) as [MenuItem, boolean][]) this.btns.get(k)?.classList.toggle("on", on);
  }

  setLabels(labels: MenuLabels) {
    for (const [k, el] of this.btns) el.querySelector("span")!.textContent = labels[k];
  }
}
