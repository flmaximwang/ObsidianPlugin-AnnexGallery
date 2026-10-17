# 「初始化 gallery」命令（命令面板 · 入口 1）

> 这条命令的**唯一口径**：它管哪一段、幂等契约是什么、annex 的「标准状态」怎么定义、失败怎么判、
> 代码落在哪、以及用什么判据钉住。
> 本文只写设计原则与判据：数量、路径、库名一律用占位符（`<count>` / `<n>` / `<library>` / `<vault>` /
> `<file>`），命令示例里的真实路径换成 `/Users/<user>/Documents/Lab/<library>/Data_<library>`。
> 可复跑的判据：`npm run verify:init`（`tools/verify-init.cjs`，真 annex 仓库 + 构建产物）。
>
> 插件在命令面板里目前只注册 **1 条**命令（`init-gallery` / 「初始化 gallery」）；那 8 个文件管理器
> 右键选项是另一套入口，口径在 [`docs/context-menu.md`](context-menu.md)。

## 职责边界

一条命令只做一件事：把「一个目录」变成「一个按 Annex Gallery 的规矩工作的 annex 仓库」。

**它管的**

- 目录 / git 仓库 / annex 仓库**存在**；
- annex 的**形态设置**（此后新文件以 unlocked 入库）收敛到标准状态；
- 两条规则文件（`.gitattributes` / `.gitignore`）补到齐；
- 设置页里配的 remote 写进配置。

**它明确不管**

- 不 `git add` / 不 `git commit` / 不 `git annex add` —— 工作树不被代劳，init 之前就在目录里的文件跑完
  仍是未跟踪（`verify:init` 场景 1 钉住这点）；
- 不 `fetch` / 不 `push` —— remote 只写配置，网络动作是使用者自己的决定；
- **不回头解锁**已 locked 的老文件（批量解锁是另一条命令，见 [`docs/context-menu.md`](context-menu.md) 的
  `Unlock largefiles`）；
- 不判断这个库「该不该」初始化 —— 只判断目录能不能当仓库根（见下条）。

## 一条命令里的 7 步（其中 2 步是 annex 命令）

| 步 | 动作 | 已经满足时 |
|---|---|---|
| 1 | 校验目标目录存在、且是目录 | — |
| 2 | `git init -b main` | 已是 git 仓库 → 跳过（**不重建、不覆盖**）；是**别人的仓库的子目录** → 直接报错，不往里写 |
| 3 | `git annex init "<目录名>"` ← **annex 命令 1** | 已是 annex 仓库 → 跳过 |
| 4 | **把 annex 的「设置」核对并修复到标准状态**（← **annex 命令 2**，见下节） | 三条都合口径 → 零写入，报告写「未改动」 |
| 5 | 合并 `.gitattributes`（内置 8 行规则，只追加缺的） | 规则齐了 → 补 0 行 |
| 6 | 合并 `.gitignore`（只 `.obsidian`） | 同上 |
| 7 | 按设置页「remote 设置」逐条 `git remote add` / `set-url`（只写配置，不 fetch / 不 push） | 同名同地址 → 一个字节都不碰 |

第 2 步的「子目录」判断是必须的：`git init` 在一个已有仓库的子目录里会造出嵌套仓库，之后 annex 的两层
配置会落在错的地方 —— 这种状态修起来比报错贵得多，所以宁可停在这一步。

## 幂等契约

「重复运行不报错」和「确实恢复标准状态」是同一件事的两面：**命令的输入是「盘上的现状」，输出是「标准
状态」，差集为空时就不动盘**。落到每一步：

| 对象 | 契约 |
|---|---|
| git 仓库 | 已有 → 不重建、不覆盖历史；`git init` 只在没有 `.git` 时跑 |
| annex 仓库 | 已有 → `git annex init` 跳过（它会写 `.git/annex` 与配置，没必要重跑） |
| annex 设置 | 逐条核对**生效值**，偏离才修；三条都合口径 → 零写入 |
| 两条规则文件 | **合并**语义：只追加缺的行，已有的行不删、不重排、不重复写（`mergeRuleText` + `writeIfChanged`，内容没变就不落盘） |
| remote | 同名同地址 → 不碰；同名不同地址 → `set-url`；缺 → `add` |
| 工作树 | 全程不碰（除步骤 5/6 那两个文件本身） |

