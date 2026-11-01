# 画廊（`.base`）与「创建画廊」

> 这份文档的**唯一口径**：一个文件夹怎么变成一面画廊 —— 成员资格怎么定义、作用域怎么写死、
> 模板能改什么、不能改什么、写坏了怎么失败。右键菜单的形状见 [`context-menu.md`](context-menu.md)，
> sidecar 的字段与键序见 [`metadata.md`](metadata.md)，模板设置在设置页的落点见
> [`setting-panel.md`](setting-panel.md)。
> 判据：`npm run verify:gallery`（真仓库层）+ `npm run smoke`（桩层）。
> 路径、数量一律用占位符（`<folder>` / `<vault>` / `<vault name>` / `<id>`）。

## 1. 定位：画廊是一次查询，不是一份目录清单

一个 Obsidian `.base` 文件 = 对笔记集合的一次查询。画廊就是**「这个文件夹里的 sidecar」这一次查询**
的产物：封面取 sidecar 的 `thumbnail`，筛选取 frontmatter 里的键。由此得到三条契约：

1. **成员 = sidecar，不是「文件夹里所有 `.md`」** —— 目录里还有普通笔记、模板、README，它们不是数据。
2. **作用域 = 文件夹（递归）+ 标签** —— 由插件写死在顶层 `filters` 里，模板改不掉（§5）。
3. **产物 = 一个派生文件，只有一个 owner** —— 只由「创建画廊」写；它不重算 sidecar、不动正文
   （唯一的例外是「补标签」，见 §6）。

这条「一个派生文件一个 owner」与 [`design.md`](design.md) 第 1 条原则同源：缩略图归「生成缩略图」，
sidecar 归「生成元数据」，`.base` 归「创建画廊」。任何一个入口重跑都不该让另一个入口的产物漂移。

## 2. 四条设计原则

1. **认标签，不认文件名。** 画廊成员资格的唯一判据是 sidecar 带 `annex-gallery-metadata` 标签。
   不按 `<stem>.md` 的命名认（任何 `.md` 都可能是笔记），也不按所在目录认（画廊要递归，目录里混着笔记）。
   标签跨预设稳定：换一条元数据预设、改一次 frontmatter 字典的键序，已有的 sidecar 照样在画廊里。
2. **作用域钉死在插件这一层，模板只能收窄。** 顶层 `filters` 永远先写
   `file.inFolder(<folder>)` 与 `file.hasTag("annex-gallery-metadata")`，模板自己的 `filters` 被
   **并进去**当作第三个条件。抄来一份模板也不会把范围放宽到整个 vault；模板作者想「不要文件夹限制」
   也没有入口。
3. **模板是数据，坏了大声失败。** 画廊模板是 vault 里的外部 `.base` 文件，
   预设原文只作「从预设创建」的素材；模板文本不塞进 `data.json`。模板本身坏了（文件没了、
   `.base` 填完不是合法 YAML）就**整体停下并指名文件**，不静默回退到内置默认 ——
   回退会把「模板坏了」伪装成「画廊是空的」。
4. **先看再写，缺件不阻断。** 点开先只读盘点（sidecar 数 / 旧 sidecar 数 / 缺件数），只有真的需要
   用户表态时才弹窗；缺 sidecar 或缺缩略图只报告并给出下一步命令，不阻止 `.base` 落盘。

## 3. 菜单入口

「创建画廊」是 `Annex Gallery` 子菜单的**第 3 项**，落在「生成类」组里、紧跟「生成缩略图」之后
（子菜单因此是 9 项；完整顺序见 [`context-menu.md`](context-menu.md)）：

```
├─ 生成元数据                      file-text
├─ 生成缩略图                      image
├─ 创建画廊 / Create Gallery       layout-grid
├─ Add largefiles to Annex         package-plus
…
```

- **标题跟随 Obsidian 的界面语言**：界面语言以 `zh` 开头时是 `创建画廊`，其余一律 `Create Gallery`。
  **只有这一项做本地化**，其它 8 项固定英文 —— 它们是 annex 的操作名，中文标题反而和 `git annex`
  对不上。
