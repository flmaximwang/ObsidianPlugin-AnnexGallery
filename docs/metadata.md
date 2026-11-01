# 元数据预设（preset）与 sidecar 渲染

「生成元数据」写出的 sidecar（`<stem>.md`）由**元数据预设**驱动：一条预设 =
一条正则 + 具名捕获组 → **frontmatter 字典**（键顺序、值类型、固定值都写在字典里）
+ 可选的正文模板（vault 里的 `.md`）。

schema 的唯一真相是 [`src/core/profiles.ts`](../src/core/profiles.ts) 的 `ParseProfile` /
`ValueType` / `PatternSource` / `BUILTIN_VARIABLES` / `DEFAULT_ASK`，加载与路径约束在
[`src/core/profile-files.ts`](../src/core/profile-files.ts)，渲染在
[`src/core/sidecar.ts`](../src/core/sidecar.ts)。

**预设从哪来（冻结口径）**：运行时的唯一来源是设置页「元数据预设」里登记的**外部 `.json` 文件** ——
**一份 JSON = 一条预设**，顶层必须是一条 `ParseProfile` 对象（数组、`{ "profiles": [...] }` 都不接受）。
`data.json` 里只存 `profileFiles: [{ path }]`（vault 相对路径）；`id` / `name` / `frontmatter` 一律以
文件内容为准。旧的内联 `profiles` 数组**不读、不迁移、不删除**（设置页只显示一条失效提示）。
右键 **Annex Gallery → 生成元数据** 的弹窗按 `match` 自动预选、并列出全部已登记的预设让人挑；
预设的选择与 ask 值都按文件夹记住。

## 一条预设的字段

```jsonc
{
  "id": "tecnaitem",                       // 必填：稳定机器 id（文件夹记忆 / 按 id 找一条用它当键）
  "name": "TECNAI 电镜（<放大倍数>X-<标记>-<序号>）", // 显示名；空则显示「（未命名）」
  "match": {                              // 可选：自动选中用（弹窗预选）
    "relpathRegex": "^2026-",             //   对相对 vault 的路径跑
    "filenameRegex": "^\\d+X-"            //   对文件名跑；两条都给了就都要命中
  },
  "source": "stem",                       // 主正则打在哪个串上：stem（默认）/ filename / relpath
  "regex": "^(?<magnification>\\d+)X-(?<marker>.+)-(?<index>\\d+)$",
  "flags": "",                            // 正则 flags，默认 ""（要忽略大小写自己写 "i"）
  "pathRegex": "^(?<session>[^/]+)/",     // 可选：再对相对 vault 的路径跑一条
  "types": { "magnification": "number" },// 变量名 → 输出类型：number / date / text（默认 text）
  "ask": ["sample"],                      // 需要现场填的变量；不写 = ["sample"]
  "onMismatch": "empty",                  // 正则不命中时：empty（照常生成）/ skip（跳过这张图）
  "frontmatter": {                        // 必填：最终写进 sidecar 开头的字典
    "tags": ["annex-gallery-metadata", "{{tags}}"]
  },
  "template": "AnnexGalleryTemplates/tecnaitem.md" // 可选：正文模板（vault 相对 .md）；"" = 只有 frontmatter
}
```

