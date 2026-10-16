# 「初始化 gallery」命令（命令面板 · 入口 1）

> 这份文档是 Annex Gallery 命令面板那一条命令的**唯一口径**：先放 spec（用户 2026-10-17 原文），
> 再放落地实况、逐条证据与实测数字。
> 可复跑的判据：`npm run verify:init`（`tools/verify-init.cjs`，真 annex 仓库 + 构建产物，49 条断言）。
>
> 插件在命令面板里目前只注册 **1 条**命令（`init-gallery` / 「初始化 gallery」）；那 8 个文件管理器
> 右键选项是另一套入口，口径在 [`docs/context-menu.md`](context-menu.md)。

## 需求（spec 原文，用户 2026-10-17）

> 初始化 Annex 命令现在不仅会执行 2 个 annex，还会将修改 config，确保新文件已 unlock 状态被 add

> 初始化 Annex 命令要确保重复运行时不报错，并确实将仓库“设置”恢复到标准状态

## 落地：一条命令里的 7 步（其中 2 步是 annex 命令）

| 步 | 动作 | 已经满足时 |
|---|---|---|
| 1 | 校验目标目录存在、且是目录 | — |
| 2 | `git init -b main` | 已是 git 仓库 → 跳过（不重建、不覆盖）；是**别人的仓库的子目录** → 直接报错 |
| 3 | `git annex init "<目录名>"` ← **annex 命令 1** | 已是 annex 仓库 → 跳过 |
| 4 | **把 annex 的「设置」核对并修复到标准状态**（← **annex 命令 2**，见下节） | 三条都合口径 → 零写入，报告写「未改动」 |
| 5 | 合并 `.gitattributes`（内置 8 行规则，只追加缺的） | 规则齐了 → 补 0 行 |
| 6 | 合并 `.gitignore`（只 `.obsidian`） | 同上 |
| 7 | 按设置页「remote 设置」逐条 `git remote add` / `set-url`（只写配置，不 fetch / 不 push） | 同名同地址 → 一个字节都不碰 |

跑完**不** `git add` / **不** `git commit` / **不** `git annex add` —— 工作树留给用户；init 之前就在目录里的
文件跑完仍是未跟踪（`verify:init` 场景 1 有一条断言钉住这点）。

命令面板跑完给的报告（Notice，第一次跑的形态）：

```
初始化 gallery 完成
仓库根：/…/vault
git init：已新建
git annex init：已执行
annex.addunlocked：分支已设为 true（此后 add 的文件以 unlocked 入库）
[本机设置：修 1 项（annex.addunlocked=false→删）]     ← 只有真的修过偏离才有这一行
.gitattributes：补 8 条规则
.gitignore：补 1 条规则
annex.addunlocked=true 已写进 git-annex 分支（此后 add 的文件以 unlocked 入库）
```

## 标准状态：第 4 步到底在核对什么

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
「全局配置反着设」的仓库上与第 4 步互相拉扯，变成每次运行都改盘（实测过的假幂等）。

## 形态口径的其它要点

- **要的是什么**：此后 `git annex add` 进来的文件一律 **unlocked** —— 工作树里是真实文件、index mode
  `100644`；不设时 add 的是 **locked 符号链接**（`120000`，指向 `.git/annex/objects/…`）。
- **为什么必须 unlocked**：locked 的符号链接会让外部工具原地写失败（Eagle 写 `metadata.json`），
  Obsidian 对符号链接也会**静默不索引**（见 skill `info-db-internals` 的实测）。
- **共享那份写在哪**：git-annex **分支**的 `config.log`（`git show git-annex:config.log` →
  `… annex.addunlocked true`）。`verify:init` 同时断言了「有 config.log」与「本机 `.git/config` 里没键」。
- **只管以后 add 的**：已经 locked 的 annex 文件跑完 init **仍是** `120000`（`verify:init` 场景 4）。
  批量解锁要另跑 `git annex unlock`（会改工作树，属另一件事）。