- 图标 `layout-grid`，与「生成类」里另外两项的 `file-text` / `image` 同属 Obsidian 内置 Lucide 图标。
- 作用域只到文件夹：右键**文件**不出现本插件任何选项（与整条菜单同一条边界）。

## 4. 产物：写到哪里、已存在怎么办

输出路径只由「右键的那个文件夹」决定：

| 右键的文件夹 | 写出的文件 |
|---|---|
| `<folder>`（vault 内的子文件夹） | `<folder>/<folder 名>.base` |
| vault 根 | `<vault name>.base`（`<vault name>` = vault 根目录名） |

两种情况都是**派生文件**：文件名随文件夹名走，不另行询问；同一文件夹再点一次就是同一个文件。

- **已存在时先问**，三选一：**覆盖**（用当前模板重写）/ **打开已有**（一个字节都不写，直接打开）/
  **取消**。没有「静默覆盖」这条路径。
- 写完/打开后**立即在 Obsidian 里打开**这个 `.base` —— 创建画廊的验收标准是「看见卡片墙」，
  不是「盘上多了一个文件」。
- `.base` 与 `.md` / `.thumbnail.png` 一样**必须留在 git 里**（`.gitattributes` 的
  `annex.largefiles=nothing`）：被 annex 变成软链之后 Obsidian 会静默不索引，画廊会静默失效
  （[`design.md`](design.md) 第 2 条原则）。

## 5. 作用域：顶层 `filters` 由插件生成

模板填完占位符后，插件把作用域并进顶层 `filters`，形状永远是：

```yaml
filters:
  and:
    - file.inFolder("<folder>")
    - file.hasTag("annex-gallery-metadata")
    - <模板自己的 filters，若有>
```

契约：

1. **文件夹条件递归**：`file.inFolder` 本身包含子文件夹（递归），所以子目录里的 sidecar 自动在画廊里；
   模板里**不要**再写 `file.folder == "<folder>"`，那会把子文件夹排除掉。
2. **vault 根没有 `file.inFolder`**：根目录的 `{{folder}}` 是空串，`inFolder("")` 没有意义，
   于是只写 `file.hasTag(...)` + 模板自己的 `filters` —— 根画廊的作用域因此是**整个 vault**。
3. **模板自己的 `filters` 原样并进去**（作为 `and` 的第三项），因此它可以是一个 `or`、一个
   `and`、或任何合法表达式 —— 无论如何都只能在前两个条件之内收窄。
4. **作用域在前、模板在后**：模板就算删掉自己的 `filters` 也去不掉作用域；反过来，模板写什么
   `filters` 都盖不掉前两项。
5. 模板顶层必须是**映射**，且含 `views` 列表；`filters` 可省略。不满足即模板错误（§8.3）。

## 6. 标签：画廊的成员资格

标签名是 `annex-gallery-metadata`（`src/core/sidecar.ts` 的 `GALLERY_TAG`）。**每一份 sidecar 的
`tags` 里都必须有它**，而这份标签由**元数据预设自己写** —— 预设的 `frontmatter.tags` 必须是一个列表，
且含这个字面量（`validateProfile` 会检查，不满足就是硬错误，一份 sidecar 都不写）。

**插件不再隐式注入这个标签。** 理由：成员资格一旦交给别的机制决定，改一次预设就可能让一批 sidecar
悄悄从所有画廊里消失；让预设显式写出来，改动看得见、也校验得住。

```jsonc
"frontmatter": {
  "tags": ["annex-gallery-metadata", "{{tags}}"]   // 第一项是字面量，第二项是内置变量
}
```

想加自己的标签，直接写进同一个列表即可；`{{tags}}` 是内置变量（图片所在目录相对 vault 的第一段路径），
不加也行 —— 标签列表里只有 `annex-gallery-metadata` 也完全合法。

### 旧 sidecar：补标签