| 字段 | 必填 | 说明 |
|---|---|---|
| `id` | 是 | 稳定机器 id。跨文件重复 = 硬错误（错误里给出两处路径）。 |
| `name` | 否 | 人读名字，显示在设置页行与弹窗下拉里。为空只是警告（显示「（未命名）」）。 |
| `match` | 否 | `{ relpathRegex?, filenameRegex? }`，用来**自动选中**预设；命中的第一条胜出。 |
| `source` | 否 | 主正则的宿主串：`stem`（文件名去最后一个扩展名，默认）/ `filename`（含扩展名）/ `relpath`（相对 vault 的路径）。 |
| `regex` | 是 | 主正则。必须能编译；编译失败 = 硬错误。 |
| `flags` | 否 | 正则 flags，默认 `""`。`pathRegex` 用同一组 flags。 |
| `pathRegex` | 否 | 第二条正则，跑在**相对 vault 的路径**上。 |
| `types` | 否 | 变量名 → `"number"` / `"date"` / `"text"`。只影响「整串恰好是一个占位符」的值。 |
| `ask` | 否 | 要现场问的变量名数组；不写或写成空数组 = `["sample"]`。 |
| `onMismatch` | 否 | `"empty"`（默认，照常生成并记进报告）/ `"skip"`（跳过这张图，不写 sidecar）。 |
| `frontmatter` | 是 | 最终写进 sidecar 开头的字典；键顺序 = JSON 书写顺序。 |
| `template` | 否 | 正文模板的 vault 相对 `.md` 路径；`""` 或不写 ⇒ sidecar 只有 frontmatter。 |

## 变量从哪来

一个预设能给出的变量有四类。同名时按下表**后者盖前者**（`stem` 除外，它永远是文件名去扩展名）。

| # | 来源 | 说明 |
|---|---|---|
| ① | `regex` 的具名捕获组 | `(?<name>…)`。组没参与匹配（可选组未命中）⇒ 空值。 |
| ② | `pathRegex` 的具名捕获组 | 跑在相对 vault 的路径上；**同名覆盖 ①**。这一组没参与匹配时**不覆盖** ① 的值。 |
| ③ | `ask` 的现场填写 | 右键弹窗里现填，按文件夹记住上次填的值。 |
| ④ | 内置变量 | 见下表。 |

内置变量（`BUILTIN_VARIABLES`）：

| 变量 | 值 | 备注 |
|---|---|---|
| `stem` | 文件名去掉最后一个扩展名 | **不可覆盖**：正则组也叫 `stem` 时仍然取文件名。 |
| `tags` | 图片所在目录相对 vault 的**第一段路径** | 例如 `20260417-run/批次A/xxx.tif` ⇒ `20260417-run`。 |
| `session` | 图片所在文件夹名 | 例如 `批次A`。 |
| `date` | `session` 前 8 位数字 → `YYYY-MM-DD` | `session` 不是 `YYYYMMDD…` 开头 ⇒ 空值。 |
| `width` / `height` | `magick identify` 得到的像素宽高 | `magick` 失败 ⇒ 空值。 |
| `size` | 文件字节数 | |
| `btime` | 文件 birthtime，`YYYY-MM-DD HH:MM:SS` | **落盘时间**，不是拍摄时间。 |
| `thumbnail` | `[[<vault 相对路径>/<stem>.thumbnail.png]]` | |
| `tif` | `[[<vault 相对路径>/<原图文件名>]]` | |

## frontmatter 字典：键序与值

`frontmatter` 是**最终写到文件开头的那个字典**。插件自己把它序列化成 YAML，所以输出永远合法。

### 键顺序

键顺序 = **JSON 里的书写顺序**，一字不差。旧格式的 `keyOrder`（一份单独的键名清单）已经没有了：
顺序直接由字典的书写顺序决定，想调顺序就改 JSON 里的行序。

### 值可以是什么

任意 JSON：字符串 / 数字 / 布尔 / `null` / 列表 / 嵌套对象。**没有 `const`** ——
固定值、空串这些直接写在字典里就是固定值：

```jsonc
"frontmatter": {
  "tags": ["annex-gallery-metadata", "{{tags}}"],
  "instrument": "tem",          // 固定值：写死一个字符串
  "operator": "",               // 固定空串：空值统一写成 YAML null，并在报告里记一笔
  "width": "{{width}}",         // 变量
  "author": { "name": "{{sample}}", "org": "lab" },  // 嵌套对象
  "keywords": ["{{marker}}", "tem"]                   // 列表
}
```

### 字符串怎么变成 YAML

