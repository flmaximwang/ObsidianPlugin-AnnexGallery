# Settings panel 布局

> 这份文档是 Annex Gallery 设置页布局的**唯一口径**：先放 spec（用户 2026-10-17 原文），再放落地实况与实测数字。
> 可复跑的判据：`npm run layout`（离屏几何，`tools/layout-check.cjs`）+ `npm run gui`（真机结构，`tools/real-gui-check.py`）。

## 布局（spec 原文）

Heading 全部没有 padding，目视检查与左侧对齐

<h1>: Annex Gallery Settings

(标题下方无说明)

从左往右的按钮：新模版、导入模版

(设计说明：不要 TECNAI 电镜作为 template，就用一个 default template 显示基本写法就行)

<Item n>
    <Name> <id> <状态：Saved/Unsaved changes/Syntax Error>
    解析预览
    第一行：示例文件名（全宽）
    避免可选：相对 vault 路径，解析与路径无关
    无解析按钮，输入示例文件名自动解析
    带边框的解析结果
    - 解析 1
    一排按钮：保存、复制、打开、删除，从右往左排
    （设计说明：打开为使用默认外部应用打开编辑，自动同步外部应用更改）
    右下角

</Item n>

分割线

<item> 缩略图边长
.gitattributes 用默认即可，无需设置
.gitignore 用默认即可，无需设置
没有所谓默认样品名，每次 Annex 添加 metadata 都要填入

### spec 里没写死、由追问确认的五处（2026-10-17）

| 问题 | 口径 |
|---|---|
| 「导入模版」的模板从哪来 | **用系统文件选择器选一个 `.json`**（不是粘贴 JSON、也不是从内置列表挑） |
| 卡片里的 JSON 文本框留不留 | **保留**：文本框继续就地编辑，状态胶囊显示 Saved / Unsaved changes / Syntax Error |
| 「带边框的解析结果 / - 解析 1」 | **每行一条解析**，例如 `magnification = 12345` 就是一条 |
| 新装插件的内置 profile | **仍然内置 TECNAI 电镜**；因此工具条再加一个 **「添加预设（下拉选框）」**（从左往右：新模版 → 导入模版 → 添加预设） |
| 「复制」按钮 | **复制这条 profile 成一张新卡片**（副本），不是复制 JSON 到剪贴板 |

### 追加口径（2026-10-17 二次）：最上方再加一个 item —— remote 设置

> 原文：**「然后在 setting 的最上方在添加一个可以包含多项的item：remote 设置，设置remote的名称与地址」**

| 问题 | 口径 |
|---|---|
| 放在哪 | **h1 标题下方、profile 卡片之上**（= 设置列表的最上方；不是标题之上） |
| 拿来做什么 | 存进 `data.json`（`remotes`），并在**「初始化 gallery」时逐个执行** `git remote add`（同名已存在就 `git remote set-url`），幂等，只写配置、不 fetch/push |
| 一条长什么样 | 一行 = `[名称] [地址] [删除]`；列表下方一个「添加 remote」。名称或地址缺一半时行尾给红字提示（缺名称 / 缺地址 / 名称里有空白字符） |

### 追加口径（2026-10-17 三次修正）：真机跑出来的三条

> 原文（连发三条）：**「添加预设和其他 2 个按钮需要放在同一行，靠右显示」** / **「打开现在并不会自动唤起外部编辑器」** /
> **「加载插件时，应该自动扫描 git remote 配置，某些仓库其实存在 remote，却会被识别为没有 remote」**