改造前生成的 sidecar 有 `tif` 键、没有这个标签。创建画廊的**只读预检**会把它们数出来
（判据：无标签 + 有 `tif`），弹窗三选一：

| 选择 | 做什么 |
|---|---|
| **补标签** | 给每份旧 sidecar 在 `tags` 第一项插入 `annex-gallery-metadata`，然后继续创建画廊 |
| **跳过** | 不碰这些 sidecar，直接创建画廊 —— 它们留在画廊之外，下次还能再补 |
| **取消** | 整体停下：一份 `.base` 都不写 |

两个弹窗同时命中时（既有旧 sidecar，`.base` 又已存在），**先问标签、再问覆盖** —— 先定成员，再定文件。

补标签是**文本级最小改动**，不经 YAML 重写：

- `tags:` 块列表已存在 ⇒ 在列表最前面插一项，缩进跟已有项一致；
- `tags:` 不存在 ⇒ 在最前面补 `tags:` + 一项；
- `tags:` 是行内值（`tags: a` / `tags: [a, b]`）⇒ 只把这一行改写成块列表，值不变；
- 已经带标签 ⇒ 原样返回（幂等）；没有 frontmatter ⇒ 不是 sidecar，不碰。

别的键的引号、顺序、注释、空行**一个字节都不动**；不按元数据预设重算、不改正文。理由：旧 sidecar
可能有用户手写的内容，重写 YAML 会把「只加一个标签」变成一次不可见的格式迁移。

## 7. 先看再写：预检与报告

预检只读（不写盘、不碰 git），数出五项：

| 计数 | 含义 | 非零时报告里给的建议 |
|---|---|---|
| `images` | 目录内（递归）的源图片数 | — |
| `tagged` | 已带标签的 sidecar 数 = 画廊里会出现的卡片数 | `0` 时如实写 0（空画廊是合法结果） |
| `untagged` | 有 `tif`、没标签的旧 sidecar 数 | 走 §6 的「补标签 / 跳过 / 取消」 |
| `missingSidecars` | 有图、没有同名 `<stem>.md` 的份数 | 先跑「生成元数据」 |
| `missingThumbnails` | sidecar 旁边没有同名 `<stem>.thumbnail.png` 的份数 | 先跑「生成缩略图」 |

「缺件」只写进最终报告，**不拦截**：一张图没有 sidecar 就不在画廊里，一张 sidecar 没有缩略图就没有
封面 —— 这是查询的自然结果，不是错误。报告用数字说清「画廊现在有几张卡、缺哪一步」，让人自己去补齐。

## 8. 模板

模板一律是**纯文本 + 占位符**：`{{name}}` 形式，取不到值就替换成空串并把名字记进报告
（笔误 `{{fooo}}` 也一样 —— 不让一个拼写错误把整批生成弄失败）。模板本身坏了才整体停下。

### 8.1 画廊模板（`.base`）

画廊模板一律是**设置页登记过的 vault 内 `.base` 文件**。预设素材只有一份（`src/defaults/base/default.base`），
它的语义是固定的：

| 项 | 值 |
|---|---|
| 视图 | 一个 `cards` 视图，名字 `Gallery` |
| `order` | `[file.name]` —— 卡片只显示文件名 |
| 封面 | `image: note.thumbnail`（sidecar 的 `thumbnail` 指到哪张，卡片就用哪张） |
| 比例 / 填充 | `imageAspectRatio: 1`、`imageFit: contain` |
| `cardSize` | 等于设置里的**缩略图边长**（两者必须一致，见 [`design.md`](design.md) 的三条贯穿约定第 2 条） |
| 排序 | `file.name` 升序 |

可用占位符：

| 占位符 | 值 | 备注 |
|---|---|---|
| `{{folder}}` | 画廊所在文件夹的 vault 相对路径（vault 根为空串） | 要不要加引号由模板决定；根目录填空串 |
| `{{cardSize}}` | 设置里的缩略图边长（数字） | 用于 `cardSize:` |
| `{{properties}}` | sidecar 里实际出现过的 frontmatter 键，**按已加载预设的 frontmatter 字典键序排序**（预设顺序优先，先出现的预设说了算），字典里都没有的键按首次出现顺序排在最后 | 渲染成 JSON 数组 —— 合法 YAML 流式列表，键名带逗号/括号/中文都安全 |