| 写法 | 结果 |
|---|---|
| 整串**恰好**是一个占位符 `"{{x}}"` | 按 `types[x]` 输出**带类型的标量**（见下表）。 |
| 占位符与文字混合 `"{{a}}X-{{b}}"` | 整体当**一个字符串**，双引号 + 转义。 |
| 纯字面量字符串 `"tem"` | 双引号 + 转义。 |
| 数字 / 布尔 | 裸写（`2048` / `true`）。 |
| 取不到值或值为空 | **保留这个键**，写成 YAML null（`key:`），并记进报告。 |
| 列表里的空项 | **整项丢弃**；一项都不剩时写成 `key: []`。 |

`types` 的三种输出形态：

| 类型 | 输出 | 条件 |
|---|---|---|
| `number` | 裸数字 | 值要像数字（`123` / `1.5` / `-3` / `.5`）；`0007` 会归一成 `7`。不像数字就退回双引号字符串。 |
| `date` | 裸写的日期 / 日期时间 | 值要像 `YYYY-MM-DD` 或 `YYYY-MM-DD HH:MM:SS`（用 `T` 分隔也认）。不像就退回双引号字符串。 |
| `text` | 双引号字符串 | 默认。转义由序列化器负责。 |

`types` **只作用于「整串恰好是一个占位符」的值**。字面量字符串不受 `types` 影响 ——
`"date": "2026-04-17"` 写出来是 `date: "2026-04-17"`（带引号），要裸写就得让它是占位符
（`"{{date}}"` + `types.date = "date"`）。

### 标签是硬规则

`frontmatter.tags` **必须**存在、**必须**是列表、**必须**含字面量 `annex-gallery-metadata` ——
画廊（`.base`）只靠它认 sidecar。插件**不再隐式注入**这个标签：删掉它，整批 sidecar 就会从所有
画廊里悄悄消失。少写 / 写错 ⇒ 该预设是硬错误，一份 sidecar 都不写。

想再加自己的标签，直接写在同一个列表里：

```json
"tags": ["annex-gallery-metadata", "{{tags}}"]
```

### 报告里会看到什么

每份 sidecar 都带一条 detail，写清这一份的异常（正常时没有）：

- `stem "xxx" 不符合预设 <id> 的正则` —— 主正则没命中（`onMismatch: "empty"` 时仍然生成）。
- `正则组没参与匹配：a,b` —— 可选组没命中。
- `空值（写成 YAML null）：sample` —— 取不到值或值为空的键。
- `列表里的空项已丢弃：keywords` —— 列表里有整项被丢掉。
- `没有来源的占位符：{{fooo}}` —— 占位符既不是捕获组、也不是 ask、也不是内置变量。

## 正文模板（`template`）

`template` 指向 vault 里的一个 `.md`，它是 sidecar 的**正文**（frontmatter 之后的全部内容）。
`""` 或不写 ⇒ sidecar 只有 frontmatter。

硬约束（违反 ⇒ 该预设是硬错误）：

- 路径必须是 **vault 相对路径**、必须在 vault 内、扩展名必须是 `.md`、文件必须存在；
- **不能自带 frontmatter**（文件不能以 `---` 开头）—— frontmatter 由预设的 `frontmatter` 字典生成，
  模板无权决定里面有哪些键。

正文里的占位符插入**原始文本**（不套引号、不转义、不带类型）：`{{thumbnail}}` / `{{tif}}` /
`{{stem}}` / `{{<任意变量>}}` 都行，取值与 frontmatter 同一套（捕获组 / ask / 内置变量）。
**取不到值的占位符替换成空串**（不留下 `{{fooo}}` 原文），并在这份 sidecar 的 detail 里记一条
「模板里的 `{{fooo}}` 取不到值，已留空」。

旧格式的 `{{frontmatter}}` **不再存在**：frontmatter 由预设的字典生成，正文模板只写正文。

## 校验：哪些是错误，哪些只是警告

