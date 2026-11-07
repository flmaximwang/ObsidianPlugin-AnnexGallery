# Settings panel 设计说明

> **UI language:** all plugin-authored user-facing text is English-only until bilingual UI (i18n) support exists.
> This covers settings, notices, modals, status text, progress/results, errors, hints and shipped preset display text.
> Stable IDs, configuration keys and user-authored values are never translated.

## 1. 定位

**管什么**

- 设置页的**顶层顺序**：从第一个 group 到最后一条普通设置项，各区块的落点与前后关系；
- 区块内部的几何**关系式**：左边缘对齐、上下间隙相等、跨行同列、撑满内容宽、不横向溢出；
- 控件的行为契约：工具条三个入口、每行（外部文件）的打开 / 取消登记、remote 编辑器（读 `.git/config`
  与 git-annex 分支的 `remote.log`、内存草稿、Save / Reload 的写入语义）、「模板」区的登记 / Create from preset /
  打开 / 取消登记；
- 每条契约由哪条命令钉住、钉到什么程度。

**不管什么**

- 解析引擎本身（正则怎么匹配、字段怎么进 frontmatter）的算法；
- 主题配色、字体、截图观感 —— 这部分没有自动判据，只能人眼看；
- git 远端的网络行为：插件不 fetch、不 push；设置页只读写 remote 配置。

本文件**不含任何随环境变化的具体数值**。像素、耗时、坐标随主题与窗口尺寸变化，写进来既会过期也会误导；
判据一律是「相等 / 对齐 / 同序 / 撑满」这类关系式，命令与配置里的路径一律是占位符
（`/Users/<user>`、`<vault>`、`<ms>`）。

## 2. 设计原则

1. **版式只写关系，不写绝对值。** 任何「某元素该多宽」都表述成它与容器或相邻元素的关系；绝对值只出现在
   一次性防护上（如宽度上限），且要能说清上限防的是什么。
2. **app 的默认值必须显式压掉。** `.vertical-tab-content` 里的 h3 带行内边距、`.setting-group`
   自带卡片底/边框，都是核心设置页的假设，不是本页的意图；每一处都要在本页样式里显式写回，
   并且写在能赢过它的特异度上。
3. **一行控件靠自身伸缩规则分配空间。** 富余空间交给 auto 外边距吸收，收窄交给 `min-width: 0` +
   宽度上限；不写死像素宽度，也不靠容器宽度算术。
4. **特异度写在选择器里，不靠加载顺序。** 与 app.css 同权重时谁在样式表后面谁赢 —— 那是构建产物与
   app 版本的偶然，不作为设计依据。
5. **设置里只存指针。** Metadata presets and gallery templates 的**正文永远在 vault 的文件里**；`data.json` 只记
   `{ path }` / `{ id, name, path }`，不抄内容、不缓存内容。
6. **写盘保守。** 坏文件不落进任何「已登记」状态；批量写（扫描、初始化）只做幂等的最小改动。

## 3. 设想的运行状态

打开设置页（`AnnexGallerySettingTab.getSettingDefinitions()`，由 Obsidian 1.13+ 声明式渲染），
内容区自上而下是三个 `.setting-group`；旧版的两条 `<hr>` 分割线由 group heading 取代：

```
.setting-group（无 heading）
┌ .annex-remotes-card ────────────────────────────────────────────┐
│ Remotes                                                          │
│ Read from .git/config; written only when you save.               │
│ [名称: <remote>] [Fetch URL: ssh://<host>/<volume>/<path>] … [Delete]│  ← 一行一条单 URL git remote
│ [名称: <remote>] [Fetch URL: /Volumes/<volume>/<path>] [Push URL] [待改标记] [Delete]│
│                                                            [+ push URL] │
│ [Add remote]                                    [Save] [Reload]  │
│ 只读：multi-URL remotes / git-annex special remotes（带文档链接）  │
└─────────────────────────────────────────────────────────────────┘
.setting-group（heading「Metadata presets and gallery templates」）
┌ .annex-profiles-section ─────────────────────────────────────────┐
│ [.annex-profile-path-input（vault 相对 .json 路径）] [Register]        │  ← 工具条：输入 + 登记 + Create from preset
│ [.annex-profile-preset ▾]                                        │
│ TECNAI microscope (…)  id: <id>  Profiles/<file>.json      [Open][Remove] │  ← 一行一份外部 JSON
│ 多孔板成像（…）  id: <id>  Profiles/<file>.json      [Open][Remove] │
│ <该文件坏了时的错误说明（整行宽）>                                 │  ← 只有坏的那一行有
│ <该文件只有警告时的说明（整行宽）>                                 │  ← 警告不阻塞这一行
└─────────────────────────────────────────────────────────────────┘
┌ .annex-templates-section ────────────────────────────────────────┐
│ ┌ .annex-templates-card[data-kind=base] ────────────────────────┐ │
│ │ Gallery templates (extension .base)                                       │ │
│ │ <名字>  id: <id>  <vault 路径>                    [Open][Remove] │ │
│ │ [.annex-template-path-input] [Register] [.annex-template-preset ▾] │ │
│ └───────────────────────────────────────────────────────────────┘ │
└─────────────────────────────────────────────────────────────────┘
.setting-group（heading "General"）
Thumbnail edge  [<n>]                     ← control（number，key = thumbnailEdge）
Debug logging    [on/off]                    ← control（toggle，key = debugLogging）；默认关
```

