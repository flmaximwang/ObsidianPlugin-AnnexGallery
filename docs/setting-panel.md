# Settings panel 设计说明

## 1. 定位

**管什么**

- 设置页的**顶层顺序**：从标题到最后一条普通设置项，各区块的落点与前后关系；
- 区块内部的几何**关系式**：左边缘对齐、上下间隙相等、跨行同列、撑满内容宽、不横向溢出；
- 控件的行为契约：工具条三个入口、每行（外部文件）的打开 / 取消登记、remote 行的增删与落盘、
  「模板」区的登记 / 从预设创建 / 打开 / 取消登记、「初始化 gallery」对 remote 的写入语义；
- 每条契约由哪条命令钉住、钉到什么程度。

**不管什么**

- 解析引擎本身（正则怎么匹配、字段怎么进 frontmatter）的算法；
- 主题配色、字体、截图观感 —— 这部分没有自动判据，只能人眼看；
- git 远端的网络行为：remote 只写配置，不 fetch、不 push。

本文件**不含任何随环境变化的具体数值**。像素、耗时、坐标随主题与窗口尺寸变化，写进来既会过期也会误导；
判据一律是「相等 / 对齐 / 同序 / 撑满」这类关系式，命令与配置里的路径一律是占位符
（`/Users/<user>`、`<vault>`、`<ms>`）。

## 2. 设计原则

1. **版式只写关系，不写绝对值。** 任何「某元素该多宽」都表述成它与容器或相邻元素的关系；绝对值只出现在
   一次性防护上（如宽度上限），且要能说清上限防的是什么。
2. **app 的默认值必须显式压掉。** `.vertical-tab-content` 里的 h1/h3 被隐藏、带行内边距，是核心设置页的
   假设，不是本页的意图；每一处都要在本页样式里显式写回，并且写在能赢过它的特异度上。
3. **一行控件靠自身伸缩规则分配空间。** 富余空间交给 auto 外边距吸收，收窄交给 `min-width: 0` +
   宽度上限；不写死像素宽度，也不靠容器宽度算术。
4. **特异度写在选择器里，不靠加载顺序。** 与 app.css 同权重时谁在样式表后面谁赢 —— 那是构建产物与
   app 版本的偶然，不作为设计依据。
5. **设置里只存指针。** 模板与文件名匹配模板的**正文永远在 vault 的文件里**；`data.json` 只记
   `{ path }` / `{ id, name, path }`，不抄内容、不缓存内容。
6. **写盘保守。** 坏文件不落进任何「已登记」状态；批量写（扫描、初始化）只做幂等的最小改动。

## 3. 设想的运行状态

打开设置页（`AnnexGallerySettingTab.display()`），内容区自上而下恰好是这一段：

```
<h1 class="annex-settings-title">Annex Gallery Settings</h1>        ← 内容区第一个元素，下方无说明
┌ .annex-remotes-card ────────────────────────────────────────────┐
│ remote 设置                                                      │
│ 「初始化 gallery」会逐个 git remote add / set-url…                 │
│ [名称: <remote>] [地址: ssh://<host>/<volume>/<path>] [删除]      │  ← 一行一条，可多条
│ [名称: <remote>] [地址: /Volumes/<volume>/<path>]     [删除]      │
│ [添加 remote]                                                     │
└─────────────────────────────────────────────────────────────────┘
─────────────────── HR.annex-remotes-divider（remote ↔ 模版）───────────────────
┌ .annex-profiles-section ─────────────────────────────────────────┐
│ [.annex-profile-path-input（vault 相对 .json 路径）] [登记]        │  ← 工具条：输入 + 登记 + 从预设创建
│ [.annex-profile-preset ▾]                                        │
│ TECNAI 电镜（…）  id: <id>  Profiles/<file>.json      [打开][删除] │  ← 一行一份外部 JSON
│ 多孔板成像（…）  id: <id>  Profiles/<file>.json      [打开][删除] │
│ <该文件坏了时的错误说明（整行宽）>                                 │  ← 只有坏的那一行有
└─────────────────────────────────────────────────────────────────┘
┌ .annex-templates-section ────────────────────────────────────────┐
│ ┌ .annex-templates-card[data-kind=metadata] ────────────────────┐ │
│ │ metadata 模板                                                 │ │
│ │ 一行说明：第一行必须是 {{frontmatter}}，正文可用 …             │ │
│ │ <名字>  id: <id>  <vault 路径>                    [打开][删除] │ │
│ │ [.annex-template-path-input] [登记] [.annex-template-preset ▾] │ │
│ └───────────────────────────────────────────────────────────────┘ │
│ ┌ .annex-templates-card[data-kind=base] ────────────────────────┐ │
│ │ 画廊模板（同上，扩展名 .base）                                 │ │
│ └───────────────────────────────────────────────────────────────┘ │
└─────────────────────────────────────────────────────────────────┘
────────────────── HR.annex-settings-divider（模板 ↔ 普通设置项）──────────────────
缩略图边长  [<n>]                     ← app 自己的 .setting-item，唯一剩下的普通设置项
```