| 问题 | 口径 | 根因 |
|---|---|---|
| 工具条三个控件 | ~~同一行 + 整排靠右~~（**已被四次修正取代**：见下 —— 现在是两个按钮靠左、下拉靠右） | 原生 `<select>` 按**最长选项文字**定宽：TECNAI 那条 464px，把排挤到第二行（离屏桩里 option 没文字，量不出来） |
| 「打开」要真的唤起外部应用 | 绝对路径走 **`electron.shell.openPath`**（绝对路径 API，返回空串才算成功）；只有路径确实在 vault 内时才退回 Obsidian 的 `app.openWithDefaultApp` | `app.openWithDefaultApp(p)` 吃的是 **vault 相对路径**（bundle 里 `getFilePath(p)` + `window.open(abs,"_external")`）；传 `TMPDIR` 绝对路径会被拼成 `<vault>/var/folders/…` ⇒ **静默失败** |
| 加载时自动扫 remote | `onload`（+ 每次打开设置页）跑 `scanRemotes()`：仓库里有、设置里没有的**补进** `data.json`（同名**不覆盖**用户改的），并给一条 Notice | 设置页原来只看 `data.json`，仓库里已有的 remote（`lab` / `tailscale`）显示成「没有 remote」 |

### 追加口径（2026-10-17 四次修正）：工具条两端分开

> 原文：**「添加模版和导入模版按钮现在靠右了，很丑，我的要求是：添加模版和导入模版按钮靠左，但是添加预设下拉选框靠右」**

| 问题 | 口径 | 落地 |
|---|---|---|
| 工具条两个按钮 | **贴内容区左边缘** | `.annex-profiles-toolbar { justify-content: flex-start }` |
| 「添加预设」下拉 | **贴内容区右边缘**（中间留白） | `.annex-profiles-toolbar select.annex-profile-preset { margin-left: auto }`（auto 外边距吃掉富余空间，把下拉顶到右边） |
| 下拉的外观（**原话没提，落地时顺手补的**） | 挂 Obsidian 的 `dropdown` 类 —— 真机里裸 `<select>` 没有边框/箭头，看着像一段浅色文字 | `toolbar.createEl("select", { cls: "dropdown annex-profile-preset" })`；选择器要写到 `.annex-profiles-toolbar select.annex-profile-preset`（0,2,1）才压得住 app.css 的 `.dropdown { max-width: 100% }` |

### 追加口径（2026-10-17 五次修正）：两条分割线

> 原文：**「模版设置与remote设置之间添加分割线」**

| 问题 | 口径 | 落地 |
|---|---|---|
| 位置 | `hr` 插在 **remote 区与模版区之间**（顶层第 3 个元素），模版区下面原来那条分割线保留 | `containerEl.createEl("hr", { cls: "annex-remotes-divider annex-settings-divider" })`（共用外观类 + 一个自己的类，判据好写） |
| 上下留白 | 实测**上下各 18.75px**（对称） | `.annex-remotes-divider { margin: 1.25em 0 }`；上面那半留白会被 `.annex-remotes-section` 的 `1em` 底边距**折叠**（取大者），所以写 `1.25em` 才对称 —— 写 `0.5em` 实测仍是 15px |

## 落地后的实况（2026-10-17）

```
<h1 class="annex-settings-title">Annex Gallery Settings</h1>        ← 内容区第一个元素，下方无说明
┌ .annex-remotes-card ────────────────────────────────────────────┐
│ remote 设置                                                      │  ← 最上方这一项
│ 「初始化 gallery」会逐个 git remote add / set-url…                 │
│ [名称: origin] [地址: ssh://nas.example/…] [删除]                   │  ← 一行一条，可多条
│ [名称: backup] [地址: /Volumes/Backup/…] [删除]                   │
│ [添加 remote]                                                     │
└─────────────────────────────────────────────────────────────────┘
─────────────────── HR.annex-remotes-divider（remote ↔ 模版）───────────────────
[新模版] [导入模版]                              [添加预设 ▾]       ← 同一行：按钮贴左、下拉贴右
┌ .annex-profile-card ────────────────────────────────────────────┐
│ TECNAI 电镜（…） · id: tecnaitem                     [Saved]     │  ← Name · id · 状态胶囊（靠右）
│ ┌ textarea.annex-profile-json（等宽，min-height 240px）┐         │
│ └──────────────────────────────────────────────────────┘        │
│ （validateProfile 的 error/warn 逐条列在文本框下面）               │
│ 解析预览                                                          │
│ [示例文件名（全宽，输入即解析）]                                    │
│ ┌ .annex-preview-result（1px 边框）─────────────────────┐        │
│ │ magnification = 12345                               │        │  ← 每行一条解析
│ │ lens = （空）                                        │        │
│ │ index = 15                                          │        │
│ └──────────────────────────────────────────────────────┘        │
│                                     [删除] [打开] [复制] [保存]   │  ← 整排贴右下角
└─────────────────────────────────────────────────────────────────┘
────────────────── HR.annex-settings-divider（模版 ↔ 普通设置项）──────────────────
缩略图边长  [256]                     ← app 自己的 .setting-item，唯一剩下的普通设置项
```

