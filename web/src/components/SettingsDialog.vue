<script setup lang="ts">
import { ref, watch } from "vue";
import { CircleCheck, CircleX, Copy, LoaderCircle } from "@lucide/vue";
import { toast } from "vue-sonner";
import type { Locale } from "pjsk-scenario-player";
import { Button } from "@/components/ui/button";
import { Dialog, DialogContent, DialogDescription, DialogFooter, DialogHeader, DialogTitle } from "@/components/ui/dialog";
import { Input } from "@/components/ui/input";
import { Label } from "@/components/ui/label";
import { Select, SelectContent, SelectItem, SelectTrigger, SelectValue } from "@/components/ui/select";
import { Switch } from "@/components/ui/switch";
import { LOCAL_SERVER, normalizeBase, settings } from "@/lib/settings";

const open = defineModel<boolean>("open", { required: true });

const assets = ref("");
const locale = ref<Locale>("zh");
const autoplay = ref(true);
watch(
  open,
  (o) => {
    if (!o) return;
    assets.value = settings.value.assets;
    locale.value = settings.value.locale;
    autoplay.value = settings.value.autoplay;
    check.value = undefined;
  },
  { immediate: true },
);

interface Check {
  manifest: number | null; // costume count
  catalog: number | null; // episode count
}
const check = ref<Check | "running">();

async function probe(url: string) {
  try {
    const r = await fetch(url);
    return r.ok ? await r.json() : null;
  } catch {
    return null;
  }
}
async function test() {
  const base = normalizeBase(assets.value);
  if (!base) return;
  check.value = "running";
  const [m, c] = await Promise.all([probe(`${base}model_manifest.json`), probe(`${base}catalog.json`)]);
  const eps = c
    ? [...c.unit.flatMap((u: any) => u.chapters), ...c.event, ...c.card, ...c.special, ...c.area].reduce(
        (n: number, s: any) => n + s.episodes.length,
        0,
      )
    : null;
  check.value = { manifest: m ? Object.keys(m).length : null, catalog: eps };
}

function save() {
  settings.value = { assets: normalizeBase(assets.value), locale: locale.value, autoplay: autoplay.value };
  open.value = false;
}

const command = "node server/cli.ts --root /path/to/asset-tree --master /path/to/master";
async function copy() {
  await navigator.clipboard.writeText(command);
  toast.success("命令已复制");
}
const isDev = import.meta.env.DEV;
</script>

<template>
  <Dialog v-model:open="open">
    <DialogContent class="max-h-[calc(100dvh-2rem)] grid-cols-[minmax(0,1fr)] overflow-y-auto sm:max-w-xl">
      <DialogHeader class="text-left">
        <DialogTitle>素材与播放设置</DialogTitle>
        <DialogDescription>
          本站只包含播放器本身。模型、语音、背景等游戏素材来自你自己的素材服务器，地址保存在这台设备的浏览器里。
        </DialogDescription>
      </DialogHeader>

      <div class="grid min-w-0 gap-5">
        <div class="grid gap-2">
          <Label for="assets-url">素材服务器地址</Label>
          <div class="flex gap-2">
            <Input id="assets-url" v-model="assets" placeholder="http://localhost:5174/" spellcheck="false" @keydown.enter="test" />
            <Button variant="outline" :disabled="!assets.trim() || check === 'running'" @click="test">
              <LoaderCircle v-if="check === 'running'" class="animate-spin" />测试
            </Button>
          </div>
          <div class="flex flex-wrap gap-1.5">
            <Button size="xs" variant="secondary" @click="assets = LOCAL_SERVER">本地素材服务器</Button>
            <Button v-if="isDev" size="xs" variant="secondary" @click="assets = '/assets/'">开发服务器 /assets/</Button>
            <Button size="xs" variant="ghost" @click="assets = ''">不使用素材</Button>
          </div>
          <ul v-if="check && check !== 'running'" class="grid gap-1 text-sm">
            <li class="flex items-center gap-2">
              <CircleCheck v-if="check.manifest" class="size-4 text-teal" /><CircleX v-else class="size-4 text-destructive" />
              {{ check.manifest ? `模型清单：${check.manifest} 套服装` : "读不到 model_manifest.json，角色不会出现" }}
            </li>
            <li class="flex items-center gap-2">
              <CircleCheck v-if="check.catalog" class="size-4 text-teal" /><CircleX v-else class="size-4 text-muted-foreground" />
              {{ check.catalog ? `剧情目录：${check.catalog} 集` : "没有 catalog.json，左侧目录不可用（仍可打开 JSON 或按 ID 播放）" }}
            </li>
          </ul>
        </div>

        <div class="grid min-w-0 gap-2 rounded-lg bg-muted p-3 text-sm">
          <p class="leading-relaxed">
            手上有 asset-updater 导出的素材树？在仓库里运行下面的命令，再把地址填成
            <code class="font-bold">{{ LOCAL_SERVER }}</code>：
          </p>
          <div class="flex min-w-0 items-center gap-2">
            <code class="min-w-0 flex-1 overflow-x-auto rounded-md bg-card px-2.5 py-1.5 text-xs whitespace-nowrap">{{ command }}</code>
            <Button size="icon-sm" variant="ghost" aria-label="复制命令" @click="copy"><Copy /></Button>
          </div>
        </div>

        <div class="grid grid-cols-[minmax(0,1fr)_auto] items-center gap-x-4 gap-y-4">
          <div>
            <Label>播放器界面语言</Label>
            <p class="text-xs text-muted-foreground">开始按钮和右上角菜单的文字</p>
          </div>
          <Select v-model="locale">
            <SelectTrigger class="w-32"><SelectValue /></SelectTrigger>
            <SelectContent>
              <SelectItem value="zh">中文</SelectItem>
              <SelectItem value="ja">日本語</SelectItem>
              <SelectItem value="en">English</SelectItem>
            </SelectContent>
          </Select>
          <div>
            <Label for="autoplay">选集后直接播放</Label>
            <p class="text-xs text-muted-foreground">关闭后每次都先显示开始按钮</p>
          </div>
          <Switch id="autoplay" v-model="autoplay" />
        </div>
      </div>

      <DialogFooter>
        <Button variant="ghost" @click="open = false">取消</Button>
        <Button @click="save">保存</Button>
      </DialogFooter>
    </DialogContent>
  </Dialog>
</template>
