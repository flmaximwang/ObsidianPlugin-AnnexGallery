# Status bar：未提交 / 未跟踪 / 未入库 largefiles

> 状态栏那一行的**唯一口径**：它替谁回答什么问题、三个数字各自怎么数、刷新与交互上有哪些不变量、
> 代码落在哪、以及用什么判据钉住。
> 本文只写设计原则与判据：数量、耗时、几何一律用占位符（`<count>` / `<n>` / `<ms>` /
> `<width> × <height> px @ (<x>, <y>)`），路径用 `/Users/<user>/Documents/Lab/<library>/Data_<library>`，
> 运行时仓库根用 `<vault>`。
> 可复跑的判据：`npm run verify:status`（`tools/status-check.cjs`，真 annex 仓库 + 构建产物）。

## 这一行是什么

状态栏右下角的一行，回答一个很窄的问题：**这个库现在有什么没落到该落的地方**。它给的是广度
（整个仓库的三个总数），不是某一目录的明细 —— 明细属于文件管理器和命令面板，状态栏只负责让人一眼看出
「要不要跑一次 add / 要不要 commit」。

```
未提交 <a> · 未跟踪 <b> · 未入库 largefiles <c>  ⟳
└──────── .annex-status-counts ────────────────┘  └ .annex-status-refresh（refresh-cw）
```

（`<a>` / `<b>` / `<c>` 是三个各自独立计的数。）

这一行 = `addStatusBarItem()` 返回的 `<div class="status-bar-item annex-status-bar">`，**一个窗口一行**；
插件卸载时随 `registerInterval` / `registerDomEvent` 一起回收，不留 handler。

**不可统计时不隐藏、也不只显示 `—`**：同一位置换成「原因 + 出路」，并且那一行仍可点。状态栏是遇到
「未初始化」的第一个地方，藏起来等于把唯一的入口藏了。

## 三个计数的口径

| 计数 | 定义 | 为什么必须有这一个 |
|---|---|---|
| 未提交 | 已跟踪文件的改动（staged + unstaged）= `git status --porcelain -uall` 里**非 `??`** 的行数；`MM` 也只算一行 | 这一批已经进了 index/历史，缺的是 commit。插件不代劳 commit，所以只能把量报出来 |
| 未跟踪 | 同一份输出里 `??` 开头的行数；用 `-uall`，**一个文件一行** | 这一批既不在 git、也不在 annex，`git annex add` 不会碰它，是三个口径里最容易被忘掉的一批 |
| 未入库 largefiles | `git annex add --dry-run --json` 里 note **不含** `git repository` 的文件数（会进 annex 的那些） | 这是「库」的完整性：文件只在 annex 里才算入库。这个数决定要不要跑一次 `git annex add` |

三个数而不是一个总数，是因为它们对应文件可能停留的三个不同位置（工作树未跟踪 / index 里未提交 /
annex 里已入库），**下一步动作各不相同**（`add` / `commit` / 什么都不用做）。合成一个数就分不出
「该 add」和「该 commit」。

两条配套约束：

- **范围 = 整个 vault 所在的仓库**：从 `git rev-parse --show-toplevel` 拿仓库根（vault 通常就是仓库根），
  两条命令都在仓库根跑、不带路径过滤，出**一个总数**，不按文件夹拆。
- **同一个文件可以在两个口径里各算一次**：已 annexed 的图解锁后改过、还没重新 add，则「未提交」与
  「未入库」都非零。这不是重复计数，是两个不同的问题都还没解决。

## 刷新与交互的不变量

| 不变量 | 形态 | 为什么 |
|---|---|---|
| 轮询间隔 | `this.registerInterval(window.setInterval(..., this.statusRefreshMs))`，`statusRefreshMs = STATUS_REFRESH_MS = 30_000` | 30 秒是「足够快地发现刚 add 完的那批」与「不无谓跑子进程」之间的取值；间隔只从常量来，不在调用点写字面量，冒烟测试直接读字段断言 |
| 点击 | 整行可点 = `onStatusClick()`：可统计 → `refreshStatus()`；`uninitialized` → `runInit()`，跑完自动重算 | 不整块可点的话，「看一眼数字」和「做下一步」就是两处入口；这一行本身就是入口 |
| 单飞 | 同一时刻只跑一趟 git 子进程；期间的请求只登记一个标记，当前这趟跑完再补一趟 | 连点/轮询撞在一起时不叠进程，也不会丢最后一次请求 |
| busy 态 | `data-busy="true"` 时刷新图标半透明（这一趟还没跑完）；重载后首趟是 `统计中…` + `data-level="loading"` | 耗时随 vault 的文件数增长、不是零成本，所以要能看出「正在算」而不是「算出来是 0」 |
| `aria-label` | 写**口径**，不写标语：仓库路径、三个计数各是什么、刷新节奏 | 定义放不进状态栏那一行，但解释必须随手可得 |

