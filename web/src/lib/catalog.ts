// Story catalog served by the asset server (server/asset-tree.ts → catalog.json),
// grouped the way the game's ストーリー screen is.

export interface Episode {
  sid: string;
  ok: boolean; // scenario file present in the asset tree
  no: string;
  title: string;
  thumb?: string;
  chars?: number[];
}
export interface Story {
  id?: number;
  title: string;
  unit?: string;
  vsUnit?: string;
  at?: number;
  logo?: string;
  thumb?: string;
  episodes: Episode[];
}
export interface Catalog {
  unit: { unit: string; chapters: { title: string; episodes: Episode[] }[] }[];
  event: Story[];
  card: Story[];
  special: Story[];
  area: Story[];
  units: Record<string, string>; // gameCharacterId → unit
}

export const TABS = [
  { key: "unit", name: "主线" },
  { key: "event", name: "活动" },
  { key: "card", name: "卡面" },
  { key: "special", name: "特别" },
  { key: "area", name: "区域" },
] as const;
export type Tab = (typeof TABS)[number]["key"];

// unit colours as the game uses them
export const UNITS = [
  { key: "light_sound", short: "L/n", name: "Leo/need", color: "#4455dd" },
  { key: "idol", short: "MMJ", name: "MORE MORE JUMP！", color: "#88dd44" },
  { key: "street", short: "VBS", name: "Vivid BAD SQUAD", color: "#ee1166" },
  { key: "theme_park", short: "WxS", name: "ワンダーランズ×ショウタイム", color: "#ff9900" },
  { key: "school_refusal", short: "25時", name: "25時、ナイトコードで。", color: "#884499" },
  { key: "piapro", short: "VS", name: "バーチャル・シンガー", color: "#33ccbb" },
];
export const unitColor = (k?: string) => UNITS.find((u) => u.key === k)?.color;

export async function loadCatalog(base: string): Promise<Catalog | null> {
  if (!base) return null;
  try {
    const r = await fetch(`${base}catalog.json`);
    return r.ok ? await r.json() : null;
  } catch {
    return null;
  }
}

// Stories of a tab as [stable key, story]. Main stories become one story per chapter.
export function storiesOf(c: Catalog, tab: Tab): [string, Story][] {
  if (tab === "unit")
    return c.unit.flatMap((u) =>
      u.chapters.map((ch, i): [string, Story] => [`unit:${u.unit}:${i}`, { title: ch.title, unit: u.unit, episodes: ch.episodes }]),
    );
  return c[tab].map((s, i): [string, Story] => [`${tab}:${s.id ?? i}`, s]);
}