### 必须成立的不变量

- **顶层顺序**（离屏与真机必须逐字一致）：
  `.setting-group（remote render）→ .setting-group（heading「Metadata presets and gallery templates」：profiles render → templates render）→ .setting-group（heading "General"：thumbnailEdge control → debugLogging control）`。
  顶层只有 `.setting-group`，没有 h1、没有 hr。
- **页面没有标题。** 侧栏已经显示 tab 名，`Annex Gallery Settings` 那个 h1 连同对抗
  `.vertical-tab-content h1{display:none}` 的样式一起删除。
- **三个编辑器是 render 项**：框架为每条定义建 `.setting-item`，name/desc 用于设置搜索；
  editor 挂在 `.setting-item-control`（框架重渲染前会 `Setting.clear()` 清空它，不会叠加），
  行上带 `annex-editor-row`，CSS 隐藏 info 列并让 control 占满整行，让编辑器卡片成为唯一视觉层。
- **两个普通设置项是 control 定义**：`Thumbnail edge`（number，`key: "thumbnailEdge"`，`validate`
  拒绝非正整数，非法值回落 `DEFAULT_SETTINGS`）与 `Debug logging`（toggle，`key: "debugLogging"`）。
  两项的 name/desc 非空且 `searchable` 不为 false，设置搜索能按「缩略图」「调试」命中。
- **`getControlValue()` / `setControlValue()` 被覆写**，读写 `host.settings` 后统一走
  `host.saveSettings()`（不依赖框架默认的 `plugin.saveData()` 路径）。
- **remote 区**是一张 `.annex-remotes-card`，git remote 的数据来源是 `<vault>/.git/config`，不是
  `data.json`：打开时读 `git config --get-regexp '^remote\.'`，一行一条 git remote（名称 / Fetch URL /
  可选 Push URL）。改动只留在内存里并标在行上（新增 / 地址变了 / 改名 / 待删除划掉），Save 之前不写盘；
  Save 把草稿与打开时的快照做 diff，按 remove → rename → set-url（fetch / push）→ add 的顺序执行；
  Reload 丢弃草稿重新读 git。多 URL remote 与 git-annex special remote 各有一段只读列表，不给编辑入口。
  special remote 的 **type** 不在 `.git/config`：git-annex 把它写在 git-annex 分支的 `remote.log` 里，
  插件本地只读 `git show git-annex:remote.log`；参数（如 `directory`）由 git-annex 存成
  `remote.<name>.annex-<param>`（`annex-directory`），主设置从这些键读。不是 git 仓库时整区禁用，提示先跑
  「Initialize gallery」。**`.git/config` 读不出来**（例如语法损坏）时不是「没有 remote」：卡片用
  `.annex-remotes-error` 逐字显示 git 的 stderr，不渲染编辑行 / Save / Add remote，也不显示
  「No git remotes yet」或 no-repo 提示，只留 Reload；把配置修好后点 Reload 即恢复正常编辑。所有新文案是英文。
- **metadata preset 区**（`.annex-profiles-section`）只有两样东西：
  1. **工具条**（`.annex-profiles-toolbar`）：`<input class="annex-profile-path-input">`（vault 相对 `.json`
     路径）+ `<button class="annex-profile-register">登记</button>` +
     `<select class="dropdown annex-profile-preset">`（占位项「Create from preset…」，之后是预设素材）。
     工具条允许换行（`flex-wrap: wrap`）：窄窗口里三个控件折行，而不是把内容顶出内容区。
  2. **已登记项列表**（`.annex-profile-list`）：每份外部 JSON 一行 `.annex-profile-row`，行内是
     `name`（来自 JSON）· `id: <id>`（来自 JSON）· vault 相对路径 · 「Open」·「Remove」。
     坏文件**仍然占一行**（路径与「打开」都留着，方便去修），下面多一行 `.annex-profile-error`；
     只有警告的文件下面多一行 `.annex-profile-warn`（不阻塞这一行）。
- **没有内联编辑器**：设置页里**不存在** 预设的 JSON textarea、解析预览、状态胶囊
  （`Saved` / `Unsaved changes` / `Syntax Error`）、逐条「保存 / 复制 / 删除 / 打开」动作排。
  内容改在 vault 的文件里改（用「打开」交给系统默认应用），插件只读。
