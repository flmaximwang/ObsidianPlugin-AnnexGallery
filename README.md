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
| 1 | 注册命令 | **初始化 gallery**：把**当前打开的 vault 根**（运行时取 `app.vault.adapter.getBasePath()`）初始化为 1 个用 git + git-annex 管理的 repo。目标目录**已经是 git 仓库**时**不重建、不覆盖**：跳过 `git init`，只补缺的那几步（必要时 `git annex init`；再把 annex 的「设置」核对并修复到标准状态：git-annex 分支 `annex.addunlocked=true`、本机无会压偏它的覆盖、本机不 `thin` —— 只在偏离时动手，重复运行零写入零报错；再合并两条规则文件）—— 所以一条命令里跑 **2 条 annex 命令**，形态口径（新文件以 unlocked 入库）见 [`docs/commands.md`](docs/commands.md)。最后按设置页的「remote 设置」逐个写 remote（`git remote add`，同名已存在则 `set-url`；只写配置，不 fetch/push）。 |
| 2 | 右键文件夹菜单 → **Annex Gallery** 子菜单 | **生成元数据**：为该文件夹中的图片生成 `.md` 元数据，供 `.base` 查找。**可以重跑** —— 改动模版（profile）后重算元数据时，若已有 sidecar，会先弹窗问「覆盖重算 / 只补缺失」（见下）。 |
| 3 | 右键文件夹菜单 → **Annex Gallery** 子菜单 | **生成缩略图**：为该文件夹中所有的图片生成 `.thumbnail.png` 缩略图。默认边长 **256×256**（可在插件设置页调整 `thumbnailEdge`；约定与 `.base` 的 `cardSize` 一致）。 |
| 4 | 右键文件夹菜单 → **Annex Gallery** 子菜单 | **Add largefiles to Annex**：把这个文件夹里的图片 `git annex add` 进 annex（按 `.gitattributes` 的 `annex.largefiles` 决定谁进 annex、谁进 git）。 |
| 5 | 右键文件夹菜单 → **Annex Gallery** 子菜单 | **Unlock & unannex largefiles**：先 unlock 再 unannex，让这些图片**退出 annex、交给 git 直接管**（内容留在工作树，并 `git annex add --force-small` 暂存回索引）。 |
| 6 | 右键文件夹菜单 → **Annex Gallery** 子菜单 | **Lock largefiles**：把这批图片锁回 annex 软链（index `120000`）。注意：Obsidian 会静默不索引软链（见下）。 |
| 7 | 右键文件夹菜单 → **Annex Gallery** 子菜单 | **Unlock largefiles**：把 annex 图片解锁成实文件（index `100644`）—— Obsidian 能正常索引的那一档。 |
| 8 | 右键文件夹菜单 → **Annex Gallery** 子菜单 | **Get largefiles**：把本地缺内容的 annex 文件从远端取回来（流式进度，见下）。 |
| 9 | 右键文件夹菜单 → **Annex Gallery** 子菜单 | **Drop largefiles**：丢掉该文件夹里 annex 文件**在本地的内容**（腾硬盘）。只丢「别处有足够副本」的；`.md` / `.thumbnail.png` / `.base` 不进 annex，照旧保留（见下）。 |
| 10 | 插件设置 | metadata 解析配置（profile）编辑器 + 缩略图边长；`.gitattributes` / `.gitignore` 用内置默认，不再暴露路径设置 |
| 11 | 状态栏（右下角，常显） | **未提交 / 未跟踪 / 未入库 largefiles** 三个数（统计的是**整个 vault 的那个 git 仓库**）：30 秒轮询 + 整行可点立即刷新；还没初始化时整行写「未初始化 · 点击初始化 gallery」，点一下就真跑「初始化 gallery」。口径见 [`docs/status-bar.md`](docs/status-bar.md)。 |