`{{properties}}` 的用途是让模板不用硬编码字段清单（例如把它放进 `order:`），换了预设之后
画廊跟着变；键只统计**被画廊认作 sidecar 的 `.md`**（带标签的，或旧式带 `tif` 的），普通笔记不算。

**选哪一份模板**：可用模板 = 设置里登记过的外部 `.base` 文件（**没有内置兜底**）。一条都没有 ⇒
直接停下并引导去登记或「从预设创建」；只有一条时直接用；多于一条时先问选哪份，选择**按文件夹记住**
（`folderBaseTemplates`），下次同一文件夹预选上次那份；记住的 id 已失效（例如旧的内置 `default`）
⇒ 用第一条已登记的。

### 8.2 sidecar 的正文模板（由元数据预设指定）

sidecar 的正文**不再单独登记**：它由每条元数据预设的 `template` 字段指向 vault 里的 `.md`。
换预设就换正文，「生成元数据」弹窗里**没有模板下拉框**。

- 正文 `.md` 必须存在、必须是 vault 相对路径、扩展名必须是 `.md`，且**不能自带 frontmatter**
  （frontmatter 由预设的 `frontmatter` 字典生成，正文模板无权决定里面有哪些键）。
- 正文可用 `{{thumbnail}}` / `{{tif}}` / `{{stem}}` / `{{<任意变量>}}`，取值与 frontmatter 同一套
  （捕获组 / ask / 内置变量）；取不到值的占位符替换成空串并记进报告。
- 预设没写 `template`（或写成 `""`）⇒ sidecar 只有 frontmatter。

完整口径见 [`metadata.md`](metadata.md)。

### 8.3 模板的失败口径

| 情形 | 结果 |
|---|---|
| 模板文件不存在 / 读不了 | 停下，Notice 指名模板的 vault 路径 |
| 正文模板（预设的 `template`）自带 frontmatter | 停下，整批 sidecar 一份都不写 |
| `.base` 填完占位符后不是合法 YAML | 停下，Notice 指名模板文件与解析错误 |
| `.base` 顶层不是映射，或没有 `views` 列表 | 停下 |
| 某个占位符取不到值（含笔误） | **不失败**：替换成空串，报告里记一条「模板里的 `{{name}}` 取不到值，已留空」 |
| 一个画廊模板都没登记 | 停下，Notice 引导去登记或「从预设创建」 |

前四行是「模板本身坏了」，第五行是「数据不全」。两者分开处理：坏模板修模板，缺值修数据，
不要用一个静默回退把两者混成「画廊看起来是空的」。

## 9. 结构落点