- **旧内联 profiles 的失效提示**（`.annex-legacy-profiles-warning`）：`data.json` 里还留着旧的
  `profiles` 数组时，在 metadata preset 区顶部显示一条**非阻塞**提示，写明「不会读取、不会自动迁移，
  也不会回退到预设」，并引导把每条配置分别保存成 vault 里的一个 `.json` 后逐条登记。
  旧值**原样留在 `data.json` 里**（不迁移、不删除、不导出）。
- **旧 metadata 模板登记表的失效提示**（同一个 class）：`data.json` 里还留着旧的 `metadataTemplates`
  时也显示一条**非阻塞**提示，写明这份登记表不再被读取、不会自动迁移（`data.json` 里的旧键原样保留、
  vault 里的旧正文文件也还在），并引导改用「Create from preset」生成新格式的预设 ——
  正文模板改由预设自己的 `template` 字段指向 vault 里的 `.md`。
- **模板区**是 `.annex-templates-section` 里的**一张卡片**：`data-kind=base`（`gallery template`）。
  卡片：标题 + 一行说明 + registered list + Register row（路径输入 + 「Register」+ 「Create from preset…」下拉）。
  每行一行放下：名字 · `id:` · vault 路径 · 「Open」·「Remove」（删除**只取消登记、不删文件**）。
  **没有 metadata 模板卡片**：sidecar 的正文不再单独登记，由每条 metadata preset 的 `template` 字段指向
  vault 里的 `.md`（见 [`metadata.md`](metadata.md)）。
- **没有可直接使用的内置模板行。** 预设（`src/defaults/` 里的原文）只是「Create from preset」的**素材**：
  设置页不列内置行，也没有「查看」「复制为自定义」。**运行时同样没有内置兜底** ——
  插件只认登记过的外部文件。
- **「Create from preset」每次写独立文件**：gallery template 写 `AnnexGalleryTemplates/<preset-id>.base`；
  metadata preset 写**两份** —— 正文 `AnnexGalleryTemplates/<preset-id>.md`（素材有正文才写）与
  预设本身 `AnnexGalleryTemplates/<preset-id>.json`，JSON 里的 `template` 写成正文**实际**落盘的路径。
  路径被占用时自动加序号（`default 2.md`），**不覆盖**已有文件；写完**不自动打开**。
  画廊预设 id 为 `default`；metadata preset id 为 `tecnaitem` / `tecnaitem-embed` / `minimal`。
  metadata preset 若与已登记 id 撞车，在**待创建的那份 JSON 里**生成唯一 id（`tecnaitem-2`），名称标「(copy)」。
- **登记的校验**（两类文件各自一套）：路径必须是 vault 内相对路径（不接受绝对路径 / 盘符路径 / `..`）、
  扩展名必须对（metadata preset `.json` / gallery template `.base`）、文件必须存在、同一路径不能重复登记。
  不满足 ⇒ 只弹一条 Notice，不新增行、不写 `data.json`。
- **「打开」走系统默认应用**：`electron.shell.openPath(<绝对路径>)`；只有在拿不到 electron 且路径确实落在
  vault 内时，才退回 `app.openWithDefaultApp(<vault 相对路径>)`（那个 API 只认相对路径）。
  打开前重新做路径与存在性检查，失败 ⇒ Notice 指名 vault 路径与原因，**绝不自动创建文件**。
- **模板区没有「保存」按钮**：改动即写 `data.json`（remote 区相反：编辑只在内存里，点 Save 才写 `.git/config`）。
- **「Generate metadata」弹窗只问两件事**：一个**metadata preset 下拉**（默认按 `match` 预选，其次是按文件夹记住的
  `folderProfiles`，再其次是第一条已登记）+ 该预设的 **ask 字段**（默认 `["sample"]`，
  按文件夹记住上次填的值）。**没有模板下拉** —— 正文由预设自己的 `template` 决定，
  换预设就换正文，不需要再选一次。选中的预设 id 写进 `folderProfiles`，ask 值写进 `folderSamples`。
- **区块之间不再有分割线**：旧的两条 `<hr>`（remote ↔ 模板、模板 ↔ 普通设置项）删掉，改用
  `.setting-group` 的 heading（「Metadata presets and gallery templates」"General"）；第一个 group 的 remote 卡片自带标题，
  所以不设 heading。间距由 app.css 的 `.setting-group + .setting-group { margin-top: … }` 提供。
- **普通设置项只剩两条**「Thumbnail edge」与「Debug logging」。`.gitattributes` / `.gitignore` 用内置默认，没有「默认样品名」
  这种东西 —— 那三行在设置页不出现。

## 4. 结构与落点

