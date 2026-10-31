# 配置驱动的 metadata 解析

「生成元数据」写出的 sidecar 由 **profile** 驱动：一条 profile =
一条正则 + 具名捕获组 → 字段命名与类型 + 最终写进 frontmatter 的键顺序（`keyOrder`）。

schema 的唯一真相是 [`src/core/profiles.ts`](../src/core/profiles.ts) 的类型与 `DEFAULT_PROFILES`
（`ParseProfile` / `FieldSpec` / `DERIVED_KEYS` / `COMPUTED_KEYS` / `DEFAULT_ASK`）。

**profile 从哪来（冻结口径，spec-774d7ee）**：运行时的唯一来源是设置页登记的**外部 `.json` 文件** ——
**一份 JSON = 一条 profile**，顶层必须是一条 `ParseProfile` 对象。`data.json` 里只存
`profileFiles: [{ path }]`（vault 相对路径）；`id` / `name` / `regex` 一律以文件内容为准。
旧的内联 `profiles` 数组**不读、不迁移、不删除**（只在设置页显示一条失效提示）。
右键 **Annex Gallery → 生成元数据** 的弹窗按 `match` 自动预选、并列出全部已登记的 profile 让人挑，
profile 选择与 ask 值都按文件夹记住。

## 一条 profile 能给出的五类值

优先级（同名时前者盖后者）：解析 / pathFields > 常量 > 询问 > 派生 > 自动。

| # | 来源 | 说明 |
|---|---|---|
| ① | 解析 `regex` + `fields` | 具名捕获组 → 声明的键；`type: "number"` 写裸数字，默认 `text` 写双引号字符串。 |
| ② | 派生 | `tags`（相对 vault 的第一段路径）/ `session`（所在文件夹名）/ `date`（`session` 前 8 位 → `YYYY-MM-DD`，否则空串）。 |
| ③ | 自动 | `width` / `height`（`magick identify`）/ `size`（字节数）/ `btime`（文件 birthtime，**不是**拍摄时间）/ `thumbnail` / `tif`（都是 `"[[全 vault 路径]]"`）。 |
| ④ | 常量 `constFields` | 固定写入的键值。 |
| ⑤ | 询问 `ask` | 右键（**Annex Gallery** 子菜单 → 生成元数据）时弹窗现场填（预设默认 `["sample"]`），按文件夹记住上次的值。 |

## `keyOrder` 的语义

`keyOrder` 是**最终 frontmatter 的键顺序**：键只会按这个顺序写，**不在表里的键一律不写**（想加字段就
同时把它加进 `keyOrder`）。表里写了、但上面五种来源都取不到值的键**被省略**，并在这份 sidecar 的
detail 里记一句「keyOrder 里的 "X" 取不到值，已省略」（例如下面示例里的 `notes`）。

**唯一例外：`tags` 的第一项。** 每份 sidecar 的 `tags` 第一项永远是 `annex-gallery-metadata`
（`GALLERY_TAG`，画廊靠它认 sidecar），不论 `keyOrder` 里有没有 `tags`：有 `tags` 时标签排在
profile 给出的值前面；没有 `tags` 时仍会在最前面补一行 `tags:`，只带这一个标签。理由：成员资格若交给
`keyOrder` 决定，改一次 profile 就能让一批 sidecar 悄悄从所有画廊里消失。完整口径见
[`gallery.md`](gallery.md) §6。

## 三条硬规则

1. `fields` 里**没列出的具名组 = 丢弃**。这是为了能把正则写成分支：两条路写进同一条正则，短的那条
   落进一个键、长的那条 token 只用来把正则配平、不落进任何键。
2. 组**没参与匹配**（可选组未命中）⇒ 写该字段的 `whenMissing`（默认空串，键位保留）。例如孔位段
   缺省时 `well: ""`。
3. 正则**完全不命中**时按 `onMismatch`：`empty`（字段写空值，报告里计入 `mismatch`，默认）/
   `skip`（跳过这张图）。另有 `pathRegex` + `pathFields` 跑在相对 vault 的路径上，**同名的键覆盖
   派生值**。

## 示例 1 —— TECNAI 电镜（预设素材 `DEFAULT_PROFILES[0]`；文件名形态 `<specimen>-<marker>-<index>`）

```jsonc
{
  "id": "tecnaitem",
  "name": "TECNAI 电镜（<放大倍数>X-<标记>-<序号>）",
  "source": "stem",
  "regex": "^(?<magnification>\\d+)X-(?<marker>.+)-(?<index>\\d+)$",
  "fields": [
    { "group": "magnification", "type": "number" },
    { "group": "marker", "type": "string" },
    { "group": "index", "type": "number" }
  ],
  "constFields": { "eagleId": "" },
  "ask": ["sample"],
  "keyOrder": ["tags","sample","session","date","magnification","index","width","height","size","btime","thumbnail","tif"],
  "onMismatch": "empty"
}
```

`constFields.eagleId` 有声明、但 `keyOrder` 里没有它 —— 按硬规则它**不会**落进 frontmatter
（要写就把 `eagleId` 加回 `keyOrder`）。

## 示例 2 —— 多孔板成像（与 TECNAI 完全不同的约定；`tools/example-profiles/plate-profile.json`）

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

它跑出来的其中一份 sidecar（`plate01_wellA3_4000x_007.md`，`--sample <specimen>`；下面用占位符标的是
机器自动取的 `width` / `height` / `size` / `btime`，实际值是裸数字，不加引号）：