- **传播**：共享那份跟着 annex **分支**走 —— 不是随 `main` 的 push 就到了远端。远端 clone 要先让
  annex 分支 union merge 一次（实测过的坑：本地 git-annex 分支 16 条 vs 远端 4 条，远端加的附件照样 locked）。

## 逐条口径（spec → 实况 → 证据）

| spec | 实况 | 证据 |
|---|---|---|
| 「执行 2 个 annex」 | `git annex init "<目录名>"` + `git annex config --set annex.addunlocked true`（后者分支上已是 true 就不写） | `verify:init`：空目录跑完 Notice 里有 `annex.addunlocked：分支已设为 true`；`git -C <dir> annex config --get annex.addunlocked` → `true` |
| 「修改 config」 | 改的是 git-annex 的**仓库级**配置（不是 `.gitattributes`，那条规则文件是第 5 步在管的） | 同上 + `git show git-annex:config.log` 里出现那一行 |
| 「确保新文件已 unlock 状态被 add」 | init 之后 `git annex add` 的文件 index mode `100644`、工作树里 `lstat().isSymbolicLink() === false` | `verify:init` 场景 2（对照：场景 4 的「addunlocked 没设时」同一个断言是 `120000`） |
| 「重复运行时不报错」 | 连跑三次：零报错、零写入（分支提交哈希不变、本机 `.git/config` 一个字节不改），报告写「未改动」 | `verify:init` 场景 3（两次重复）+ 场景 7（全局污染下再跑一次也不动盘） |
| 「确实恢复标准状态」 | 分支被压成非真值时重设；本机 `annex.addunlocked=false` 被清掉（生效值真的回到 unlocked）；本机 `annex.thin=true` 被清掉；只认**生效值**，不看「看着像设过」 | `verify:init` 场景 5、6、7：偏离前 add 出来是 `120000`，跑完命令后新 add 的文件是 `100644` |
| 不越权碰工作树 | init 之前就在的文件跑完仍 `?? `（未跟踪） | `verify:init` 场景 1 的最后一条 |
| `--dry-run` 不动盘 | 没有 `.git`，JSON 里 `shape.addUnlocked.action = "planned"`、`shape.changed = false` | `verify:init` 场景 8 |

## 实测数字（2026-10-17，本机 git-annex 10.20260901）

`annex.addunlocked` **没设**时（探针仓库）：

```
git annex config --get annex.addunlocked   → 退出码 0，输出只有一行空行（不是非零退出、也不是报错）
git annex add a.txt → git ls-files -s  = 120000 …  a.txt
readlink a.txt      = .git/annex/objects/f9/Mw/SHA256E-s5--2cf2…txt/SHA256E-s5--2cf2…txt
```

`git annex config --set annex.addunlocked true` 之后：

```
git annex add b.txt → git ls-files -s  = 100644 …  b.txt        （unlocked，真实文件）
git show git-annex:config.log          = 1792173649s annex.addunlocked true
git config --local --get annex.addunlocked → 空                  （没写本地 .git/config）
```

**本机覆盖压过分支**（这是「看着设过了、其实还是 locked」的成因）：

```
分支：git annex config --get annex.addunlocked  = true
本机：git config --local annex.addunlocked false
生效：git ls-files -s x.bin = 120000（符号链接）      ← 本机那条赢了
再把本机那条删掉 → 同一个仓库新 add 的 y.bin = 100644
```

`annex.thin` **存不进** git-annex 分支：

```
git annex config --set annex.thin true
→ exit 1：annex.thin is not a configuration setting that can be stored in the git-annex branch
git annex config --get annex.thin（分支上）= 空
git config --local annex.thin true 生效（本地开着 thin 时，工作树文件的 nlink = 2）
```

`git config --local --unset` 的退出码（重复运行必须先判存在）：

```
unset 存在的键   → 0
unset 已不存在的键 → 5        ← 直接调用会让「重复运行」报错
unset 从没设过的键 → 5
```