| 落点 | 内容 |
|---|---|
| `src/ui/settings.ts` | `AnnexGallerySettingTab`：`getSettingDefinitions()` 返回三个 group（remote render → Metadata presets and gallery templates render ×2 → 常规 control ×2）；覆写 `getControlValue()` / `setControlValue()` 统一走 `host.saveSettings()`；`PluginSettings` / `DEFAULT_SETTINGS`（含 `profileFiles` / `baseTemplates` / `folderProfiles` / `folderSamples` / `folderBaseTemplates`，**不含 remotes**）；旧键检测（`detectLegacyInlineProfiles` / `detectLegacyMetadataTemplates`）；旧 `remotes` 键由 `main.ts` 的 `loadSettings()` 静默删掉并在有旧键时立即落盘一次；`SettingsHost` 暴露 `vaultRoot()` / `createVaultFile()`；remote 区把 `app` / `vaultRoot` / `refresh` 交给 `RemotesEditor` |
| `src/ui/remotes-editor.ts` | `RemotesEditor.render()`：打开时 `readRemotes()`；可编辑行（名称 / Fetch URL / Push URL）、待改标记、Save / Reload；多 URL 与 special remotes 只读列表（special remote 的类型来自 git-annex 分支 `remote.log`）；删除确认（annex-uuid 额外警告）；无仓库时禁用；快照带 `configError` 时只渲染 git stderr + Reload（编辑行 / Save 全部不出现） |
| `src/ui/profile-editor.ts` | `ProfileEditor.render()`：`.annex-profiles-toolbar`、`.annex-profile-list`、`.annex-profile-row`、`-name` / `-id` / `-path` / `-open` / `-del` / `-error` / `-warn`；登记 / Create from preset / 打开 / 取消登记 |
| `src/ui/templates-editor.ts` | `TemplatesEditor.render()`：`.annex-templates-section`、`.annex-templates-card[data-kind=base]`、`-title` / `-hint`、`.annex-template-list` / `-row` / `-name` / `-id` / `-path` / `-open` / `-del`、`.annex-template-add-row` / `-path-input` / `-add` / `-preset`；`TEMPLATE_FOLDER`（`AnnexGalleryTemplates/`）、`uniqueTemplateId()` |
| `src/core/external-files.ts` | 外部文件的路径规范化与校验：`normalizeVaultRelPath()` / `validateVaultRelPath()` / `resolveVaultFile()` / `readVaultTextFile()`（vault 相对路径、扩展名、存在性）；三类文件：metadata preset `.json` / 正文模板 `.md` / gallery template `.base` |
| `src/core/profile-files.ts` | 外部 metadata preset JSON 的读取：`profileFileRefs()` / `inspectProfileFile()`（不抛错，逐行显示用）/ `loadProfileFile()` / `loadProfileFiles()`（单对象约束、跨文件 id 重复、坏 JSON、坏正则、旧格式） |
| `src/core/profiles.ts` | `ParseProfile` / `ValueType` / `PatternSource` / `BUILTIN_VARIABLES` / `DEFAULT_ASK` / `LEGACY_PROFILE_KEYS`；`validateProfile()`（错误 / 警告分级）、`parseWithProfile()`、`pickProfile()` |
| `src/core/presets.ts` | 「Create from preset」的素材：`PRESET_PROFILES`（`tecnaitem` / `tecnaitem-embed` / `minimal`，各带一份正文）、`presetJsonText()` |
| `src/core/templates.ts` | gallery template id / 预设素材 / `TemplateRef`（`id` · `name` · vault 相对 `path`）/ `listTemplates()`（只有登记项）/ `resolveTemplate()`（无内置兜底）/ `readTemplateFile()` / 占位符填充（从 `placeholders.ts` 转出） |
| `src/defaults/presets/*.json`、`src/defaults/presets/*.body.md`、`src/defaults/base/*.base` | 预设素材原文 —— 源码里的唯一一份，构建时由 `defaults-text` 内联（与 `.gitattributes` 同一条路） |
| `src/core/remotes.ts` | remote 的唯一读取 / 规划 / 执行入口：`readRemotes()` 读 `.git/config`（`config: Record<string, string[]>`，保留重复键）与 git-annex 分支的 `remote.log`（快照带 `remoteLog`，读取失败时带 `configError`）；`SpecialRemote` 带 `baseType` / `externalType`；`parseRemoteConfig()` / `rowsFromSnapshot()` / `planRemoteChanges()` / `applyRemotePlan()` / `sameRemoteConfig()`（同时比对 `remote.log`）/ `specialRemoteDocUrl()` |
| `src/core/stems.ts` | `stemOf()` —— 全插件唯一的 stem 实现 |
| `styles.css` | 本页全部选择器；与 app.css 的对抗关系写在注释里 |
| `esbuild.config.mjs` | `defaults-text` 插件把 `src/defaults/presets/*.body.md`、`src/defaults/base/*.base` 内联成字符串（预设素材只有源码这一份）；`src/defaults/presets/*.json` 走 esbuild 的 JSON loader |
| `tools/layout-check.cjs` | 离屏几何（`npm run layout`） |
| `tools/real-gui-check.py` | 真机结构（`npm run gui`） |
| `tools/smoke-test.cjs` / `tools/remotes-check.cjs` | 无头结构与落盘；remote 的读取 / 解析 / diff 顺序 / 校验 / 写入语义 |