由此得到可核对的现象：在标准态仓库上连跑三次 —— 零报错、零写入（git-annex 分支提交哈希不变、本机
`.git/config` 一个字节不改），报告写「未改动」。

命令面板跑完给的报告（Notice，第一次跑的形态；`<n>` 是这一趟真的修掉的项数）：

```
初始化 gallery 完成
仓库根：<vault>
git init：已新建
git annex init：已执行
annex.addunlocked：分支已设为 true（此后 add 的文件以 unlocked 入库）
[本机设置：修 <n> 项（annex.addunlocked=false→删）]     ← 只有真的修过偏离才有这一行
.gitattributes：补 8 条规则
.gitignore：补 1 条规则
annex.addunlocked=true 已写进 git-annex 分支（此后 add 的文件以 unlocked 入库）
```

报告按「这一步做了什么」逐行写，而不是一句「完成」：重复运行时哪一行消失，就是哪一步本来就对。

## 标准状态：第 4 步在核对什么

「设置」= 让**新文件以 unlocked 入库**的那几条 annex 配置。它们分散在两个地方（git-annex 分支上的
**共享**配置、本机 `.git/config` 的**每 clone** 配置），所以标准状态是三条，第 4 步逐条核对、偏离才修：

| # | 位置 | 标准 | 偏离时怎么修 |
|---|---|---|---|
| 1 | git-annex **分支** `annex.addunlocked` | `true` | `git annex config --set annex.addunlocked true`（已是 `true` 不写 —— 写一次就多一个分支提交） |
| 2 | **本机** `.git/config` `annex.addunlocked` | 不得是**非真值** | 删掉这个本机键，让分支那份接着生效 |
| 3 | **本机** `.git/config` `annex.thin` | 不得是**真值**（thin = hardlink，原地写会毁掉 annex 里那份内容） | 删掉这个本机键 |
| 4 | 兜底 | 上面三条做完后**生效值**仍不合口径（本机或全局配置在头上反着设） | 就本机压一条符合口径的值（`annex.addunlocked true` / `annex.thin false`），报告里写明原因 |

**生效值 = git 配置那层（本机 > 全局 > 系统）压过 git-annex 分支上的共享值**，两层都没有才轮得到分支。
这个合成是代码里显式做的：`git config` **看不见** git-annex 分支（`config.log` 不是配置文件），
而 `git annex config --get` **只看分支**、不看 git 配置 —— 两边单独看都可能「看着对、实际不对」。

**只动会改变行为的偏离，不碰等价的东西**：本机写着 `true`（与分支一致）时**不删** —— 删了会在
「全局配置反着设」的仓库上与第 4 步互相拉扯，变成每次运行都改盘（一种看着幂等、其实每次都写盘的假幂等）。

## 形态口径：unlocked 到底意味着什么

- **要的是什么**：此后 `git annex add` 进来的文件一律 **unlocked** —— 工作树里是真实文件、index mode
  `100644`；不设时 add 的是 **locked 符号链接**（`120000`，指向 `.git/annex/objects/…`）。
- **为什么必须 unlocked**：locked 的符号链接会让外部工具原地写失败（Eagle 写 `metadata.json`），
  Obsidian 对符号链接也会**静默不索引**（见 skill `info-db-internals`）。
- **共享那份写在哪**：git-annex **分支**的 `config.log`（`git show git-annex:config.log` →
  `… annex.addunlocked true`）。`verify:init` 同时断言了「有 config.log」与「本机 `.git/config` 里没键」。
- **只管以后 add 的**：已经 locked 的 annex 文件跑完 init **仍是** `120000`（`verify:init` 场景 4）。
- **传播**：共享那份跟着 annex **分支**走 —— 不是随 `main` 的 push 就到了远端。远端 clone 要先让
  annex 分支 union merge 一次（否则本地分支上有 `annex.addunlocked true`、远端分支上没有，远端新加的
  附件照样是 locked —— 分支内容不会自己并过来）。

## 三种形态下第 4 步会怎么动

| 形态 | 分支（共享） | 本机 `.git/config` | 生效值 | 跑一次命令会做什么 |
|---|---|---|---|---|
| 只有本机覆盖 | 空 | `annex.addunlocked = true` | unlocked | 行为已是 unlocked，但**共享那份没设过** —— 别的 clone / NAS 侧不跟着走。跑一次会把分支补上，本机那条（真值、与口径一致）保留不动 |
| 两层都没设 | 空 | 空 | **locked 入库** | 跑一次就会把分支设成 `true`，不动其它任何东西 |
| 分支设了、本机反着设 | `true` | `annex.addunlocked = false` | **locked** | 删掉本机那条，让分支那份接着生效（报告里写明修了哪一项） |

