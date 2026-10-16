# Status bar：未提交 / 未跟踪 / 未入库 largefiles

> 这份文档是 Annex Gallery 状态栏那一行的**唯一口径**：先放 spec（用户 2026-10-17 原文），再放追问确认的
> 五处，然后是落地实况、逐条证据与实测数字。
> 可复跑的判据：`npm run verify:status`（`tools/status-check.cjs`，真 annex 仓库 + 构建产物）。

## 需求（spec 原文，用户 2026-10-17）

> 在 status bar 中显示未提交的更改数量，未入库的 largefiles 数量

## spec 没写死、由追问确认的五处（2026-10-17）

| 问题 | 口径 |
|---|---|
| 统计哪个范围 | **整个 vault** —— 当前窗口打开的那个 vault 所在的**那一个 git 仓库**（`git rev-parse --show-toplevel`；vault 通常就是仓库根），一个总数，不按文件夹拆 |
| 「未提交的更改数量」按什么口径数 | **分开计数、都显示**：已跟踪文件的改动（staged + unstaged）与未跟踪文件各算一个数（所以那一行是三个数字，不是一个） |
| 「未入库的 largefiles」指哪一批 | **还没 add 进 annex 的大文件** = `git annex add --dry-run` 里会进 annex 的那些（用 `--json` 的 `note` 区分进 git 的 `.md` / `.thumbnail.png` / `.base` / `*.py`） |
| 刷新时机 | **30 秒轮询 + 刷新按钮**（状态栏那一行整行可点 = 立即刷新，右侧另有 `refresh-cw` 图标示意可点） |
| 不是 git 仓库 / 没装 git-annex 时 | **写明原因**（如「未初始化」），并让**点击去跑「初始化 gallery」**（不是藏起来、也不是只显示 `—`） |

## 落地实况（2026-10-17）

状态栏右下角那一行（以真实 vault `Data_lab_08` 当时的数字为例）：

```
未提交 1519 · 未跟踪 2 · 未入库 largefiles 1520  ⟳
└──────── .annex-status-counts ────────────────┘  └ .annex-status-refresh（refresh-cw）
```

- 整个状态栏项 = `addStatusBarItem()` 返回的 `<div class="status-bar-item annex-status-bar">`，**一个窗口一行**；
  插件卸载时随 `registerInterval` / `registerDomEvent` 一起回收，不留 handler。
- 文字分三段，`·` 隔开；数字用 `font-variant-numeric: tabular-nums` —— 30 秒一刷新，数量变化时不会把整行挤得左右抖。
- `data-level` 四档，只管配色（`styles.css`）：`zero`（三项全 0）→ `--text-faint`；`dirty` → `--text-normal`；
  `uninitialized` / `unavailable` → `--text-warning`（这两档的文字本身就是原因说明）。
- `data-busy="true"` 时刷新图标半透明（这一趟还没跑完；vault 大时约 5 秒，见下）。
- **悬停提示（`aria-label`）写的是口径**，因为它解释的东西放不进状态栏：

```
仓库：/Users/example/Documents/Lab/lab_08_lab-project-b_2026.04.17/Data_lab_08
未提交：已跟踪文件的改动（staged + unstaged），= git status --porcelain -uall 的行数
未跟踪：同一份输出里 ?? 开头的文件数（一个文件一行）
未入库 largefiles：git annex add --dry-run 里会进 annex 的文件数（.md / .thumbnail.png / .base 按 .gitattributes 进 git，不算）
每 30 秒自动刷新 · 点击这一行立即刷新
```

未初始化 / 不可统计时，同一位置换成原因 + 出路（三档，悬停提示里同样写明）：

| 情形 | 状态栏文字 | 悬停提示里的原因 | 点击 |
|---|---|---|---|
| 不是 git 仓库 | `未初始化 · 点击初始化 gallery` | 不是 git 仓库（未初始化） | 跑「初始化 gallery」 |
| 不是 git-annex 仓库 | `未初始化 · 点击初始化 gallery` | 不是 git-annex 仓库（未初始化 annex） | 跑「初始化 gallery」 |
| 找不到 git-annex 命令 | `无法统计：找不到 git-annex 命令（brew install git-annex）` | 同上 | 重新统计 |