### 关键选择器与特异度

| 选择器 | 特异度 | 压掉谁 |
|---|---|---|
| `.vertical-tab-content h3.annex-templates-title` | (0,2,1) | 同上（模板区卡片的标题） |
| `.setting-item.annex-editor-row` | (0,2,0) | app 给 `.setting-item` 的内边距 / 背景 / 边框；render 项整行交给编辑器卡片 |
| `.setting-item.annex-editor-row > .setting-item-info` | (0,2,0) | 隐藏只用于设置搜索的 name/desc（编辑器自带标题） |
| `.setting-group.annex-editors-group .setting-items` | (0,3,0) | 去掉框架给 group 的卡片底/边框，避免卡片套卡片 |
| `.annex-profiles-toolbar select.annex-profile-preset` | (0,2,1) | `.dropdown { max-width: 100% }` 与 `.theme-dark .dropdown`（(0,1,0)；同权重靠顺序太脆） |

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

区块之间不再自己画分割线：`.setting-group + .setting-group` 的间距由 app.css 提供；本页只负责把
编辑器组的框架卡片底去掉（`.setting-group.annex-editors-group .setting-items`），避免「卡片套卡片」。

## 5. 约束与取舍

取舍逐条列出，每条都写清另一条为什么不取：

1. **整页声明式，不保留 `display()` 回退。** `SettingTab.display()` 在 `getSettingDefinitions()` 返回
   非空数组时根本不会被调用；`minAppVersion` 已是 1.14.4，没有旧版本要兼容。页面标题也一起删掉 ——
   侧栏已有 tab 名，硬造一个 h1 只会和 `.vertical-tab-content h1{display:none}` 对抗。
2. **工具条允许换行，但控件都收着。** 折行优于把内容顶出内容区；输入框 `flex: 1 1 16em` 吃掉剩余宽度，
   下拉有 `max-width` 上限 —— 长预设名不会把整排挤成两行。
3. **下拉收窄，不跟随最长选项。** 原生 `<select>` 按**最长选项文字**定宽，不是当前显示项；预设名一长，
   整排就被挤到第二行。下拉在选完后立刻回到占位项「Create from preset…」，收起态永远只显示这一句，所以收窄是安全的。
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
   旧格式的**预设文件**（`keyOrder` / `fields` / `constFields` / `metadataTemplate` 等）同样不迁移：
   加载时直接报错，设置页在那一行显示迁移提示，用户用「Create from preset」重建后手工搬字段。
   旧的 `metadataTemplates` 登记表也不再被读取（正文改由预设的 `template` 字段指向 vault `.md`），
   `data.json` 里的旧键与 vault 里的旧正文文件都**原样保留**，只显示一条非阻塞提示。
8. **「打开」走 `electron.shell.openPath(绝对路径)`，只在路径确实位于 vault 内时才退回
   `app.openWithDefaultApp`。** 后者吃的是**vault 相对路径**（bundle 内是 `getFilePath(p)` +
   `window.open(abs, "_external")`）；传 `TMPDIR` 那种绝对路径会被拼到 vault 根后面，指向不存在的文件
   —— **静默失败**：返回成功、什么都不弹。因此「把 API 换成探针」只能证明它被调用，证明不了它有效；
   有效性只能在真机上看副作用（`lsof` / 进程表）。
9. **remote 只在 Save 时写，`.git/config` 是唯一真相。** 设置页打开时读
   `git config --get-regexp '^remote\.'` 建快照；编辑留在内存里，Save 才对快照与草稿做 diff，按
   remove → rename → set-url（fetch / push）→ add 的顺序执行（先删再改再新增，删除 + 重建同一个名字才
   不会撞车）。rename 用 `git remote rename`，保留 `remote.<name>.*`（包括 annex-uuid / annex-ignore 与
   tracking refs）；push URL 用 `set-url --push` 写、用 `git config --unset-all remote.<name>.pushurl`
   清（不经正则）。执行前先整批校验
   （空名称/地址、名称带空白、重名、与现有 remote 撞名），有问题一条命令都不跑。不做 fetch / push，
   也不整段重写配置。
10. **打开即读，Save 前再核对一次。** 不扫描、不合并、不迁移：`data.json` 里不再有 remote，加载时静默
    删掉旧键并立即落盘一次（文件不再留着它）。每次 Save 前重新读一遍 `.git/config` 与 git-annex 分支的
    `remote.log`；和打开时的快照不一致（含 push URL、special remotes 的类型）就一条命令都不执行，
    提示用户在别处改过，然后按 git 现状重新加载。删 remote 要确认对话框；带 annex-uuid 的 remote 额外
    警告 git-annex 正在用它。没仓库时编辑器禁用。`.git/config` 读失败时显示 git 的 stderr 与 Reload，
    不把「读不了」冒充成「没有 remote」（空列表 + 永远禁用的 Save 会把坏配置藏起来）。