| 级别 | 情形 |
|---|---|
| **错误**（阻断生成） | `frontmatter` 缺失或不是对象；`frontmatter.tags` 缺失 / 不是列表 / 不含 `annex-gallery-metadata` / 列表项不是字符串；`id` 为空；`regex` 为空或编译不过；`pathRegex` 不是字符串或编译不过；`types` 不是对象或值不是 `number`/`date`/`text`；`ask` 不是非空字符串数组；`onMismatch` 不是 `empty`/`skip`；`template` 不是字符串；正文模板读不了或自带 frontmatter；JSON 顶层不是一条预设对象（数组 / `{ "profiles": [...] }`）；**旧格式预设**。 |
| **警告**（不阻断） | `name` 为空；`types` 里的键不是任何已知变量；`frontmatter` 里的 `{{x}}` 没有来源；正文模板里的 `{{x}}` 没有来源。 |

**设置页逐行显示**：错误与警告都写在对应那一行下面（错误把整行标红，警告单独一行），
坏行照样能「打开」去修、也能「删除」取消登记。
**生成时**：任何一份已登记的预设带错误 ⇒ **整次生成在写盘之前停下**，错误里带具体文件路径；
不跳过坏条目、不静默回退到内置内容。

跨文件的硬错误还有两条：**id 重复**（错误里给出两处路径）与**同一路径重复登记**。

## 示例 1 —— TECNAI 电镜（内置预设素材 `tecnaitem`）

```jsonc
{
  "id": "tecnaitem",
  "name": "TECNAI 电镜（<放大倍数>X-<标记>-<序号>）",
  "source": "stem",
  "regex": "^(?<magnification>\\d+)X-(?<marker>.+)-(?<index>\\d+)$",
  "types": {
    "magnification": "number",
    "index": "number",
    "width": "number",
    "height": "number",
    "size": "number",
    "date": "date",
    "btime": "date"
  },
  "ask": ["sample"],
  "onMismatch": "empty",
  "frontmatter": {
    "tags": ["annex-gallery-metadata", "{{tags}}"],
    "sample": "{{sample}}",
    "session": "{{session}}",
    "date": "{{date}}",
    "magnification": "{{magnification}}",
    "index": "{{index}}",
    "width": "{{width}}",
    "height": "{{height}}",
    "size": "{{size}}",
    "btime": "{{btime}}",
    "thumbnail": "{{thumbnail}}",
    "tif": "{{tif}}"
  },
  "template": "AnnexGalleryTemplates/tecnaitem.md"
}
```

对 `20260417-run/1000X-abc-007.tif`（`--sample S-1`）生成出来的一份 sidecar：

```yaml
---
tags:
  - "annex-gallery-metadata"
  - "20260417-run"
sample: "S-1"
session: "20260417-run"
date: 2026-04-17
magnification: 1000
index: 7
width: 2048
height: 1536
size: 1048576
btime: 2026-04-17 12:34:56
thumbnail: "[[20260417-run/1000X-abc-007.thumbnail.png]]"
tif: "[[20260417-run/1000X-abc-007.tif]]"
---

缩略图：[[20260417-run/1000X-abc-007.thumbnail.png]]

原图（用系统默认程序打开）：[[20260417-run/1000X-abc-007.tif]]
```

注意三点：`index` 是 `"007"` 但写出来是裸数字 `7`（`types.index = "number"` 会归一）；
`date` / `btime` 是裸写的日期与日期时间；`tags` 的第一项是字面量 `annex-gallery-metadata`
（写在字典里，不是插件注入的）。

## 示例 2 —— 多孔板成像（与 TECNAI 完全不同的约定）

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
  "types": { "plate": "number", "magnification": "number", "index": "number", "date": "date", "width": "number", "height": "number", "size": "number" },
  "ask": ["sample"],
  "onMismatch": "empty",
  "frontmatter": {
    "tags": ["annex-gallery-metadata", "{{tags}}"],
    "sample": "{{sample}}",
    "session": "{{session}}",
    "date": "{{date}}",
    "plate": "{{plate}}",
    "well": "{{well}}",
    "magnification": "{{magnification}}",
    "index": "{{index}}",
    "instrument": "plate-reader",
    "width": "{{width}}",
    "height": "{{height}}",
    "size": "{{size}}",
    "thumbnail": "{{thumbnail}}",
    "tif": "{{tif}}"
  }
}
```

`plate01_wellA3_4000x_007` 跑出来（`--sample S-001`）：

```yaml
---
tags:
  - "annex-gallery-metadata"
  - "20260417-plate-run"
