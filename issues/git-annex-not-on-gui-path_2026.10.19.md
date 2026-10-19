---
type: bug
status: closed
open_time: 2026-10-19 10:37:10
close_time: 2026-10-19 10:42:00
---

# Data_zsqlab_10 状态栏：无法统计 —— `git: 'annex' is not a git command`

## 现象

vault `Data_zsqlab_10`（`/Users/maxim/Documents/Lab/zsqlab_10_gammaPFD-Fiber_2026.06.25/Data_zsqlab_10`）
右下角状态栏那一行不显示三个数字，而是报错：

```
无法统计：git annex add --dry-run 失败：git: 'annex' is not a git command. See 'git --help'.
```

同一台机器、同一个 vault，在终端里跑 `git annex add --dry-run --json` 是正常的 —— 所以不是仓库坏了，
是**跑这条命令的环境**和终端不一样。

## 复现

```bash
V=/Users/maxim/Documents/Lab/zsqlab_10_gammaPFD-Fiber_2026.06.25/Data_zsqlab_10

# 终端（PATH 里有 /opt/homebrew/bin）：正常
git -C "$V" annex version                       # git-annex version: 10.20260901

# 只给 Obsidian 实际拿到的那份 PATH：报出用户看到的那一句
env PATH=/usr/bin:/bin:/usr/sbin:/sbin git -C "$V" annex add --dry-run --json
# → git: 'annex' is not a git command. See 'git --help'.   （exit 1，stdout 为空）

# 末尾补上 Homebrew 的 bin：恢复
env PATH=/usr/bin:/bin:/usr/sbin:/sbin:/opt/homebrew/bin git -C "$V" annex add --dry-run --json
# → exit 0，23 行 JSON
```

## 根因

1. **子进程继承的是 Obsidian 的 PATH，而 GUI 启动的 Obsidian 只有 launchd 那一份。** 本机实测主进程
   （`ps -Eww -p 58670`，从 Dock 启动）：`PATH=/usr/bin:/bin:/usr/sbin:/sbin`。`src/core/status.ts` 的
   `execAsync()` 用 `cleanEnv()`，而 `cleanEnv()` 只删代理变量、从未补过 PATH。
2. **`git annex` 是「git 去 PATH 里找 `git-annex`」，不是 git 的内建子命令。** 本机 git-annex 只装在
   `/opt/homebrew/bin/git-annex`（→ Cellar 10.20260901），那份 PATH 里没有它；而 `git` 自己是
   `/usr/bin/git`（Apple Git 2.54），找得到。于是 git 打印
   `git: 'annex' is not a git command. See 'git --help'.` 并以 1 退出。
3. **这个失败被当成了「annex 命令跑失败」。** `readRepoStatus()` 里 `dry.missing` 只在 `execFile` 报
   `ENOENT`（连 `git` 都找不到）时成立 —— git 在，所以永远走通用分支，把 git 的原文转述成
   「git annex add --dry-run 失败：…」。既没说清原因，也没给出路。
4. **为什么以前一直是好的**：之前那些 Obsidian 实例是从终端带 `--remote-debugging-port=9333` 启动的，
   继承了 shell 的 PATH（含 Homebrew）；从 Dock 正常启动的这份没有。

**影响面不止状态栏**：`cleanEnv()` 是所有子进程的入口，`git.ts` 的 `run()` / `runStream()` 都走它 ——
右键菜单那 6 个 largefiles 操作与「初始化 gallery」里的 `git annex init`，在 GUI 启动的实例里会以同一句
git 报错失败。状态栏只是第一个把它显示出来的地方。

## 修复建议（已按此实施）

1. **在 `cleanEnv()` 里补 PATH，且只追加不前置**：`/opt/homebrew/bin`、`/opt/homebrew/sbin`、`/usr/local/bin`、
   `/usr/local/sbin`、`/opt/local/bin`、`/opt/local/sbin`、`~/.local/bin`、`~/bin` 中**存在且不在 PATH 里**的，
   按顺序追加到末尾。前置会让 Homebrew Git 压过 `/usr/bin/git`，改变所有 git 命令的解析；追加只解决
   「PATH 里根本没这个目录」这一件事，从终端启动时行为逐字节不变。