11. **`types` 只有 `number` / `date` / `text` 三种。** 旧格式里的 `type: "string"` 不再是 `text` 的
    同义写法 —— 新格式里类型只写在 `types` 对象里，值写错就是**硬错误**（不会被默默当成 text 放行）。
    不写 `types` 的变量一律按 `text` 处理（双引号字符串），这是最安全的默认。
12. **`.gitattributes` / `.gitignore` 不暴露路径，没有默认样品名。** 合并目标固定为 `<vault>/.gitattributes`
    与 `<vault>/.gitignore`；旧 `data.json` 里的 `gitattributesPath` / `gitignorePath` / `defaultSample`
    在 `loadSettings()` 里删掉。样品名每次生成 metadata 都在弹窗里填（仍按文件夹记住上次的值，只是预填）。
13. **预设素材以源码文件为唯一一份。** 预设文本不抄进 `data.json`、也不另存一份设置页常量：两份文本一旦
    分叉，判据就不知道以哪一份为准。「Create from preset」是拿到可改副本的唯一路径，副本是 vault 里受 git 管理的
    普通文件。metadata preset 有三份素材（`tecnaitem` / `tecnaitem-embed` / `minimal`），每份都带一份正文，
    「Create from preset」一次写出 JSON + 正文两份文件。
14. **「删除」只取消登记，不删文件。** 模板 / 预设文件是 vault 里的数据，插件只持有指针；
    删文件不可撤销，而取消登记随时可以再登记回来。
15. **CLI 与插件读的是同一种东西：一份预设一个 `.json` 文件。** CLI 没有设置页可点，所以用
    `--preset <file>` 直接给文件路径（相对当前工作目录解析），要给几条就重复给几次；
    旧的 `--profiles-file` 与 `{ "profiles": [...] }` 格式已经没有了。两条路径的区别在
    [`tools/cli.md`](tools/cli.md) 里写明。
16. **核心层不兜底，缺参数就报错。** `src/core/sidecar.ts` 的 `generateSidecars()` 拿不到 `profiles`
    时直接抛错，不再退回内置默认 —— 那样「调用方漏传参数」会变成「生成结果看起来正常但用的是另一套预设」，
    比报错难查得多。插件传外部文件，CLI 传显式预设，两条路都显式给参数。正文模板同理：预设没写
    `template` 就是「只有 frontmatter」，不是「回退到内置正文」。

### 六条只有量过才成立的约束

1. **声明式设置在 `.vertical-tab-content` 里生成 `.setting-group`，外层自带卡片底/边框。**
   `.setting-group { width: 100%; max-width: 700px; margin-inline: auto }`，编辑器行又被包进
   `.setting-items`；不去掉这两层背景，编辑器自己的卡片就会变成「卡片套卡片」。这一层只能量。
2. **app 的 `.setting-item` 自带内边距**（`padding: var(--size-4-4)`）。所以「Thumbnail edge」那一行的**文字**
   比 group 左边缘再右移一个间距；编辑器行把 padding 压成 0，卡片才与 group 左缘对齐。
   render 行的 name/desc 只服务于设置搜索，视觉上由编辑器自己的标题承担。
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

落进 `data.json` 的只有七项：

| 字段 | 默认值 | 说明 |
|---|---|---|
| Thumbnail edge（`thumbnailEdge`） | `256` | 生成 `.thumbnail.png` 的边长（px）；建议与 `.base` 的 `cardSize` 保持一致。 |
| Debug logging（`debugLogging`） | `false` | 把 git / git-annex 的进度输出到开发者控制台；默认关闭，避免默认配置下刷屏。 |
| 已登记的 metadata preset（`profileFiles`） | `[]` | 一条 = `{ path }`：**vault 相对路径**，正斜杠；一条预设一个 `.json`（顶层一条 `ParseProfile` 对象，含 frontmatter 字典与可选的 `template`）。 |
| `folderSamples` | `{}` | 按文件夹记住现场填过的 ask 值（`sample` 用目录本身当键，其余 ask 键用 `<目录>\u0001<键>`）。**没有**全局的「默认样品名」：每次生成 metadata 都要在弹窗里填。 |
| `folderProfiles` | `{}` | 按文件夹记住上次选的**metadata preset id**；「Generate metadata」弹窗的预设下拉预选它。 |
| 已登记的 gallery template（`baseTemplates`） | `[]` | 一条 = `{ id, name, path }`；`path` 是 vault 相对路径（`.base`）。 |
| 按文件夹记住的 gallery template（`folderBaseTemplates`） | `{}` | 文件夹绝对路径 → 模板 id；「Create Gallery」的模板选择预选它。 |