一张卡片 = 一条 profile（`data-profile-id`）。标题、卡片列表、两条分割线都贴内容区左右边缘。

**顶层顺序（6 项，真机与离屏一致）**：
`H1.annex-settings-title → DIV.annex-remotes-section → HR.annex-remotes-divider → DIV.annex-profiles-section → HR.annex-settings-divider → DIV.setting-item`

## 逐条口径（spec → 实况 → 证据）

| spec | 实况 | 证据 |
|---|---|---|
| 标题 `<h1>`「Annex Gallery Settings」，下方无说明 | `<h1 class="annex-settings-title">` 是内容区第一个元素，紧接着就是 remote 区（原来的 h3 + 说明段已删） | `npm run layout`：顶层顺序 = 标题 → remote 区 → 分割线 → 模版区 → 分割线 → 缩略图边长 |
| Heading 全部没有 padding，与左侧对齐 | `.vertical-tab-content h1.annex-settings-title { display: block; padding: 0; margin: 0 0 16px }` | 实测：标题 left = 519 = 卡片 left = 内容左边缘 |
| 从左往右的按钮：新模版、导入模版（+ 追问补的「添加预设」） | 两个 `<button>` **贴左边缘** + 一个 `<select class="dropdown annex-profile-preset">`（占位项「添加预设…」，之后是内置预设 TECNAI 电镜）**贴右边缘**；下拉收窄到 14em | `npm run layout`（离屏 41 条：不换行 / flex-start / 新模版贴左 / 下拉贴右 / 两控件间隙 >40px / top 一致）+ `npm run gui`（真机 14 条：新模版 257 = 内容左，下拉右 868 = 内容右） |
| **（四次修正）**两个按钮靠左、下拉靠右 | `.annex-profiles-toolbar { justify-content: flex-start }` + 下拉 `margin-left: auto`；实测按钮组与下拉之间留白 282.5px | 真机：新模版 257..320、导入模版 327.5..403.5、添加预设… 686..868 |
| 不要 TECNAI 电镜作 template，用 default template 显示基本写法 | 「新模版」插入 `TEMPLATE_PROFILE`（示例 `<放大倍数>x_<序号>`，演示 regex / fields / keyOrder / ask / onMismatch）；TECNAI 改从「添加预设」下拉里加 | `npm run smoke`：「新模版来自通用模板（不是 TECNAI 电镜）」 |
| 导入模版 | 工具条里挂隐藏的 `<input type="file" accept=".json,application/json">` → 系统文件选择器；认单条 / 数组 / `{ profiles: [...] }` | `npm run smoke`：读 `.json` 后卡片数 +1 且落盘 |
| `<Name> <id> <状态：Saved/Unsaved changes/Syntax Error>` | 卡片头三项：Name、`id: …`、状态胶囊（`data-level` = ok / warn / error）；`match: …` 不再显示（在 JSON 里可见） | `npm run smoke`：状态三态断言 |
| 解析预览 / 第一行：示例文件名（全宽） | `input.annex-preview-filename { width: 100% }`；实测宽 620px = 卡片内宽 | `npm run layout` |
| 避免可选：相对 vault 路径，解析与路径无关 | 那一格删了；`buildContext(filename)` 只用文件名，relpath 就取文件名 | `npm run smoke`：`annex-preview-relpath` 数 = 0 |
| 无解析按钮，输入示例文件名自动解析 | 只监听 `input`，没有「解析」按钮 | `npm run smoke`：`annex-preview-run` 数 = 0 |
| 带边框的解析结果 / 每行一条解析 | `.annex-preview-result { border: 1px solid var(--background-modifier-border) }`，行 = `key = value`；三态不变：没填 → 提示、不命中 → 写明「正则不命中」、命中 → 结果行 | `npm run layout`：border 1px solid，3 行 `magnification = 12345 / lens = （空） / index = 15` |
| 一排按钮：保存、复制、打开、删除，从右往左排，右下角 | DOM 顺序 删除→打开→复制→保存，`justify-content: flex-end`；最右的「保存」右边缘 = 卡片内容右边缘 | `npm run layout`：两条断言 |
| 打开 = 系统默认外部应用打开编辑，自动同步外部应用更改 | 卡片 JSON 写进 `<os.tmpdir()>/annex-gallery-profiles/<id>.json` → **`electron.shell.openPath(绝对路径)`**（拿不到才退回 vault 相对路径的 `app.openWithDefaultApp`）→ 每 700ms 轮询 mtime+size，外部一改就回灌文本框、重跑校验，合法就顺手落盘 | 真机：`lsof` 见 VS Code helper 持有该文件；外部原子改名后面板同步成 `Saved` + 「已从外部应用同步并写盘。」+ `data.json` 同步改 |
| 分割线 | **两条** `hr`：`annex-remotes-divider`（remote 区 ↔ 模版区）+ `annex-settings-divider`（模版区 ↔ 普通设置项），都 1px、撑满内容宽 | `npm run layout`：顶层顺序 + 「两条分割线都可见/撑宽/1px」+「上面那条真的夹在卡片与工具条之间」 |
| **（五次修正）**模版设置与 remote 设置之间加分割线 | remote 卡片底 → 线 18.7px，线 → 模版工具条 18.8px（对称） | 真机实测（见下）+ `npm run smoke`：`children[2]` 就是 `annex-remotes-divider` |
| `<item> 缩略图边长` | 第二条分割线以下只剩这一个 `Setting`；`.gitattributes 路径` / `.gitignore 路径` / `默认样品名` 三行已删 | `npm run smoke`：`data-name` 列表 = `["缩略图边长"]` |
| .gitattributes / .gitignore 用默认即可 | 合并目标固定 `<vault>/.gitattributes` / `<vault>/.gitignore`，不再暴露路径；旧 `data.json` 里的 `gitattributesPath` / `gitignorePath` / `defaultSample` 三个键在加载时删掉 | `main.ts` `loadSettings()` |
| 没有所谓默认样品名，每次都要填入 | 「默认样品名」设置项删掉；每次生成 metadata 都在弹窗里填（仍按文件夹记住上次的值，只是预填） | 同上 |
| **（追加）**最上方一个可装多条的 item：remote 设置 | `.annex-remotes-section`（h1 之后、分割线之前）= 一张 `.annex-remotes-card`，里面有 h3「remote 设置」+ 一行说明 + N 行 `[名称][地址][删除]` + 「添加 remote」；输入即写 `data.json` 的 `remotes` | `npm run layout`（顶层顺序 + 行内几何）、`npm run smoke`（增删改/落盘/读回） |
| **（追加）**remote 的名称与地址 | 「初始化 gallery」逐个 `git remote add`；同名已存在且地址不同 ⇒ `git remote set-url`，地址相同 ⇒ `unchanged`（一个字节都不碰）；名称/地址缺一半、名称带空白 ⇒ `skipped` 并写明原因；同名重复只认第一条；dry-run 只报不写 | `npm run remotes`（21 条断言，真 git 仓库） |