CLI（`node tools/annex-gallery.mjs init <dir>`）三次跑的差别：

```
第一次  annex.addunlocked（分支）=set → 生效值 true   + 「… 已写进 git-annex 分支」一行
第二次  annex.addunlocked（分支）=unchanged → 生效值 true   + 本机设置：无偏离
（本机覆盖 case）annex.addunlocked（分支）=unchanged   + 本机 annex.addunlocked：false → unset（本机覆盖是 false…）
```

真实 vault 现状（只读核对，没有跑 init）：

| vault | 分支（共享） | 本机 `.git/config` | 生效值 | 说明 |
|---|---|---|---|---|
| `Data_lab_10` | **空** | `annex.addunlocked = true` | `true`（unlocked） | 行为已是 unlocked，但**共享那份没设过** —— 别的 clone / NAS 侧不跟着走。跑一次命令会把分支补上，本机那条（真值）保留不动 |
| `Data_lab_08` | 空 | 空 | 空（**locked 入库**） | 跑一次命令就会把分支设成 `true`，不动其它任何东西 |

## 五个「不量就会写错」的判定要点

1. **「没设过」的判据是空输出，不是退出码**：`git annex config --get annex.addunlocked` 在键不存在时
   **退出码仍是 0**、stdout 只有空行。按退出码判会永远以为「设过了」。
2. **既要读分支、也要读 git 配置**：`git config --get` 看不见分支，`git annex config --get` 看不见 git 配置。
   两边单独看都会得出「已经是 true」的错误结论 —— 分支 `true` + 本机 `false` 的实际行为是 locked（实测）。
3. **公共那份必须先读再写**：`git annex config --set` 每次都会往 git-annex 分支写一个提交。「初始化 gallery」
   号称幂等，就得在值已经是 `true` 时不写 —— 否则每点一次命令，annex 分支就多一个噪声提交（会跟着
   分支推到所有 clone）。
4. **`git config --unset` 对不存在的键退 5**：先判存在再删，否则「重复运行不报错」这条就守不住。
   同理 **`git annex config --set annex.thin …` 会直接抛异常**（exit 1），thin 只能在本机配置里修。
5. **它只管以后 add 的**：`annex.addunlocked` 不回头解锁已 annexed 的文件。想让老文件变 unlocked 得
   显式 `git annex unlock`（那是另一条命令，见 [`docs/context-menu.md`](context-menu.md) 的
   `Unlock largefiles`）。

## 怎么复跑

```bash
npm run build        # 出 main.js / tools/annex-gallery.mjs（这条命令的代码在两份产物里都有）
npm run verify:init  # 真 annex 仓库 + 构建产物：49 条断言（PASS=49 FAIL=0 → VERIFY-INIT OK）
```

`verify:init` 覆盖 8 个场景：空目录初始化、命令不碰工作树、新文件 unlocked、重复运行零写入、
老 locked 文件不动、本机覆盖被清掉（连「清之前 add 是 120000 / 清之后是 100644」一起断言）、
本机 thin 被清掉、`GIT_CONFIG_GLOBAL` 伪造的全局污染被兜底压回且再跑一次不动盘、CLI `--dry-run` 不写盘。

它全程只动 `os.tmpdir()` 下的临时目录，跑完 `chmod -R u+w` + `rm -rf` 删掉（annex 的对象文件是只读的，
直接 `fs.rmSync` 会半途 EACCES）；伪造全局配置用的是临时文件 + `GIT_CONFIG_GLOBAL` 环境变量，
**不碰**真的 `~/.gitconfig`。需要本机有 `git` 与 `git annex`，没有 annex 时打印 SKIP 并以 0 退出。

**真机复核**（在 Obsidian 里点命令面板那条命令、看 Notice）还没做：需要把构建产物装进 vault 的
`.obsidian/plugins/annex-gallery/` 再重载插件（见 skill `inspect-obsidian-gui-with-maxim`）。
