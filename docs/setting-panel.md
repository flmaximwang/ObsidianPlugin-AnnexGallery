# Settings panel 设计说明

## 1. 定位

**管什么**

- 设置页的**顶层顺序**：从标题到最后一条普通设置项，各区块的落点与前后关系；
- 区块内部的几何**关系式**：左边缘对齐、上下间隙相等、跨行同列、同一行不换行、撑满内容宽；
- 控件的行为契约：工具条三个入口、卡片的编辑/保存/复制/打开/删除与状态胶囊、remote 行的增删与落盘、
  「初始化 gallery」对 remote 的写入语义；
- 每条契约由哪条命令钉住、钉到什么程度。

**不管什么**

- 解析引擎本身（正则怎么匹配、字段怎么进 frontmatter）的算法；
- 主题配色、字体、截图观感 —— 这部分没有自动判据，只能人眼看；
- git 远端的网络行为：remote 只写配置，不 fetch、不 push。

本文件**不含任何随环境变化的具体数值**。像素、耗时、坐标随主题与窗口尺寸变化，写进来既会过期也会误导；
判据一律是「相等 / 对齐 / 同序 / 不换行 / 撑满」这类关系式，命令与配置里的路径一律是占位符
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
5. **状态由数据推导，不由操作历史推导。** 「Saved」是内容与盘上那份语义相同，不是「上次点了保存」。
6. **写盘保守。** 有 error 级问题的配置任何时候都不落盘；批量写（扫描、初始化）只做幂等的最小改动。

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
[新模版] [导入模版]                              [添加预设 ▾]       ← 同一行：按钮贴左、下拉贴右
┌ .annex-profile-card ────────────────────────────────────────────┐
│ TECNAI 电镜（…） · id: <id>                          [Saved]     │  ← Name · id · 状态胶囊（靠右）
│ ┌ textarea.annex-profile-json（等宽，带最小高度）──────────┐      │
│ └──────────────────────────────────────────────────────┘        │
│ （validateProfile 的 error/warn 逐条列在文本框下面）               │
│ 解析预览                                                          │
│ [示例文件名（全宽，输入即解析）]                                    │
│ ┌ .annex-preview-result（1px 边框）─────────────────────┐        │
│ │ magnification = <value>                             │        │  ← 每行一条解析
│ │ marker = <marker>                                   │        │
│ │ index = <index>                                     │        │
│ └──────────────────────────────────────────────────────┘        │
│                                     [删除] [打开] [复制] [保存]   │  ← 整排贴右下角
└─────────────────────────────────────────────────────────────────┘
────────────────── HR.annex-settings-divider（模版 ↔ 普通设置项）──────────────────
缩略图边长  [<n>]                     ← app 自己的 .setting-item，唯一剩下的普通设置项
```

### 必须成立的不变量

- **顶层顺序**（离屏与真机必须逐字一致）：
  `H1.annex-settings-title → DIV.annex-remotes-section → HR.annex-remotes-divider → DIV.annex-profiles-section → HR.annex-settings-divider → DIV.setting-item`。
- **标题**是内容区第一个子元素，是真正的 `<h1>`（`containerEl.createEl("h1", …)`），下方无说明文字；
  `display: block`、`padding: 0`、只保留一行底部外边距。标题左边缘 = 卡片左边缘 = 内容区左边缘。
- **remote 区**是一张 `.annex-remotes-card`：`h3.annex-remotes-title` + 一行 `.annex-remotes-hint` +
  N 行 `.annex-remote-row`（名称 / 地址 / 删除）+ 一个「添加 remote」。行内三列跨行同列对齐；名称列定宽，
  地址列吃掉剩余宽度。输入即写 `data.json` 的 `remotes`。名称或地址缺一半 ⇒ 行尾红字提示
  （缺名称 / 缺地址 / 名称里有空白字符）。
- **工具条**是一行且不换行：两个 `<button>` 贴内容区左边缘，`<select class="dropdown annex-profile-preset">`
  贴内容区右边缘，中间留白随窗口宽度变化而两端不动；三者 `top` 相同。
  「新模版」插入 `TEMPLATE_PROFILE` —— 一个通用模板（示例名形状 `<放大倍数>x_<序号>`），把 regex / fields /
  keyOrder / ask / onMismatch 五样基本写法都演示到，**不是**某台电镜的配置；电镜预设从下拉里加。
  「导入模版」挂一个隐藏的 `<input type="file" accept=".json,application/json">`，走系统文件选择器，
  认单条 profile / profile 数组 / `{ profiles: [...] }` 三种形状。
  下拉的占位项是「添加预设…」，之后是内置预设（含 TECNAI 电镜）。
- **内置预设的形状**：`TECNAI_TEM_PROFILE` 的 `name` 里写 `<标记>`；`X-` 之间只有一个具名组 `marker`，
  写成 `(?<marker>.+)`；`fields` 三项（magnification → `number`、marker → `string`、index → `number`）；
  `keyOrder` 不含 `lens` 与 `eagleId`。同一份 JSON 也落在 `tools/example-profiles/two-profiles.json`、
  `tools/example-profiles/verify-plugin-load.cjs`（键数断言）与 README 示例里，三处必须一致。
- **卡片**：一张卡片 = 一条 profile（`data-profile-id`）。头部 Name · `id:` · 状态胶囊（靠右，`data-level`
  = ok / warn / error）；等宽 textarea 就地编辑；校验消息逐条列在文本框下方；解析预览由一个全宽的示例
  文件名输入框驱动，输入即解析，结果区带 1px 边框、每行一条 `key = value`；动作按钮整排贴卡片右下角，
  DOM 顺序 删除→打开→复制→保存。
- **状态胶囊只有三个词**：`Saved` / `Unsaved changes` / `Syntax Error`。校验的 error/warn 逐条列在文本框
  下方，不占用这三个词。
- **分割线有两条**，1px、撑满内容宽：上面那条夹在 remote 区与工具条之间，两侧留白相等；下面那条在卡片与
  普通设置项之间。
- **普通设置项只剩一条**「缩略图边长」。`.gitattributes` / `.gitignore` 用内置默认，没有「默认样品名」
  这种东西 —— 那三行在设置页不出现。

## 4. 结构与落点

| 落点 | 内容 |
|---|---|
| `src/ui/settings.ts` | `AnnexGallerySettingTab`：`display()` 负责顶层顺序与标题/两条分割线的创建；`PluginSettings` / `DEFAULT_SETTINGS`；`SettingsHost` 暴露 `vaultRoot()` / `scanVaultRemotes()`；`hide()` 收摊 |
| `src/ui/remotes-editor.ts` | `RemotesEditor.render()`：`.annex-remotes-card`、`.annex-remote-list`、`.annex-remote-row`、`.annex-remote-note(-warn)`、`.annex-remote-add` |
| `src/ui/profile-editor.ts` | `ProfileEditor.render()`：`.annex-profiles-toolbar`、`.annex-profile-list`、`.annex-profile-card`、`-head` / `-name` / `-id` / `-status` / `-json` / `-messages`、`.annex-preview` / `-title` / `-filename` / `-result` / `-actions`；示例名到 stem 的换算 |
| `src/ui/external-edit.ts` | 外部编辑通道：临时缓冲文件、`openWithDefaultApp()`、mtime+size 轮询与回灌 |
| `src/core/profiles.ts` | `FieldType`、`ParseProfile`、`TEMPLATE_PROFILE`（新模版用的通用模板）、`TECNAI_TEM_PROFILE`、`DEFAULT_PROFILES` |
| `src/core/remotes.ts` | `scanRemotes()` / `mergeScannedRemotes()` / `applyRemotes()` |
| `src/core/stems.ts` | `stemOf()` —— 全插件唯一的 stem 实现 |
| `styles.css` | 本页全部选择器；与 app.css 的对抗关系写在注释里 |
| `tools/layout-check.cjs` | 离屏几何（`npm run layout`） |
| `tools/real-gui-check.py` | 真机结构（`npm run gui`） |
| `tools/smoke-test.cjs` / `tools/remotes-check.cjs` | 无头结构与落盘、remote 写入语义 |

### 关键选择器与特异度

| 选择器 | 特异度 | 压掉谁 |
|---|---|---|
| `.vertical-tab-content h1.annex-settings-title` | (0,2,1) | app.css 的 `.vertical-tab-content h1`（隐藏 + 行内 padding，约 (0,1,1)） |
| `.vertical-tab-content h3.annex-remotes-title` | (0,2,1) | 同一批给 h3 的行内 padding |
| `.annex-profiles-toolbar select.annex-profile-preset` | (0,2,1) | `.dropdown { max-width: 100% }` 与 `.theme-dark .dropdown`（(0,1,0)；同权重靠顺序太脆） |
| `.annex-remotes-divider` | 与 `.annex-settings-divider` 同权重，按出现顺序接管 `margin` | 共用外观类 + 自己的类：外观复用，位置与留白单独可测 |

工具条与下拉的伸缩规则是成套的，不能拆开用：

```css
.annex-profiles-toolbar { display: flex; flex-wrap: nowrap; justify-content: flex-start; }
.annex-profiles-toolbar select.annex-profile-preset {
  min-width: 0;        /* 允许原生 select 被压窄，否则它按最长选项定宽 */
  flex: 0 1 auto;      /* 可收缩，不参与均分 */
  max-width: 14em;     /* 上限，防止长预设名把一排挤成两行 */
  margin-left: auto;   /* 吃掉富余空间，把下拉顶到右边缘 */
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
2. **工具条两端分开，不是整排靠右。** 整排靠右会让两个高频按钮远离阅读起点，且视觉重量全压在右侧；
   两端分开让按钮贴内容左缘、只在需要时把下拉推到右缘。
3. **下拉收窄，不跟随最长选项。** 原生 `<select>` 按**最长选项文字**定宽，不是当前显示项；预设名一长，
   整排就被挤到第二行。下拉在选完后立刻回到占位项「添加预设…」，收起态永远只显示这一句，所以收窄是安全的。
4. **下拉挂 Obsidian 的 `dropdown` 类，不自己画边框/箭头。** 挂上之后吃的是主题里下拉的既有外观
   （背景、圆角、右侧 chevron 的 svg）；自己画会在换主题时立刻失真。判断「这个主题里下拉就该长这样」
   的办法是把**原生下拉**的 computed 值与我们的逐项比（`background` / `border` / `border-radius` /
   `box-shadow` / 有没有 chevron），而不是靠肉眼断言「我们样式坏了」。
5. **「复制」是复制卡片，不是复制 JSON 到剪贴板。** 副本落成一张新卡片，服务于「在一条相似 profile 上改」；
   剪贴板语义没有落点，也和「新模版」重复。
6. **保存是显式按钮 + 状态胶囊，失焦不写盘。** 既然有「保存」和 `Saved` / `Unsaved changes` 两态，
   失焦自动保存就会让这两态失去意义。JSON 文本框保留是这条的前提：没有就地编辑，就没有这两个状态；
   「打开」是**额外**的一条外部编辑通道，不是替代。有 error 级问题的配置**任何时候都不写盘** ——
   坏正则进了 `data.json`，右键弹窗会在解析那一刻直接崩。
7. **状态按语义比较。** `Saved` = 文本框内容与盘上那份按键名排序后相同，只改缩进或键序不算改；
   `Unsaved changes` = 语义不同；`Syntax Error` = JSON 解析不过。
8. **「打开」走 `electron.shell.openPath(绝对路径)`，只在路径确实位于 vault 内时才退回
   `app.openWithDefaultApp`。** 后者吃的是**vault 相对路径**（bundle 内是 `getFilePath(p)` +
   `window.open(abs, "_external")`）；传 `TMPDIR` 那种绝对路径会被拼到 vault 根后面，指向不存在的文件
   —— **静默失败**：返回成功、什么都不弹。因此「把 API 换成探针」只能证明它被调用，证明不了它有效；
   有效性只能在真机上看副作用（`lsof` / 进程表 / `data.json`）或核对入参语义。
9. **remote 只写配置，幂等。** 「初始化 gallery」逐个 `git remote add`；同名已存在且地址不同 ⇒
   `git remote set-url`，地址相同 ⇒ `unchanged`（一个字节都不碰）；名称/地址缺一半、名称带空白 ⇒
   `skipped` 并写明原因；同名重复只认第一条；dry-run 只报不写。不做 fetch/push，也不整段重写配置。
10. **加载时扫描只补不覆盖。** `onload` 与每次打开设置页都跑 `scanRemotes()`：仓库里有、设置里没有的补进
    `data.json`，同名条目**不覆盖**维护者改过的地址，补进来时给一条 Notice。只看 `data.json` 会让仓库里
    本来就存在的 remote 显示成「没有 remote」，这是这套设计必须避免的假阴性。
11. **`type: "string"` 作为 `text` 的等价拼写，不新增渲染分支。** 插件 schema 原来只有 `number` / `text`；
    把 `"string"` 认成 `text` 的同义写法（渲染都走带引号那条，sidecar 里只有 `number` 是特判），
    是为了让原文 JSON 一个字符都不用改就能落进 schema。
12. **`<specimen>-<marker>-<index>` 的中间段采 `.+`，不采 `.*`。** 两者的差别只在 marker 能不能为空；
    真实文件名里不存在空 marker，所以 `.+` 不丢任何现有文件，且比 `.*` 严。旧写法在 `X-` 之间只允许
    `\d{1,2}` 或 `[0-9A-Za-z]+`，带 `_` 与 `.` 的 marker 直接不命中 —— 这是形状匹配失败的第一层原因。
13. **`eagleId`（与 `lens`）留在 `constFields` 里，但不进 `keyOrder`。** 按硬规则「不在 `keyOrder` 里的键
    一律不写」，它们不会落进 frontmatter；这是原文写法的原样保留。要写就把它加回 `keyOrder`。
14. **分割线共用一个外观类，各自带自己的类。** 外观（1px、变量色）只写一次，位置与留白各自可测：判据能
    直接问「`children[2]` 是不是 `annex-remotes-divider`」，不必解析计算样式。
15. **示例文件名不做相对路径输入。** 解析只用文件名，`buildContext(filename)` 的 relpath 就取文件名本身，
    所以「相对 vault 路径」那一格删掉；没有解析按钮，只监听 `input`。
16. **`.gitattributes` / `.gitignore` 不暴露路径，没有默认样品名。** 合并目标固定为 `<vault>/.gitattributes`
    与 `<vault>/.gitignore`；旧 `data.json` 里的 `gitattributesPath` / `gitignorePath` / `defaultSample`
    在 `loadSettings()` 里删掉。样品名每次生成 metadata 都在弹窗里填（仍按文件夹记住上次的值，只是预填）。

### 示例名到 stem 的换算

预览必须复用 `core/stems` 的 `stemOf` —— 全插件只允许这一份实现，不允许在 UI 里另抄一份。候选有两条，
**两条都要试，命中即用**：

1. 输入带图片扩展名时，按引擎口径去掉扩展名；
2. 输入不带图片扩展名时，把这个串本身也当作 stem 再试一次。

两条都不命中，才按引擎那条口径报「正则不命中」。只按「最后一个 `.` 之后整段都是扩展名」来实现是错的：
`<specimen>-<marker>-<index>` 这种不带扩展名的示例名会被削掉最后一段，本该命中的正则被报成不命中。
`number` 类型的字段照旧规整掉前导零，与其它编号同一口径。
判据：`npm run smoke` 与 `npm run gui` 各有一条同义断言（`state=ok`，`marker` 与 `index` 各自对得上）。

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
   正常。真机上预设名一长就把这一排挤成两行。约束是上面那条收缩链：`flex-wrap: nowrap` +
   `min-width: 0` + `max-width`，三者缺一都会回到换行。
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

落进 `data.json` 的只有五项：

| 字段 | 默认值 | 说明 |
|---|---|---|
| 缩略图边长（`thumbnailEdge`） | `256` | 生成 `.thumbnail.png` 的边长（px）；建议与 `.base` 的 `cardSize` 保持一致。 |
| remote 设置（`remotes`） | 插件加载时从仓库自动扫 | 一条 = 名称 + 地址，可多条；加载时扫当前仓库的 `git remote`，把设置里没有的补进来（同名不覆盖手改过的地址）；初始化时逐个 `git remote add`（同名已存在就 `set-url`，地址相同则一个字节都不碰）。 |
| `profiles` | 内置 TECNAI 电镜 | metadata 解析配置；工具条的「新模版 / 导入模版 / 添加预设」增，卡片上的「保存 / 复制 / 打开 / 删除」改。 |
| `folderSamples` | `{}` | 按文件夹记住现场填过的 ask 值（内置默认只有 `sample`）。**没有**全局的「默认样品名」：每次生成 metadata 都要在弹窗里填。 |
| `folderProfiles` | `{}` | 按文件夹记住上次选的 profile id。 |

两条规则文件（`.gitattributes` / `.gitignore`）不在设置里，见 [`commands.md`](commands.md)。

## 7. 判据

| 命令 | 钉住什么 | 钉不住什么 |
|---|---|---|
| `npm run build` | 产物 `main.js` / `styles.css` 可生成 | 任何版式 |
| `npm run smoke` | 无头加载构建产物：设置页结构（remote 区、两条分割线、三态胶囊、无解析按钮、无 relpath 格）、导入 `.json`、右键菜单、弹窗、落盘、状态栏 | 几何、原生控件宽度 |
| `npm run layout` | 离屏几何：真实 app.css + 真实 DOM + headless Chromium，只回答「结构没塌」 | 下拉宽度、控件外观、运行时行为 |
| `npm run remotes` | 真 git 仓库上的 add / set-url / 幂等 / dry-run / 扫描合并 / 非仓库不报错 | 设置页 UI |
| `npm run gui` | 真机：原生 select 的宽度与外观、`openPath` 的路径语义、popout 分治、重载后的 CSS、外部编辑回灌 | 配色与审美 |
| 截图 + 人眼 | 配色与观感 | — |

判定统一是**脚本全绿（`FAIL=0`）**，不是断言条数 —— 条数会随用例增长。

### `npm run smoke` 钉住的条目

无头加载构建产物，断言的是结构与落盘，例如：

```
- 顶层 children 顺序；children[2] 就是 annex-remotes-divider
- 标题是一条 h1，且 styles.css 里 .annex-settings-title 的 margin / padding 都被清零
- 状态胶囊三态：改一个字符 → Unsaved changes，敲坏 JSON → Syntax Error，存回去 → Saved
- annex-preview-relpath 数 = 0（没有相对路径那一格）
- annex-preview-run 数 = 0（没有解析按钮）
- 「新模版」来自通用模板 TEMPLATE_PROFILE（不是电镜预设）
- 导入一个 .json 后卡片数 +1 且落盘
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
- 工具条: justify=flex-start、wrap=nowrap，盒子撑满内容宽；两个按钮贴左、下拉贴右、三者 top 相同
- 示例文件名输入框宽度 = 卡片内宽
- 解析结果: border=1px solid；命中时行数 = 解析出的字段数
- 动作按钮 L→R = 删除/打开/复制/保存，最右「保存」贴住卡片内容右边缘
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
- 工具条: justify=flex-start、wrap=nowrap、盒子撑满内容宽；两按钮贴左、下拉贴右、三者 top 相同
- 按钮组右端 → 下拉左端 = 剩余留白（明显大于一个按钮宽）
- 分割线①: 卡片底 → 线顶 与 线底 → 模版区顶 两个间隙相等
- remote 行: 每行的 name / url / 删除 同列对齐；行数 = `git -C <vault> remote` 的条数
- 动作按钮: justify=flex-end，最右「保存」右边缘 = 卡片内容右边缘
```

脚本末行打印 PASS / FAIL 计数，`FAIL` 必须为 0；打印出的几何值只供人眼比对，不进判据（换主题、换窗口
尺寸都会变）。

「打开」与自动同步的真机证据是可复算的副作用，不是探针：

- `require("electron").shell.openPath(<缓冲文件>)` 返回 `""`（Electron 契约：空串 = 成功）；
- `lsof` 显示外部应用的 helper 进程持有该文件（`<os.tmpdir()>/annex-gallery-profiles/<id>.json`）——
  即确实被系统给 `.json` 配的默认应用打开（是哪家应用不重要）；
- 外部按「原子保存（写临时文件 + rename）」改名后，下一个轮询周期（`<ms>`）内：卡片头 Name 跟着变、
  状态回到 `Saved`、消息行出现「已从外部应用同步并写盘。」、`data.json` 同步改；改回去同样同步回来；
- 插件 disable → enable 重载后 `problems: []`（无异常、无 console error/warning），设置页照常渲染。

### 复跑

```bash
npm run build     # 出 main.js / styles.css
npm run smoke     # 无头加载构建产物：设置页结构（含 remote 设置 + 两条分割线）+ 右键菜单 + 弹窗 + 落盘 + 状态栏
npm run remotes   # remote 设置的核心行为：真 git 仓库上验 add / set-url / 幂等 / dry-run / 扫描合并
npm run layout    # 离屏布局几何：真实 app.css + 真实 DOM + headless Chromium
node tools/layout-check.cjs --json   # 另把原始几何 JSON 打出来（看字段齐不齐，别拿数值当断言）
```

真机复核（离屏量不出来的那些：原生 select 宽度与外观、`openPath` 的路径语义、观感）：

```bash
# 端口只在启动时生效，所以要重启一次 Obsidian
osascript -e 'quit app "Obsidian"'
open -na /Applications/Obsidian.app --args --remote-debugging-port=9333 "--remote-allow-origins=*"
# 部署产物到 <vault>/.obsidian/plugins/<plugin-id>/ 后直接跑；脚本自己会 disable→enable 插件
ANNEX_SHOT=<shot-path> npm run gui     # 真机判据 + 截图
```

`npm run layout` 需要本机有 Chrome / Chromium / Edge 之一，`npm run gui` 需要 `python3` +
`websocket-client`。

## 7. 已知边界

- **离屏那条下拉的宽度没有参考价值。** 桩模块的 `<option>` 没有文字，永远量成收窄态；下拉宽度、chevron、
  控件的真实观感只能靠 `npm run gui` + 人眼看截图。
- **`layout` 只保证结构不塌**（可见性、对齐、边框、方向、溢出），运行时行为一律不在它的范围内。
- **截图不是判据。** 窗口被遮挡时 `Page.captureScreenshot` 会挂到超时；这不该让一轮复核失败。
- **设置页在较新的 Obsidian 里是独立窗口。** `app.setting.open()` 会把设置开成独立窗口（target 标题
  「设置 - <vault>」，`body` 带 `is-popout-window`），那个窗口里**没有** `app` 全局 —— 读 DOM 走设置窗口
  那个 target，读 `app` / 插件 settings 走主窗口那个 target。
- **`styles.css` 在插件加载时才注入 `<style>`。** 复核前必须 disable → enable 插件，否则量到的是内存里的
  旧 CSS。
- **状态胶囊只覆盖三个词。** 校验 error/warn 仍逐条列在文本框下方，不并入胶囊。
- **`keyOrder` 之外的键一律不写。** `constFields.eagleId` 因此在，但不进 frontmatter；要写得改 `keyOrder`。
- **remote 的写入是配置层面的。** 只 `add` / `set-url`，不 fetch、不 push、不改工作区；`dry-run` 只报不写。
- **配色与观感没有自动判据。** 最终要人眼看那张真机截图（skill `inspect-obsidian-gui-with-maxim`）。