## 三处 spec 没写死、我按现有信息定的判断

1. **状态胶囊怎么判**：`Saved` = 文本框内容与盘上那份**语义相同**（按键名排序后比较，只改缩进或键序不算改）；
   `Unsaved changes` = 语义不同；`Syntax Error` = JSON 解析不过。校验 error/warn 仍逐条列在文本框下方，
   不占用状态胶囊那三个词。
2. **JSON 文本框保留**：spec 没提它，但要了「保存」按钮和 Saved / Unsaved changes 两个状态 —— 没有就地编辑就
   没有这两样东西，所以保留；「打开」是**额外**的一条外部编辑通道，不是替代。
3. **失焦不再自动保存**：既然有显式「保存」和状态胶囊，textarea 失焦不再写盘（改造前会）。
   有 error 级问题的配置**任何时候都不写盘**（坏正则进 `data.json` 会让右键弹窗直接崩）。

## 真机复验（Obsidian 1.14.4，2026-10-17）

`npm run gui`（`tools/real-gui-check.py`，CDP 连跑着的 Obsidian）量的。**注意实况**：1.14 里
`app.setting.open()` 会把设置开成**独立窗口**（target 标题「设置 - <vault>」，`body` 带 `is-popout-window`），
那个窗口里**没有** `app` 全局 —— 所以读 DOM 走设置窗口那个 target，读 `app` / 插件 settings 走主窗口那个 target。
脚本开始时会 **disable → enable 插件**（styles.css 是插件加载时才注入 `<style>` 的，不重载就会量到内存里的旧 CSS）。