| 位置 | 承担什么 |
|---|---|
| `src/core/gallery.ts` | `planGallery()` 只读盘点；`addGalleryTag()` 文本级补标签；`buildGalleryBase()` 填占位符 → YAML 校验 → 并作用域；`galleryFilePath()` 输出路径；`orderProperties()` 键排序（按已加载预设的 frontmatter 字典键序） |
| `src/core/templates.ts` | 画廊模板 id / 预设素材 / 已登记清单（`TemplateRef`）/ `listTemplates()`（只有登记项）/ `resolveTemplate()`（**无内置兜底**）/ `fillPlaceholders()`（从 `placeholders.ts` 转出） |
| `src/core/placeholders.ts` | `{{name}}` 占位符的解析与替换（frontmatter 字典 / 正文模板 / `.base` 共用） |
| `src/core/external-files.ts` | 外部文件（元数据预设 `.json` / 正文模板 `.md` / 画廊模板 `.base`）的路径规范化与校验（vault 相对路径、扩展名、存在性） |
| `src/core/profile-files.ts` | 外部元数据预设 JSON 的读取（单对象约束、跨文件 id 重复、坏 JSON、坏正则、旧格式） |
| `src/core/sidecar.ts` | `GALLERY_TAG`；frontmatter 字典 → YAML 的渲染；正文模板的占位符填充 |
| `src/core/presets.ts` | 元数据预设素材（`tecnaitem` / `tecnaitem-embed` / `minimal`，各带一份正文） |
| `src/defaults/presets/*.json`、`src/defaults/presets/*.body.md`、`src/defaults/base/*.base` | **预设素材** ——「从预设创建」的原料，不是运行时可用文件 |
| `src/ui/templates-editor.ts` | 设置页「画廊模板」区：登记外部 `.base` / 从预设创建（写 `AnnexGalleryTemplates/<id>.base`）/ 打开 / 取消登记 |
| `src/ui/profile-editor.ts` | 设置页「元数据预设」区：登记外部 `.json` / 从预设创建（写 JSON + 正文两份）/ 打开 / 取消登记 |
| `src/ui/settings.ts` | `profileFiles` / `baseTemplates` / `folderBaseTemplates` 与两个区的顶层落点 |
| `main.ts` | 子菜单第 3 项、标题本地化、预检 → 弹窗 → 写 `.base` → 打开 |
| `scripts/cli.ts` | `gallery` 子命令（同一套 core；dry-run 默认；`--template` 给 `.base` 文件路径） |
| `tools/verify-gallery.cjs` | 判据侧，不是运行时 |
| `esbuild.config.mjs` | `defaults-text` 插件把 `defaults/presets/*.body.md`、`defaults/base/*.base` 内联成字符串（与 `.gitattributes` 同一条路） |

## 10. 命令行

```bash
# 画廊：dry-run 默认；--apply 才落盘
node tools/annex-gallery.mjs gallery <dir> --vault <vaultRoot> --preset <file> [--preset <file> ...] \
  [--template <base file>] [--edge <n>] [--apply] [--overwrite] [--fix-tags] [--json]

# sidecar：正文由预设自己的 template 决定，CLI 不再接受 --template
node tools/annex-gallery.mjs sidecar <dir> --vault <vaultRoot> --preset <file> [--preset <file> ...] \
  [--profile <id>] [--sample <name>] [--ask key=value] [--apply] [--force] [--verify] [--json]
```

| 选项 | 语义 |
|---|---|
| `--preset <file>` | 一条元数据预设的 `.json` 文件路径（相对当前工作目录解析），顶层是一条预设对象；要给几条就重复给几次。`{{properties}}` 的键序按它们的前后顺序排。 |
| `--template <base file>` | 画廊 `.base` 模板的**文件路径**；给了但找不到即报错，不回退。不给时用 CLI 自带的画廊预设 `default`（插件运行时没有这个兜底）。 |
| `--profile <id>` | 从 `--preset` 给的预设里挑一条（`sidecar` 用它决定用哪条；`profiles --parse` 用它指定解析哪条）。 |
| `--edge <n>` | `{{cardSize}}` 的值；不给用插件默认的缩略图边长（与设置页默认一致） |
| `--apply` | 真正写 `.base`（以及 `--fix-tags` 的标签）；不给就是 dry-run，不写任何文件 |
| `--overwrite` | 与 `--apply` 同用：`.base` 已存在时覆盖；不给则按「已存在」报错退出（连补标签也不做） |
| `--fix-tags` | 给旧 sidecar 补标签（等价于弹窗里的「补标签」）；必须与 `--apply` 同用，dry-run 下传它会直接报错 |
| `--json` | 机器可读报告：`plan`（五项计数 + `untagged` 列表）、`properties`、`target`、`text`、`missing`、`wrote`、`fixedTags` |

退出码表态：有失败（坏模板、已存在未 `--overwrite`、写盘失败）即非零退出 —— 便于在脚本里串联。
CLI 不读 `data.json`，所以插件设置里登记的外部文件在 CLI 不可用 —— 直接给文件路径。
**这是插件与 CLI 的刻意差别**：插件运行时只认登记过的外部文件（没有内置兜底），CLI 是脚本场景、
没有设置页可点，所以用 `--preset <file>` / `--template <file>` 直接给路径。
完整口径见 [`tools/cli.md`](tools/cli.md)。