`aria-label` 的文案模板（多行）：

```
仓库：/Users/<user>/Documents/Lab/<library>/Data_<library>
未提交：已跟踪文件的改动（staged + unstaged），= git status --porcelain -uall 的行数
未跟踪：同一份输出里 ?? 开头的文件数（一个文件一行）
未入库 largefiles：git annex add --dry-run 里会进 annex 的文件数（.md / .thumbnail.png / .base 按 .gitattributes 进 git，不算）
每 30 秒自动刷新 · 点击这一行立即刷新
```

最后一行跟着当前状态换（`初始化 gallery` / `重新统计` / `立即刷新`）—— 因为点击的含义随
`uninitialized` 变，提示若不自洽就成了一句错话。

## 不可统计的三档：写明原因 + 给出路

| 情形 | 状态栏文字 | 悬停提示里的原因 | 点击 |
|---|---|---|---|
| 不是 git 仓库 | `未初始化 · 点击初始化 gallery` | 不是 git 仓库（未初始化） | 跑「初始化 gallery」 |
| 不是 git-annex 仓库 | `未初始化 · 点击初始化 gallery` | 不是 git-annex 仓库（未初始化 annex） | 跑「初始化 gallery」 |
| 找不到 git-annex 命令 | `无法统计：找不到 git-annex 命令（brew install git-annex）` | 同上 | 重新统计 |

前两档合并成一句「未初始化」，因为对状态栏这一行来说它们要做的动作是同一个；区别留在悬停提示里。

「找不到 git-annex」有两种来路，别混：**真的没装**，与**装了但 GUI 的 PATH 里没有它**。从 Finder / Dock
启动的 Obsidian 继承的是 launchd 的那份极小 PATH（`/usr/bin:/bin:/usr/sbin:/sbin`），Homebrew 的
`/opt/homebrew/bin` 不在里面 —— `git` 找得到（`/usr/bin/git`），`git annex` 却退化成
`git: 'annex' is not a git command. See 'git --help'.`（exit 1），后者才是本插件必须自己处理的。做法是给
**每个子进程**的 PATH 末尾补上常见可执行目录（见下节），于是「装了但 GUI 看不见」这一档不再出现；真的
一个都找不到时，状态栏写「找不到 git-annex 命令（brew install git-annex）」，悬停提示里写明是 PATH 的问题
（细节与复现见 [`issues/git-annex-not-on-gui-path_2026.10.19.md`](../issues/git-annex-not-on-gui-path_2026.10.19.md)）。

同一根因还会让 **`git status` 自己失败**：`git annex init` 写下的 `* filter=annex` 与
`filter.annex.process = git-annex filter-process` 意味着「工作树里尺寸不变的改动」必须过 clean filter 才算得出
哈希，这时 git 报 `git-annex filter-process: git-annex: command not found`（exit 128）—— 连前两个数都拿不到。
两条命令的失败点因此都要认这两种原文，各自报同一句「找不到 git-annex 命令」。

## 数据来源与为什么是异步

数据只来自两条命令（`src/core/status.ts`，**没有 Obsidian import**）：`git status --porcelain -uall` 与
`git annex add --dry-run --json`，都在仓库根执行。

- **异步 `execFile`，不用 `spawnSync`**：真实 vault 上一趟两条命令不是零成本（随文件数增长），
  `spawnSync` 会在 Obsidian 的渲染进程里同步阻塞这么久 —— 一个状态栏数字不值得让界面卡住。
- **`cleanEnv()` 剥掉代理变量**（沿用 `git.ts` 的做法）：代理变量会让 git/annex **静默失败**而不是报错，
  失败被当成「0 个」比报错更坏。