### 必须成立的不变量

- **顶层顺序**（离屏与真机必须逐字一致）：
  `H1.annex-settings-title → DIV.annex-remotes-section → HR.annex-remotes-divider → DIV.annex-profiles-section → DIV.annex-templates-section → HR.annex-settings-divider → DIV.setting-item`。
- **标题**是内容区第一个子元素，是真正的 `<h1>`（`containerEl.createEl("h1", …)`），下方无说明文字；
  `display: block`、`padding: 0`、只保留一行底部外边距。标题左边缘 = 卡片左边缘 = 内容区左边缘。
- **remote 区**是一张 `.annex-remotes-card`：`h3.annex-remotes-title` + 一行 `.annex-remotes-hint` +
  N 行 `.annex-remote-row`（名称 / 地址 / 删除）+ 一个「添加 remote」。行内三列跨行同列对齐；名称列定宽，
  地址列吃掉剩余宽度。输入即写 `data.json` 的 `remotes`。名称或地址缺一半 ⇒ 行尾红字提示
  （缺名称 / 缺地址 / 名称里有空白字符）。
- **文件名匹配模板区**（`.annex-profiles-section`）只有两样东西：
  1. **工具条**（`.annex-profiles-toolbar`）：`<input class="annex-profile-path-input">`（vault 相对 `.json`
     路径）+ `<button class="annex-profile-register">登记</button>` +
     `<select class="dropdown annex-profile-preset">`（占位项「从预设创建…」，之后是预设素材）。
     工具条允许换行（`flex-wrap: wrap`）：窄窗口里三个控件折行，而不是把内容顶出内容区。
  2. **已登记项列表**（`.annex-profile-list`）：每份外部 JSON 一行 `.annex-profile-row`，行内是
     `name`（来自 JSON）· `id: <id>`（来自 JSON）· vault 相对路径 · 「打开」·「删除」。
     坏文件**仍然占一行**（路径与「打开」都留着，方便去修），下面多一行 `.annex-profile-error`。
- **没有内联编辑器**：设置页里**不存在** profile 的 JSON textarea、解析预览、状态胶囊
  （`Saved` / `Unsaved changes` / `Syntax Error`）、逐条「保存 / 复制 / 删除 / 打开」动作排。
  内容改在 vault 的文件里改（用「打开」交给系统默认应用），插件只读。
- **旧内联 profiles 的失效提示**（`.annex-legacy-profiles-warning`）：`data.json` 里还留着旧的
  `profiles` 数组时，在文件名匹配模板区顶部显示一条**非阻塞**提示，写明「不会读取、不会自动迁移，
  也不会回退到预设」，并引导把每条配置分别保存成 vault 里的一个 `.json` 后逐条登记。
  旧值**原样留在 `data.json` 里**（不迁移、不删除、不导出）。
- **模板区**是 `.annex-templates-section` 里的**两张卡片**：`data-kind=metadata`（`metadata 模板`）与
  `data-kind=base`（`画廊模板`）。每张卡片：标题 + 一行说明 + 已登记列表 + 登记行
  （路径输入 + 「登记」+ 「从预设创建…」下拉）。每行一行放下：名字 · `id:` · vault 路径 · 「打开」·
  「删除」（删除**只取消登记、不删文件**）。
- **没有可直接使用的内置模板行。** 预设（`src/defaults/` 里的原文）只是「从预设创建」的**素材**：
  设置页不列内置行，也没有「查看」「复制为自定义」。**运行时同样没有内置兜底** ——
  插件只认登记过的外部文件。
