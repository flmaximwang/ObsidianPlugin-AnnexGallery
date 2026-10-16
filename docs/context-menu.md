# 文件管理器的右键菜单（已实现）

> 本文件原本只有一行 spec（2026-10-17 早）：
>
> - All context menu options in file explorer should be wrapped in the `Annex Gallery` option
>
> 下面是**实现后**的实际形状与口径；原始那一行仍然成立，只是补全了内容。

## 形状

右键 file explorer 里的**文件夹** → 顶层一项 `Annex Gallery`（`images` 图标）→ 悬停 250 ms（或按 `→`）展开子菜单，
里面是**全部 8 个选项**。顶层项本身不做任何事（点它只 `preventDefault`，纯展开）。
**右键文件不出现任何本插件选项** —— 只对文件夹生效。

实现用 `MenuItem.setSubmenu()`：Obsidian **内置但未进公开 typings** 的 API（`obsidian` 1.14.4 的
`obsidian.d.ts` 里没有；`obsidian.asar` 里实测存在，Obsidian 自己的编辑器菜单也在用），所以 `main.ts` 里给它补了
一句可选签名（`SubmenuCapableMenuItem`）；万一运行环境没有它，选项退回顶层菜单（功能不丢）。

## 8 个选项（顺序 = 菜单顺序）

| # | 标题 | 图标 | 实际执行 | 交互 |
|---|---|---|---|---|
| 1 | 生成元数据 | `file-text` | profile 驱动生成 `<stem>.md`（`src/core/sidecar.ts`） | 先弹「选解析配置 + 填 ask 字段」；**若已有 sidecar** 再弹「覆盖重算 / 只补缺失 / 取消」 |
| 2 | 生成缩略图 | `image` | 生成 `<stem>.thumbnail.png`（默认边长 256，`src/core/thumbnails.ts`） | 直接跑，报告新建 / 跳过 / 失败 |
| 3 | Add largefiles to Annex | `package-plus` | 目录内**图片**分批 `git annex add` | 直接跑；候选数 = 图片数（已排除 `.thumbnail.png`） |
| 4 | Unlock & unannex largefiles | `package-open` | `annex unlock` → `annex unannex` → `git annex add --force-small` | 直接跑；结束提示「还需一次 commit」 |
| 5 | Lock largefiles | `lock` | `annex lock`（整棵子树） | 直接跑；结束提示「Obsidian 会静默不索引软链」 |
| 6 | Unlock largefiles | `unlock` | `annex unlock`（整棵子树） | 直接跑 |
| 7 | Get largefiles | `download` | `annex get --json-progress`（整棵子树） | **流式**：进度实时写进常驻 Notice，下载几分钟也不冻 UI |
| 8 | Drop largefiles | `cloud-off` | `annex drop`（整棵子树） | 先**只读预览**（N 个 / X MB）→ 确认弹窗 → 才真丢 |

## 语义要点

- **1 生成元数据可重跑**：改动模版（profile）后重算元数据走的就是这条路。重跑前用 `planSidecarTargets()`（只读：
  `collectImages` + 一次 `git status`）数出「图片数 / 已有 sidecar 数 / 其中被改过的数」，有已存在的才弹窗问；
  「覆盖重算」= `overwrite: true`（干净的与被改过的一起重写），「只补缺失」= 默认行为（已存在的一律 `skipped-existing`）。
- **3–8 共用 `src/core/annex.ts` 的 `runAnnexOp(op, dir)`**：一律 `git annex <op> --json --json-error-messages`
  （`get` 再加 `--json-progress`），**逐文件读 `success`** 判定，绝不看退出码。报告口径是「annex 真的报了动作的文件」——
  annex 对不需要动的文件不输出任何行（例如 unlock 一个已解锁的文件），所以数字可能小于目录里的图片数。
- **3 只对图片跑**：目标集来自 `collectImages(dir)`（排除 `.thumbnail.png`），所以不会顺手把 `.DS_Store` 之类也 `git add`
  进去；谁进 annex、谁进 git 仍由 `.gitattributes` 的 `annex.largefiles` 决定。
- **4 的最后一步必须是 `git annex add --force-small`**：`git annex init` 会写 `.git/info/attributes` 的 `* filter=annex`
  并把 `filter.annex.clean` 设成 `git-annex smudge --clean`，于是**普通 `git add` 会把文件重新 annex 回去**
  （实测：提交后 HEAD 里落的是 ~100 字节指针 ⇒ unannex 成了假动作）。`--force-small` 才是「按普通 git 文件暂存」的正解。
- **5 Lock 的代价**：锁上后工作树里是软链，**Obsidian 会静默不索引软链**（见 README 末尾 pitfall 1），`[[…tif]]` 会失效；
  要复原用 6。当前实现是在完成报告里写明这条，不额外弹确认（可改成点之前先确认）。
- **8 的安全语义交给 git-annex**：默认只丢「别处有足够副本」的内容；别处没有副本的文件被挡下
  （实测 `{"success":false,"note":"unsafe…"}`），内容原样保留，报告记为「被挡下 N 个」。`.md` / `.thumbnail.png` / `.base`
  按 `annex.largefiles=nothing` 进的是 git，`drop` 根本碰不到 —— 画廊照旧可用。要连「唯一副本」也丢只有 CLI 的 `--force`。

## 实测踩过的坑（实现时已规避，别重蹈）

1. **annex 的退出码不可信**：全失败时也是 `0`，`drop: N failed` 只在 stderr ⇒ 必须逐文件读 `--json` 的 `success`。
2. **`git annex drop` 没有 `--dry-run`**（实测 `Invalid option '--dry-run'`）⇒ 预览只能用 `find --in=here` 自己算。
3. **annex 不认绝对路径**（实测给绝对路径直接不输出）⇒ 一律用 `git rev-parse --show-prefix` 算出的仓库相对路径。
4. **`/var` 与 `/private/var`**：macOS 同一目录两种写法，`path.relative(repoRoot, dir)` 会算出 `../../../../var/…`，
   传给 git/annex 就是 `fatal: … is outside repository`（git 接受绝对路径 pathspec，annex 不接受）。
5. **`collectImages()` 必须认软链**：annex locked 文件在工作树里是软链，`Dirent.isFile()` 对它们是 false ⇒
   仓库一切到 locked 模式，「生成缩略图 / 生成元数据 / Add」会静默空转（实测 4 张图只数出 1 张）。
6. **`sidecar.ts` 的 `isDirty()` 不能用 `path.relative`**（同 4）：会静默失效，脏文件保护形同虚设。
7. **`setSubmenu()` 不在公开 typings 里**：要自己补签名；类名 `has-submenu` 没有任何 CSS 规则，
   可见的展开提示来自 `setSubmenu()` 自己造的 `mod-submenu` 雪佛龙。

## 验证（可复跑）

| 命令 | 覆盖 |
|---|---|
| `npm run smoke` | 桩加载构建产物：**8 项的顺序与图标逐项断言**、顶层项只 preventDefault、右键文件不出现选项 |
| `npm test` | `tests/test-annex-functions.cjs`：多对本地/远程 annex 仓库上的 6 个命令，判「无异常」+「不丢数据」 |
| `npm run verify:annex` | 6 个操作在真 annex 仓上的行为与报告（含插件路径：菜单 → 弹窗 → 真丢） |
| `npm run verify:sidecar` | 生成元数据重跑：`--plan` / 只补缺失 / `--overwrite` / 脏文件保护 + 插件侧覆盖提示弹窗 |