```
内容左边缘=257  内容右边缘=868
h1: display=block  paddingLeft=0px  left=257（= 内容左边缘）  height=18
顶层顺序: H1.annex-settings-title → DIV.annex-remotes-section → HR.annex-remotes-divider annex-settings-divider
          → DIV.annex-profiles-section → HR.annex-settings-divider → DIV.setting-item
工具条: justify=flex-start  wrap=nowrap  box 257..868
        新模版 257..320(63px) · 导入模版 327.5..403.5(76px) · 添加预设… 686..868(182px)   ← 三者 top 都是 325.7（同一行）
        按钮组右端 403.5 → 下拉左端 686 = 空隙 282.5px
分割线①(annex-remotes-divider): 卡片底 310.7 → 线顶 329.4 = 18.7px；线底 330.4 → 模版区顶 349.2 = 18.8px（margin 18.75/18.75）
remote 行: lab(273..852) · tailscale(273..852)   ← 与 `git -C <vault> remote` 的输出一致（自动扫出来的）
动作按钮: 删除(629.5) 打开(687) 复制(744.5) 保存(802..852)  justify=flex-end
REAL-GUI PASS=14 FAIL=0
```

「打开」与自动同步的真机证据（都是可复算的）：

- `require("electron").shell.openPath(缓冲文件)` 返回 `""`（Electron 契约：空串 = 成功）；
- `lsof` 显示 **VS Code 的 helper 进程持有该文件**（`Code H… 33r  …/annex-gallery-profiles/tecnaitem.json`）——
  即真的被默认外部应用（本机 `.json` 的默认应用 = `/Applications/Visual Studio Code.app`）打开了；
- 外部按「原子保存（写临时文件 + rename）」改名后 ~2 秒：卡片头 Name 跟着变、状态回到 `Saved`、
  消息行出现「已从外部应用同步并写盘。」、`data.json` 里的 profile 同步改；把名字改回去同样自动同步回来。
- 插件 disable → enable 重载：`problems: []`（无异常、无 console error/warning），设置页照常渲染。

