# ObsidianPlugin-AnnexGallery

把「侧车式图片库」做成 Obsidian 插件的仓库：在同一文件夹里为每张图产出 `<stem>.thumbnail.png`（缩略图）
与 `<stem>.md`（元数据 sidecar），再用 `.base` 的 cards 视图当图片浏览器；数据层仍是 **git + git-annex**。

本仓库同时收配套 skill [`obsidian-image-gallery`](skills/obsidian-image-gallery/SKILL.md) —— 它记录侧车模式
的字段形状、两个必踩的坑（annex 软链被 Obsidian 静默丢弃、链接必须写全 vault 路径）与交付前验证。

**可见性**：远端已创建 —— GitHub `flmaximwang/ObsidianPlugin-AnnexGallery`（**private**），remote 已是 SSH 形式
`git@github.com:flmaximwang/ObsidianPlugin-AnnexGallery.git`，`main` 已推送（2026-10-08 起）。
选 private 是因为仓库里带课题绝对路径与样品名；要公开只需 `gh repo edit --visibility public`。

## 开发计划（loomerto）

本仓库的开发计划住在仓库里，就是本仓库的基石：

```
plans/annex-gallery-plugin/
├── plan.json     唯一真相（任务图 + 块文档 + 事件日志）
├── PLAN.md       人读摘要（自动生成）
├── plan.html     离线看板（自动生成，file:// 打开即可）
└── plan.canvas   Obsidian JSON Canvas（自动生成）
```

```bash
# 看现在该谁动 / 图质量 / 手动重渲三视图（plan 库不在默认位置，所以要给 --plans-root）
loomerto --plans-root plans current annex-gallery-plugin
loomerto --plans-root plans check   annex-gallery-plugin
loomerto --plans-root plans render  annex-gallery-plugin
# 要动手改就开可编辑画布（只绑 127.0.0.1）
loomerto --plans-root plans open annex-gallery-plugin
```

**别手改** `PLAN.md` / `plan.html` / `plan.canvas`（下一次落盘就覆盖）；状态与文档一律走 `loomerto`。
当前 22 个块 / 7 条泳道；三个原先待拍板的块已由用户 2026-10-08 拍板并落进下文规格：
`T-002#B-001`（初始化 gallery 作用于哪个目录 = 当前打开的 vault 根）、`T-003#B-001`（缩略图边长 = 256×256）、
`T-007#B-002`（GitHub 远端已建：private + SSH）。

## 插件规格（待实现 —— 用户 2026-10-08 口径）

| # | 入口 | 行为 |
|---|---|---|
| 1 | 注册命令 | **初始化 gallery**：把**当前打开的 vault 根**（运行时取 `app.vault.adapter.getBasePath()`）初始化为 1 个用 git + git-annex 管理的 repo。目标目录**已经是 git 仓库**时**不重建、不覆盖**：跳过 `git init`，只补缺的那几步（必要时 `git annex init`，再合并两条规则文件）。 |
| 2 | 右键文件夹菜单 | **生成缩略图**：为该文件夹中所有的图片生成 `.thumbnail.png` 缩略图。默认边长 **256×256**（可在插件设置页调整 `thumbnailEdge`；约定与 `.base` 的 `cardSize` 一致）。 |
| 3 | 右键文件夹菜单 | **使用 Annex Gallery 管理**：为该文件夹中的图片生成 `.md` 元数据，供 `.base` 查找 |
| 4 | 插件设置 | 可修改 `.gitattributes` 与 `.gitignore`（默认值见下） |

### 插件设置页（字段与默认值）

| 字段 | 默认值 | 说明 |
|---|---|---|
| 缩略图边长（`thumbnailEdge`） | `256` | 生成 `.thumbnail.png` 的边长（px）；建议与 `.base` 的 `cardSize` 保持一致。 |
| `.gitattributes` 路径（`gitattributesPath`） | 空 ⇒ `<vault>/.gitattributes` | 合并目标文件；留空即用当前 vault 根下的 `.gitattributes`。 |
| `.gitignore` 路径（`gitignorePath`） | 空 ⇒ `<vault>/.gitignore` | 合并目标文件；默认内容只有一行 `.obsidian`。 |
| 默认样品名（`defaultSample`） | 空 | 命令 3 写 sidecar `.md` 时填进 `sample` 字段的默认值；为空时命令 3 会先提示填写。按文件夹记住上一次用过的名字（`folderSamples`）。 |