- **`cleanEnv()` 同时补 PATH，且只追加不前置**：`/opt/homebrew/bin` / `/opt/homebrew/sbin` / `/usr/local/bin` /
  `/usr/local/sbin` / `/opt/local/bin` / `/opt/local/sbin` / `~/.local/bin` / `~/bin` 里**存在且不在 PATH 中**的，
  按顺序追加到末尾；`ANNEX_GALLERY_EXTRA_PATH` 可以再补自定义目录。前置会改变 `git` 的解析（Homebrew Git 会
  压过 `/usr/bin/git`），追加只解决「PATH 里根本没有这个目录」这一件事。判据也在这里：`ANNEX_GALLERY_NO_PATH_FIX=1`
  关掉补 PATH，`verify:status` 用它证明修复不是碰巧。
- **反过来判 note**：`--json` 里会进 annex 的文件**不给** `note`，进 git 的写
  `non-large file; adding content to git repository`（dotfile 是 `dotfile; adding content to git repository`）。
  代码判「note 里没有 `git repository` 就计数」，比列举 annex 侧文案更耐 git-annex 版本变化。
- **`--dry-run` 尊重 `.gitignore`**：`.obsidian` 下的文件不出现，也就不计入。

## 结构落点

| 位置 | 承担什么 |
|---|---|
| `src/core/status.ts` | 口径本身：`STATUS_REFRESH_MS`、两条命令的解析、`RepoStatus` 的四档判定、`aria-label` 文案合成。不 import Obsidian，所以在 Node 里能单独驱动 |
| `main.ts` | `setupStatusBar()` 建 DOM 与事件、`onStatusClick()` 分流点击、`refreshStatus()`（单飞 + 写状态）、`renderStatus()` 把 `RepoStatus` 落到文字/`data-level`/`data-busy`/`aria-label` |
| `styles.css` | `.annex-status-bar` / `.annex-status-counts` / `.annex-status-refresh`，以及 `data-level` 四档、`data-busy`、`:hover` 的配色 |
| `tools/status-check.cjs` / `tools/status-gui-check.py` | 判据侧（见下节），不是运行时的一部分 |

## 视觉不变量

- **与同一排其它状态栏项等高、同基线**：这一行是 flex 子项，`display: flex`（`inline-flex` 作为 flex 子项
  算出来就是 flex）、`align-items: center`；`padding` 用 app 自带的，不自造。宽度**随文字长短变**，
  不设固定宽度 —— 三个数会变位数。
- **等宽数字**：`font-variant-numeric: tabular-nums`，30 秒一刷新，数量变化时整行不会左右抖。
- **变量驱动**：颜色和尺寸只取主题变量 —— `--text-faint` / `--text-normal` / `--text-warning` /
  `--text-muted` / `--icon-s` / `--size-2-2`，图标尺寸取 `--icon-s`、颜色取 `--text-muted`。硬编码
  `px` / 十六进制色会在别人的主题下失效。
- **`data-level` 四档只管配色**：`zero`（三项全 0）→ `--text-faint`；`dirty` → `--text-normal`；
  `uninitialized` / `unavailable` → `--text-warning`（这两档的文字本身就是原因说明）。
- `cursor: pointer`（整行可点必须有指针反馈）、文字 `white-space: nowrap`（不折行）。

## 判据：三层各钉什么

| 判据 | 钉住什么 | 边界 |
|---|---|---|
| `npm run smoke` | **结构**：`.annex-status-bar` 建出来了、项里有 `refresh-cw` 图标、文字 span / `data-level` / `styles.css` 规则齐全、`statusRefreshMs === 30000` 且 `window.setInterval` 确实按 30000ms 注册 | 跑在非仓库目录上，**不认识数字对不对** |
| `npm run verify:status` | **口径**：临时真 annex 仓库里逐场景的数字与相对变化（下面两张表） | 不验配色与几何 |
| `npm run gui:status` | **真机**：跑着的 Obsidian 里那一行的文字 / 几何 / 配色 / 悬停提示 / 点击真的触发刷新 | 需 `python3` + `websocket-client`，且 Obsidian 带 `--remote-debugging-port=9333` |

断言写的是**场景与相对变化**，不是某台机器上的绝对数字：数字随拷进去的文件数变，判据不变。