代码落点：`main.ts`（`setupStatusBar()` / `onStatusClick()` / `refreshStatus()` / `renderStatus()`）+
`src/core/status.ts`（口径与两个命令的解析，**没有 Obsidian import**）。

## 逐条口径（spec → 实况 → 证据）

| spec | 实况 | 证据 |
|---|---|---|
| 在 status bar 中显示 | 一行状态栏项：文字 + `refresh-cw` 图标；整行可点 | `npm run smoke`：「onload 建了状态栏那一行（.annex-status-bar）」+「状态栏项里有 refresh-cw 刷新图标」 |
| 未提交的更改数量 | `git status --porcelain -uall` 里**非 `??`** 的行数（`MM` 也只算一行） | `npm run verify:status`：已 add 未 commit → `未提交 3`；改一张已 annexed 的图 → `未提交 1` |
| （追问补的）未跟踪数量 | 同一份输出里 `??` 的行数；用 `-uall`，**一个文件一行** | `npm run verify:status`：未跟踪目录里 3 个文件 → `未跟踪 3`，并对照「不带 `-uall` 只有一行 `?? sub/ses3/`」 |
| 未入库的 largefiles 数量 | `git annex add --dry-run --json` 里 note **不含** `git repository` 的文件数 | `npm run verify:status`：2 图 + 1 md → `未入库 largefiles 2`（md 不算）；`git annex add .` 之后 → `0` |
| 范围 = 整个 vault 的仓库 | 从 `git rev-parse --show-toplevel` 拿仓库根，两条命令都在仓库根跑，不带路径过滤 | `npm run verify:status` 的临时仓库就是「vault 根 = 仓库根」这一形态 |
| 30 秒轮询 + 刷新按钮 | `this.registerInterval(window.setInterval(..., this.statusRefreshMs))`，`statusRefreshMs = STATUS_REFRESH_MS = 30_000`；点整行 → `refreshStatus()` | `npm run smoke`：`statusRefreshMs === 30000` + 「window.setInterval 确实按 30000ms 注册」 |
| 未初始化 → 点击去初始化 | `uninitialized` 时点整行 → `runInit()`（真跑 `git init` + `git annex init` + `annex.addunlocked=true` + 合并两条规则文件，见 [`docs/commands.md`](commands.md)），跑完自动重算 | `npm run verify:status`：空目录上 `click()` → Notice「初始化 gallery 完成」+ 盘上出现 `.git/annex` + 那一行变成 `未提交 0 · 未跟踪 2 · 未入库 largefiles 0` |
| 没装 git-annex → 写明原因 | `unavailable` 档，文字 = `无法统计：找不到 git-annex 命令（brew install git-annex）` | 同 `readRepoStatus()` 的 `missing` 分支（`execFile` 的 `ENOENT`） |

## 实测数字

### 真实 vault（2026-10-17，本机）

| vault | 状态栏那一行 | `git status --porcelain -uall` | `git annex add --dry-run --json` |
|---|---|---|---|
| `Data_lab_08` | `未提交 1519 · 未跟踪 2 · 未入库 largefiles 1520` | 1521 行（已跟踪 1519 + 未跟踪 2），**2.74 s** | 1521 行（会进 annex 1520 + 进 git 1），**2.68 s** |
| `Data_lab_10` | `未提交 1 · 未跟踪 186 · 未入库 largefiles 62` | 187 行（已跟踪 1 + 未跟踪 186），**0.03 s** | 187 行（会进 annex 62 + 进 git 125），**0.27 s** |

`Data_lab_08` 那 1519 行是它当时的 WIP（1432 个未暂存改动 + 87 个 typechange）：**大文件改过还没重新 add
也算「未入库」**，所以两个数字会一起大 —— 这是口径本身，不是重复计数（见下「判定要点 1」）。
两趟合计 5.4 s（`08`）/ 0.3 s（`10`），所以刷新**不能**同步跑（见「判定要点 3」）。

### 桩环境（`npm run verify:status`，临时 annex 仓库 + 构建产物）