**写入语义是「合并」**：逐行比对规则（去首尾空白、把连续空白压成一个空格后比较），目标文件里**已有的行一字不改、
不动顺序**，只把缺的规则追加到末尾；重复运行**幂等**（不多写一个字节）。两条规则文件的默认内容是插件内置模板
（`src/defaults/gitattributes`、`src/defaults/gitignore`），与真实数据仓库那份**逐字一致**。

内置默认 `.gitattributes`（与真实数据仓库 `Data_lab_10/.gitattributes` **逐字节一致**；文件结尾**无换行符**）：

```gitattributes
# 默认都进 annex
*               annex.largefiles=anything
# 缩略图不进 annex
*.thumbnail.png annex.largefiles=nothing
# .md 作为每个文件的 metadata, 进 git
*.md            annex.largefiles=nothing
# .base 作为文件展示的视图，进 git
*.base          annex.largefiles=nothing
```

## 配置驱动的 metadata 解析

metadata 生成不再是「TECNAI 专用」，改成由**可配置的 profile** 驱动：一条 profile = 一条正则 + 具名捕获组 →
字段命名与类型 + 最终写进 frontmatter 的键顺序（`keyOrder`）。schema 的唯一真相在
[`src/core/profiles.ts`](src/core/profiles.ts) 的类型与 `DEFAULT_PROFILES`
（`ParseProfile` / `FieldSpec` / `DERIVED_KEYS` / `COMPUTED_KEYS` / `DEFAULT_ASK`）。设置页可增删 / 复制多条 profile
（落进 `data.json` 的 `profiles` 数组）；右键「使用 Annex Gallery 管理」的弹窗按 `match` 自动预选、并列出全部让人挑，
profile 选择与 ask 值都按文件夹记住。

### 一条 profile 能给出的五类值

优先级（同名时前者盖后者）：解析 / pathFields > 常量 > 询问 > 派生 > 自动。

| # | 来源 | 说明 |
|---|---|---|
| ① | 解析 `regex` + `fields` | 具名捕获组 → 声明的键；`type: "number"` 写裸数字，默认 `text` 写双引号字符串。 |
| ② | 派生 | `tags`（相对 vault 的第一段路径）/ `session`（所在文件夹名）/ `date`（`session` 前 8 位 → `YYYY-MM-DD`，否则空串）。 |
| ③ | 自动 | `width` / `height`（`magick identify`）/ `size`（字节数）/ `btime`（文件 birthtime，**不是**拍摄时间）/ `thumbnail` / `tif`（都是 `"[[全 vault 路径]]"`）。 |
| ④ | 常量 `constFields` | 固定写入的键值。 |
| ⑤ | 询问 `ask` | 右键时弹窗现场填（内置默认 `["sample"]`），按文件夹记住上次的值。 |

### `keyOrder` 的语义

`keyOrder` 是**最终 frontmatter 的键顺序**：键只会按这个顺序写，**不在表里的键一律不写**（想加字段就同时把它加进
`keyOrder`）。表里写了、但上面五种来源都取不到值的键**被省略**，并在这份 sidecar 的 detail 里记一句
「keyOrder 里的 "X" 取不到值，已省略」（例如下面示例里的 `notes`）。

### 三条硬规则

1. `fields` 里**没列出的具名组 = 丢弃**。这是为了能把正则写成分支，例如内置 TECNAI 的
   `(?:(?<lens>\d{1,2})|(?<lensToken>[0-9A-Za-z]+))` —— 短的走 `lens`，长的那个 `lensToken` 只为把正则配平、不落进任何键。