2. **留两个出口**：`ANNEX_GALLERY_EXTRA_PATH` 给非标准安装（nix / conda / 自定义 prefix）补目录；
   `ANNEX_GALLERY_NO_PATH_FIX=1` 关掉补 PATH，专供验证脚本复现失败那一档 —— 否则「修好了」可能只是碰巧。
3. **把「git 找不到 annex 子命令」单独认出来**：`readRepoStatus()` 判 stderr 里的
   `'annex' is not a git command`，报「找不到 git-annex 命令（brew install git-annex）」；状态栏那一行放不下
   的解释（GUI 只有 launchd 的 PATH、装好后点一下即重新统计、不用重启 Obsidian）放进悬停提示。

## 解决

| 文件 | 改动 |
|---|---|
| `src/core/git.ts:25` | `EXTRA_BIN_DIRS` + `withBinaryDirs()`：只追加存在且缺的目录；`~` 展开；`ANNEX_GALLERY_EXTRA_PATH` / `ANNEX_GALLERY_NO_PATH_FIX` 两个开关 |
| `src/core/git.ts:87` | `cleanEnv()` 出口统一 `env.PATH = withBinaryDirs(env.PATH)` —— 所有 `git` / `git annex` / `magick` 子进程都走这一处 |
| `src/core/status.ts:147` | `isAnnexBinaryMissing()`：认 `'annex' is not a git command` 这一句 |
| `src/core/status.ts:199-206` | 该情形报短句 `找不到 git-annex 命令（brew install git-annex）`，长解释进 `hint`（`RepoStatus.hint`，`statusTooltip()` 在 `src/core/status.ts:236` 追加） |
| `tools/status-check.cjs:214` | 新场景 5c：把进程 PATH 改成 launchd 那份，先断言裸跑 `git annex` 得到用户看到的那句（复现），再断言插件仍能量出三个数；`ANNEX_GALLERY_NO_PATH_FIX=1` 时断言文案变成「找不到 git-annex 命令」 |
| `docs/status-bar.md` | 不可统计那一节补「两种来路」、数据来源补 PATH 口径、场景表补一行、判定要点 5 |

## 实测

| 检查 | 结果 |
|---|---|
| `npm run typecheck` | 通过（无输出） |
| `npm run build` | 通过（`main.js` / `styles.css` / `tools/annex-gallery.mjs`） |
| `npm run verify:status` | **PASS=38 FAIL=0**（原 31 条 + 新场景 5c 的 7 条）；含「复现」与「关掉补 PATH 后的文案」两侧断言 |
| `npm test`（6 个 largefiles 命令 × 4 场景） | PASS=155 FAIL=0 |
| `npm run smoke` | SMOKE OK（结构断言全过） |
| `npm run verify:init` | PASS=49 FAIL=0 |
| 真 vault 探针（构建产物 + `PATH=/usr/bin:/bin:/usr/sbin:/sbin`） | `未提交 23 · 未跟踪 1 · 未入库 largefiles 0`，`data-level=dirty` |
| 同 vault 命令行独立量（终端 PATH） | `git status --porcelain -uall` → 23 / 1；`git annex add --dry-run --json` 会进 annex → 0 —— 三个数与状态栏**逐个相同** |
| 同探针 · `ANNEX_GALLERY_NO_PATH_FIX=1`（= 修复前） | `无法统计：找不到 git-annex 命令（brew install git-annex）`，悬停提示写明是 launchd 的 PATH |

对照组用的是同一份构建产物、同一个 vault、同一个进程，只切 PATH —— 所以「终端能跑、GUI 不能跑」这件事
被钉在 PATH 上，而不是仓库、git 版本或 annex 版本。
