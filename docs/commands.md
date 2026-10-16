# 「初始化 gallery」命令（命令面板 · 入口 1）

> 这份文档是 Annex Gallery 命令面板那一条命令的**唯一口径**：先放 spec（用户 2026-10-17 原文），
> 再放落地实况、逐条证据与实测数字。
> 可复跑的判据：`npm run verify:init`（`tools/verify-init.cjs`，真 annex 仓库 + 构建产物，23 条断言）。
>
> 插件在命令面板里目前只注册 **1 条**命令（`init-gallery` / 「初始化 gallery」）；那 8 个文件管理器
> 右键选项是另一套入口，口径在 [`docs/context-menu.md`](context-menu.md)。

## 需求（spec 原文，用户 2026-10-17）

> 初始化 Annex 命令现在不仅会执行 2 个 annex，还会将修改 config，确保新文件已 unlock 状态被 add

## 落地：一条命令里的 7 步（其中 2 步是 annex 命令）

| 步 | 动作 | 已经满足时 |
|---|---|---|
| 1 | 校验目标目录存在、且是目录 | — |
| 2 | `git init -b main` | 已是 git 仓库 → 跳过（不重建、不覆盖）；是**别人的仓库的子目录** → 直接报错 |
| 3 | `git annex init "<目录名>"` ← **annex 命令 1** | 已是 annex 仓库 → 跳过 |
| 4 | `git annex config --set annex.addunlocked true` ← **annex 命令 2** | 已经是 `true` → 跳过（见「坑 2」） |
| 5 | 合并 `.gitattributes`（内置 8 行规则，只追加缺的） | 规则齐了 → 补 0 行 |
| 6 | 合并 `.gitignore`（只 `.obsidian`） | 同上 |
| 7 | 按设置页「remote 设置」逐条 `git remote add` / `set-url`（只写配置，不 fetch / 不 push） | 同名同地址 → 一个字节都不碰 |

跑完**不** `git add` / **不** `git commit` / **不** `git annex add` —— 工作树留给用户；init 之前就在目录里的
文件跑完仍是未跟踪（`verify:init` 里有一条断言钉住这点）。

命令面板跑完给的报告（Notice）：

```
初始化 gallery 完成
仓库根：/…/vault
git init：已新建
git annex init：已执行
annex.addunlocked：已设为 true（此后 add 的文件以 unlocked 入库）
.gitattributes：补 8 条规则
.gitignore：补 1 条规则
annex.addunlocked=true 已写进 git-annex 分支（此后 add 的文件以 unlocked 入库）
```

## 形态口径：`annex.addunlocked=true`

- **要的是什么**：此后 `git annex add` 进来的文件一律 **unlocked** —— 工作树里是真实文件、index mode
  `100644`；不设时 add 的是 **locked 符号链接**（`120000`，指向 `.git/annex/objects/…`）。
- **为什么必须 unlocked**：locked 的符号链接会让外部工具原地写失败（Eagle 写 `metadata.json`），
  Obsidian 对符号链接也会**静默不索引**（见 skill `info-db-internals` 的实测）。
- **写在哪**：git-annex **分支**的 `config.log`（`git show git-annex:config.log` → `… annex.addunlocked true`），
  不是本地 `.git/config` —— `verify:init` 同时断言了这两件事（有 config.log、本地 `.git/config` 里没有该键）。
  实测真实 vault `Data_lab_10` 就是这个形态：`git annex config --get annex.addunlocked` → `true`，
  `git config --local --get annex.addunlocked` → 空。
- **只管以后 add 的**：已经 locked 的 annex 文件跑完 init **仍是** `120000`（`verify:init` 场景 4）。
  批量解锁要另跑 `git annex unlock`（会改工作树，属另一件事）。
- **幂等**：已经是 `true` 时**不再** `--set`（`git annex config --set` 每次都会在 git-annex 分支上留一个
  提交），第二次跑完 git-annex 分支的提交哈希不动。
- **传播**：配置在 annex 分支上，跟着**那个分支**走 —— 不是随 `main` 的 push 就到了远端。远端 clone 要先
  让 annex 分支 union merge 一次（实测过的坑：本地 git-annex 分支 16 条 vs 远端 4 条，远端加的附件照样 locked）。