**remote 不落 `data.json`**：`.git/config` 是唯一真相；旧 `data.json` 里的 `remotes` 键在
`loadSettings()` 里被静默删掉（不提示、不迁移、不比较），检测到旧键时立即落盘一次，文件里不再留着它；
`Initialize gallery` 也不再写 remote。

**旧 `profiles` 数组**：旧版把 profile 内联在 `data.json` 里。新版**不读、不迁移、不删除**它 ——
它在 `data.json` 里原样留着（用户想删可以自己删），设置页只显示一条失效提示，运行时不参与。

**旧 `metadataTemplates` 数组**：旧版把 sidecar 正文模板单独登记在设置里。新版**不读、不迁移、不删除**它 ——
正文改由每条 metadata preset 的 `template` 字段指向 vault 里的 `.md`。旧键在 `data.json` 里原样留着，
旧正文文件也仍在 vault 里，设置页只显示一条失效提示。

两条规则文件（`.gitattributes` / `.gitignore`）不在设置里，见 [`commands.md`](commands.md)。

## 7. 判据

| 命令 | 钉住什么 | 钉不住什么 |
|---|---|---|
| `npm run build` | 产物 `main.js` / `styles.css` 可生成 | 任何版式 |
| `npm run smoke` | 无头加载构建产物：设置定义（3 个 group、两个 control key）、remote 区、metadata preset 区、模板区、两类外部文件的登记 / Create from preset / 打开 / 取消登记、metadata preset JSON 的各种坏法、右键菜单、弹窗、落盘、状态栏 | 几何、原生控件宽度 |
| `npm run layout` | 离屏几何：真实 app.css + 真实 DOM + headless Chromium，只回答「结构没塌」 | 下拉宽度、控件外观、运行时行为 |
| `npm run verify:core` | 核心层契约：缺 `template` / `profiles` 时直接报错，不回退内置默认 | UI 与几何 |
| `npm run remotes` | 真 git 仓库上的 `.git/config` + `remote.log` 解析（pushurl / 多 URL / special remote 类型 / annex-uuid）、diff 顺序、校验、执行失败停止、非仓库不报错 | 设置页 UI |
| `npm run gui` | 真机：原生 select 的宽度与外观、设置页与 `data.json` 的行数对应、重载后的 CSS | 配色与审美 |
| 截图 + 人眼 | 配色与观感 | — |

判定统一是**脚本全绿（`FAIL=0`）**，不是断言条数 —— 条数会随用例增长。

### `npm run smoke` 钉住的条目

无头加载构建产物，断言的是结构与落盘，例如：

```
- 设置定义：顶层 3 个 group（remote / Metadata presets and gallery templates / 常规）；第三个 group 的两项是
  control 定义，key = thumbnailEdge / debugLogging，name/desc 非空且参与设置搜索
- 设置页没有 h1（annex-settings-title）也没有 hr 分割线；三个编辑器仍挂在 render 行里
- 顶层 DOM 顺序 = remote → metadata preset → 模板区
- 没有内联编辑器：annex-profile-card / annex-profile-json / annex-preview-* / annex-profile-status /
  annex-profile-actions 的数量都是 0
- 工具条 = 路径输入 + 登记 + Create from preset（下拉），没有「新模版 / 导入模版 / 添加预设」
- 模板区：一张卡片（data-kind = base），没有 annex-template-builtin / -view-btn / -copy
- 登记：路径越界 / 绝对路径 / 盘符路径 / 扩展名不对 / 文件不存在 ⇒ 只多一条 Notice，不新增行、不写 data.json
- 同一路径不能重复登记；「删除」只取消登记、文件仍在盘上
- Create from preset：写到 AnnexGalleryTemplates/（无空格），同名加序号不覆盖，不自动打开
- 打开：拿不到系统默认应用 ⇒ Notice 指名 vault 路径；宿主抛错 ⇒ Notice 带原因；成功 ⇒ 交给宿主的绝对路径
- metadata preset JSON：顶层是数组 / { profiles: [...] } / 坏 JSON / 坏正则 / 文件丢失 / 跨文件 id 重复 /
  旧格式预设 ⇒ 行上可见错误（错误标红、警告另起一行）
- 运行时：坏文件、重复 id、空列表 ⇒ 弹窗都不开，更不写盘；外部改 id/name 后下一次生成读到新值
- 旧内联 profiles：显示失效提示、不迁移、不参与运行时
- 常规 group 里渲染出「Thumbnail edge」「Debug logging」两个 setting-item
- remote：打开读 git、Save 前不写盘（待删只是草稿，Undo 还原）、Save 后增删改、删除确认
  （带 annex-uuid 时多一条警告）、校验失败一条命令都不跑、外部改过则 Save 不执行并重载、无仓库禁用；
  编辑器直接用 esbuild 现场打包 `src/ui/remotes-editor.ts`，挂到临时真 git 仓库上跑
- 坏 `.git/config`：错误卡片逐字显示 git stderr（不渲染编辑行 / Save / Add remote，也不显示
  No git remotes yet），修好配置后点 Reload 恢复原来的编辑行；没有 remote 的仓库仍是正常空列表提示
- 旧 `data.json` 的 `remotes` 键加载时静默丢弃并立即落盘（文件里不再有它）
```