2. 组**没参与匹配**（可选组未命中）⇒ 写该字段的 `whenMissing`（默认空串，键位保留）。例如孔位段缺省时 `well: ""`。
3. 正则**完全不命中**时按 `onMismatch`：`empty`（字段写空值，报告里计入 `mismatch`，默认）/ `skip`（跳过这张图）。
   另有 `pathRegex` + `pathFields` 跑在相对 vault 的路径上，**同名的键覆盖派生值**。

### 示例 1 —— 内置 TECNAI 电镜（`DEFAULT_PROFILES[0]`，逐字节复现改造前行为）

```jsonc
{
  "id": "tecnaitem",
  "name": "TECNAI 电镜（<放大倍数>X-<视野号|会话后缀>-<序号>）",
  "source": "stem",
  "regex": "^(?<magnification>\\d+)X-(?:(?<lens>\\d{1,2})|(?<lensToken>[0-9A-Za-z]+))-(?<index>\\d+)$",
  "fields": [
    { "group": "magnification", "type": "number" },
    { "group": "lens", "type": "number", "whenMissing": "\"\"" },
    { "group": "index", "type": "number" }
  ],
  "constFields": { "eagleId": "" },
  "ask": ["sample"],
  "keyOrder": ["tags","sample","session","date","magnification","lens","index","width","height","size","eagleId","btime","thumbnail","tif"],
  "onMismatch": "empty"
}
```

### 示例 2 —— 多孔板成像（与 TECNAI 完全不同的约定；`tools/example-profiles/plate-profile.json`）

```jsonc
{
  "id": "platewell",
  "name": "多孔板成像（plate01_wellA3_4000x_007）",
  "match": {
    "relpathRegex": "plate\\d+(?:_well[A-Z]\\d+)?_\\d+x_\\d+\\.(?:png|tif|tiff|jpg|jpeg|bmp|webp)$",
    "filenameRegex": "^plate\\d+(?:_well[A-Z]\\d+)?_\\d+x_\\d+"
  },
  "source": "stem",
  "regex": "^plate(?<plate>\\d+)(?:_well(?<well>[A-Z]\\d+))?_(?<magnification>\\d+)x_(?<index>\\d+)$",
  "fields": [
    { "group": "plate", "type": "number" },
    { "group": "well", "type": "text", "whenMissing": "" },
    { "group": "magnification", "type": "number" },
    { "group": "index", "type": "number" }
  ],
  "constFields": { "instrument": "plate-reader" },
  "ask": ["sample"],
  "keyOrder": ["tags","sample","session","date","plate","well","magnification","index","instrument","notes","width","height","size","btime","thumbnail","tif"],
  "onMismatch": "empty"
}
```

它跑出来的其中一份 sidecar（`plate01_wellA3_4000x_007.md`，`--sample plate-demo`）：

```
---
tags:
  - 20260417-plate-run
sample: "plate-demo"
session: "20260417-plate-run"
date: 2026-04-17
plate: 1
well: "A3"
magnification: 4000
index: 7
instrument: "plate-reader"
width: 1024
height: 1024
size: 3340
btime: 2026-10-08 14:24:48
thumbnail: "[[20260417-plate-run/plate01_wellA3_4000x_007.thumbnail.png]]"
tif: "[[20260417-plate-run/plate01_wellA3_4000x_007.png]]"
---

缩略图：[[20260417-plate-run/plate01_wellA3_4000x_007.thumbnail.png]]

原图（用系统默认程序打开）：[[20260417-plate-run/plate01_wellA3_4000x_007.png]]
```

（`notes` 没有任何来源 ⇒ 被省略，detail 记「keyOrder 里的 "notes" 取不到值，已省略」；同一批里 `plate02_4000x_012`
没有孔位段 ⇒ 可选组未命中，`well: ""`。）

### 命令行

```bash
node tools/annex-gallery.mjs profiles --list
node tools/annex-gallery.mjs profiles --check [--profiles-file <json>]
node tools/annex-gallery.mjs profiles --parse <名字> [--path <相对路径>] [--profile <id>]
node tools/annex-gallery.mjs sidecar <dir> --vault <vaultRoot> --sample <name> --profile <id> [--profiles-file <json>] [--apply|--verify]
```

