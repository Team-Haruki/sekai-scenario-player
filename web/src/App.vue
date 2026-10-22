<script setup lang="ts">
import { computed, onBeforeUnmount, onMounted, ref, shallowRef, watch } from "vue";
import { useDark, useMediaQuery, useStorage, useToggle } from "@vueuse/core";
import {
  EyeOff,
  FastForward,
  Maximize,
  Minimize,
  FileBraces,
  Moon,
  PanelLeft,
  PanelRight,
  Play,
  RotateCcw,
  Settings2,
  Sun,
} from "@lucide/vue";
import { toast } from "vue-sonner";
import { type ModelManifest, type PjskPlayer, type ScenarioSceneData, createAssetResolver, createPlayer } from "pjsk-scenario-player";
import fontBold from "../../fonts/SourceHanSansJP-Bold.otf?url";
import fontMedium from "../../fonts/SourceHanSansJP-Medium.otf?url";
import StoryBrowser from "@/components/StoryBrowser.vue";
import SettingsDialog from "@/components/SettingsDialog.vue";
import Transcript from "@/components/Transcript.vue";
import { Button } from "@/components/ui/button";
import { Toaster } from "@/components/ui/sonner";
import { Tabs, TabsContent, TabsList, TabsTrigger } from "@/components/ui/tabs";
import { Toggle } from "@/components/ui/toggle";
import { Tooltip, TooltipContent, TooltipProvider, TooltipTrigger } from "@/components/ui/tooltip";
import { type Catalog, loadCatalog, storiesOf, TABS } from "@/lib/catalog";
import { settings } from "@/lib/settings";
import { cn } from "@/lib/utils";

const REPO = "https://github.com/Team-Haruki/sekai-scenario-player";
const SAMPLE = "./samples/sample_demo.json";

const isDark = useDark({ storageKey: "pjsk:theme" });
const toggleDark = useToggle(isDark);
const wide = useMediaQuery("(min-width: 1024px)");
const showBrowser = useStorage("pjsk:show-browser", true);
const showLog = useStorage("pjsk:show-log", true);
const settingsOpen = ref(false);

// what is loaded: a ScenarioId from the asset source, a dropped file, or the sample
type Source = { kind: "id"; sid: string } | { kind: "file"; name: string; data: ScenarioSceneData } | { kind: "sample" };
const source = shallowRef<Source>();
const scenario = shallowRef<ScenarioSceneData>();
const progress = ref(-1);
const total = ref(0);
const state = ref<"idle" | "loading" | "playing" | "ended" | "error">("idle");
const auto = ref(true);
const fast = ref(false);

const base = computed(() => settings.value.assets);
const catalog = shallowRef<Catalog | null>(null);
const catalogLoading = ref(false);
const icons = shallowRef<Record<string, string>>({});

const host = ref<HTMLElement>();
let player: PjskPlayer | undefined;

// ── player lifecycle ───────────────────────────────────────────────────────
function mount() {
  player?.destroy();
  // no source configured: resolve under a path that holds nothing, so the
  // engine still runs (text, telops, fades) with an empty stage
  const assets = createAssetResolver(base.value || "./no-assets/");
  const models = async (): Promise<ModelManifest> => {
    if (!base.value) return {};
    try {
      const r = await fetch(assets.modelManifest());
      if (r.ok) return await r.json();
    } catch {
      /* fall through */
    }
    toast.warning("读不到模型清单", { description: "角色不会出现。检查素材服务器地址是否正确。" });
    return {};
  };
  const p = createPlayer(host.value!, {
    assets,
    models,
    locale: settings.value.locale,
    // the site ships its own copy, so text looks right with any asset source
    fonts: { name: fontBold, body: fontMedium },
    autoplay: settings.value.autoplay ? "auto" : false,
    auto: auto.value,
  });
  p.on("load", (e) => {
    scenario.value = e.scenario;
    progress.value = -1;
    total.value = e.scenario.Snippets.length;
    state.value = "loading";
  });
  p.on("play", () => (state.value = "playing"));
  p.on("progress", (e) => (progress.value = e.index));
  p.on("end", () => (state.value = "ended"));
  p.on("error", (e) => {
    state.value = "error";
    toast.error("剧情加载失败", { description: e.error.message });
  });
  p.on("mode", (m) => ((auto.value = m.auto), (fast.value = m.fast)));
  p.on("log", () => (wide.value ? (showLog.value = !showLog.value) : toast.info("台词在播放器下方的「台词」页")));
  p.setLogActive(showLog.value);
  player = p;
}
watch(showLog, (on) => player?.setLogActive(on));