**右键菜单只有一层**（spec [`docs/context-menu.md`](docs/context-menu.md)，2026-10-17 口径）：file explorer 里本插件的
**所有**选项都收在一个顶层 `Annex Gallery` 项的子菜单里；父项自己不做任何事（只展开子菜单）。实现用的是
`MenuItem.setSubmenu()` —— 它是 Obsidian **内置但未进公开 typings** 的 API（`obsidian` 1.14.4 的 `obsidian.d.ts`
里没有；`obsidian.asar` 里实测存在，Obsidian 自己的编辑器菜单也在用），所以代码里给它补了一句可选签名；
万一运行环境没有它，选项退回顶层菜单（功能不丢）。子菜单只对**文件夹**出现，文件上不出现。

### 插件设置页（字段与默认值）

布局口径见 [`docs/setting-panel.md`](docs/setting-panel.md)。落进 `data.json` 的只有：

| 字段 | 默认值 | 说明 |
|---|---|---|
| 缩略图边长（`thumbnailEdge`） | `256` | 生成 `.thumbnail.png` 的边长（px）；建议与 `.base` 的 `cardSize` 保持一致。 |
| remote 设置（`remotes`） | 插件加载时从仓库自动扫 | 一条 = 名称 + 地址，可多条；**插件加载时自动扫当前仓库的 `git remote`**，把设置里没有的补进来（同名不覆盖你改过的地址）；**「初始化 gallery」时逐个 `git remote add`**（同名已存在就 `git remote set-url`，地址相同则一个字节都不碰）。 |
| `profiles` | 内置 TECNAI 电镜 | metadata 解析配置：工具条「新模版 / 导入模版 / 添加预设」增，卡片上「保存 / 复制 / 打开 / 删除」改。 |
| `folderSamples` | `{}` | 按文件夹记住现场填过的 ask 值（内置默认只有 `sample`）。**没有**「默认样品名」这种全局设置：每次生成 metadata 都要在弹窗里填。 |
| `folderProfiles` | `{}` | 按文件夹记住上次选的 profile id。 |

`.gitattributes` / `.gitignore` 的合并目标固定是 `<vault>/.gitattributes` / `<vault>/.gitignore`（桌面版取
`app.vault.adapter.getBasePath()`），**不提供路径设置** —— 用内置默认即可。旧 `data.json` 里的
`gitattributesPath` / `gitignorePath` / `defaultSample` 三个键在加载时会被删掉（已不是设置项）。

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

### git-annex largefiles 操作（Add / Unlock & unannex / Lock / Unlock / Get）

右键文件夹 → **Annex Gallery** 子菜单里的第 4–8 项。五个操作共用 `src/core/annex.ts` 的
`runAnnexOp(op, dir)`：一律 `git annex <op> --json --json-error-messages`（`get` 再加 `--json-progress`），
逐文件读 `success` 判定，绝不看退出码（见下）。报告口径是「annex 真的报了动作的文件」——
annex 对不需要动的文件**不输出任何行**（例如 unlock 一个已经解锁的文件），所以数字可能比目录里的图片数小。

| 菜单项 | 实际执行 | 要知道的后果 |
|---|---|---|
| Add largefiles to Annex | 对目录里的**图片**（`collectImages`，已排除 `.thumbnail.png`）分批 `git annex add` | 谁进 annex、谁进 git 由 `.gitattributes` 的 `annex.largefiles` 决定；新增/暂存的改动**还要 commit** 一次 |
| Unlock & unannex largefiles | `annex unlock` → `annex unannex` → `git annex add --force-small` | 图片**退出 annex、交给 git**；内容留在工作树里，并已暂存回索引（还需 commit） |
| Lock largefiles | `annex lock`（整棵子树） | 工作树里变回软链（index `120000`）—— **Obsidian 会静默不索引软链**（见 README 末尾的 pitfall 1），`[[…tif]]` 会失效；要复原用 Unlock |
| Unlock largefiles | `annex unlock`（整棵子树） | 变实文件（index `100644`），Obsidian 能正常索引 |
| Get largefiles | `annex get --json-progress`（整棵子树，**流式**） | 只取本地缺内容的；进度实时写进那条常驻 Notice。**走异步流式执行**，不阻塞 Obsidian 的 UI（下载几分钟也不会冻界面） |

