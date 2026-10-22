// UI text the player draws itself (start overlay + story menu).

export interface MenuLabels {
  bookmark: string;
  auto: string;
  consecutive: string;
  skip: string;
  fast: string;
  hide: string;
  log: string;
}
export interface PlayerLabels {
  start: string;
  loading: string;
  menu: MenuLabels;
}

export type Locale = "zh" | "ja" | "en";

export const LABELS: Record<Locale, PlayerLabels> = {
  zh: {
    start: "点击开始播放",
    loading: "加载中",
    menu: { bookmark: "书签", auto: "自动", consecutive: "连续播放", skip: "跳过", fast: "快进", hide: "隐藏", log: "记录" },
  },
  // the game's own labels (ScenarioMenu)
  ja: {
    start: "タップして再生",
    loading: "読み込み中",
    menu: { bookmark: "しおり", auto: "オート", consecutive: "連続再生", skip: "スキップ", fast: "早送り", hide: "非表示", log: "ログ" },
  },
  en: {
    start: "Tap to play",
    loading: "Loading",
    menu: { bookmark: "Mark", auto: "Auto", consecutive: "Chain", skip: "Skip", fast: "Fast", hide: "Hide", log: "Log" },
  },
};