async function play(s: Source, push = true) {
  source.value = s;
  if (!player) return;
  if (push) {
    const q = new URLSearchParams(location.search);
    if (s.kind === "id") q.set("scenario", s.sid);
    else q.delete("scenario");
    history.pushState(null, "", q.size ? `?${q}` : location.pathname);
  }
  scenario.value = undefined;
  state.value = "loading";
  if (s.kind === "id") await player.load(s.sid);
  else if (s.kind === "file") await player.load(s.data);
  else await player.load(SAMPLE);
}
const restart = () => source.value && play(source.value, false);
const initialSource = (): Source => {
  const sid = new URLSearchParams(location.search).get("scenario");
  return sid && base.value ? { kind: "id", sid } : { kind: "sample" };
};

async function refreshSource() {
  catalog.value = null;
  icons.value = {};
  if (!base.value) return;
  catalogLoading.value = true;
  const [c, map] = await Promise.all([
    loadCatalog(base.value),
    fetch(`${base.value}ui/chr_ts/map.json`)
      .then((r) => (r.ok ? r.json() : {}))
      .catch(() => ({})),
  ]);
  catalog.value = c;
  icons.value = map;
  catalogLoading.value = false;
}
const icon = (id?: number) => (id != null && icons.value[id] ? `${base.value}ui/chr_ts/${icons.value[id]}` : undefined);

onMounted(() => {
  mount();
  void refreshSource();
  void play(initialSource(), false);
  addEventListener("popstate", onPop);
});
onBeforeUnmount(() => {
  player?.destroy();
  removeEventListener("popstate", onPop);
});
function onPop() {
  const s = initialSource();
  if (s.kind !== source.value?.kind || (s.kind === "id" && source.value.kind === "id" && s.sid !== source.value.sid)) void play(s, false);
}

// a new asset source or player language: rebuild the player, replay what was on
watch(
  () => [settings.value.assets, settings.value.locale, settings.value.autoplay],
  ([a], [prevA]) => {
    mount();
    if (a !== prevA) void refreshSource();
    const s = source.value?.kind === "id" && !a ? { kind: "sample" as const } : source.value;
    if (s) void play(s, false);
  },
);

// ── title of what is playing ─────────────────────────────────────────────
const title = computed(() => {
  const s = source.value;
  if (!s) return "";
  if (s.kind === "sample") return "示例剧情";
  if (s.kind === "file") return s.name;
  if (catalog.value)
    for (const t of TABS)
      for (const [, story] of storiesOf(catalog.value, t.key)) {
        const ep = story.episodes.find((e) => e.sid === s.sid);
        if (ep) return `${story.title}　${ep.no} ${ep.title}`;
      }
  return s.sid;
});
const scenarioId = computed(() => scenario.value?.ScenarioId);

// ── opening files ─────────────────────────────────────────────────────────
const fileInput = ref<HTMLInputElement>();
const dragging = ref(false);
async function openFile(f?: File | null) {
  if (!f) return;
  try {
    const data = JSON.parse(await f.text()) as ScenarioSceneData;
    if (!Array.isArray(data.Snippets) || !Array.isArray(data.TalkData)) throw new Error("不是 ScenarioSceneData 格式的剧情 JSON");
    await play({ kind: "file", name: f.name.replace(/\.json$/i, ""), data });
  } catch (e) {
    toast.error(`打不开 ${f.name}`, { description: (e as Error).message });
  }
}
function onDrop(e: DragEvent) {
  dragging.value = false;
  void openFile(e.dataTransfer?.files[0]);
}
function onDragOver(e: DragEvent) {
  if (!e.dataTransfer?.types.includes("Files")) return;
  e.preventDefault();
  dragging.value = true;
}