**为什么开头的数字可能小于图片总数**：annex 只报它真的动了或出错的文件。反过来，`failed` 只统计 annex 明确报错的文件
（例如 get 时远端没有那份内容）。

**实现上踩到的两件事（都有测试兜住）**：

1. **普通 `git add` 会被 annex 截回 annex**。`git annex init` 会写 `.git/info/attributes` 的 `* filter=annex`，
   并把 `filter.annex.clean` 设成 `git-annex smudge --clean`。所以「unannex 之后 `git add` 保住文件」这条常见配方
   **在 annex 仓库里是假动作**：实测提交后 HEAD 里落的是 ~100 字节的指针，文件又回到 annex。
   正解是 `git annex add --force-small`（实测提交后 HEAD blob = 原文件大小）。
2. **`collectImages()` 必须把软链算作图片**。git-annex 的 locked 文件在工作树里就是软链，`Dirent.isFile()` 对它们是
   `false` —— 老代码只认 `isFile()`，于是仓库一切到 locked 模式，「生成缩略图 / 生成元数据 / Add largefiles」会
   **静默什么都不做**（实测 4 张图只数出 1 张）。现在 `isFile() || isSymbolicLink()` 都算。

### Drop largefiles（丢弃本地 annex 内容）

右键文件夹 → **Annex Gallery → Drop largefiles**：丢掉该文件夹里 annex 文件**在本地的内容**，腾出硬盘。

- **动谁**：只动 annex 里那份内容。`.md` / `.thumbnail.png` / `.base` 按上面 `.gitattributes` 的
  `annex.largefiles=nothing` 进的是 git，`git annex drop` 根本碰不到它们 —— 画廊照旧能看（封面来自缩略图）。
- **安全语义交给 git-annex**：默认只丢「别处有足够副本」的内容。别处没有副本的文件会被 annex 挡下
  （实测 `{"success":false,"note":"unsafe\nCould not verify the existence of the 1 necessary copy."}`），
  内容原样保留，报告里记为「被挡下 N 个」。要连这些也丢，只有 CLI 的 `--force` 能做（插件里不暴露）。
- **丢完长什么样**：已 lock 的文件变成指向 `.git/annex/objects/…` 的**断软链**；已 unlock 的文件
  （本仓库现状：index 全是 `100644`）变成 **~101 字节的 pointer 文件**。要取回来用 `git annex get <路径>`。
- **先预览再动手**：点菜单先算「本地有内容的文件数 + 总字节数」，弹窗确认后才真丢。预览只跑
  `git annex find --in=here`，一个字节不动 —— 因为 annex 的 `drop` **没有** `--dry-run`（实测
  `Invalid option '--dry-run'`）。
- **实现上的三个坑（都是实测踩出来的）**：
  1. annex 的**退出码不可信** —— 全失败时也是 `0`，`drop: N failed` 只出现在 stderr；所以逐文件读
     `git annex drop --json --json-error-messages` 的 `success`。
  2. 子路径**交给 git 算**（`git rev-parse --show-prefix`），别用 `path.relative(repoRoot, dir)`：macOS 上
     `/var` 与 `/private/var` 是同一目录的两种写法，`path.relative` 会算出 `../../../../var/…` 传给 annex，
     结果是 `fatal: … is outside repository`（`src/core/git.ts` 的 `realPath()` 注释里记过同一个坑）。
  3. 已经没内容的文件**不产生任何 JSON 行**；用「列出却在输出里缺席」判定「本地已无内容」。