下拉观感的对照实验（同一窗口里）：Obsidian 自己的 `select.dropdown`（外观页那几个）computed 值 =
`bg rgba(0,0,0,0) / border 0px none / radius 8px / shadow none / 有 chevron`，与我们的
`select.dropdown.annex-profile-preset` **逐项相同** —— 所以「透明无边框」是这个主题里下拉的本来样子，
不是我们样式的问题（`--dropdown-background: #333333` 那个变量在这里并没有真的画在控件上，原生下拉也一样）。

## 离屏实测数字（Obsidian 1.14.4，2026-10-17）

`npm run layout` 用**真实 app.css**（从本机 `obsidian-1.14.4.asar` 抽出）+ **真实 DOM**（桩模块跑构建产物
`main.js` 的 `tab.display()`）+ headless Chromium 量出来的：

```
内容左边缘=519   内容右边缘=1171   标题左=519   卡片左=519   「缩略图边长」行左=519（行内 padding 16px）
h1: display=block  paddingLeft=0px  marginTop=0px  fontSize=15px
顶层: annex-settings-title → annex-remotes-section → annex-remotes-divider → annex-profiles-section
      → annex-settings-divider → setting-item
分割线① 519..1171 top=377.4 1px；分割线② 519..1171 top=1098.8 1px
工具条: 519..1171（justify=flex-start, wrap=nowrap, top=397.1）
        新模版 519..582(63px) · 导入模版 589.5..665.5(76px) · 添加预设… 989..1171(182px)
示例文件名: left=535 width=620（= 卡片内宽）
解析结果: border=1px solid，3 行 magnification = 12345 / lens = （空） / index = 15
动作按钮 L→R: 删除(932.5) 打开(990) 复制(1047.5) 保存(1105)   ← 保存贴住卡片内容右边缘
LAYOUT PASS=41 FAIL=0
```

「remote 设置」那一项（同一套量法，装 2 条时）：

```
内容左边缘=519 → remote 卡片 519..1171（padding 15px + border 1px）
标题「remote 设置」left=535（= 卡片内容左边缘）、自己 padding=0、fontSize=15px
第1行: name 535..695(160px) → url 702.5..1090(387px) → del 1105..1155
第2行: 同列对齐（上下排列）
[添加 remote] left=535（与标题同列）width=96px，在两行下面
```

> 离屏那条下拉的宽度**没有参考价值**（桩模块的 `<option>` 没有文字，永远量成收窄态）——
> 下拉宽度、chevron、控件的真实观感只能靠 `npm run gui` + 人眼看截图。

## 六个「量出来才知道」的坑

1. **`.vertical-tab-content h1 { display: none; }`** —— Obsidian 1.14.4 的 `app.css` 会把设置页内容里的 h1
   **隐掉**（核心设置页的标题由 app 自己的 `.setting-page-titlebar` 提供，所以内容里的 h1 被隐藏）。插件设置页
   走旧 API，`containerEl` 就是一个 `.vertical-tab-content`，**没有 titlebar** —— 所以 spec 要的那个 `<h1>`
   必须自带 `display: block` 才看得见；同一批规则还给它 `padding: 0 var(--size-4-4)`（16px），得一起压掉。
   选择器要写成 `.vertical-tab-content h1.annex-settings-title`（0,2,1）才盖得住 app 的 (0,1,1)。
   **这条不量就会写错**：只看代码会以为 h1 正常显示。
2. **app 的 `.setting-item` 自带 16px 内边距**（`padding: var(--size-4-4)`）—— 所以「缩略图边长」那一行的**文字**
   比卡片左边缘再右移 16px。标题与卡片按 spec「没有 padding」贴内容左边缘；若想让标题跟设置项文字也对齐，
   把 `.annex-settings-title` 的 padding 改成 `0 var(--size-4-4)` 即可（一行）。
