<script setup lang="ts">
import { computed, nextTick, ref, watch } from "vue";
import { useStorage } from "@vueuse/core";
import { ChevronDown, FolderOpen, Search, Server } from "@lucide/vue";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { ScrollArea } from "@/components/ui/scroll-area";
import { type Catalog, type Story, type Tab, TABS, UNITS, storiesOf, unitColor } from "@/lib/catalog";
import { centerInScrollArea, cn } from "@/lib/utils";

const props = defineProps<{ catalog: Catalog | null; loading: boolean; current?: string; base: string }>();
const emit = defineEmits<{ pick: [sid: string]; settings: []; sample: []; open: [] }>();

const tab = useStorage<Tab>("pjsk:browser-tab", "event");
const unit = useStorage("pjsk:browser-unit", "");
const query = ref("");
const sid = ref("");
const opened = ref(new Set<string>());
const list = ref<HTMLElement>();

const img = (p?: string) => (p ? `${props.base}images/${p}` : undefined);
const date = (at?: number) => (at ? new Date(at).toISOString().slice(0, 10) : "");

function matchesUnit(s: Story, c: Catalog) {
  if (!unit.value) return true;
  if (s.unit === unit.value || s.vsUnit === unit.value) return true;
  // area talks: any participating character from that unit
  return s.episodes.some((e) => e.chars?.some((id) => c.units[id] === unit.value));
}

const rows = computed(() => {
  const c = props.catalog;
  if (!c) return [];
  const q = query.value.trim().toLowerCase();
  const out: { key: string; story: Story; episodes: Story["episodes"]; open: boolean; cur: boolean }[] = [];
  for (const [key, s] of storiesOf(c, tab.value)) {
    if (!matchesUnit(s, c)) continue;
    let eps = s.episodes;
    if (tab.value === "area" && unit.value) eps = eps.filter((e) => e.chars?.some((id) => c.units[id] === unit.value));
    const titleHit = !q || s.title.toLowerCase().includes(q);
    if (q && !titleHit) eps = eps.filter((e) => e.title.toLowerCase().includes(q) || e.sid.includes(q));
    if (!eps.length) continue;
    out.push({ key, story: s, episodes: eps, open: opened.value.has(key) || (!!q && !titleHit), cur: eps.some((e) => e.sid === props.current) });
    if (out.length >= 300) break; // keep the DOM light; search narrows further
  }
  // newest first for dated tabs
  return tab.value === "unit" || tab.value === "area" ? out : out.reverse();
});

function toggle(key: string) {
  const s = new Set(opened.value);
  s.has(key) ? s.delete(key) : s.add(key);
  opened.value = s;
}

// open the tab + story holding the scenario now playing, and scroll to it
watch(
  () => [props.catalog, props.current] as const,
  async ([c, sid]) => {
    if (!c || !sid) return;
    for (const t of TABS)
      for (const [key, s] of storiesOf(c, t.key))
        if (s.episodes.some((e) => e.sid === sid)) {
          tab.value = t.key;
          opened.value = new Set(opened.value).add(key);
          await nextTick();
          centerInScrollArea(list.value?.querySelector("[data-current]"), "instant");
          return;
        }
  },
  { immediate: true },
);
</script>