| 场景 | 期望 |
|---|---|
| 干净仓库 | 三个数全 0 |
| 拷进 `<n>` 张图 + 1 个 md（都未跟踪） | 未跟踪 = 拷入的文件数；未入库只数图（md 进 git，不算） |
| `git annex add .` 之后（已 add 未 commit） | 未提交 = 已 add 的文件数；未入库归 0 |
| commit 之后 | 三个数全 0 |
| 解锁后改一张已 annexed 的图（未重新 add） | 未提交与未入库**都变成非零** —— 同一个文件在两个口径里各算一次 |
| 重新 add | 未入库归 0；未提交仍计（还没 commit） |
| 未跟踪目录里放多个文件 | 未跟踪 = 文件数（不是目录数） |
| 被 `.gitignore` 忽略的 `.obsidian` 下的文件 | 三个数都不变（dry-run 尊重忽略规则） |
| 非 annex 仓库 / 非 git 目录 | `未初始化 · 点击初始化 gallery` |
| PATH 只剩 launchd 那四个目录（= 从 Finder / Dock 启动的 Obsidian） | 三个数与终端里**逐个相同**；关掉补 PATH（`ANNEX_GALLERY_NO_PATH_FIX=1`）时变成 `无法统计：找不到 git-annex 命令（brew install git-annex）` |
| 空目录点一下状态栏（= 初始化 gallery） | 初始化成功，那一行变成可统计的三段（未跟踪 = 盘上原本就在的文件） |

这些场景**全 PASS** 才算口径成立；出现 FAIL 时按下面五条查是哪一层错。

## 五个「不量就会写错」的判定要点

1. **「未入库」的判据只能是 `git annex add --dry-run`**（`--json` 的 `note` 字段）。它列的是
   **「还没 add 进 index 的文件」**：已跟踪、但内容改过还没重新 add 的大文件也在里面。所以
   「未入库」= **没 add 进 annex**，**不是**「没 commit」—— verify:status 里两条断言把这层区分钉住了
   （`git annex add .` 之后未提交非零、而未入库归 0）。
2. **必须 `git status --porcelain -uall`**：默认的 `-unormal` 把整个未跟踪目录压成 `?? dir/` 一行，
   未跟踪数会变成「目录数」。verify:status 并存断言了这两种输出（同一批文件，两种口径给出两个不同的数）。
3. **同一时刻只跑一趟子进程**：状态栏的价值在「随时可看」，不在「点得越快越好」。单飞 + 补一趟，
   避免连点把 git 进程叠起来 —— 代价是点击后最多等一趟的延迟，这个代价可以接受。
4. **未初始化那一档也是入口**：点一下就真跑「初始化 gallery」（`git init -b main` + `git annex init` +
   git-annex 分支 `annex.addunlocked=true`（并按标准状态修本机覆盖 / `thin`）+ 合并
   `.gitattributes` / `.gitignore`，口径见 [`docs/commands.md`](commands.md)），盘上复核 `.git/annex` 出现，
   不是只看 Notice 文案。
5. **GUI 启动的 Obsidian 拿的不是终端的 PATH**：`git annex` 是 **git 去 PATH 里找 `git-annex`**；找不到时 git
   只给一句 `git: 'annex' is not a git command`（exit 1），而 `execFile` 的 `ENOENT` 判据永远不成立（git 自己
   是找得到的）。同一条 PATH 还会让 `git status` 在「尺寸不变的改动」上失败，原文是
   `git-annex filter-process: git-annex: command not found`（exit 128）。所以两件事都得做：子进程 PATH
   **末尾**补常见目录，以及把这两种原文单独认出来报成「找不到 git-annex 命令」。只做前者，非标准安装的
   用户仍然看到一句没有任何出路的 git 原文；只做后者，装了 Homebrew 版的人每个 30 秒都被劝去
   `brew install`。verify:status 把「补了 PATH 能出数」与「关掉补 PATH 会变成哪句文案」两条一起钉住
   （`git annex` 与 `git status` 两个失败点各一条）。

## 怎么复跑

```bash
npm run build          # 出 main.js / styles.css（状态栏代码在 main.js 里）
npm run smoke          # 无头加载构建产物：设置页 + 右键菜单 + 弹窗 + 落盘 + 状态栏结构
npm run verify:status  # 真 annex 仓库 + 逐场景数字（上面那张表的断言）
npm run gui:status     # 真机那一行：文字 / 几何 / 配色 / 悬停提示（只读）
npm run gui:status -- --click   # 再点一下那一行，验证「点了会刷新」
npm run gui:status -- --reload  # 先把插件关/开一次（会改运行中的 app 状态）再量
```

`npm run verify:status` 用临时 annex 仓库，跑完删掉，需要本机有 `git` 与 `git annex`。