- **端到端校验可复跑**：`node tools/verify-annex-ops.cjs`（= `npm run verify:annex`）—— 在临时 annex 仓里造出
  「图片进 annex、`.md`/缩略图进 git、另一个仓库有副本、一个文件只有本地一份」，把 6 个操作都真跑一遍：
  预览不动字节、真丢释放字节、唯一副本被挡下、子目录之外不受影响、`.md` 与缩略图逐字节未动、非仓库目录报错退 1，
  外加**插件路径**（菜单 → 弹窗 → 点确认 → 盘上真的少了）。缺 `git annex` 时打印 SKIP 退出 0。
  更全面的数据安全测试见下面的 **测试** 一节（`npm test`）。
- **CLI**：`node tools/annex-gallery.mjs drop <dir> [--dry-run] [--force] [--json]`
  （等价写法：`node tools/annex-gallery.mjs annex drop <dir> [--json]`）。

### 状态栏（未提交 / 未跟踪 / 未入库 largefiles）

右下角一直显示三个数，对应**整个 vault 所在的那个 git 仓库**（口径与实测见
[`docs/status-bar.md`](docs/status-bar.md)）：

```
未提交 1519 · 未跟踪 2 · 未入库 largefiles 1520  ⟳
```

- **未提交** = `git status --porcelain -uall` 里**非 `??`** 的行数（已跟踪文件的 staged + unstaged 改动）。
- **未跟踪** = 同一份输出里 `??` 的文件数（用 `-uall`，一个文件一行；默认的 `-unormal` 会把整个未跟踪目录
  压成 `dir/` 一行）。
- **未入库 largefiles** = `git annex add --dry-run --json` 里**会进 annex** 的文件数 —— note 里带
  `git repository` 的（`.md` / `.thumbnail.png` / `.base` / `*.py` 等按 `.gitattributes` 进 git）不算。
  它列的是「**还没 add 进 index** 的文件」，所以已跟踪、但内容改过还没重新 add 的大文件也计入：
  「未入库」= 没 add 进 annex，**不是**没 commit。
- **刷新**：30 秒轮询 + 状态栏那一行整行可点（右侧 `refresh-cw` 图标示意）立即刷新。真实 vault 上一趟
  约 0.3–5.4 秒（`git status` + `git annex add --dry-run`），所以走异步子进程、且同一时刻只跑一趟。
- **还没初始化**：那一行写「未初始化 · 点击初始化 gallery」，点一下就跑「初始化 gallery」；悬停提示写明原因
  （不是 git 仓库 / 不是 git-annex 仓库 / 找不到 git-annex 命令）。
- **端到端校验可复跑**：`npm run verify:status`（`tools/status-check.cjs`，临时 annex 仓库 + 构建产物，
  31 条断言）；结构部分在 `npm run smoke` 里（16 条）；真机那一行（文字 / 几何 / 配色 / 点击刷新）在
  `npm run gui:status` 里（`tools/status-gui-check.py`，16 条/窗口，需要带 `--remote-debugging-port` 的 Obsidian）。

## 配置驱动的 metadata 解析

metadata 生成不再是「TECNAI 专用」，改成由**可配置的 profile** 驱动：一条 profile = 一条正则 + 具名捕获组 →
字段命名与类型 + 最终写进 frontmatter 的键顺序（`keyOrder`）。schema 的唯一真相在
[`src/core/profiles.ts`](src/core/profiles.ts) 的类型与 `DEFAULT_PROFILES`
（`ParseProfile` / `FieldSpec` / `DERIVED_KEYS` / `COMPUTED_KEYS` / `DEFAULT_ASK`）。设置页可增删 / 复制多条 profile
（落进 `data.json` 的 `profiles` 数组）；右键 **Annex Gallery → 使用 Annex Gallery 管理** 的弹窗按 `match` 自动预选、并列出全部让人挑，
profile 选择与 ask 值都按文件夹记住。