```
---
tags:
  - annex-gallery-metadata
  - 20260417-plate-run
sample: "<specimen>"
session: "20260417-plate-run"
date: 2026-04-17
plate: 1
well: "A3"
magnification: 4000
index: 7
instrument: "plate-reader"
width: <count>
height: <count>
size: <count>
btime: <timestamp>
thumbnail: "[[20260417-plate-run/plate01_wellA3_4000x_007.thumbnail.png]]"
tif: "[[20260417-plate-run/plate01_wellA3_4000x_007.png]]"
---

缩略图：[[20260417-plate-run/plate01_wellA3_4000x_007.thumbnail.png]]

原图（用系统默认程序打开）：[[20260417-plate-run/plate01_wellA3_4000x_007.png]]
```

（`notes` 没有任何来源 ⇒ 被省略，detail 记「keyOrder 里的 "notes" 取不到值，已省略」；同一批里
`plate02_4000x_012` 没有孔位段 ⇒ 可选组未命中，`well: ""`。`tags` 第一项是强制标签
`annex-gallery-metadata`，profile 派生的路径段跟在后面 —— 即使 `keyOrder` 里没有 `tags`，这一项也在。）

## metadata 模板（`metadataTemplate`）

profile 决定 frontmatter，**模板决定 sidecar 的整份文本**（frontmatter + 正文）。模板同样是
**vault 里的外部 `.md` 文件**，在设置页「模板」区登记；运行时只认登记过的文件，**没有内置兜底**。

profile 的 `metadataTemplate` 字段指定默认用哪份**已登记**的模板 id；不写等价于「用第一条已登记的」。
「生成元数据」弹窗里还有一个模板下拉框，优先级是**按文件夹记住的 > `profile.metadataTemplate` >
第一条已登记**。声明的 id 没登记（旧的内置 `default` / `embed` 也算）⇒ 直接报错并引导去登记，
**不静默回退到内置内容**。

模板的硬约束与占位符：

- **第一行必须是 `{{frontmatter}}`，且只能出现一次** —— frontmatter 只能写在文件开头，由 profile
  生成；模板决定不了里面有哪些键。不满足就让整批 sidecar 一份都不写（见下）。
- 正文占位符：`{{thumbnail}}` / `{{tif}}` / `{{stem}}`，以及 `{{<任意键>}}`。取值与 frontmatter
  同一套解析（解析 / 常量 / 询问 / 派生 / 自动），**包括不在 `keyOrder` 里的键** —— 例如一条 profile
  为了少写字段把 `thumbnail` 从 `keyOrder` 里省掉，正文照样拿得到它。
- 取不到值的占位符替换成空串，并在这份 sidecar 的 detail 里记「模板里的 `{{name}}` 取不到值，已留空」
  （笔误 `{{fooo}}` 同样处理）。**模板本身**坏了（文件不存在、第一行不是 `{{frontmatter}}`）才整体停下，
  不静默回退到内置默认。

预设素材有两份 metadata（`src/defaults/metadata/`，构建时内联，源码里只有这一份），它们**只是
「从预设创建」的素材**，不是运行时可直接使用的模板：

| 预设 id | 正文 |
|---|---|
| `default` | 与改造前硬编码的正文逐字节相同（缩略图链接 + 原图链接两行） |
| `embed` | `!{{thumbnail}}` 直接嵌入缩略图 + 原图链接 |

设置页的「从预设创建…」会把其中一份写成 vault 里的独立文件（`AnnexGalleryTemplates/default.md` 等），
登记之后才算数；同名再加序号（`default 2.md`），不覆盖、不自动打开。
选哪份、怎么登记，见 [`setting-panel.md`](setting-panel.md) 与 [`gallery.md`](gallery.md) §8。

## 命令行

```bash
node tools/annex-gallery.mjs profiles --list
node tools/annex-gallery.mjs profiles --check [--profiles-file <json>]
node tools/annex-gallery.mjs profiles --parse <名字> [--path <相对路径>] [--profile <id>]
node tools/annex-gallery.mjs sidecar <dir> --vault <vaultRoot> --sample <name> --profile <id> \
  [--profiles-file <json>] [--template <id|file>] [--apply|--verify]
```

`--profiles-file` 传 profile 数组或 `{ "profiles": [ … ] }`，不给就用 CLI 自带的 `DEFAULT_PROFILES`
（**CLI 的刻意例外**：命令行没有设置页可点，脚本场景要有开箱即用的默认值；插件运行时没有这个例外）。
`--template` 认 CLI 自带的预设 id（metadata：`default` / `embed`）或模板文件路径；不给 `--template`
等价于 `default`。CLI **不读** `data.json`，所以插件设置里登记的模板 id 在 CLI 不可用 ——
自定义模板直接给文件路径。
合成语料、两条 profile 与一键复跑脚本见 [`tools/cli.md`](tools/cli.md)。

## 判据

| 命令 | 钉住什么 |
|---|---|
| `npm run verify:sidecar` | 重跑语义：`--plan` 不写盘、默认只补缺失、`--overwrite` 覆盖重算、脏文件保护；插件路径在**登记了外部 profile / metadata 模板**之后才走得通 |
| `npm run verify:gallery` | 标签：`tags` 第一项恒为 `annex-gallery-metadata`（含 `keyOrder` 没有 `tags` 的 profile）；metadata 模板：预设 `default` 与改造前逐字节相同、`embed`、占位符缺值留空、坏模板整体停下 |
| `npm run smoke` | 外部 profile JSON 的登记 / 各种坏法（数组、`{ profiles: [...] }`、坏 JSON、坏正则、文件丢失、跨文件 id 重复）、运行时重读外部内容、坏文件在写盘前停下、设置页「模板」区（登记 / 从预设创建 / 打开 / 取消登记） |
| `npm run smoke` + `tools/example-profiles/verify-plugin-load.cjs` | 示例 profile 逐字节读回、外部改动即时生效、旧内联 profiles 不迁移不参与运行时 |
| `npm test` | sidecar 与 annex 操作的组合场景（含内容逐字节不变的断言） |