`gui:status` 要求 Obsidian 带 `--remote-debugging-port` 启动（那个开关只在启动时生效，得先真退出）。**没带
调试端口、也不想重启 app** 时，用 Obsidian 自带的 CLI 读同一份真 DOM、并让改过的插件就地生效（Obsidian
1.14.4 实测）：

```bash
obsidian vault=<vault名> dev:dom selector=".annex-status-bar" text           # 那一行的文字
obsidian vault=<vault名> dev:dom selector=".annex-status-bar" attr=data-level
obsidian vault=<vault名> dev:dom selector=".annex-status-bar .annex-status-counts" css=color  # 整份 computed style
obsidian vault=<vault名> plugin:reload id=annex-gallery                      # 换上 vault 里的 main.js，不重启 app
obsidian vault=<vault名> eval 'code=document.querySelector(".annex-status-bar")?.dataset.level'  # 返回 `=> dirty`
```

`dev:dom css=<prop>` 打印的是**整份** computed style（不是只那一项），`eval` 的结果带 `=> ` 前缀。

## 真机复核的口径

真机复核读的是**跑着的 Obsidian 里的真 DOM / computed style**（CDP over `--remote-debugging-port=9333`，
见 skill `inspect-obsidian-gui-with-maxim`），**不是**从头文件或构建产物推断。DOM 形如：

```html
<div class="status-bar-item plugin-annex-gallery annex-status-bar" data-level="dirty" data-busy="false"
     aria-label="仓库：/Users/<user>/Documents/Lab/<library>/Data_<library>
未提交：已跟踪文件的改动（staged + unstaged），= git status --porcelain -uall 的行数
未跟踪：同一份输出里 ?? 开头的文件数（一个文件一行）
未入库 largefiles：git annex add --dry-run 里会进 annex 的文件数（.md / .thumbnail.png / .base 按 .gitattributes 进 git，不算）
每 30 秒自动刷新 · 点击这一行立即刷新">
  <span class="annex-status-counts">未提交 <a> · 未跟踪 <b> · 未入库 largefiles <c></span>
  <span class="annex-status-refresh"><svg …/></span>
</div>
```

要断言的东西（`Runtime.evaluate` + `getComputedStyle`），值一律以占位符表示：

| 量 | 判据 |
|---|---|
| 那一行的文字 | 三个数 `<a>` · `<b>` · `<c>` 与**独立用命令行**跑 `git status --porcelain -uall` / `git annex add --dry-run --json` 得到的三个数**逐个相同** —— 这是状态栏唯一的正确性判据 |
| `data-level` / `data-busy` | 与当前状态相符（有改动 → `dirty`；一趟在跑 → `busy=true`） |
| 盒子 | `<width> × <height> px @ (<x>, <y>)`：位置在状态栏右侧、与同一行其它状态栏项**等高**，宽度随文字长短变 |
| 那一行（item） | `display: flex`、`align-items: center`、`gap` 一致、`cursor: pointer`、`padding` 由 app 自带 |
| 文字 span | `color` 等于 `--text-normal`（`dirty` 档那一档的变量）、`font-variant-numeric: tabular-nums`、`white-space: nowrap` |
| 刷新图标 | 尺寸取 `--icon-s`、颜色取 `--text-muted` |
| 用到的 CSS 变量 | `--icon-s`、`--size-2-2`、`--text-faint`、`--text-normal`、`--text-warning` 在真机主题里**都存在**（缺一个就会静默回退，配色档位失效） |

版式另算一条：文字完整未截断、图标与文字垂直居中、间距自然（截图局部放大看一次即可）。

重载与点击这两件事只有真机能验：

| 步骤 | 期望 |
|---|---|
| `app.plugins.disablePlugin('annex-gallery')` → `enablePlugin('annex-gallery')` | 重载成功；重载后 `.annex-status-bar` 出现（证明跑着的是当前构建，而不是旧的插件实例） |
| 重载后第一趟还没跑完时 | 文字 `统计中…`、`data-level=loading`、`data-busy=true` |
| `el.click()`（= 点那一行） | 短时间内 `data-busy` 变成 `true` —— 点击**真的**触发了一趟刷新，而不只是绑了 handler |
| 那趟跑完 | `data-busy=false`、`data-level` 回到 `dirty`，三个数回到与命令行独立量一致的值 |

前提：vault 的 `.obsidian/plugins/annex-gallery/` 里 `main.js` / `styles.css` 必须是当前构建（与仓库内文件
sha256 相同），否则量到的是旧构建的行为。