- **「从预设创建」每次写一个独立文件**：路径是 `AnnexGalleryTemplates/<preset-id>.<ext>`
  （文件夹名**无空格**）；路径被占用时自动加序号（`default 2.md`），**不覆盖**已有文件；
  写完**不自动打开**。metadata 预设 id 为 `default` / `embed`，画廊预设 id 为 `default`，
  文件名匹配模板预设 id 为 `template` / `tecnaitem`。文件名匹配模板的预设若与已登记 id 撞车，
  在**待创建的那份 JSON 里**生成唯一 id（`template-2`），名称标「（副本）」。
- **登记的校验**（三种模板一样）：路径必须是 vault 内相对路径（不接受绝对路径 / 盘符路径 / `..`）、
  扩展名必须对（`.json` / `.md` / `.base`）、文件必须存在、同一路径不能重复登记。
  不满足 ⇒ 只弹一条 Notice，不新增行、不写 `data.json`。
- **「打开」走系统默认应用**：`electron.shell.openPath(<绝对路径>)`；只有在拿不到 electron 且路径确实落在
  vault 内时，才退回 `app.openWithDefaultApp(<vault 相对路径>)`（那个 API 只认相对路径）。
  打开前重新做路径与存在性检查，失败 ⇒ Notice 指名 vault 路径与原因，**绝不自动创建文件**。
- **模板区没有「保存」按钮**：改动即写 `data.json`，口径与 remote 区一致。
- **分割线有两条**，1px、撑满内容宽：上面那条夹在 remote 区与文件名匹配模板区之间，两侧留白相等；
  下面那条在模板区与普通设置项之间。
- **普通设置项只剩一条**「缩略图边长」。`.gitattributes` / `.gitignore` 用内置默认，没有「默认样品名」
  这种东西 —— 那三行在设置页不出现。

## 4. 结构与落点

| 落点 | 内容 |
|---|---|
| `src/ui/settings.ts` | `AnnexGallerySettingTab`：`display()` 负责顶层顺序与标题/两条分割线/两个区块的创建；`PluginSettings` / `DEFAULT_SETTINGS`（含 `profileFiles` / `metadataTemplates` / `baseTemplates` / 两个按文件夹记住的模板字段）；`SettingsHost` 暴露 `vaultRoot()` / `scanVaultRemotes()` / `createVaultFile()`；`hide()` 收摊 |
| `src/ui/remotes-editor.ts` | `RemotesEditor.render()`：`.annex-remotes-card`、`.annex-remote-list`、`.annex-remote-row`、`.annex-remote-note(-warn)`、`.annex-remote-add` |
| `src/ui/profile-editor.ts` | `ProfileEditor.render()`：`.annex-profiles-toolbar`、`.annex-profile-list`、`.annex-profile-row`、`-name` / `-id` / `-path` / `-open` / `-del` / `-error`；登记 / 从预设创建 / 打开 / 取消登记 |
| `src/ui/templates-editor.ts` | `TemplatesEditor.render()`：`.annex-templates-section`、`.annex-templates-card`、`-title` / `-hint`、`.annex-template-list` / `-row` / `-name` / `-id` / `-path` / `-open` / `-del`、`.annex-template-add-row` / `-path-input` / `-add` / `-preset`；`TEMPLATE_FOLDER`（`AnnexGalleryTemplates/`）、`uniqueTemplateId()` |
| `src/core/external-files.ts` | 外部文件的路径规范化与校验：`normalizeVaultRelPath()` / `validateVaultRelPath()` / `resolveVaultFile()` / `readVaultTextFile()`（vault 相对路径、扩展名、存在性） |
| `src/core/profile-files.ts` | 外部 profile JSON 的读取：`profileFileRefs()` / `loadProfileFile()` / `loadProfileFiles()`（单对象约束、跨文件 id 重复、坏 JSON、坏正则） |
| `src/core/templates.ts` | 模板 id / 预设清单 / `TemplateRef`（`id` · `name` · vault 相对 `path`）/ `listTemplates()`（只有登记项）/ `resolveTemplate()`（无内置兜底）/ `readTemplateFile()` / 占位符填充 / metadata 模板的 `{{frontmatter}}` 硬约束 |
| `src/defaults/metadata/*.md`、`src/defaults/base/*.base` | 预设素材原文 —— 源码里的唯一一份，构建时由 `defaults-text` 内联（与 `.gitattributes` 同一条路） |
| `src/core/profiles.ts` | `FieldType`、`ParseProfile`、`TEMPLATE_PROFILE`（通用模板预设）、`TECNAI_TEM_PROFILE`、`DEFAULT_PROFILES`（**只作预设素材**，不再是运行时来源） |
| `src/core/remotes.ts` | `scanRemotes()` / `mergeScannedRemotes()` / `applyRemotes()` |
| `src/core/stems.ts` | `stemOf()` —— 全插件唯一的 stem 实现 |
| `styles.css` | 本页全部选择器；与 app.css 的对抗关系写在注释里 |
| `esbuild.config.mjs` | `defaults-text` 插件把 `src/defaults/metadata/*.md`、`src/defaults/base/*.base` 内联成字符串（预设素材只有源码这一份） |
| `tools/layout-check.cjs` | 离屏几何（`npm run layout`） |
| `tools/real-gui-check.py` | 真机结构（`npm run gui`） |
| `tools/smoke-test.cjs` / `tools/remotes-check.cjs` | 无头结构与落盘、remote 写入语义 |