### 一条 profile 能给出的五类值

优先级（同名时前者盖后者）：解析 / pathFields > 常量 > 询问 > 派生 > 自动。

| # | 来源 | 说明 |
|---|---|---|
| ① | 解析 `regex` + `fields` | 具名捕获组 → 声明的键；`type: "number"` 写裸数字，默认 `text` 写双引号字符串。 |
| ② | 派生 | `tags`（相对 vault 的第一段路径）/ `session`（所在文件夹名）/ `date`（`session` 前 8 位 → `YYYY-MM-DD`，否则空串）。 |
| ③ | 自动 | `width` / `height`（`magick identify`）/ `size`（字节数）/ `btime`（文件 birthtime，**不是**拍摄时间）/ `thumbnail` / `tif`（都是 `"[[全 vault 路径]]"`）。 |
| ④ | 常量 `constFields` | 固定写入的键值。 |
| ⑤ | 询问 `ask` | 右键（**Annex Gallery** 子菜单 → 使用 Annex Gallery 管理）时弹窗现场填（内置默认 `["sample"]`），按文件夹记住上次的值。 |

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
| 插件主入口 | `main.ts`（命令 + 状态栏 + 8 个右键菜单项 + 设置页接线；右键选项统一收进 `Annex Gallery` 子菜单；`npm run build` 打成 `main.js`） |
| 核心逻辑 | `src/core/init.ts` · `rules.ts` · `thumbnails.ts` · `sidecar.ts` · `stems.ts` · `annex.ts` · `git.ts`（不依赖 Obsidian，插件与 CLI 共用） |
| 设置页 | `src/ui/settings.ts`（字段定义与 `DEFAULT_SETTINGS`） |
| 内置默认模板 | `src/defaults/gitattributes` · `src/defaults/gitignore` |
| CLI 源码 | `tools/cli.ts` |
| 测试与校验 | `tests/test-annex-functions.cjs`（`npm test`）· `tools/verify-annex-ops.cjs` · `tools/verify-sidecar-overwrite.cjs` · `tools/smoke-test.cjs` · `tools/obsidian-stub.cjs` |

CLI 走同一套核心逻辑、脱离 Obsidian 跑。构建产物 `tools/annex-gallery.mjs` 由 `npm run build` 生成、**不入库**：

```bash
node tools/annex-gallery.mjs init    <dir> [--dry-run] [--json]
node tools/annex-gallery.mjs thumbs  <dir> [--edge 256] [--dry-run] [--force] [--json]
node tools/annex-gallery.mjs sidecar <dir> --vault <vaultRoot> --sample <name> [--repo <root>] [--apply] [--overwrite] [--force] [--plan] [--json]
node tools/annex-gallery.mjs stems   <dir> [--json]
node tools/annex-gallery.mjs drop    <dir> [--dry-run] [--force] [--json]
node tools/annex-gallery.mjs annex   <add|unlock|lock|get|unannex|drop> <dir> [--json]
node tools/annex-gallery.mjs defaults          # 打印插件内置的 .gitattributes 模板
```

## 测试

| 命令 | 覆盖 |
|---|---|
| `npm test` | `tests/test-annex-functions.cjs`：**多对本地仓库 + 远程 annex 仓库**上的 6 个命令，判「无异常」+「不丢数据」—— 每步之后复核原始内容哈希、远程那份内容始终没被动过、`.md`/缩略图逐字节不变、`unannex` 出来的文件不受 `drop` 影响，最后跑 `git annex fsck`。场景：A 远程有副本（6 个命令全跑）· B 本地唯一副本（drop 必须被拒）· C 内容只在远程（get 必须取回）· D 两个远程（副本只在 remote2） |
| `npm run smoke` | 桩加载构建产物 `main.js`：插件能启用、8 个菜单项顺序与图标、设置页渲染、右键弹窗与落盘 |
| `npm run verify:annex` | 6 个操作在真 annex 仓上的行为与报告（含插件路径：菜单 → 弹窗 → 真丢） |
| `npm run verify:sidecar` | 「生成元数据」重跑：`--plan` 不写盘、默认只补缺失、`--overwrite` 覆盖重算、脏文件保护；以及插件侧「覆盖重算 / 只补缺失」弹窗 |
| `npm run layout` | 设置页布局（真实 app.css + headless Chromium） |