// fullscreen: the element API where there is one (and landscape on phones
// that allow locking it), otherwise a fixed overlay (iPhone Safari)
const stageBox = ref<HTMLElement>();
const fullscreen = ref(false);
async function toggleFullscreen() {
  if (fullscreen.value) {
    fullscreen.value = false;
    if (document.fullscreenElement) await document.exitFullscreen().catch(() => {});
    return;
  }
  fullscreen.value = true;
  if (!stageBox.value?.requestFullscreen) return;
  try {
    await stageBox.value.requestFullscreen({ navigationUI: "hide" });
    // left (exit button / Escape) while the request was pending: undo it
    if (!fullscreen.value) return void (await document.exitFullscreen().catch(() => {}));
    await (screen.orientation as ScreenOrientation & { lock?: (o: string) => Promise<void> }).lock?.("landscape");
  } catch {
    /* overlay only */
  }
}
const onFullscreenChange = () => {
  if (!document.fullscreenElement) fullscreen.value = false;
};
const onKey = (e: KeyboardEvent) => {
  if (e.key === "Escape" && fullscreen.value && !document.fullscreenElement) fullscreen.value = false;
};
onMounted(() => {
  document.addEventListener("fullscreenchange", onFullscreenChange);
  addEventListener("keydown", onKey);
});
onBeforeUnmount(() => {
  document.removeEventListener("fullscreenchange", onFullscreenChange);
  removeEventListener("keydown", onKey);
});

const jump = (i: number) => player?.jumpTo(i);
const setAuto = (on: boolean) => player?.setAuto(on);
const setFast = (on: boolean) => player?.setFast(on);
const hideUi = () => player?.setUiHidden(true);

const lineCount = computed(() => `${Math.max(0, progress.value + 1)} / ${total.value}`);
</script>

