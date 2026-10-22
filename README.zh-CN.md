# PJSK Scenario Player

在浏览器里还原《プロジェクトセカイ カラフルステージ！ feat. 初音ミク》的剧情播放。给它一份剧情 JSON（游戏的 `ScenarioSceneData`），它就按游戏的时间线规则播放 Live2D 角色、对话、语音、BGM 和各种转场特效。

[English](README.md)（`docs/` 下的详细文档和 CONTRIBUTING 为英文）

- **贴近游戏**：时间线、站位、口型、渐变等逻辑都来自对游戏二进制的逆向，并对照游戏内录屏校准。
- **可嵌入**：一个不依赖框架的 TypeScript 库，几行代码就能接进任何前端项目。
- **不含素材**：仓库和预览站都不分发任何游戏素材，素材由你自己的服务器提供。

## 快速开始

需要 Node.js 22.18 或更高版本。

```bash
git clone https://github.com/Team-Haruki/sekai-scenario-player.git
cd sekai-scenario-player
npm install
npm run dev            # 预览站：http://localhost:5173
```

不连接素材时，预览站会播放自带的示例剧情（只有文字和转场）。要播放真实剧情，需要准备素材，见下一节。

## 准备素材

播放器从一个**素材根地址**按固定目录结构取文件（[docs/assets.md](docs/assets.md)）。最省事的方式是用 asset-updater 导出的素材树启动自带的素材服务器：

```bash
node server/cli.ts --root /path/to/jp-assets --master /path/to/master
# → http://localhost:5174/
```

然后在预览站右上角的素材设置里填 `http://localhost:5174/`。开发时也可以直接：

```bash
SEKAI_ASSET_ROOT=/path/to/jp-assets SEKAI_MASTER_DIR=/path/to/master npm run dev
```

已经整理好的素材可以放在仓库根目录的 `assets/` 下（已 gitignore），开发服务器会把它挂在 `/assets/`。

## 作为库使用

```bash
npm i github:Team-Haruki/sekai-scenario-player pixi.js@^7.4
```

```ts
import { createPlayer } from "pjsk-scenario-player";

const player = createPlayer("#stage", { assets: "http://localhost:5174/" });
player.on("progress", ({ index, total }) => console.log(index, "/", total));
await player.load("event_107_01");
```

完整的选项、方法、事件和素材解析规则见 [docs/api.md](docs/api.md)。

## 预览站

`web/` 是用 Vue 3 + shadcn-vue 写的预览站，也是库的完整使用示例，包含：

- 剧情目录：主线、活动、卡面、特别、区域对话，可按团筛选、搜索；
- 带搜索和跳转的台词列表；
- 拖入或打开本地剧情 JSON；
- 素材源设置；
- 深色模式和移动端布局。

```bash
npm run build:web      # → dist/site/，可直接部署到任意静态托管
```

仓库带有 GitHub Pages 部署工作流（`.github/workflows/pages.yml`）。部署出去的站点只包含播放器和示例剧情，访问者在设置里填自己的素材服务器地址即可；也可以用 `?assets=<url>&scenario=<id>` 分享链接。

## 当前进度

主线、活动、卡面剧情中常见的 action 和特效都已实现。尚未实现的有：

- 分支选项（Selectable）和改名输入；
- MV 播放；
- 部分 Sound 模式；
- 角色前后层级。

完整清单和实现细节见 [docs/internals.md](docs/internals.md)。发现和游戏不一致的地方，欢迎带上剧情 ID 和位置提 issue。

## 常用命令

| 命令 | 作用 |
|---|---|
| `npm run dev` | 预览站开发服务器 |
| `npm run typecheck` | 库、服务器、预览站的类型检查 |
| `npm run build` | 构建库（`dist/lib`）和预览站（`dist/site`） |
| `npm run serve:assets -- --root …` | 启动独立素材服务器 |

## 参与开发

见 [CONTRIBUTING.md](CONTRIBUTING.md)。

## 许可与声明

代码以 [MIT](LICENSE) 许可发布。

这是一个非官方的粉丝项目，与 SEGA、Colorful Palette、Crypton Future Media 无关。「プロジェクトセカイ」及相关的角色、剧情、模型、音乐、图像、字体等素材的权利归各自权利方所有；本仓库不包含、也不分发这些素材，请勿把它们提交到本仓库或公开传播。

对话框字体使用 Adobe 的[思源黑体](https://github.com/adobe-fonts/source-han-sans)（SIL Open Font License 1.1，`fonts/` 目录），以替代游戏所用的商业字体。

Live2D 模型渲染使用 [pixi-live2d-display-mulmotion](https://github.com/Sekai-World/pixi-live2d-display)（MIT）和 Live2D Cubism Core。Cubism Core 由 Live2D Inc. 依其[专有软件许可](https://www.live2d.com/eula/live2d-proprietary-software-license-agreement_en.html)提供，本仓库不包含它。