### 关键选择器与特异度

| 选择器 | 特异度 | 压掉谁 |
|---|---|---|
| `.vertical-tab-content h1.annex-settings-title` | (0,2,1) | app.css 的 `.vertical-tab-content h1`（隐藏 + 行内 padding，约 (0,1,1)） |
| `.vertical-tab-content h3.annex-remotes-title` | (0,2,1) | 同一批给 h3 的行内 padding |
| `.vertical-tab-content h3.annex-templates-title` | (0,2,1) | 同上（模板区两张卡片的标题） |
| `.annex-profiles-toolbar select.annex-profile-preset` | (0,2,1) | `.dropdown { max-width: 100% }` 与 `.theme-dark .dropdown`（(0,1,0)；同权重靠顺序太脆） |
| `.annex-remotes-divider` | 与 `.annex-settings-divider` 同权重，按出现顺序接管 `margin` | 共用外观类 + 自己的类：外观复用，位置与留白单独可测 |

工具条与下拉的伸缩规则是成套的，不能拆开用：

```css
.annex-profiles-toolbar { display: flex; flex-wrap: wrap; align-items: center; }
.annex-profiles-toolbar .annex-profile-path-input { flex: 1 1 16em; min-width: 12em; }
.annex-profiles-toolbar select.annex-profile-preset {
  min-width: 0;        /* 允许原生 select 被压窄，否则它按最长选项定宽 */
  flex: 0 1 auto;      /* 可收缩，不参与均分 */
  max-width: 18em;     /* 上限，防止长预设名把工具条挤成两行 */
}
```

分割线的留白同样是一个成套的写法：`.annex-remotes-divider { margin: 1.25em 0 }`，且**上边距必须大于相邻
容器的底边距**（`.annex-remotes-section` 的 `1em`）。相邻块的外边距会折叠并取大者，上边距写小了就只有
下面那半生效，视觉上大下小。

## 5. 约束与取舍

取舍逐条列出，每条都写清另一条为什么不取：

1. **标题用显式 `<h1>`，不用 `Setting.setHeading()`。** 后者产出的是 `.setting-item` 骨架里的一行标题，
   既不在「内容区第一个子元素」这个位置，也不落在 `.vertical-tab-content h1.annex-settings-title` 这条
   规则上；`display`、`padding`、左缘对齐都得重新论证一遍，还会让「顶层第一个元素是 h1」这条断言失效。
2. **工具条允许换行，但控件都收着。** 折行优于把内容顶出内容区；输入框 `flex: 1 1 16em` 吃掉剩余宽度，
   下拉有 `max-width` 上限 —— 长预设名不会把整排挤成两行。
3. **下拉收窄，不跟随最长选项。** 原生 `<select>` 按**最长选项文字**定宽，不是当前显示项；预设名一长，
   整排就被挤到第二行。下拉在选完后立刻回到占位项「从预设创建…」，收起态永远只显示这一句，所以收窄是安全的。
4. **下拉挂 Obsidian 的 `dropdown` 类，不自己画边框/箭头。** 挂上之后吃的是主题里下拉的既有外观
   （背景、圆角、右侧 chevron 的 svg）；自己画会在换主题时立刻失真。判断「这个主题里下拉就该长这样」
   的办法是把**原生下拉**的 computed 值与我们的逐项比（`background` / `border` / `border-radius` /
   `box-shadow` / 有没有 chevron），而不是靠肉眼断言「我们样式坏了」。