三行的共同点是判据只看**生效值**：形态 1 的盘上配置与形态 3 完全相反，但前者已经是对的行为，命令要做的
只是把「共享」补齐；后者行为是错的，命令要做的是删那一行。凭「配置里有没有这一行」判断会两种都判错。

## 两条规则文件（`.gitattributes` / `.gitignore`）

初始化时把两条规则文件补到齐，**写入语义是「合并」**：逐行比对（去首尾空白、把连续空白压成一个
空格后比较），目标文件里已有的行一字不改、不动顺序，只把缺的规则追加到末尾；重复运行幂等
（不多写一个字节）。默认内容是插件内置模板（`src/defaults/gitattributes`、`src/defaults/gitignore`），
插件与 CLI 共用同一份。

合并目标固定是 `<vault>/.gitattributes` / `<vault>/.gitignore`（桌面版取 vault 根），**不提供路径设置**；
旧 `data.json` 里的 `gitattributesPath` / `gitignorePath` / `defaultSample` 三个键在加载时会被删掉。

内置默认 `.gitattributes`（文件结尾**无换行符**）：

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

写成「默认全进 annex、再逐个排除派生文件」是有意的：数据仓库里绝大多数内容是图像/原始数据，
适合走 annex；而 `.md` / 缩略图 / `.base` 必须留在 git 里，否则会被 annex 变成软链、画廊静默失效
（见 [`design.md`](design.md) 第 2 条原则）。

## 失败与观测口径

判据的**形状**是退出码与输出形状，因为这些决定了代码怎么写；具体键名、路径、时间戳一律用占位符。

`annex.addunlocked` **没设**时（任意探针仓库）：

```
git annex config --get annex.addunlocked   → 退出码 0，输出只有一行空行（不是非零退出、也不是报错）
git annex add <file> → git ls-files -s     = 120000 …  <file>
readlink <file>                            = .git/annex/objects/<dir>/<dir>/<key>/<key>
```

`git annex config --set annex.addunlocked true` 之后：

```
git annex add <file> → git ls-files -s  = 100644 …  <file>     （unlocked，真实文件）
git show git-annex:config.log           = <timestamp>s annex.addunlocked true
git config --local --get annex.addunlocked → 空                （没写本地 .git/config）
```

**本机覆盖压过分支**（这是「看着设过了、其实还是 locked」的成因）：

```
分支：git annex config --get annex.addunlocked  = true
本机：git config --local annex.addunlocked false
生效：git ls-files -s <file> = 120000（符号链接）      ← 本机那条赢了
再把本机那条删掉 → 同一个仓库新 add 的 <file> = 100644
```

`annex.thin` **存不进** git-annex 分支：

```
git annex config --set annex.thin true
→ exit 1：annex.thin is not a configuration setting that can be stored in the git-annex branch
git annex config --get annex.thin（分支上）= 空
git config --local annex.thin true 生效（本地开 thin 时，工作树文件与 annex 对象是同一个 inode，nlink > 1）
```

`git config --local --unset` 的退出码（重复运行必须先判存在）：

```
unset 存在的键   → 0
unset 已不存在的键 → 5        ← 直接调用会让「重复运行」报错
unset 从没设过的键 → 5
```

CLI（`node tools/annex-gallery.mjs init <dir>`）连跑两次的差别 —— 第二次什么都不写，这是幂等的判据：

```
第一次  annex.addunlocked（分支）=set → 生效值 true   + 「… 已写进 git-annex 分支」一行
第二次  annex.addunlocked（分支）=unchanged → 生效值 true   + 本机设置：无偏离
（本机覆盖 case）annex.addunlocked（分支）=unchanged   + 本机 annex.addunlocked：false → unset（本机覆盖是 false…）
```

## 结构落点