需要 `git`、`git annex`（测试会 SKIP）与 `magick`（overwrite 测试会 SKIP）。

**当前状态**：远端已创建（`flmaximwang/ObsidianPlugin-AnnexGallery`，private，`main` 已推送）；插件本体尚未发布到
Obsidian 社区市场。`obsidian-image-gallery` 目前仍以手拷副本存在于 default 与 `plasmid-engineer` 两个 profile，
**迁移完成后会走 hub 安装并清掉手拷副本**（profile 收敛是另一块，需用户发话）。

## skills/obsidian-image-gallery

一图三件套（`<stem>.tif` / `<stem>.thumbnail.png` / `<stem>.md`，同目录同 stem），`.base` 只读 sidecar 的
frontmatter；正文**不嵌图**，只放两条可点击链接（`缩略图：[[…thumbnail.png]]` + `原图（用系统默认程序打开）：[[…tif]]`）——
cards 视图的封面来自 frontmatter 的 `thumbnail`（`image: note.thumbnail`），`.tif` 本身 Obsidian 渲染不了。

已实测的两个坑：

- **git-annex 工作树里的软链会被 Obsidian 静默丢弃**（`realpath` 落在 vault 根内即跳过）⇒ `[[…tif]]` 永远解析不到。
  首选解法 `annex.thin true` + `git annex unlock`（会改用户数据仓库语义，须先确认）。
- **缩略图必须按全 vault 路径链接**：显微图像 stem 跨会话重名（实测 118 个 basename 里 48 个被 >1 条笔记共用）。

交付前的五步验证（frontmatter 解析、双链目标存在、缩略图同一几何、`.base` 的 cards 视图带 `image: note.thumbnail`、
hub 笔记不带画廊 tag）都在 [SKILL.md](skills/obsidian-image-gallery/SKILL.md) 正文。

---
name: obsidian-image-gallery
description: Use when building an Obsidian gallery over images.
platforms: [macos, linux, windows]
---

# Image gallery in Obsidian via Bases (sidecar-md pattern)

Use when the user wants an image *browser* in Obsidian (gallery, contact sheet, filterable image
library) over a data folder — typically replacing Eagle / TagSpaces. Verified against Obsidian
1.14.4 and a 218-image TEM library (`lab_10/Data/TEM`, git-annex).

## The shape that works

One image = three files, same folder, same stem:

```
<folder>/<stem>.tif              # original (may be an annex symlink — see pitfall 1)
<folder>/<stem>.thumbnail.png    # 256x256 cover by default (plugin setting; keep == .base cardSize)
<folder>/<stem>.md               # the metadata file ("the Eagle .info replacement")
```

- Thumbnail name MUST be `<stem>.thumbnail.png`, not `<stem>.png`: a later original may itself be a
  `.png`, and derived artifacts must stay distinguishable from source images.
- Sidecar frontmatter carries every displayable/filterable value; the `.base` only reads them.
- Body: two *clickable links*, not image embeds — `缩略图：[[<full vault path>.thumbnail.png]]`
  then `原图（用系统默认程序打开）：[[<full vault path>.tif]]`. Do **not** write `![[…]]` embeds
  (user directive, 2026-10-08): Obsidian cannot render `.tif` anyway, and the cards-view cover comes
  from the frontmatter `image: note.thumbnail` key, not from a body embed.