```
干净仓库                                    → 未提交 0 · 未跟踪 0 · 未入库 largefiles 0
拷进 2 图 + 1 md（都未跟踪）                 → 未提交 0 · 未跟踪 3 · 未入库 largefiles 2
git annex add . 之后（已 add 未 commit）     → 未提交 3 · 未跟踪 0 · 未入库 largefiles 0
commit 之后                                  → 未提交 0 · 未跟踪 0 · 未入库 largefiles 0
解锁后改一张已 annexed 的图（未重新 add）     → 未提交 1 · 未跟踪 0 · 未入库 largefiles 1
重新 add                                     → 未提交 1 · 未跟踪 0 · 未入库 largefiles 0
未跟踪目录里 3 个文件                         → 未提交 0 · 未跟踪 3 · 未入库 largefiles 3
被 .gitignore 忽略的 .obsidian 下的文件        → 未提交 0 · 未跟踪 3 · 未入库 largefiles 3（数字不变）
非 annex 仓库 / 非 git 目录                   → 未初始化 · 点击初始化 gallery
空目录点一下状态栏（= 初始化 gallery）        → 未提交 0 · 未跟踪 2 · 未入库 largefiles 0
PASS=31 FAIL=0
```

## 四个「不量就会写错」的判定要点

1. **「未入库」的判据只能是 `git annex add --dry-run`**（`--json` 的 `note` 字段）：
   - 会进 annex 的文件**不给 note**；进 git 的会写 `non-large file; adding content to git repository`
     （dotfile 是 `dotfile; adding content to git repository`）→ 所以代码反过来判「note 里没有 `git repository`
     就计数」，比列举 annex 侧的文案更耐 git-annex 版本变化。
   - 它列的是**「还没 add 进 index 的文件」**：已跟踪、但内容改过还没重新 add 的大文件也在里面。所以
     「未入库」= **没 add 进 annex**，**不是**「没 commit」（verify:status 里两条断言把这层区分钉住了：
   `git annex add .` 之后 `未提交 3 / 未入库 0`）。
   - 它**尊重 `.gitignore`**：`.obsidian` 不会被算进来（临时仓库里 `.obsidian/` 下的文件在 dry-run 输出里不出现）。
2. **必须 `git status --porcelain -uall`**：默认的 `-unormal` 把整个未跟踪目录压成 `?? dir/` 一行，
   未跟踪数会变成「目录数」。verify:status 并存断言了这两种输出（3 个文件 vs 1 行）。
3. **刷新走异步 `execFile`，不用 `spawnSync`**：真实 vault 一趟 5.4 s，`spawnSync` 会在 Obsidian 的渲染
   进程里同步阻塞这么久 —— 一个状态栏数字不值得让界面卡住。`src/core/status.ts` 里的 `execAsync` 沿用
   `git.ts` 的 `cleanEnv()`（这台机器上 `HTTP(S)_PROXY` 指向常不在线的 Clash，带代理时 git/annex 会**静默失败**）；
   同一时刻只跑一趟 git 子进程，期间的请求只登记一个标记，当前这趟跑完再补一趟。
4. **未初始化那一档也是入口**：点一下就真跑「初始化 gallery」（`git init -b main` + `git annex init` +
   `git annex config --set annex.addunlocked true` + 合并 `.gitattributes` / `.gitignore`）。verify:status 在盘上复核了 `.git/annex` 出现，不是只看 Notice 文案。

## 怎么复跑

```bash
npm run build          # 出 main.js / styles.css（状态栏代码在 main.js 里）
npm run smoke          # 无头加载构建产物：设置页 + 右键菜单 + 弹窗 + 落盘 + 状态栏结构（当前 131 条断言，其中状态栏 16 条）
npm run verify:status  # 真 annex 仓库 + 逐场景数字（31 条断言）
npm run gui:status     # 真机那一行：文字 / 几何 / 配色 / 悬停提示（16 条断言/窗口，只读）
npm run gui:status -- --click   # 再点一下那一行，验证「点了会刷新」
npm run gui:status -- --reload  # 先把插件关/开一次（会改运行中的 app 状态）再量
```

`npm run smoke` 只保证**结构**（文字 span / 图标 / `data-level` / 30 秒注册 / styles.css 规则），因为它跑在
非仓库目录上；三项数字的逐场景核验在 `npm run verify:status`（临时 annex 仓库，跑完删掉，需要本机有
`git` 与 `git annex`）；配色、几何与「点了真的会刷新」只有 `npm run gui:status` 能在跑着的 Obsidian 里量
（需要 `python3` + `websocket-client`，且 Obsidian 要带 `--remote-debugging-port=9333` 启动 —— 那个开关
只在启动时生效，所以要先真退出再带参数打开，见 skill `inspect-obsidian-gui-with-maxim`）。