| 位置 | 承担什么 |
|---|---|
| `src/core/init.ts` | 7 步的编排；第 4 步是 `applyAnnexShape()` —— 读分支值、读本机/全局值、合成生效值、按标准状态决定 set / unset / 兜底，并把「做了什么、为什么」写进报告 |
| `src/core/rules.ts` | 两条规则文件的内置模板与**合并**实现（`mergeRuleText` / `ensureRulesFile` / `writeIfChanged`）—— 幂等语义在这里，不在调用点 |
| `tools/cli.ts` | 同名子命令（`node tools/annex-gallery.mjs init <dir>`），与命令面板共用 `init.ts` 的同一条路径，带 `--dry-run` |
| `tools/verify-init.cjs` | 判据侧，不是运行时的一部分 |

## 判据：`npm run verify:init` 钉什么

```bash
npm run build        # 出 main.js / tools/annex-gallery.mjs（这条命令的代码在两份产物里都有）
npm run verify:init  # 真 annex 仓库 + 构建产物：全 PASS 才算口径成立
```

覆盖 8 个场景：空目录初始化、命令不碰工作树、新文件 unlocked、重复运行零写入、老 locked 文件不动、
本机覆盖被清掉（连「清之前 add 是 `120000` / 清之后是 `100644`」一起断言）、本机 `thin` 被清掉、
`GIT_CONFIG_GLOBAL` 伪造的全局污染被兜底压回且再跑一次不动盘、CLI `--dry-run` 不写盘。逐条口径与
证据的对应：

| 口径 | 断言 |
|---|---|
| 两条 annex 命令 | 空目录跑完 Notice 里有 `annex.addunlocked：分支已设为 true`；`git -C <dir> annex config --get annex.addunlocked` → `true` |
| 改的是仓库级配置 | `git show git-annex:config.log` 里出现那一行（不是 `.gitattributes`，那条规则文件归第 5 步） |
| 新文件 unlocked | 场景 2：index mode `100644`、`lstat().isSymbolicLink() === false`；对照场景 4（`addunlocked` 没设）同一断言是 `120000` |
| 重复运行 | 场景 3（连跑两次）+ 场景 7（全局污染下再跑）都不动盘 |
| 恢复标准状态 | 场景 5、6、7：偏离前 add 出来是 `120000`，跑完命令后新 add 的是 `100644` |
| 不越权碰工作树 | 场景 1 最后一条：init 之前就在的文件跑完仍 `??` |
| `--dry-run` 不动盘 | 场景 8：没有 `.git`，JSON 里 `shape.addUnlocked.action = "planned"`、`shape.changed = false` |

`verify:init` 全程只动 `os.tmpdir()` 下的临时目录，跑完 `chmod -R u+w` + `rm -rf` 删掉（annex 的对象文件是
只读的，直接 `fs.rmSync` 会半途 EACCES）；伪造全局配置用的是临时文件 + `GIT_CONFIG_GLOBAL` 环境变量，
**不碰**真的 `~/.gitconfig`。需要本机有 `git` 与 `git annex`，没有 annex 时打印 SKIP 并以 0 退出。

真机那一步（在 Obsidian 里点命令面板那条命令、读 Notice）的做法：把构建产物装进 vault 的
`.obsidian/plugins/annex-gallery/` 再重载插件（见 skill `inspect-obsidian-gui-with-maxim`）。

## 五个「不量就会写错」的判定要点

1. **「没设过」的判据是空输出，不是退出码**：`git annex config --get annex.addunlocked` 在键不存在时
   **退出码仍是 0**、stdout 只有空行。按退出码判会永远以为「设过了」。
2. **既要读分支、也要读 git 配置**：`git config --get` 看不见分支，`git annex config --get` 看不见 git 配置。
   两边单独看都会得出「已经是 true」的错误结论 —— 分支 `true` + 本机 `false` 的实际行为是 locked
   （见上「本机覆盖压过分支」那一组）。
3. **公共那份必须先读再写**：`git annex config --set` 每次都会往 git-annex 分支写一个提交。「初始化 gallery」
   号称幂等，就得在值已经是 `true` 时不写 —— 否则每点一次命令，annex 分支就多一个噪声提交（会跟着
   分支推到所有 clone）。
4. **`git config --unset` 对不存在的键退 5**：先判存在再删，否则「重复运行不报错」这条就守不住。
   同理 **`git annex config --set annex.thin …` 会直接抛异常**（exit 1），thin 只能在本机配置里修。
5. **它只管以后 add 的**：`annex.addunlocked` 不回头解锁已 annexed 的文件。想让老文件变 unlocked 得
   显式 `git annex unlock`（那是另一条命令，见 [`docs/context-menu.md`](context-menu.md) 的
   `Unlock largefiles`）。