sample: "S-001"
session: "20260417-plate-run"
date: 2026-04-17
plate: 1
well: "A3"
magnification: 4000
index: 7
instrument: "plate-reader"
width: 2048
height: 1536
size: 1048576
thumbnail: "[[20260417-plate-run/plate01_wellA3_4000x_007.thumbnail.png]]"
tif: "[[20260417-plate-run/plate01_wellA3_4000x_007.png]]"
---
```

`plate02_4000x_012` 没有孔位段 ⇒ 可选组 `well` 没参与匹配 ⇒ `well:` 是 YAML null，
detail 记「正则组没参与匹配：well」「空值（写成 YAML null）：well」。
`instrument` 是**固定值**，直接写在字典里 —— 没有 `constFields` 这一层了。

## 内置预设素材（「从预设创建」）

设置页的「从预设创建…」会写出**两份**文件（同名加序号，不覆盖、不自动打开）：

| 预设 id | 写出的 JSON | 写出的正文 |
|---|---|---|
| `tecnaitem` | `AnnexGalleryTemplates/tecnaitem.json` | `AnnexGalleryTemplates/tecnaitem.md`（缩略图 + 原图两行） |
| `tecnaitem-embed` | `AnnexGalleryTemplates/tecnaitem-embed.json` | `AnnexGalleryTemplates/tecnaitem-embed.md`（`!{{thumbnail}}` 嵌入缩略图 + 原图链接） |
| `minimal` | `AnnexGalleryTemplates/minimal.json` | `AnnexGalleryTemplates/minimal.md`（只一行缩略图链接） |

JSON 里的 `template` 写成正文**实际**落盘的路径。素材原文在
[`src/defaults/presets/`](../src/defaults/presets/)；它们**只是素材**，不是运行时可直接使用的预设 ——
写进 vault 并登记之后才算数。

## 旧格式：不迁移，也不回退

2.0 及更早的预设（顶层带 `keyOrder` / `fields` / `constFields` / `pathFields` / `whenMissing` /
`metadataTemplate`）**不迁移、不改写、不删除**：文件原样留在 vault 里，加载时给出明确错误，
设置页据此显示非阻塞提示，引导用户用「从预设创建」生成新格式的 `.json`，再把字段手工搬过去。
旧的 metadata 模板登记表（`data.json` 的 `metadataTemplates`）同样不再被读取，旧正文文件也仍在 vault 里。

对照表：

| 旧字段 | 新字段 | 怎么搬 |
|---|---|---|
| `keyOrder` | `frontmatter` 的**键顺序** | 把清单里的键按同样顺序写进字典；不在清单里的键不写。 |
| `fields` | `types` + 字典里的占位符 | `type: "number"` ⇒ `types.<group> = "number"`；`type: "string"` ⇒ 不用写（默认 text）。 |
| `constFields` | 字典里的**固定值** | 直接写进 `frontmatter`（`"eagleId": ""`）。 |
| `pathFields` | `pathRegex` + 字典里的占位符 | 把路径正则搬进 `pathRegex`，同名组自动覆盖主正则的组。 |
| `whenMissing` | 取不到值就是 YAML null | 没有「缺省值」这一层：要么用 `pathRegex` / `ask` 补上，要么接受 null。 |
| `metadataTemplate` | `template` | 指向 vault 里那份正文 `.md`（正文模板不再单独登记）。 |
| `{{frontmatter}}`（旧正文模板的第一行） | 删掉 | frontmatter 由字典生成，正文模板只写正文。 |

迁移示例（TECNAI）：

**旧** —— 预设 `AnnexGalleryTemplates/tecnaitem.json`：

```jsonc
{
  "id": "tecnaitem",
  "name": "TECNAI 电镜",
  "source": "stem",
  "regex": "^(?<magnification>\\d+)X-(?<marker>.+)-(?<index>\\d+)$",
  "fields": [
    { "group": "magnification", "type": "number" },
    { "group": "marker", "type": "string" },
    { "group": "index", "type": "number" }
  ],
  "constFields": { "instrument": "tem" },
  "ask": ["sample"],
  "keyOrder": ["tags", "sample", "session", "date", "magnification", "marker", "index", "instrument"],
  "metadataTemplate": "default",
  "onMismatch": "empty"
}
```

旧正文模板 `AnnexGalleryTemplates/default.md`：

```markdown
{{frontmatter}}