## 逐条口径（spec → 实况 → 证据）

| spec | 实况 | 证据 |
|---|---|---|
| 「执行 2 个 annex」 | `git annex init "<目录名>"` + `git annex config --set annex.addunlocked true`（后者已是 true 就跳过） | `npm run verify:init`：空目录跑完 Notice 里有 `annex.addunlocked：已设为 true`；`git -C <dir> annex config --get annex.addunlocked` → `true` |
| 「修改 config」 | 改的是 git-annex 的**仓库级**配置（不是 `.gitattributes`，那条规则文件是第 5 步在管的） | 同上 + `git show git-annex:config.log` 里出现那一行 |
| 「确保新文件已 unlock 状态被 add」 | init 之后 `git annex add` 的文件 index mode `100644`、工作树里 `lstat().isSymbolicLink() === false` | `verify:init` 场景 2（对照：场景 4 的「addunlocked 没设时」同一个断言是 `120000`） |
| 不越权碰工作树 | init 之前就在的文件跑完仍 `?? `（未跟踪） | `verify:init` 场景 1 的最后一条 |
| 幂等 | 第二次跑：git-annex 分支提交哈希不变 + 报告写「已是 true，未改动」 | `verify:init` 场景 3 |
| `--dry-run` 不动盘 | 没有 `.git`，JSON 里 `addUnlocked.action = "planned"` | `verify:init` 场景 5 |

## 实测数字（2026-10-17，本机 git-annex 10.20260901）

`annex.addunlocked` **没设**时（同一台机器上的探针仓库）：

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

CLI（`node tools/annex-gallery.mjs init <dir>`）两次跑的差别：

```
第一次  annex.addunlocked=true（set）        + 「… 已写进 git-annex 分支」一行
第二次  annex.addunlocked=true（unchanged）  + 「annex.addunlocked 已是 true，跳过（新文件本来就会以 unlocked 形态 add）」
```

真实 vault 现状（只读核对，没有跑 init）：

| vault | `git annex config --get annex.addunlocked` |
|---|---|
| `Data_lab_10` | `true`（已是目标形态） |
| `Data_lab_08` | 空（**未设** —— 下次在它上面跑一次「初始化 gallery」就会设上，不动其它任何东西） |

## 三个「不量就会写错」的判定要点

1. **「没设过」的判据是空输出，不是退出码**：`git annex config --get annex.addunlocked` 在键不存在时
   **退出码仍是 0**、stdout 只有空行。按退出码判会永远以为「设过了」。
2. **必须先读再写**：`git annex config --set` 每次都会往 git-annex 分支写一个提交。「初始化 gallery」
   号称幂等，就得在值已经是 `true` 时不写 —— 否则每点一次命令，annex 分支就多一个噪声提交（会跟着
   分支推到所有 clone）。
3. **它只管以后 add 的**：`annex.addunlocked` 不回头解锁已 annexed 的文件。想让老文件变 unlocked 得
   显式 `git annex unlock`（那是另一条命令，见 [`docs/context-menu.md`](context-menu.md) 的
   `Unlock largefiles`）。

## 怎么复跑

```bash
npm run build        # 出 main.js / tools/annex-gallery.mjs（这条命令的代码在两份产物里都有）
npm run verify:init  # 真 annex 仓库 + 构建产物：23 条断言（PASS=23 FAIL=0 → VERIFY-INIT OK）
```

`verify:init` 全程只动 `os.tmpdir()` 下的临时目录，跑完 `chmod -R u+w` + `rm -rf` 删掉（annex 的对象文件
是只读的，直接 `fs.rmSync` 会半途 EACCES）。它需要本机有 `git` 与 `git annex`，没有 annex 时打印 SKIP
并以 0 退出。

**真机复核**（在 Obsidian 里点命令面板那条命令、看 Notice）还没做：需要把构建产物装进 vault 的
`.obsidian/plugins/annex-gallery/` 再重载插件（见 skill `inspect-obsidian-gui-with-maxim`）。