## 11. 判据（可复跑）

| 命令 | 钉住什么 |
|---|---|
| `npm run verify:gallery` | sidecar：预设的 `frontmatter.tags` 恒含 `annex-gallery-metadata`、正文模板占位符缺值留空、坏模板整体停下且不写任何 sidecar。画廊：预检五项计数；补标签的**文本级最小改动**与幂等（除插入的那一项外逐字节不变）；作用域合并（模板 `filters` 被并进 `and`、删不掉前两项）；输出路径（子文件夹 / vault 根）；重复 `--apply` 的保护与 `--overwrite`；CLI 的 dry-run / `--fix-tags` / 坏 `.base` 模板 |
| `npm run smoke` | 桩环境：子菜单 9 项的**顺序与图标**、`创建画廊` / `Create Gallery` 的标题选择（含 `language=en` 时只有第 3 项变）、设置页「画廊模板」区（登记 / 从预设创建 / 打开 / 取消登记）、创建画廊的弹窗（选模板 / 已存在 `.base` / 旧 sidecar / 坏模板）、**坏元数据预设在写 `.base` 前停下** |
| `npm run build` + `npm run typecheck` | 两份产物可生成、类型不塌 |
| 截图 + 人眼 | `.base` 打开后的卡片观感、`cardSize` 与缩略图是否同尺寸 —— 这部分没有自动判据 |

判定统一是**脚本全绿（`FAIL=0`）**，不是断言条数。

## 12. 边界与陷阱

1. **`.base` 必须进 git。** 靠 `*.base annex.largefiles=nothing`；被 annex 接管成软链后 Obsidian
   **静默不索引**，画廊会变成空的 —— 不是「没匹配到」，是查询根本没加载。
2. **作用域里的路径是 vault 相对、正斜杠。** 不写绝对路径：macOS 上 `/var` 与 `/private/var` 两种写法
   会让同一个目录看起来在 vault 外（[`context-menu.md`](context-menu.md) §5.4 同因）。
3. **递归交给 `inFolder`，不要自己加文件夹等值条件。** 模板里写 `file.folder == "<folder>"` 会把
   子文件夹排除，与「递归」口径相反。
4. **标签是成员资格，不是展示用的徽章。** 预设的 `frontmatter.tags` 必须是一个列表且含字面量
   `annex-gallery-metadata`，少写就是硬错误（整批 sidecar 都不写）。插件不再隐式注入这个标签 ——
   成员资格写在预设里，改动看得见、也校验得住。
5. **补标签不能走 YAML 重写。** 重写会改引号、顺序、注释；旧 sidecar 可能有手写内容。这条与「只加
   一个标签、别的字节不动」的承诺冲突，必须以文本级实现，并由一条逐字节对比的断言钉住。
6. **`{{properties}}` 用 JSON 编码。** 键名可能带逗号、括号、中文；手写 YAML 列表会在这些键名上崩。
   JSON 数组同时是合法的 YAML 流式列表，所以两种视角都对。
7. **`cardSize` 与缩略图边长必须一致。** 不一致会把封面放大、发虚（[`design.md`](design.md) 的
   三条贯穿约定第 2 条）；默认模板从 `{{cardSize}}` 取设置值，自定义模板不要写死数字。
8. **登记的模板 id 由文件名生成。** 预设 id（画廊 `default`）不是注册项，所以不会与登记项撞名；
   登记项之间撞名（小写、非字母数字转 `-`）时自动加 `-2` / `-3`，不让两份同名模板互相顶掉。
9. **坏模板不回退。** 静默回退到内置默认会把「模板第一行写错了」显示成「画廊是空的」；Notice 必须
   指名是哪份模板、哪一个文件。
10. **vault 根的特殊形状。** `{{folder}}` 是空串、作用域里没有 `inFolder`；模板给 `folder` 加引号时
    得到的是 `""`，不是 `/`。
