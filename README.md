# ObsidianPlugin-AnnexGallery

**一眼看到，而不是一层层点进去找。** Annex Gallery 把 git + git-annex 管的目录平铺成一面卡片墙：
一份数据一张卡，封面、名称与关键元数据并排铺开，按样品、日期、参数一筛就只剩你关心的那几张。

卡片有没有封面，取决于有没有缩略图：图片（`.tif` `.tiff` `.png` `.jpg` `.jpeg` `.bmp` `.webp`）
由插件直接生成缩略图与 sidecar；其他格式 —— Obsidian 打不开、也解析不了的那些 —— 你放一张同名缩略图、
把 sidecar 的 `thumbnail` 指向它，它就和图片一样出现在墙上。

墙底下仍然是那个 git + git-annex 仓库：右键对 annex 的大文件做 Add / Get / Drop / Lock / Unlock，
状态栏常驻显示未提交、未跟踪、未入库的数目，元数据由 profile 从文件名里抽（任意命名约定都只改配置）。
数据层一个字都不新造 —— 你在终端里 `git annex` 能做的事，装上插件之后照样能做。

## 安装

- Obsidian **1.14.4+**，**仅桌面版**（用到 Node / Electron API）。
- 本机要有 `git` 与 `git-annex`（插件通过子进程调它们）。
- 安装方式：社区插件目录搜索 **Annex Gallery**；或用 BRAT 添加本仓库；或从 release 下载
  `main.js` / `manifest.json` / `styles.css` 放进 `<vault>/.obsidian/plugins/annex-gallery/`。

首次使用：打开你的数据 vault → 命令面板跑 **初始化 gallery** → 插件把当前 vault 根整理成一个
git + git-annex 仓库（已经是仓库的不会重建，只补缺的步骤）。

## 用法速查

| 入口 | 你会看到 | 细节 |
|---|---|---|
| 命令面板 · **初始化 gallery** | 初始化/修正当前 vault 的仓库形态、规则文件与远端配置，可重复执行 | [`docs/commands.md`](docs/commands.md) |
| 文件管理器右键 · **Annex Gallery** | 9 个动作：生成元数据 / 生成缩略图 / 创建画廊 / Add / Unlock & unannex / Lock / Unlock / Get / Drop | [`docs/context-menu.md`](docs/context-menu.md) |
| 文件管理器右键 · **Annex Gallery → 创建画廊** | 生成 `<文件夹>/<文件夹名>.base`（vault 根 → `<vault name>.base`），成员 = 带 `annex-gallery-metadata` 标签的 sidecar，作用域递归、模板可换 | [`docs/gallery.md`](docs/gallery.md) |
| 状态栏（右下角） | **未提交 · 未跟踪 · 未入库 largefiles** 三个数，30 秒刷新、点一下立即刷新 | [`docs/status-bar.md`](docs/status-bar.md) |
| 设置页 | profile（文件名解析规则）编辑器、模板区（metadata / 画廊模板）、缩略图边长、remote 列表 | [`docs/setting-panel.md`](docs/setting-panel.md) |

## 开发入门

### 命令

```bash
npm install
npm run dev        # esbuild watch → main.js（开发时用）
npm run build      # 生产构建：main.js + tools/annex-gallery.mjs
npm run typecheck  # tsc --noEmit
npm test           # 数据安全：真 annex 仓库上的多场景集成测试
npm run smoke      # 桩环境加载构建产物：能否启用、入口形状、设置页
npm run layout     # 设置页布局（真实 app.css + headless Chromium）
```

完整的判据清单（哪条命令钉住什么）见 [`docs/tools/`](docs/tools/README.md)。

### 仓库结构

```
main.ts            插件入口：命令、状态栏、9 个右键菜单项、设置页接线
src/core/          核心逻辑（不依赖 Obsidian，插件与 CLI 共用）
                   init · rules · thumbnails · sidecar · gallery · templates · stems · annex · git · status · remotes
src/ui/            设置页、profile 编辑器、模板编辑器、remotes 编辑器、「打开」的外部编辑
src/defaults/      内置规则文件与模板（.gitattributes / .gitignore / metadata / base）
tools/             判据（桩层 / 真仓库层 / 真机层）、CLI、示例语料
tests/             数据安全测试（npm test）
docs/              设计与口径文档（见下）
```

### 构建产物与部署

- `npm run build` 产出 `main.js` 与 `tools/annex-gallery.mjs`，**两者都不入库**。
- 插件的三份发行物是 `main.js` / `manifest.json` / `styles.css`；装到 vault =
  拷进 `<vault>/.obsidian/plugins/annex-gallery/`，然后在 Obsidian 里重载插件。
- `manifest.json` 的 `version` 必须与 release 的 tag 逐字相等。

### 改动前先读哪一份

| 要改什么 | 先读 |
|---|---|
| 初始化命令 / annex 设置收敛 | [`docs/commands.md`](docs/commands.md) |
| 右键菜单的形状与语义 | [`docs/context-menu.md`](docs/context-menu.md) |
| 画廊（`.base`）的成员、作用域与模板 | [`docs/gallery.md`](docs/gallery.md) |
| 状态栏的三个数 | [`docs/status-bar.md`](docs/status-bar.md) |
| 设置页的布局与字段 | [`docs/setting-panel.md`](docs/setting-panel.md) |
| 文件名解析 / sidecar 字段 | [`docs/metadata.md`](docs/metadata.md) |
| 加一条判据或改工具 | [`docs/tools/`](docs/tools/README.md) |
| 为什么要这么设计 | [`docs/design.md`](docs/design.md) |

## 文档导航

| 文档 | 内容 |
|---|---|
| [`docs/design.md`](docs/design.md) | 设计原则、三条全局约定、文档里的占位符 |
| [`docs/commands.md`](docs/commands.md) | 「初始化 gallery」的职责边界、7 步、幂等契约、规则文件合并 |
| [`docs/context-menu.md`](docs/context-menu.md) | 右键菜单的形状原则、9 项语义、平台 API 边界与坑 |
| [`docs/gallery.md`](docs/gallery.md) | 画廊的成员资格（标签）、作用域、输出路径、`.base` / metadata 模板与命令行 |
| [`docs/status-bar.md`](docs/status-bar.md) | 三个计数的口径、刷新与交互不变量、视觉不变量 |
| [`docs/setting-panel.md`](docs/setting-panel.md) | 设置页的定位、不变量、结构落点、字段与默认值 |
| [`docs/metadata.md`](docs/metadata.md) | profile 的 schema、五类值、`keyOrder`、三条硬规则 |
| [`docs/tools/`](docs/tools/README.md) | 判据的设计原则与三层工具（桩 / 真仓库 / 真机） |
| [`docs/publish-checklist.md`](docs/publish-checklist.md) | 提交到 Obsidian 社区目录的硬要求与判据 |

## 许可

[MIT](LICENSE)