`--profiles-file` 传 profile 数组或 `{ "profiles": [ … ] }`，不给就用内置 `DEFAULT_PROFILES`。合成语料、两条 profile
与一键复跑脚本在 [`tools/example-profiles/`](tools/example-profiles/README.md)。

## 索引

| skill | 用途 | 可执行入口 |
|---|---|---|
| [obsidian-image-gallery](skills/obsidian-image-gallery/SKILL.md) | 用 Bases 在 Obsidian 里做图片浏览器（缩略图 + sidecar md + cards 视图） | —（纯流程 / 方法论；命令在正文） |

装进 Hermes（三段式标识符，按仓库内路径，**不需要 tap**；`--category` 只决定落点）：

```bash
hermes skills install "flmaximwang/ObsidianPlugin-AnnexGallery/skills/obsidian-image-gallery" --category obsidian -y
```

安装时会 pin 到当时的 commit，之后 `hermes skills check` / `hermes skills update <name>` 直接可用。

### 插件源码与 CLI

| 入口 | 相对路径 |
|---|---|
| 插件主入口 | `main.ts`（四入口注册 + 设置页接线；`npm run build` 打成 `main.js`） |
| 核心逻辑 | `src/core/init.ts` · `rules.ts` · `thumbnails.ts` · `sidecar.ts` · `stems.ts` · `git.ts`（不依赖 Obsidian，插件与 CLI 共用） |
| 设置页 | `src/ui/settings.ts`（字段定义与 `DEFAULT_SETTINGS`） |
| 内置默认模板 | `src/defaults/gitattributes` · `src/defaults/gitignore` |
| CLI 源码 | `tools/cli.ts` |

CLI 走同一套核心逻辑、脱离 Obsidian 跑。构建产物 `tools/annex-gallery.mjs` 由 `npm run build` 生成、**不入库**：

```bash
node tools/annex-gallery.mjs init    <dir> [--dry-run] [--json]
node tools/annex-gallery.mjs thumbs  <dir> [--edge 256] [--dry-run] [--force] [--json]
node tools/annex-gallery.mjs sidecar <dir> --vault <vaultRoot> --sample <name> [--repo <root>] [--apply] [--force] [--json]
node tools/annex-gallery.mjs stems   <dir> [--json]
node tools/annex-gallery.mjs defaults          # 打印插件内置的 .gitattributes 模板
```

**当前状态**：远端已创建（`flmaximwang/ObsidianPlugin-AnnexGallery`，private，`main` 已推送）；插件本体尚未发布到
Obsidian 社区市场。`obsidian-image-gallery` 目前仍以手拷副本存在于 default 与 `plasmid-engineer` 两个 profile，
**迁移完成后会走 hub 安装并清掉手拷副本**（profile 收敛是另一块，需用户发话）。

## skills/obsidian-image-gallery

一图三件套（`<stem>.tif` / `<stem>.thumbnail.png` / `<stem>.md`，同目录同 stem），`.base` 只读 sidecar 的
frontmatter，正文 `![[…thumbnail.png]]` 给 Obsidian 一个能渲染的 cover（`.tif` 它渲染不了）。

已实测的两个坑：

- **git-annex 工作树里的软链会被 Obsidian 静默丢弃**（`realpath` 落在 vault 根内即跳过）⇒ `[[…tif]]` 永远解析不到。
  首选解法 `annex.thin true` + `git annex unlock`（会改用户数据仓库语义，须先确认）。
- **缩略图必须按全 vault 路径链接**：显微图像 stem 跨会话重名（实测 118 个 basename 里 48 个被 >1 条笔记共用）。

交付前的五步验证（frontmatter 解析、双链目标存在、缩略图同一几何、`.base` 的 cards 视图带 `image: note.thumbnail`、
hub 笔记不带画廊 tag）都在 [SKILL.md](skills/obsidian-image-gallery/SKILL.md) 正文。