<template>
  <TooltipProvider :delay-duration="300">
    <div
      class="flex h-dvh flex-col"
      @dragover="onDragOver"
      @dragleave.self="dragging = false"
      @drop.prevent="onDrop"
    >
      <!-- header -->
      <header class="flex h-14 shrink-0 items-center gap-3 border-b bg-card px-3 sm:px-4">
        <a href="./" class="flex shrink-0 items-center gap-2.5 rounded-lg focus-visible:ring-2 focus-visible:ring-ring focus-visible:outline-none">
          <span class="grid size-8 place-items-center rounded-[10px] bg-pink text-white">
            <svg viewBox="0 0 32 32" class="size-5" aria-hidden="true"><path fill="currentColor" d="M12 22.5a3 3 0 1 1-2-2.83V9l11-2v11.5a3 3 0 1 1-2-2.83V10.4l-7 1.27z" /></svg>
          </span>
          <span class="hidden text-[15px] leading-tight font-extrabold sm:block">PJSK Scenario Player</span>
        </a>
        <div class="min-w-0 flex-1 border-l pl-3">
          <p class="truncate text-sm font-bold">{{ title || "未选择剧情" }}</p>
          <p v-if="scenarioId && scenarioId !== title" class="truncate text-[11px] text-muted-foreground">{{ scenarioId }}</p>
        </div>
        <div class="flex shrink-0 items-center gap-1">
          <Button variant="ghost" size="sm" class="hidden sm:inline-flex" @click="fileInput?.click()"><FileBraces />打开 JSON</Button>
          <Button variant="ghost" size="sm" @click="settingsOpen = true">
            <span :class="cn('size-2 rounded-full', base ? 'bg-teal' : 'bg-muted-foreground/50')" />
            <span class="hidden max-w-40 truncate md:inline">{{ base ? base.replace(/^https?:\/\//, "") : "未连接素材" }}</span>
            <Settings2 class="md:hidden" />
          </Button>
          <Tooltip>
            <TooltipTrigger as-child>
              <Button variant="ghost" size="icon-sm" :aria-label="isDark ? '切换到浅色' : '切换到深色'" @click="toggleDark()">
                <Sun v-if="isDark" /><Moon v-else />
              </Button>
            </TooltipTrigger>
            <TooltipContent>{{ isDark ? "浅色" : "深色" }}</TooltipContent>
          </Tooltip>
          <Button variant="ghost" size="icon-sm" as-child>
            <a :href="REPO" target="_blank" rel="noopener" aria-label="GitHub 仓库">
              <svg viewBox="0 0 16 16" fill="currentColor" aria-hidden="true"><path d="M8 0C3.58 0 0 3.58 0 8c0 3.54 2.29 6.53 5.47 7.59.4.07.55-.17.55-.38 0-.19-.01-.82-.01-1.49-2.01.37-2.53-.49-2.69-.94-.09-.23-.48-.94-.82-1.13-.28-.15-.68-.52-.01-.53.63-.01 1.08.58 1.23.82.72 1.21 1.87.87 2.33.66.07-.52.28-.87.51-1.07-1.78-.2-3.64-.89-3.64-3.95 0-.87.31-1.59.82-2.15-.08-.2-.36-1.02.08-2.12 0 0 .67-.21 2.2.82.64-.18 1.32-.27 2-.27s1.36.09 2 .27c1.53-1.04 2.2-.82 2.2-.82.44 1.1.16 1.92.08 2.12.51.56.82 1.27.82 2.15 0 3.07-1.87 3.75-3.65 3.95.29.25.54.73.54 1.48 0 1.07-.01 1.93-.01 2.2 0 .21.15.46.55.38A8.01 8.01 0 0 0 16 8c0-4.42-3.58-8-8-8"/></svg>
            </a>
          </Button>
        </div>
        <input ref="fileInput" type="file" accept=".json,application/json" class="hidden" @change="openFile(($event.target as HTMLInputElement).files?.[0]); ($event.target as HTMLInputElement).value = ''" />
      </header>

      <main
        :class="
          cn(
            'flex min-h-0 flex-1 flex-col short-landscape:flex-row lg:grid',
            wide && showBrowser && showLog && 'lg:grid-cols-[320px_minmax(0,1fr)_360px]',
            wide && showBrowser && !showLog && 'lg:grid-cols-[320px_minmax(0,1fr)]',
            wide && !showBrowser && showLog && 'lg:grid-cols-[minmax(0,1fr)_360px]',
          )
        "
      >
        <aside v-if="wide && showBrowser" class="min-h-0 border-r bg-card/60" aria-label="剧情目录">
          <StoryBrowser
            :catalog="catalog"
            :loading="catalogLoading"
            :current="source?.kind === 'id' ? source.sid : undefined"
            :base="base"
            @pick="(sid) => play({ kind: 'id', sid })"
            @settings="settingsOpen = true"
            @sample="play({ kind: 'sample' })"
            @open="fileInput?.click()"
          />
        </aside>

        <!-- stage -->
        <section
          class="flex shrink-0 flex-col items-center gap-2 p-3 sm:p-4 lg:min-h-0 lg:justify-center lg:gap-3 lg:p-6"
          aria-label="播放器"
        >
          <div
            ref="stageBox"
            :class="cn('relative', fullscreen ? 'fixed inset-0 z-50 grid place-items-center bg-black' : 'stage-width')"
          >
            <div
              ref="host"
              :class="
                cn(
                  'overflow-hidden bg-stage',
                  fullscreen ? 'w-[min(100vw,calc(100dvh*16/9))]' : 'rounded-xl shadow-[0_12px_40px_-12px_rgba(0,0,34,.45)] ring-1 ring-black/5',
                )
              "
            />
            <Button
              v-if="fullscreen"
              variant="secondary"
              size="icon-sm"
              class="absolute top-3 left-3 opacity-80"
              aria-label="退出全屏"
              @click="toggleFullscreen"
            >
              <Minimize />
            </Button>
          </div>
          <div class="stage-width flex flex-wrap items-center gap-x-1 gap-y-1 sm:gap-2">
            <Tooltip v-if="wide">
              <TooltipTrigger as-child>
                <Button variant="ghost" size="icon-sm" :aria-pressed="showBrowser" aria-label="剧情目录" @click="showBrowser = !showBrowser"><PanelLeft /></Button>
              </TooltipTrigger>
              <TooltipContent>剧情目录</TooltipContent>
            </Tooltip>
            <Toggle :model-value="auto" size="sm" aria-label="自动播放" @update:model-value="setAuto"><Play />自动</Toggle>
            <Toggle :model-value="fast" size="sm" aria-label="快进" @update:model-value="setFast"><FastForward />快进</Toggle>
            <Button variant="ghost" size="sm" @click="hideUi"><EyeOff />隐藏界面</Button>
            <Button variant="ghost" size="sm" :disabled="!source" @click="restart"><RotateCcw />重播</Button>
            <Button variant="ghost" size="sm" @click="toggleFullscreen"><Maximize />全屏</Button>
            <span class="ml-auto text-xs text-muted-foreground tabular-nums short-landscape:hidden">
              <template v-if="state === 'ended'">播放完毕</template>
              <template v-else-if="total">片段 {{ lineCount }}</template>
            </span>
            <Tooltip v-if="wide">
              <TooltipTrigger as-child>
                <Button variant="ghost" size="icon-sm" :aria-pressed="showLog" aria-label="台词" @click="showLog = !showLog"><PanelRight /></Button>
              </TooltipTrigger>
              <TooltipContent>台词</TooltipContent>
            </Tooltip>
          </div>
          <p v-if="!base && wide" class="text-xs text-muted-foreground">
            没有连接素材时只播放文字和转场。
            <button class="font-bold text-pink underline-offset-4 hover:underline" @click="settingsOpen = true">连接素材服务器</button>
          </p>
        </section>

        <aside v-if="wide && showLog" class="min-h-0 border-l bg-card/60" aria-label="台词">
          <Transcript :scenario="scenario" :progress="progress" :icon="icon" @jump="jump" />
        </aside>

        <!-- narrow screens: transcript and browser below the stage -->
        <Tabs v-if="!wide" default-value="log" class="flex min-h-0 flex-1 flex-col gap-0 px-3 pb-3 sm:px-4 short-landscape:pt-3 short-landscape:pl-0">
          <TabsList class="w-full">
            <TabsTrigger value="log">台词</TabsTrigger>
            <TabsTrigger value="browse">剧情目录</TabsTrigger>
          </TabsList>
          <TabsContent value="log" class="mt-2 min-h-0 flex-1 overflow-hidden rounded-xl border bg-card">
            <Transcript :scenario="scenario" :progress="progress" :icon="icon" @jump="jump" />
          </TabsContent>
          <TabsContent value="browse" class="mt-2 min-h-0 flex-1 overflow-hidden rounded-xl border bg-card">
            <StoryBrowser
              :catalog="catalog"
              :loading="catalogLoading"
              :current="source?.kind === 'id' ? source.sid : undefined"
              :base="base"
              @pick="(sid) => play({ kind: 'id', sid })"
              @settings="settingsOpen = true"
              @sample="play({ kind: 'sample' })"
              @open="fileInput?.click()"
            />
          </TabsContent>
        </Tabs>
      </main>

      <div
        v-if="dragging"
        class="pointer-events-none fixed inset-3 z-50 grid place-items-center rounded-2xl border-2 border-dashed border-pink bg-background/85 backdrop-blur-sm"
      >
        <p class="text-lg font-extrabold">松开即可播放这个剧情 JSON</p>
      </div>
    </div>
    <SettingsDialog v-model:open="settingsOpen" />
    <Toaster rich-colors position="bottom-right" :mobile-offset="16" />
  </TooltipProvider>
</template>