5. **内容改在文件里改，设置页只管指针。** 内联 textarea 意味着两处真相（`data.json` 里一份、vault 里一份），
   再加上「保存 / Saved / Unsaved changes」三态与临时缓冲文件回同步 —— 一次编辑要跨三个地方对齐。
   改成「一份文件 = 一处真相」之后：没有保存按钮、没有状态胶囊、没有回同步；改完存盘，下次操作重新读。
6. **运行时没有内置兜底。** 内置模板曾经是「模板坏了就静默退回」的出口；那个出口把「模板写错了」显示成
   「画廊是空的」。现在模板坏了就**指名文件停下**，用户去登记或修文件。
7. **旧内联 profiles 只提示、不迁移。** 自动迁移会把用户的旧配置悄悄改写成另一套结构（一份 JSON 拆成
   N 个文件还要分配 id），出错时无法回退；提示 + 手工登记把这一步交给用户，代价是多点几下。
8. **「打开」走 `electron.shell.openPath(绝对路径)`，只在路径确实位于 vault 内时才退回
   `app.openWithDefaultApp`。** 后者吃的是**vault 相对路径**（bundle 内是 `getFilePath(p)` +
   `window.open(abs, "_external")`）；传 `TMPDIR` 那种绝对路径会被拼到 vault 根后面，指向不存在的文件
   —— **静默失败**：返回成功、什么都不弹。因此「把 API 换成探针」只能证明它被调用，证明不了它有效；
   有效性只能在真机上看副作用（`lsof` / 进程表）。
9. **remote 只写配置，幂等。** 「初始化 gallery」逐个 `git remote add`；同名已存在且地址不同 ⇒
   `git remote set-url`，地址相同 ⇒ `unchanged`（一个字节都不碰）；名称/地址缺一半、名称带空白 ⇒
   `skipped` 并写明原因；同名重复只认第一条；dry-run 只报不写。不做 fetch/push，也不整段重写配置。
10. **加载时扫描只补不覆盖。** `onload` 与每次打开设置页都跑 `scanRemotes()`：仓库里有、设置里没有的补进
    `data.json`，同名条目**不覆盖**维护者改过的地址，补进来时给一条 Notice。只看 `data.json` 会让仓库里
    本来就存在的 remote 显示成「没有 remote」，这是这套设计必须避免的假阴性。
11. **`type: "string"` 作为 `text` 的等价拼写，不新增渲染分支。** 插件 schema 原来只有 `number` / `text`；
    把 `"string"` 认成 `text` 的同义写法（渲染都走带引号那条，sidecar 里只有 `number` 是特判），
    是为了让原文 JSON 一个字符都不用改就能落进 schema。
12. **`.gitattributes` / `.gitignore` 不暴露路径，没有默认样品名。** 合并目标固定为 `<vault>/.gitattributes`
    与 `<vault>/.gitignore`；旧 `data.json` 里的 `gitattributesPath` / `gitignorePath` / `defaultSample`
    在 `loadSettings()` 里删掉。样品名每次生成 metadata 都在弹窗里填（仍按文件夹记住上次的值，只是预填）。
13. **预设素材以源码文件为唯一一份。** 预设文本不抄进 `data.json`、也不另存一份设置页常量：两份文本一旦
    分叉，判据就不知道以哪一份为准。「从预设创建」是拿到可改副本的唯一路径，副本是 vault 里受 git 管理的
    普通文件。
14. **「删除」只取消登记，不删文件。** 模板 / profile 文件是 vault 里的数据，插件只持有指针；
    删文件不可撤销，而取消登记随时可以再登记回来。
15. **CLI 是唯一保留内置预设的地方（刻意的例外）。** 插件运行时只认登记过的外部文件；命令行是脚本场景，
    没有设置页可点，所以 `--template default|embed` 与「不给 `--template`」显式取 CLI 自带的预设原文。
    两条路径的区别在 [`tools/cli.md`](tools/cli.md) 里写明。
16. **核心层不兜底，缺参数就报错。** `src/core/sidecar.ts` 的 `generateSidecars()` / `buildSidecarText()`
    拿不到 `template` 或 `profiles` 时直接抛错，不再退回内置默认 —— 那样「调用方漏传参数」会变成
    「生成结果看起来正常但用的是另一套模板」，比报错难查得多。插件传外部文件，CLI 传显式预设，
    两条路都显式给参数。

### 六条只有量过才成立的约束