## 真机复核（Obsidian 1.14.4 桌面版，CDP over `--remote-debugging-port=9333`）

`Data_lab_10` 那个窗口的插件实例已经加载到含状态栏的 `main.js`，直接用 CDP 读真 DOM / computed style
（见 skill `inspect-obsidian-gui-with-maxim`），**不是**从头文件推断：

```html
<div class="status-bar-item plugin-annex-gallery annex-status-bar" data-level="dirty" data-busy="false"
     aria-label="仓库：/Users/example/Documents/Lab/lab_10_lab-project-a_2026.06.25/Data_lab_10
未提交：已跟踪文件的改动（staged + unstaged），= git status --porcelain -uall 的行数
未跟踪：同一份输出里 ?? 开头的文件数（一个文件一行）
未入库 largefiles：git annex add --dry-run 里会进 annex 的文件数（.md / .thumbnail.png / .base 按 .gitattributes 进 git，不算）
每 30 秒自动刷新 · 点击这一行立即刷新">
  <span class="annex-status-counts">未提交 1 · 未跟踪 186 · 未入库 largefiles 62</span>
  <span class="annex-status-refresh"><svg …/></span>
</div>
```

真机上量出来的（`Runtime.evaluate` + `getComputedStyle`）：

| 量 | 值 |
|---|---|
| 那一行的文字 | `未提交 1 · 未跟踪 186 · 未入库 largefiles 62` —— 与上面**独立用命令行**量 `Data_lab_10` 得到的三个数**逐个相同** |
| `data-level` / `data-busy` | `dirty` / `false` |
| 盒子 | 267 × 22 px，位置 left=1399 top=1058（状态栏右侧，与其它 5 项同一行、等高 22px） |
| 那一行（item） | `display: flex`（`inline-flex` 作为 flex 子项算出来就是 flex）、`align-items: center`、`gap: 4px`、`cursor: pointer`、`padding: 3px 4px`（app 自带） |
| 文字 span | `color: rgb(218,218,218)` = `--text-normal`（`dirty` 档）、`font-variant-numeric: tabular-nums`、`white-space: nowrap`、`font-size: 12px` |
| 刷新图标 | `<svg>` 16 × 16 px（`--icon-s` = 16px）、`color: rgb(179,179,179)`（= `--text-muted`） |
| 用到的 CSS 变量在真机上都在 | `--icon-s: 16px`、`--size-2-2: 4px`、`--text-faint: #666`、`--text-normal: #dadada`、`--text-warning: #e9973f` |

截图（状态栏局部，3× 放大）确认：文字完整未截断、图标与文字垂直居中、间距自然，没有跑版。

`Data_lab_08` 那个窗口另外实测了**重载插件**与**点击那一行**（都在同一个 CDP 会话里，用户明确授权）：

| 步骤（08 窗口） | 实测结果 |
|---|---|
| `app.plugins.disablePlugin('annex-gallery')` → `enablePlugin('annex-gallery')` | 重载成功；重载**前**那个窗口没有 `.annex-status-bar`（插件实例还是旧构建），重载后出现 |
| 重载后第一趟还没跑完时 | 文字 `统计中…`、`data-level=loading`、`data-busy=true`，盒子 74 × 22 px |
| `el.click()`（= 点那一行） | 150 ms 后 `data-busy` 已经是 `true` —— 点击**真的**触发了一趟刷新 |
| 那趟跑完 | `未提交 1519 · 未跟踪 2 · 未入库 largefiles 1520`、`data-level=dirty`、`data-busy=false`，盒子 290 × 22 px —— 与**独立用命令行**量 `Data_lab_08` 的三个数逐个相同 |

两个窗口的 16 条/窗口真机判据都过（`npm run gui:status` → `PASS=29 FAIL=0`，含 08 的 `--click` 那一趟）。
两个 vault 的 `.obsidian/plugins/annex-gallery/` 里 `main.js` / `styles.css` 都已是当前构建（与仓库内文件
sha256 相同）。
