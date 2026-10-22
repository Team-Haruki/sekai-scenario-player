<script setup lang="ts">
import { computed, nextTick, ref, watch } from "vue";
import { useElementHover } from "@vueuse/core";
import { Search } from "@lucide/vue";
import type { ScenarioSceneData } from "pjsk-scenario-player";
import { scriptLines } from "pjsk-scenario-player";
import { Input } from "@/components/ui/input";
import { ScrollArea } from "@/components/ui/scroll-area";
import { centerInScrollArea, cn } from "@/lib/utils";

const props = defineProps<{
  scenario?: ScenarioSceneData;
  progress: number; // snippet index now playing
  icon: (character2dId?: number) => string | undefined;
}>();
const emit = defineEmits<{ jump: [index: number] }>();

const query = ref("");
const root = ref<HTMLElement>();
const hovering = useElementHover(root);
const lines = computed(() => (props.scenario ? scriptLines(props.scenario) : []));
const talks = computed(() => lines.value.filter((l) => l.kind === "talk").length);

// the last line at or before the current snippet
const current = computed(() => {
  let cur = -1;
  for (let i = 0; i < lines.value.length && lines.value[i].index <= props.progress; i++) cur = i;
  return cur;
});
const done = computed(() => lines.value.slice(0, current.value + 1).filter((l) => l.kind === "talk").length);

const shown = computed(() => {
  const q = query.value.trim().toLowerCase();
  return lines.value
    .map((l, i) => ({ ...l, i }))
    .filter((l) => !q || `${l.name}\n${l.body}`.toLowerCase().includes(q));
});

// highlight matches in the body
function parts(body: string) {
  const q = query.value.trim().toLowerCase();
  if (!q) return [{ t: body, hit: false }];
  const out: { t: string; hit: boolean }[] = [];
  const lower = body.toLowerCase();
  let i = 0;
  for (let j = lower.indexOf(q); j >= 0; j = lower.indexOf(q, i)) {
    out.push({ t: body.slice(i, j), hit: false }, { t: body.slice(j, j + q.length), hit: true });
    i = j + q.length;
  }
  out.push({ t: body.slice(i), hit: false });
  return out;
}

// follow playback unless the reader is looking around the list
watch(current, async (cur) => {
  if (query.value || hovering.value) return;
  await nextTick();
  centerInScrollArea(root.value?.querySelector(`[data-line="${cur}"]`));
});
</script>

<template>
  <div ref="root" class="flex h-full min-h-0 flex-col">
    <div class="flex items-center gap-3 p-3 pb-2">
      <div class="relative flex-1">
        <Search class="pointer-events-none absolute top-1/2 left-3 size-4 -translate-y-1/2 text-muted-foreground" />
        <Input v-model="query" type="search" placeholder="搜索台词或角色" class="h-9 rounded-full pl-9" spellcheck="false" />
      </div>
      <span class="shrink-0 text-xs font-bold text-muted-foreground tabular-nums">
        {{ query ? `${shown.length} 条` : `${done} / ${talks}` }}
      </span>
    </div>
    <div class="mx-3 mb-2 h-1 overflow-hidden rounded-full bg-muted">
      <div class="h-full rounded-full bg-pink transition-[width] duration-300" :style="{ width: `${talks ? (100 * done) / talks : 0}%` }" />
    </div>
    <ScrollArea class="min-h-0 flex-1">
      <p v-if="!lines.length" class="px-6 py-10 text-center text-sm text-muted-foreground">播放剧情后，台词会按顺序出现在这里，点一句就能跳过去。</p>
      <ol class="pb-4">
        <li v-for="l in shown" :key="l.index" :data-line="l.i">
          <button
            :class="
              cn(
                'relative flex w-full gap-3 px-4 py-2.5 text-left hover:bg-accent/60 focus-visible:bg-accent focus-visible:outline-none',
                l.i === current && 'bg-accent',
                l.i > current && !query && 'opacity-50',
              )
            "
            @click="emit('jump', l.index)"
          >
            <span v-if="l.i === current" class="absolute inset-y-0 left-0 w-1 bg-pink" />
            <template v-if="l.kind === 'talk'">
              <span class="relative mt-0.5 size-9 shrink-0 overflow-hidden rounded-full bg-muted">
                <span class="absolute inset-0 grid place-items-center text-xs font-bold text-muted-foreground">{{ l.name.slice(0, 1) }}</span>
                <img v-if="icon(l.character2dId)" :src="icon(l.character2dId)" alt="" loading="lazy" class="relative size-full" @error="($event.target as HTMLElement).hidden = true" />
              </span>
              <span class="min-w-0 flex-1">
                <span v-if="l.name" class="block text-xs font-extrabold text-muted-foreground">{{ l.name }}</span>
                <span class="block text-sm leading-relaxed whitespace-pre-line">
                  <template v-for="(p, k) in parts(l.body)" :key="k"><mark v-if="p.hit" class="bg-transparent text-pink">{{ p.t }}</mark><template v-else>{{ p.t }}</template></template>
                </span>
              </span>
            </template>
            <span v-else class="flex-1 rounded-md bg-muted px-3 py-1.5 text-xs font-bold text-muted-foreground">{{ l.body }}</span>
          </button>
        </li>
      </ol>
    </ScrollArea>
  </div>
</template>
