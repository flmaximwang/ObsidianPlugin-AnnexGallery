---
type: bug
status: open
open_time: 2026-10-19 10:37:10
close_time:
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
git -C "$V" annex version

# 只给 Obsidian 实际拿到的那份 PATH：报出用户看到的那一句
env PATH=/usr/bin:/bin:/usr/sbin:/sbin git -C "$V" annex add --dry-run --json
# → git: 'annex' is not a git command. See 'git --help'.   （exit 1）
```

## 待补

- 根因
- 修复建议
- 解决 / 实测