缩略图：{{thumbnail}}

原图（用系统默认程序打开）：{{tif}}
```

**新** —— 预设 `AnnexGalleryTemplates/tecnaitem.json`：

```jsonc
{
  "id": "tecnaitem",
  "name": "TECNAI 电镜",
  "source": "stem",
  "regex": "^(?<magnification>\\d+)X-(?<marker>.+)-(?<index>\\d+)$",
  "types": { "magnification": "number", "index": "number" },
  "ask": ["sample"],
  "onMismatch": "empty",
  "frontmatter": {
    "tags": ["annex-gallery-metadata", "{{tags}}"],
    "sample": "{{sample}}",
    "session": "{{session}}",
    "date": "{{date}}",
    "magnification": "{{magnification}}",
    "marker": "{{marker}}",
    "index": "{{index}}",
    "instrument": "tem"
  },
  "template": "AnnexGalleryTemplates/tecnaitem.md"
}
```

新正文 `AnnexGalleryTemplates/tecnaitem.md`：

```markdown
缩略图：{{thumbnail}}

原图（用系统默认程序打开）：{{tif}}
```

三处变化：`keyOrder` 变成字典的书写顺序；`fields` 拆成 `types` + 占位符；
`{{frontmatter}}` 那行删掉（frontmatter 由字典生成）。

## 命令行

```bash
node tools/annex-gallery.mjs sidecar <dir> --vault <vaultRoot> --preset <file> [--preset <file> ...] \
  [--profile <id>] [--sample <name>] [--ask key=value] [--repo <root>] \
  [--apply] [--force] [--verify] [--json]

node tools/annex-gallery.mjs gallery <dir> --vault <vaultRoot> --preset <file> [--preset <file> ...] \
  [--template <base file>]

node tools/annex-gallery.mjs profiles --list | --check | --parse <name> --preset <file> [--preset <file> ...] \
  [--vault <root>] [--path <rel>] [--profile <id>]
```

CLI **只认 `--preset <file>`**：给的是**文件路径**（相对当前工作目录解析），
文件内容就是一条预设（顶层一个对象）。旧的 `--profiles-file` 与 `{ "profiles": [...] }` 格式没有了 ——
要给几条预设就重复给几次 `--preset`。
`--profile <id>` 从已给的预设里挑一条（`sidecar` 用它决定用哪条；`profiles --parse` 用它指定解析哪条）。
预设自己的 `template` 指向的正文 `.md` **从 `--vault` 解析**（vault 相对路径）。
`sidecar` 不再接受 `--template` —— 正文由预设自己决定。完整口径见 [`tools/cli.md`](tools/cli.md)。

## 判据

| 命令 | 钉住什么 |
|---|---|
| `npm run verify:sidecar` | 重跑语义：`--plan` 不写盘、默认只补缺失、`--overwrite` 覆盖重算、脏文件保护 |
| `npm run verify:gallery` | 标签：sidecar 的 `tags` 里恒有 `annex-gallery-metadata`；`.base` 的属性顺序跟随预设字典的键序 |
| `npm run smoke` | 外部预设 JSON 的登记 / 各种坏法（数组、`{ profiles: [...] }`、坏 JSON、坏正则、文件丢失、跨文件 id 重复）、旧格式预设的行内错误、运行时重读外部内容、坏文件在写盘前停下 |
| `npm test` | sidecar 与 annex 操作的组合场景（含内容逐字节不变的断言） |