3. **原生 `<select>` 的宽度由「最长选项文字」决定**，不是当前显示的那一项。TECNAI 预设的名字很长 ⇒ 真机里
   下拉宽 464px ⇒ 把「新模版 / 导入模版 / 添加预设」这一排挤成两行。**离屏量不出来**：桩模块的 `<option>` 没有
   文字，量到 41.6px，看着完全正常。修法：`flex-wrap: nowrap` + `min-width: 0` + `max-width: 14em`
   （选完立刻回到占位项，所以收起时永远只显示「添加预设…」，收窄是安全的）。
4. **`app.openWithDefaultApp(p)` 吃的是 vault 相对路径**（bundle：`getFilePath(p)` → `window.open(abs,"_external")`）。
   传绝对路径会被拼成 `<vault>/var/folders/…`，**返回成功、什么都不弹**。教训：用「把 API 换成探针」的办法
   只能证明它**被调用**，证明不了它**有效** —— 这次就是探针绿了、功能是坏的。要真机看副作用（`lsof` / 进程表 /
   `data.json`），或至少核对 API 的入参语义。
5. **裸 `<select>` 在真机里没有任何「控件感」** —— 不挂 Obsidian 的 `dropdown` 类，就吃不到 app.css 里
   `.dropdown` 那批规则（背景 + 8px 圆角 + 右侧 chevron 的 svg），渲染出来只是一段浅色文字（**截图看得出、
   离屏量不出**：两边的盒子一样大）。挂上之后还有第二下：`.dropdown { max-width: 100% }` 与我们的
   `max-width: 14em` **同权重**（0,1,0），谁在样式表里靠后就谁赢 —— 靠「插件 CSS 排在 app.css 之后」这种顺序
   太脆，直接把选择器写成 `.annex-profiles-toolbar select.annex-profile-preset`（0,2,1）。
   判断「这个主题里下拉就该长这样」别靠肉眼：把**原生下拉**的 computed 值
   （`bg / border / radius / shadow / 有没有 chevron`）和我们的逐项比。
6. **CDP `Page.captureScreenshot` 在窗口被遮挡时会一直挂到 websocket 超时**（实测 60s：判据全过、`exit=1`、
   图根本没落地）。抓图前先 `osascript` activate + `AXRaise` 把设置窗口提到前台。另外：截图**不是判据**，
   抓不到要打印警告并继续，不能让它把一轮全绿的复核拖成失败。

## 怎么复跑

```bash
npm run build     # 出 main.js / styles.css
npm run smoke     # 无头加载构建产物：设置页结构（含 remote 设置 + 两条分割线）+ 右键菜单 + 弹窗 + 落盘 + 状态栏（133 条断言）
npm run remotes   # remote 设置的核心行为：真 git 仓库上验 add / set-url / 幂等 / dry-run / 扫描合并（21 条断言）
npm run layout    # 离屏布局几何：41 条断言（真实 app.css + 真实 DOM + headless Chromium）
node tools/layout-check.cjs --json   # 另把原始几何 JSON 打出来
```

真机复核（离屏量不出来的那些：原生 select 宽度与外观、`openWithDefaultApp` 的路径语义、观感）：

```bash
# 端口只在启动时生效，所以要重启一次 Obsidian
osascript -e 'quit app "Obsidian"'
open -na /Applications/Obsidian.app --args --remote-debugging-port=9333 "--remote-allow-origins=*"
# 部署产物到 vault 后直接跑；脚本自己会 disable→enable 插件（不用手动重载、不用重启）
ANNEX_SHOT=/tmp/annex-settings.png npm run gui     # 14 条真机判据 + 截图
```

`npm run layout` 会从 `~/Library/Application Support/obsidian/obsidian-*.asar` 抽 `app.css`（缓存在 `TMPDIR`），
本机需要 Chrome / Chromium / Edge 之一；`npm run gui` 需要 `python3` + `websocket-client`。
`layout` 只保证**结构**不塌（可见性、对齐、边框、方向、溢出），`gui` 补上真机的控件宽度/控件外观/运行时行为，
**配色与观感**最后仍要人眼看那张截图（见 skill `inspect-obsidian-gui-with-maxim`）。