<template>
  <div class="flex h-full min-h-0 flex-col">
    <template v-if="catalog">
      <div class="flex flex-col gap-3 p-3 pb-2">
        <div class="flex rounded-full bg-muted p-1" role="tablist" aria-label="剧情类别">
          <button
            v-for="t in TABS"
            :key="t.key"
            role="tab"
            :aria-selected="tab === t.key"
            :class="
              cn(
                'h-7 flex-1 rounded-full text-[13px] font-bold transition-colors focus-visible:ring-2 focus-visible:ring-ring',
                tab === t.key ? 'bg-card text-foreground shadow-sm' : 'text-muted-foreground hover:text-foreground',
              )
            "
            @click="tab = t.key"
          >
            {{ t.name }}
          </button>
        </div>
        <div class="flex flex-wrap gap-1.5" role="group" aria-label="按团筛选">
          <button
            :class="cn('h-7 rounded-full border px-2.5 text-xs font-bold', !unit ? 'border-pink text-pink' : 'text-muted-foreground')"
            @click="unit = ''"
          >
            全部
          </button>
          <button
            v-for="u in UNITS"
            :key="u.key"
            :title="u.name"
            :class="
              cn(
                'inline-flex h-7 items-center gap-1.5 rounded-full border px-2.5 text-xs font-bold',
                unit === u.key ? 'border-pink text-pink' : 'text-muted-foreground hover:text-foreground',
              )
            "
            @click="unit = unit === u.key ? '' : u.key"
          >
            <span class="size-2 rounded-full" :style="{ background: u.color }" />{{ u.short }}
          </button>
        </div>
        <div class="relative">
          <Search class="pointer-events-none absolute top-1/2 left-3 size-4 -translate-y-1/2 text-muted-foreground" />
          <Input v-model="query" type="search" placeholder="搜索标题或剧情 ID" class="h-9 rounded-full pl-9" spellcheck="false" />
        </div>
      </div>
      <ScrollArea class="min-h-0 flex-1">
        <div ref="list" class="flex flex-col gap-2 px-3 pb-4">
          <p v-if="!rows.length" class="py-10 text-center text-sm text-muted-foreground">没有匹配的剧情</p>
          <div
            v-for="r in rows"
            :key="r.key"
            :class="cn('overflow-hidden rounded-xl border bg-card', r.cur && 'border-pink/60')"
          >
            <button
              class="relative flex w-full items-center gap-3 py-2 pr-3 pl-4 text-left focus-visible:bg-accent focus-visible:outline-none"
              :aria-expanded="r.open"
              @click="toggle(r.key)"
            >
              <span class="absolute inset-y-0 left-0 w-1" :style="{ background: unitColor(r.story.unit) ?? 'transparent' }" />
              <img v-if="r.story.logo" :src="img(r.story.logo)" alt="" loading="lazy" class="h-10 w-20 shrink-0 object-contain" @error="($event.target as HTMLElement).hidden = true" />
              <img v-else-if="r.story.thumb" :src="img(r.story.thumb)" alt="" loading="lazy" class="size-10 shrink-0 rounded-lg" @error="($event.target as HTMLElement).hidden = true" />
              <span class="flex min-w-0 flex-1 flex-col gap-0.5">
                <span class="line-clamp-2 text-[13px] leading-snug font-bold">{{ r.story.title }}</span>
                <span v-if="r.story.at" class="text-[11px] text-muted-foreground">{{ date(r.story.at) }}</span>
              </span>
              <ChevronDown :class="cn('size-4 shrink-0 text-muted-foreground transition-transform', r.open && 'rotate-180')" />
            </button>
            <ul v-if="r.open" class="border-t bg-muted/40">
              <li v-for="e in r.episodes" :key="e.sid">
                <button
                  :disabled="!e.ok"
                  :title="e.ok ? e.sid : `${e.sid}（素材树里没有这一集）`"
                  :data-current="e.sid === current ? '' : undefined"
                  :class="
                    cn(
                      'relative flex w-full items-center gap-2 border-b px-4 py-2 text-left last:border-b-0 hover:bg-card focus-visible:bg-card focus-visible:outline-none disabled:cursor-not-allowed disabled:opacity-40',
                      e.sid === current && 'bg-card text-pink',
                    )
                  "
                  @click="emit('pick', e.sid)"
                >
                  <span v-if="e.sid === current" class="absolute inset-y-0 left-0 w-1 bg-pink" />
                  <span class="flex min-w-0 flex-1 flex-col">
                    <span :class="cn('text-[11px] font-bold', e.sid === current ? 'text-pink' : 'text-muted-foreground')">{{ e.no }}</span>
                    <span class="text-[13px] leading-snug">{{ e.title }}</span>
                  </span>
                  <img v-if="e.thumb" :src="img(e.thumb)" alt="" loading="lazy" class="h-10 w-[72px] shrink-0 rounded-md object-cover" @error="($event.target as HTMLElement).hidden = true" />
                </button>
              </li>
            </ul>
          </div>
        </div>
      </ScrollArea>
    </template>

    <div v-else-if="loading" class="flex flex-1 items-center justify-center text-sm text-muted-foreground">正在读取剧情目录…</div>

    <div v-else class="flex flex-1 flex-col justify-center gap-4 p-6">
      <div v-if="!base">
        <h2 class="text-base font-extrabold">还没有剧情目录</h2>
        <p class="mt-1.5 text-sm leading-relaxed text-muted-foreground">
          目录和素材都来自你自己的素材服务器，本站不分发任何游戏素材。连上之后，这里会列出主线、活动、卡面等全部剧情。
        </p>
      </div>
      <div v-else>
        <h2 class="text-base font-extrabold">这个素材源没有剧情目录</h2>
        <p class="mt-1.5 text-sm leading-relaxed text-muted-foreground">
          目录要用 master 数据生成：启动素材服务器时带上 <code class="font-bold">--master</code>。现在也可以直接输入剧情 ID 播放。
        </p>
        <form class="mt-3 flex gap-2" @submit.prevent="sid.trim() && emit('pick', sid.trim())">
          <Input v-model="sid" placeholder="例如 event_107_01" class="h-9" spellcheck="false" aria-label="剧情 ID" />
          <Button type="submit" variant="secondary" :disabled="!sid.trim()">播放</Button>
        </form>
      </div>
      <div class="flex flex-col gap-2">
        <Button v-if="!base" @click="emit('settings')"><Server />连接素材服务器</Button>
        <Button variant="outline" @click="emit('open')"><FolderOpen />打开剧情 JSON</Button>
        <Button variant="ghost" @click="emit('sample')">播放示例剧情</Button>
      </div>
    </div>
  </div>
</template>