1. **`app.css` 在 `.vertical-tab-content` 里隐藏 h1**（`.vertical-tab-content h1 { display: none }`），
   并给它 `padding: 0 var(--size-4-4)`。核心设置页的标题由 app 自己的 `.setting-page-titlebar` 提供，
   所以内容里的 h1 被隐掉；插件设置页走旧 API，`containerEl` 就是一个 `.vertical-tab-content`，
   **没有 titlebar**。因此这个 `<h1>` 必须自带 `display: block` 并把 padding 压掉，
   选择器写到 `.vertical-tab-content h1.annex-settings-title`（0,2,1）才盖得住 app 的 (0,1,1)。
   只看代码会以为 h1 正常显示 —— 这条只能量。
2. **app 的 `.setting-item` 自带内边距**（`padding: var(--size-4-4)`）。所以「缩略图边长」那一行的**文字**
   比卡片左边缘再右移一个间距。标题与卡片按「无 padding」贴内容左缘；若要让标题也与设置项文字对齐，
   把 `.annex-settings-title` 的 padding 改成同一个变量即可（一行）。
3. **原生 `<select>` 的宽度由最长选项决定**，而离屏桩里的 `<option>` 没有文字 ⇒ 永远量成收窄态，看着完全
   正常。真机上预设名一长就要靠 `max-width` 收着。约束是上面那条收缩链：`flex-wrap: wrap` +
   `min-width: 0` + `max-width`，三者缺一都会回到撑破。
4. **`app.openWithDefaultApp(p)` 吃 vault 相对路径。** 传绝对路径会拼成 `<vault>/<绝对路径>`，
   返回成功但什么都不弹。教训：换 API 为探针只能证明调用发生，证明不了效果；要么真机看副作用，要么先核对
   入参语义。
5. **裸 `<select>` 在真机里没有任何控件感**，不挂 `dropdown` 类就吃不到 app.css 那批规则，渲染成一段浅色
   文字 —— 截图看得出、离屏量不出（两边盒子一样大）。挂上之后还有第二下：`.dropdown { max-width: 100% }`
   与我们的 `max-width` 同权重（0,1,0），谁在样式表后面谁赢，所以选择器直接写到 (0,2,1)。
6. **CDP `Page.captureScreenshot` 在窗口被遮挡时会挂到 websocket 超时**（判据全过、`exit=1`、图没落地）。
   抓图前先 `osascript` activate + `AXRaise` 把设置窗口提到前台。截图**不是判据**：抓不到要打印警告并继续，
   不能让它把一轮全绿的复核拖成失败。

## 6. 字段与默认值（`data.json`）

落进 `data.json` 的只有这些：

| 字段 | 默认值 | 说明 |
|---|---|---|
| 缩略图边长（`thumbnailEdge`） | `256` | 生成 `.thumbnail.png` 的边长（px）；建议与 `.base` 的 `cardSize` 保持一致。 |
| remote 设置（`remotes`） | 插件加载时从仓库自动扫 | 一条 = 名称 + 地址，可多条；加载时扫当前仓库的 `git remote`，把设置里没有的补进来（同名不覆盖手改过的地址）；初始化时逐个 `git remote add`（同名已存在就 `set-url`，地址相同则一个字节都不碰）。 |
| 已登记的文件名匹配模板（`profileFiles`） | `[]` | 一条 = `{ path }`：**vault 相对路径**，正斜杠；正文在 vault 的 `.json` 文件里（顶层一条 `ParseProfile` 对象）。 |
| `folderSamples` | `{}` | 按文件夹记住现场填过的 ask 值。**没有**全局的「默认样品名」：每次生成 metadata 都要在弹窗里填。 |
| `folderProfiles` | `{}` | 按文件夹记住上次选的 profile id。 |
| 已登记的 metadata 模板（`metadataTemplates`） | `[]` | 一条 = `{ id, name, path }`；`path` 是 vault 相对路径（`.md`）。 |
| 已登记的画廊模板（`baseTemplates`） | `[]` | 同上，文件扩展名是 `.base`。 |
| 按文件夹记住的 metadata 模板（`folderMetadataTemplates`） | `{}` | 文件夹绝对路径 → 模板 id；「生成元数据」弹窗的模板下拉框预选它。 |
| 按文件夹记住的画廊模板（`folderBaseTemplates`） | `{}` | 文件夹绝对路径 → 模板 id；「创建画廊」的模板选择预选它。 |

**旧 `profiles` 数组**：旧版把 profile 内联在 `data.json` 里。新版**不读、不迁移、不删除**它 ——
它在 `data.json` 里原样留着（用户想删可以自己删），设置页只显示一条失效提示，运行时不参与。

