# 配置驱动的 metadata 解析

「生成元数据」写出的 sidecar 由 **profile** 驱动，内置的 TECNAI 只是其中一条：一条 profile =
一条正则 + 具名捕获组 → 字段命名与类型 + 最终写进 frontmatter 的键顺序（`keyOrder`）。

schema 的唯一真相是 [`src/core/profiles.ts`](../src/core/profiles.ts) 的类型与 `DEFAULT_PROFILES`
（`ParseProfile` / `FieldSpec` / `DERIVED_KEYS` / `COMPUTED_KEYS` / `DEFAULT_ASK`）。设置页可增删 /
复制多条 profile（落进 `data.json` 的 `profiles` 数组）；右键 **Annex Gallery → 使用 Annex Gallery
管理** 的弹窗按 `match` 自动预选、并列出全部让人挑，profile 选择与 ask 值都按文件夹记住。

## 一条 profile 能给出的五类值

优先级（同名时前者盖后者）：解析 / pathFields > 常量 > 询问 > 派生 > 自动。

| # | 来源 | 说明 |
|---|---|---|
| ① | 解析 `regex` + `fields` | 具名捕获组 → 声明的键；`type: "number"` 写裸数字，默认 `text` 写双引号字符串。 |
| ② | 派生 | `tags`（相对 vault 的第一段路径）/ `session`（所在文件夹名）/ `date`（`session` 前 8 位 → `YYYY-MM-DD`，否则空串）。 |
| ③ | 自动 | `width` / `height`（`magick identify`）/ `size`（字节数）/ `btime`（文件 birthtime，**不是**拍摄时间）/ `thumbnail` / `tif`（都是 `"[[全 vault 路径]]"`）。 |
| ④ | 常量 `constFields` | 固定写入的键值。 |
| ⑤ | 询问 `ask` | 右键（**Annex Gallery** 子菜单 → 使用 Annex Gallery 管理）时弹窗现场填（内置默认 `["sample"]`），按文件夹记住上次的值。 |

## `keyOrder` 的语义

`keyOrder` 是**最终 frontmatter 的键顺序**：键只会按这个顺序写，**不在表里的键一律不写**（想加字段就
同时把它加进 `keyOrder`）。表里写了、但上面五种来源都取不到值的键**被省略**，并在这份 sidecar 的
detail 里记一句「keyOrder 里的 "X" 取不到值，已省略」（例如下面示例里的 `notes`）。

## 三条硬规则

1. `fields` 里**没列出的具名组 = 丢弃**。这是为了能把正则写成分支：两条路写进同一条正则，短的那条
   落进一个键、长的那条 token 只用来把正则配平、不落进任何键。
2. 组**没参与匹配**（可选组未命中）⇒ 写该字段的 `whenMissing`（默认空串，键位保留）。例如孔位段
   缺省时 `well: ""`。
3. 正则**完全不命中**时按 `onMismatch`：`empty`（字段写空值，报告里计入 `mismatch`，默认）/
   `skip`（跳过这张图）。另有 `pathRegex` + `pathFields` 跑在相对 vault 的路径上，**同名的键覆盖
   派生值**。

## 示例 1 —— 内置 TECNAI 电镜（`DEFAULT_PROFILES[0]`；文件名形态 `<specimen>-<marker>-<index>`）

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
`plate02_4000x_012` 没有孔位段 ⇒ 可选组未命中，`well: ""`。）

## 命令行

```bash
node tools/annex-gallery.mjs profiles --list
node tools/annex-gallery.mjs profiles --check [--profiles-file <json>]
node tools/annex-gallery.mjs profiles --parse <名字> [--path <相对路径>] [--profile <id>]
node tools/annex-gallery.mjs sidecar <dir> --vault <vaultRoot> --sample <name> --profile <id> \
  [--profiles-file <json>] [--apply|--verify]
```

`--profiles-file` 传 profile 数组或 `{ "profiles": [ … ] }`，不给就用内置 `DEFAULT_PROFILES`。
合成语料、两条 profile 与一键复跑脚本见 [`tools/cli.md`](tools/cli.md)。

## 判据

| 命令 | 钉住什么 |
|---|---|
| `npm run verify:sidecar` | 重跑语义：`--plan` 不写盘、默认只补缺失、`--overwrite` 覆盖重算、脏文件保护 |
| `npm run smoke` | 设置页的 profile 编辑器、解析预览、右键弹窗与落盘 |
| `npm test` | sidecar 与 annex 操作的组合场景（含内容逐字节不变的断言） |