### 离屏几何（`npm run layout`）

用真实 app.css（从本机 Obsidian 安装包的 `obsidian-*.asar` 抽出，macOS 默认在
`~/Library/Application Support/obsidian/`，缓存在 `TMPDIR`）+ 真实 DOM（桩模块跑构建产物 `main.js` 的
`tab.update()`）+ headless Chromium。断言全是关系式：

```
- 没有 h1 / hr；顶层 = 3 个 .setting-group（heading：无 / Metadata presets and gallery templates / 常规）
- 三个编辑器都挂在 render 行里（annex-editor-row：remote 1 + 模板 2）
- 「Thumbnail edge」行贴住常规 group 的左边缘（行内文字另带 app 的 padding）
- remote 卡片与第一个 group 左对齐
- metadata preset 工具条: 输入框 + 登记 + Create from preset，三个控件从左往右、垂直居中，输入框吃掉剩余宽度
- 每条已登记 profile 一行：name → path → 打开 → 删除，行有 1px 边框，允许换行且不溢出
- 模板区: 一张卡片撑满内容宽；每行一行放下；登记行 = 路径输入 + 登记 + Create from preset
- 面板没有横向溢出
```

remote 区同一套量法（布局 vault 是真 git 仓库，种了 2 条单 URL remote + 1 条多 URL + 1 条 special remote）：

```
- remote 卡片撑满内容宽；标题左 = 卡片内容左，标题自身 padding=0
- 每一行的控件从左往右 = 名称 → Fetch URL →（有 pushurl 时多一格 Push URL）→ 待改标记 → Delete；
  窄行允许换行（push / 标记 / Delete 折到第二行），断言的是「左→右顺序不变」与「不横向溢出卡片」
- 行内 fetch URL 那一格比名称宽（地址更长）；有 pushurl 的行多一格 push 输入框
- [Add remote] 与标题左对齐，排在所有可编辑行下面；未改动时 Save 是禁用态（aria-disabled=true）
- 只读列表（多 URL / special remotes）与可编辑行分开，不混排；special remote 的 type 带文档链接
```

`node tools/layout-check.cjs --json` 另把原始几何打出来，用来检查字段齐不齐 —— 具体数值不作为断言。

### 真机（`npm run gui`）

在真实窗口上量，断言同样是关系式：

```
- 没有 h1 / hr；顶层 = 3 个 .setting-group（heading：无 / Metadata presets and gallery templates / 常规）
- 设置搜索能按「缩略图」「调试」命中两个普通设置项
- 工具条: 输入 + 登记 + Create from preset，三个控件从左往右；预设下拉宽度受 CSS max-width 约束
- 已登记行数 = data.json 里 profileFiles 的条数，且每行 path 一一对应
- 模板区卡片：行数 = data.json 里 baseTemplates 的条数，id 一一对应
- 没有旧内联编辑器 / 内置模板行 / 查看 / 复制为自定义
- remote 行: 每行的 name / Fetch URL / Push URL 同列对齐；可编辑行数 = `git -C <vault> remote` 里单 URL 的条数（多 URL / special remote 在只读区）
```

脚本**不点「打开」**（那会拉起系统默认应用）；打开行为的成功 / 失败由 `npm run smoke` 用可替换的
`openWithDefaultApp` 覆盖。脚本末行打印 PASS / FAIL 计数，`FAIL` 必须为 0；打印出的几何值只供人眼比对，
不进判据（换主题、换窗口尺寸都会变）。

### 复跑

```bash
npm run build     # 出 main.js / styles.css
npm run smoke     # 无头加载构建产物：设置定义（3 个 group）+ remote 设置 + 右键菜单 + 弹窗 + 落盘 + 状态栏
npm run remotes   # remote 设置的核心行为：真 git 仓库上验解析 / diff 顺序 / 校验 / 写入 / 非仓库
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
- **设置页是声明式渲染的**（Obsidian 1.13+ `getSettingDefinitions()`）：DOM 外层是 `.setting-group`，
  三个编辑器作为 render 项挂在框架的 `.setting-item-control` 里。按旧结构（h1 / hr / 顶层 section）
  量的脚本必须一起改。
- **配色与观感没有自动判据。** 最终要人眼看那张真机截图（skill `inspect-obsidian-gui-with-maxim`）。