两条规则文件（`.gitattributes` / `.gitignore`）不在设置里，见 [`commands.md`](commands.md)。

## 7. 判据

| 命令 | 钉住什么 | 钉不住什么 |
|---|---|---|
| `npm run build` | 产物 `main.js` / `styles.css` 可生成 | 任何版式 |
| `npm run smoke` | 无头加载构建产物：设置页结构（remote 区、文件名匹配模板区、模板区、两条分割线）、三类模板的登记 / 从预设创建 / 打开 / 取消登记、profile JSON 的各种坏法、右键菜单、弹窗、落盘、状态栏 | 几何、原生控件宽度 |
| `npm run layout` | 离屏几何：真实 app.css + 真实 DOM + headless Chromium，只回答「结构没塌」 | 下拉宽度、控件外观、运行时行为 |
| `npm run verify:core` | 核心层契约：缺 `template` / `profiles` 时直接报错，不回退内置默认 | UI 与几何 |
| `npm run remotes` | 真 git 仓库上的 add / set-url / 幂等 / dry-run / 扫描合并 / 非仓库不报错 | 设置页 UI |
| `npm run gui` | 真机：原生 select 的宽度与外观、设置页与 `data.json` 的行数对应、重载后的 CSS | 配色与审美 |
| 截图 + 人眼 | 配色与观感 | — |

判定统一是**脚本全绿（`FAIL=0`）**，不是断言条数 —— 条数会随用例增长。

### `npm run smoke` 钉住的条目

无头加载构建产物，断言的是结构与落盘，例如：

```
- 顶层 children 顺序；children[2] 就是 annex-remotes-divider，children[4] 就是 annex-templates-section
- 标题是一条 h1，且 styles.css 里 .annex-settings-title 的 margin / padding 都被清零
- 没有内联编辑器：annex-profile-card / annex-profile-json / annex-preview-* / annex-profile-status /
  annex-profile-actions 的数量都是 0
- 工具条 = 路径输入 + 登记 + 从预设创建（下拉），没有「新模版 / 导入模版 / 添加预设」
- 模板区：两张卡片（data-kind = metadata / base），没有 annex-template-builtin / -view-btn / -copy
- 登记：路径越界 / 绝对路径 / 盘符路径 / 扩展名不对 / 文件不存在 ⇒ 只多一条 Notice，不新增行、不写 data.json
- 同一路径不能重复登记；「删除」只取消登记、文件仍在盘上
- 从预设创建：写到 AnnexGalleryTemplates/（无空格），同名加序号不覆盖，不自动打开
- 打开：拿不到系统默认应用 ⇒ Notice 指名 vault 路径；宿主抛错 ⇒ Notice 带原因；成功 ⇒ 交给宿主的绝对路径
- profile JSON：顶层是数组 / { profiles: [...] } / 坏 JSON / 坏正则 / 文件丢失 / 跨文件 id 重复 ⇒ 行上可见错误
- 运行时：坏文件、重复 id、空列表 ⇒ 弹窗都不开，更不写盘；外部改 id/name 后下一次生成读到新值
- 旧内联 profiles：显示失效提示、不迁移、不参与运行时
- 第二条分割线以下 data-name 列表 = ["缩略图边长"]
- remote 的增删改、落盘、读回
```

### 离屏几何（`npm run layout`）

用真实 app.css（从本机 Obsidian 安装包的 `obsidian-*.asar` 抽出，macOS 默认在
`~/Library/Application Support/obsidian/`，缓存在 `TMPDIR`）+ 真实 DOM（桩模块跑构建产物 `main.js` 的
`tab.display()`）+ headless Chromium。断言全是关系式：

```
- 内容左边缘 = 标题左 = 卡片左；「缩略图边长」那一行的盒子左也 = 内容左（文字另带 app 的行内 padding）
- h1: display=block、paddingLeft=0、marginTop=0
- 顶层顺序 与真机一致
- 两条分割线都可见、1px、撑满内容宽；上面那条真的夹在卡片与工具条之间
- 文件名匹配工具条: 输入框 + 登记 + 从预设创建，三个控件从左往右、垂直居中，输入框吃掉剩余宽度
- 每条已登记 profile 一行：name → path → 打开 → 删除，行有 1px 边框，允许换行且不溢出
- 模板区: 两张卡片撑满内容宽；每行一行放下；登记行 = 路径输入 + 登记 + 从预设创建
- 面板没有横向溢出
```