- ImageMagick one-liner (macOS has `magick`; no PIL needed):
  `magick in.tif -resize 256x256 -strip -define png:compression-level=9 out.thumbnail.png`
  An sRGB 2048x2048 tif lands as an 8-bit Grayscale png — measured ~49 KB at 256x256 (~7 KB at 96x96).
  Thumbnails stay in git (`.gitattributes` → `annex.largefiles=nothing`), so 218 of them ≈ 10 MB.

## Pitfall 1 — symlinked sources (git-annex, DVC, DataLad) are silently DROPPED

Obsidian's FileSystemAdapter walks the vault, `lstat()`s each entry, and for a symlink resolves
`realpath` then **skips it when the target is inside the vault root** ("Symlink targets must be
fully disjoint from the vault root", obsidian.md/help/symlinks). Source, `obsidian.asar`:
`reconcileFileInternal` -> `reconcileSymbolicLinkCreation` ->
`for (a in watchers) if (i.startsWith(w.resolvedPath + sep)) return;`

Consequence: a git-annex working tree inside the vault always loses — its symlinks point at
`<repo>/.git/annex/objects/...`, which is inside the vault. The `.tif` never enters the index and
`[[path.tif]]` stays an unresolved link, whatever link format you use. Folder symlinks are
rejected outright; file symlinks are "may work" only when the target is outside the vault.

Fixes, in order of preference:
1. **Unlock with thin** — `git config annex.thin true` then `git annex unlock <paths>`: the working
   tree becomes real files hardlinked to the annex objects (same filesystem), so Obsidian indexes
   them as ordinary attachments at zero extra disk cost. Cost: with `annex.thin` you must never edit
   those files in place, and `git annex drop` semantics change. Confirm with the user first — it
   mutates their data repo.
2. Keep symlinks and make the vault root not contain `.git` (vault = the image folder, repo above
   it). Layout-fragile; only when the user won't unlock.

Same trap applies to your own sidecars: if the repo sets `annex.largefiles=include=*`, a later
`git annex add` turns `.md`/`.thumbnail.png` into symlinks too and the gallery silently dies.
Pin them with `.gitattributes`: `*.md annex.largefiles=nothing` / `*.thumbnail.png annex.largefiles=nothing`.

## Pitfall 2 — link the thumbnail by FULL vault path

Microscopy stems repeat across sessions (`12345X-1-0001.tif` in two different date folders): in one
218-image library 48 of 118 basenames were shared by >1 note. Basename-only wikilinks then resolve
to the wrong file. Write `thumbnail: "[[Data/TEM/<session>/<stem>.thumbnail.png]]"` (same for `tif`).
Assert it in the build: count duplicate basenames before choosing the link format.

## Cards view keys (read out of the 1.14.4 settings schema, not guessed)

```yaml
views:
  - type: cards
    name: 画廊·全部
    image: note.thumbnail        # key is `image`, type property, value must be a wikilink
    imageAspectRatio: 1          # slider .25-2.5, step .05, default 1
    imageFit: contain            # {"": cover, contain}
    cardSize: 96                 # slider 50-800, step 10, default 200 — width of a card
    order: [file.name, sample]   # properties printed on the card
    groupBy: {property: note.session, direction: ASC}
```

Set `cardSize` equal to the thumbnail's pixel size, otherwise the cover is upscaled and looks soft.
At 96 px a cover is enough to tell images apart but useless for judging structure — say so when the
user asks for 96 px, and keep the thumbnail size a single constant so re-rendering at 500 px (with
cardSize 500) is one command.

## Frontmatter fields that earn their place

`tags: [<gallery tag>]` (the base filter), plus per-image: source id, sample/group, session/folder,
date, magnification, lens, index, width, height, size, and the two link fields. Keep numeric fields
unquoted and camelCase. Mirroring an existing library's own field names (Eagle: `btime`, `eagleId`,
`size`) is the cheapest way to make the sidecars credible — but **verify what a timestamp means
before naming it**: Eagle `btime` looked like acquisition time, yet within one session the 10-30
images spanned 0.1-2 min in index order and sibling session folders interleaved — that is file-write
/ import time, not exposure time. Name it `btime`, don't name it `acquired`.