remote 区同一套量法（装两条时）：

```
- remote 卡片撑满内容宽；标题「remote 设置」左 = 卡片内容左，标题自身 padding=0
- 每一行的 name / url / 删除 三列跨行同列对齐
- 「添加 remote」与标题同列，排在所有行下面
```

`node tools/layout-check.cjs --json` 另把原始几何打出来，用来检查字段齐不齐 —— 具体数值不作为断言。

### 真机（`npm run gui`）

在真实窗口上量，断言同样是关系式：

```
- h1: display=block、paddingLeft=0，左边缘 = 内容区左边缘
- 顶层顺序 = 上面列的那一串（顺序错即 FAIL）
- 工具条: 输入 + 登记 + 从预设创建，三个控件从左往右；预设下拉宽度受 CSS max-width 约束
- 已登记行数 = data.json 里 profileFiles 的条数，且每行 path 一一对应
- 模板区两张卡片：每张的行数 = data.json 里对应登记项的条数，id 一一对应
- 没有旧内联编辑器 / 内置模板行 / 查看 / 复制为自定义
- remote 行: 每行的 name / url / 删除 同列对齐；行数 = `git -C <vault> remote` 的条数
```

脚本**不点「打开」**（那会拉起系统默认应用）；打开行为的成功 / 失败由 `npm run smoke` 用可替换的
`openWithDefaultApp` 覆盖。脚本末行打印 PASS / FAIL 计数，`FAIL` 必须为 0；打印出的几何值只供人眼比对，
不进判据（换主题、换窗口尺寸都会变）。

### 复跑

```bash
npm run build     # 出 main.js / styles.css
npm run smoke     # 无头加载构建产物：设置页结构（含 remote 设置 + 两条分割线）+ 右键菜单 + 弹窗 + 落盘 + 状态栏
npm run remotes   # remote 设置的核心行为：真 git 仓库上验 add / set-url / 幂等 / dry-run / 扫描合并
npm run layout    # 离屏布局几何：真实 app.css + 真实 DOM + headless Chromium
node tools/layout-check.cjs --json   # 另把原始几何 JSON 打出来（看字段齐不齐，别拿数值当断言）
```

真机复核（离屏量不出来的那些：原生 select 宽度与外观、设置页与 `data.json` 的对应、观感）：

```bash
# 端口只在启动时生效，所以要重启一次 Obsidian
osascript -e 'quit app "Obsidian"'
open -na /Applications/Obsidian.app --args --remote-debugging-port=9333 "--remote-allow-origins=*"
# 部署产物到 <vault>/.obsidian/plugins/<plugin-id>/ 后直接跑；脚本自己会 disable→enable 插件
ANNEX_SHOT=<shot-path> npm run gui     # 真机判据 + 截图
```

`npm run layout` 需要本机有 Chrome / Chromium / Edge 之一，`npm run gui` 需要 `python3` +
`websocket-client`。

## 8. 已知边界

- **离屏那条下拉的宽度没有参考价值。** 桩模块的 `<option>` 没有文字，永远量成收窄态；下拉宽度、chevron、
  控件的真实观感只能靠 `npm run gui` + 人眼看截图。
- **`layout` 只保证结构不塌**（可见性、对齐、边框、方向、溢出），运行时行为一律不在它的范围内。
- **截图不是判据。** 窗口被遮挡时 `Page.captureScreenshot` 会挂到超时；这不该让一轮复核失败。
- **设置页在较新的 Obsidian 里是独立窗口。** `app.setting.open()` 会把设置开成独立窗口（target 标题
  「设置 - <vault>」，`body` 带 `is-popout-window`），那个窗口里**没有** `app` 全局 —— 读 DOM 走设置窗口
  那个 target，读 `app` / 插件 settings 走主窗口那个 target。
- **`styles.css` 在插件加载时才注入 `<style>`。** 复核前必须 disable → enable 插件，否则量到的是内存里的
  旧 CSS。
- **模板 / profile 登记只是指针，不复制内容。** 文件被移走 / 改名 / 改坏之后，下次操作时整体停下，
  Notice 指名 vault 路径；没有「退回内置默认」这条出路。
- **旧内联 profiles 只提示、不迁移。** 用户要自己把每条配置拆成 vault 里的 `.json` 再逐条登记。
- **配色与观感没有自动判据。** 最终要人眼看那张真机截图（skill `inspect-obsidian-gui-with-maxim`）。