## Config-driven metadata parsing（配置驱动的 metadata 解析）

The generator ships a TECNAI profile but is **not** TECNAI-only: a *profile* is one regex with named
groups → named/typed fields → the exact frontmatter key order. The schema of record is the types plus
`DEFAULT_PROFILES` in `src/core/profiles.ts` (`ParseProfile`, `FieldSpec`, `DERIVED_KEYS`,
`COMPUTED_KEYS`, `DEFAULT_ASK`). Adding a second, unrelated naming convention means editing
settings/JSON only — no code change. The settings tab edits multiple profiles (persisted in
`data.json`'s `profiles` array); the right-click prompt pre-selects by `match` and remembers the
choice per folder.

Five value sources per profile, precedence `parsed/pathFields > constFields > ask > derived > computed`:

1. **parsed** — `regex` named groups → `fields` (`type: "number"` renders bare, default `text` renders double-quoted);
2. **derived** — `tags` (first vault-relative path segment), `session` (folder name), `date` (first 8 chars of `session` → `YYYY-MM-DD`, else empty);
3. **computed** — `width`/`height` (`magick identify`), `size` (bytes), `btime` (file birthtime, *not* exposure), `thumbnail`/`tif` (both `"[[full vault path]]"`);
4. **constant** — `constFields`;
5. **asked** — `ask` (default `["sample"]`), filled in the right-click prompt, remembered per folder.

`keyOrder` **is** the final frontmatter key order: keys not listed are never written (add a field only
if you also add it to `keyOrder`); a listed key with no value from any source is **omitted** and noted
in that sidecar's detail. Three hard rules: (1) named groups absent from `fields` are **discarded** —
this lets you write branch regexes such as `(?:(?<lens>\d{1,2})|(?<lensToken>[0-9A-Za-z]+))` where the
long token only balances the alternation; (2) a group that did not participate in the match writes its
field's `whenMissing` (default empty string, key kept); (3) a fully non-matching name follows
`onMismatch` — `empty` (blank fields, counted in `mismatch`, default) or `skip`. `pathRegex` +
`pathFields` run on the vault-relative path and override same-named derived values.

CLI surface: `node tools/annex-gallery.mjs profiles --list | --check | --parse "<name>" [--path <rel>]
[--profile <id>]`, and `sidecar <dir> --vault <root> --profiles-file <json> [--profile <id>]
[--apply|--verify]`. A worked example with a `plate/well/magnification/index` convention completely
unlike TECNAI — plus a rerun script — lives in `tools/example-profiles/`.

## A live Obsidian session rewrites your .base

While the vault is open, the app re-serializes `.base` files after any UI edit: keys get reordered,
`note.session` in `groupBy`/`summaries` is normalized to `session`, and user tweaks (an extra card
property, a dragged `cardSize` slider) land in the same file. Consequences: (1) a blind
regex/rewrite of the `.base` can silently clobber or miss what the user set by hand — read the
current file first and patch exact values; (2) a count-based sed-style replacement gives false
confidence ("5 replacements" when one card had been pulled to a different number). Re-read and
assert the final value per view.

## Validation before reporting done

1. `yaml.safe_load` every sidecar's frontmatter; assert required keys and types (`datetime` is a
   legitimate parse of an unquoted timestamp — don't fail it), tag present.
2. For each link field, regex `\[\[(.+)\]\]` and assert the target exists under the vault root.
3. `magick identify -format "%w %h\n"` every thumbnail; assert one geometry bucket.
4. `yaml.safe_load` the `.base`; assert the cards views carry `image: note.thumbnail`.
5. The hub/index note must NOT carry the gallery tag, or it renders as a row. Assert that.
