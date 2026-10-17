# 文件管理器的右键菜单

> 文件管理器菜单里，本插件的**所有**选项都收在一个顶层 `Annex Gallery` 项之下。
> 本文说明这条形状背后的设计原则与判据 —— 不记录某次运行的结果；要验「现在是否符合」，跑文末的判据。

## 1. 形状原则

- **单一顶层入口**：整个插件在文件管理器菜单里只占一项 `Annex Gallery`（图标 `images`），选项收在子菜单里。
  不把多个动作平铺到顶层 —— 文件管理器菜单是所有插件共用的位置。
- **顶层项是纯容器**：点它**不做任何事**，只 `preventDefault`，避免「点一下猜你想干嘛」。
- **展开交给平台**：子菜单由平台的悬停展开（或键盘 `→`）触发，不自己算 hover 计时、不自造弹出层 ——
  计时和键盘可达性一旦自己实现，就会和系统其它菜单不一致。
- **作用域只到文件夹**：右键**文件**不出现本插件任何选项。单文件的操作走命令面板或设置页，菜单入口只承诺「对一个目录做批量事」。
- **顺序即契约**：顺序固定为「生成类 → 入库类 → 传输类 → 危险操作」，危险操作永远最后一项。
  顺序变了就是行为变更，要能被一条断言抓住（见 §5）。

示例（右键一个文件夹看到的菜单树）：

```
右键 <文件夹>
└─ Annex Gallery                     images
   ├─ 生成元数据                      file-text
   ├─ 生成缩略图                      image
   ├─ Add largefiles to Annex         package-plus
   ├─ Unlock & unannex largefiles     package-open
   ├─ Lock largefiles                 lock
   ├─ Unlock largefiles               unlock
   ├─ Get largefiles                  download
   └─ Drop largefiles                 cloud-off
```

## 2. 每一项的设计意图

标题用英文、图标用 Obsidian 内置的 Lucide 名，是为了在别人的菜单里也认得出、且不依赖自定义图标资源。

| 选项 | 做什么 | 交互原则 |
|---|---|---|
| 生成元数据 | 按 profile 写 `<stem>.md` 侧车（`src/core/sidecar.ts`） | 先确认解析配置与 `ask` 字段；已有侧车时**二次确认**（覆盖重算 / 只补缺失 / 取消） |
| 生成缩略图 | 写 `<stem>.thumbnail.png`（`src/core/thumbnails.ts`） | 直接跑，结束时报告新建 / 跳过 / 失败三类 |
| Add largefiles to Annex | 对目录内**图片**分批 `git annex add` | 直接跑；候选集 = 图片（排除缩略图） |
| Unlock & unannex largefiles | `annex unlock` → `annex unannex` → `git annex add --force-small` | 直接跑；结束提示「还需一次 commit」 |
| Lock largefiles | `annex lock`（整棵子树） | 直接跑；结束提示软链的代价（见 §3.7） |
| Unlock largefiles | `annex unlock`（整棵子树） | 直接跑 |
| Get largefiles | `annex get --json-progress`（整棵子树） | **流式**：进度写进一条常驻 Notice，长下载不冻 UI |
| Drop largefiles | `annex drop`（整棵子树） | **只读预览 → 确认弹窗 → 才动手**；预览给数量与大小 |

## 3. 语义原则

1. **幂等优先，重跑不靠记忆**。生成元数据允许反复跑：改完 profile 再跑一次，走的就是同一条路。
   重跑前先做一次**只读计划**（数出「图片数 / 已有侧车数 / 其中被改过的数」），只有真的存在侧车时才问；
   「覆盖重算」= `overwrite: true`（干净的和被改过的一起重写），「只补缺失」= 默认（已存在的一律 `skipped-existing`）。
   原则：**先看再问，问才动手**，不要点开就写盘。
2. **判定看逐文件结果，不看退出码**。所有 annex 操作共用一条通道（`src/core/annex.ts` 的 `runAnnexOp(op, dir)`），
   一律 `git annex <op> --json --json-error-messages`（`get` 再加 `--json-progress`），逐个文件读 `success`。
   示例判据：

   ```jsonc
   {"file":"a.tif","success":true,"note":"..."}
   {"file":"b.tif","success":false,"note":"unsafe ..."}   // ← 只有这里能看出失败
   ```
3. **报告口径 = 「工具真的报了动作的文件」**，不是「目录里的文件数」。不需要动的文件不产生任何输出
   （例如 unlock 一个已解锁的文件），所以报告里的数字天然会小于目录里的图片数 —— 不能当失败处理。
4. **先收敛目标集，再交给 git**。Add 只对枚举出来的图片跑（排除 `.thumbnail.png`），不会顺手把 `.DS_Store`
   之类也 `git add` 进去；谁进 annex、谁进 git 仍由 `.gitattributes` 的 `annex.largefiles` 决定，插件不越权改这个判断。
5. **`--force-small` 是语义的一部分，不是优化**。`git annex init` 会把 annex 的 clean filter 挂进 git，
   于是普通 `git add` 会把文件**重新 annex 回去** —— unannex 就成了假动作（提交里落的是指针而不是内容）。
   `git annex add --force-small` 才是「按普通 git 文件暂存」的正解，这一步不能省、不能换。
6. **破坏性操作分两步，安全默认交给 git-annex**。Drop 先预览再确认，且默认只丢「别处有足够副本」的内容：
   唯一副本会被挡下（`success:false` + `unsafe` 一类的 note），内容原样留在盘上，报告记为「被挡下 N 个」。
   侧车 `.md` / 缩略图 `.base` 走的是 git（`annex.largefiles=nothing`），`drop` 根本碰不到 —— 画廊不会因为 drop 变空。
   要连唯一副本也丢只有 CLI 的 `--force`，插件不提供这个入口。
7. **有代价的操作，把代价写进结果**。Lock 之后工作树里是软链，Obsidian 会**静默不索引软链**，`[[…tif]]` 随之失效；
   要复原用 Unlock。当前选择是「做完在报告里写明」而不是「每次点之前弹确认」——
   因为确认弹窗会被无脑点掉，写进结果至少留下了证据。这条是取舍，可以反过来（点之前先确认），但不要两头都不做。
8. **子菜单只是分组，不是能力**。平台没有可用的子菜单 API 时，选项退回顶层菜单：**功能不丢，只是不好看**。
   任何组织方式都不应该成为「某些操作在旧环境里消失」的理由。

## 4. 与平台 API 的边界

- 子菜单用 `MenuItem.setSubmenu()`。它是 Obsidian **内置但未进公开 typings** 的 API（`obsidian.d.ts` 里没有），
  Obsidian 自己的编辑器菜单也在用。做法：`main.ts` 里补一句**可选**签名（`SubmenuCapableMenuItem`），
  调用前判存在 —— 类型上承认「可能没有」，运行时不因此崩。
- 展开用的雪佛龙是 `setSubmenu()` 自己造的（`mod-submenu`）；`has-submenu` 这个类名**不携带任何样式**，
  别指望给它写 CSS 就能得到展开提示。

## 5. 边界与陷阱（设计上必须接着守）

1. **annex 的退出码不可信**：全失败时也可能是 `0`，失败信息只在 stderr ⇒ 只能逐文件读 `--json` 的 `success`（§3.2）。
2. **`git annex drop` 没有 `--dry-run`**（会直接被拒为无效选项）⇒ 预览必须自己算（在仓库内用 `find --in=here` 一类的枚举）。
   别把 `--dry-run` 写进命令然后指望它「只是不删」。
3. **annex 不认绝对路径**：给绝对路径它不报错、也不输出 ⇒ 一律用 `git rev-parse --show-prefix` 算出的**仓库相对路径**。
4. **同一个目录可能有两种绝对写法**（系统级固定行为：macOS 上 `/var` 族路径会解析到 `/private/var`），`path.relative(repoRoot, dir)` 会算出
   以 `../..` 开头的越界路径，交给 git/annex 就是 `fatal: … is outside repository`（git 接受绝对路径 pathspec，annex 不接受）。
   原则：**插件内部只保留一种路径表示** —— 仓库根 + 仓库相对路径，边界处一次性解析掉软链与符号。
5. **目录枚举必须认软链**：annex locked 文件在工作树里是软链，`Dirent.isFile()` 对它们返回 false ⇒
   仓库一进 locked 模式，「生成缩略图 / 生成元数据 / Add」会**静默空转**（数出 0 个候选，还报成功）。
   任何遍历都要按「软链也算目标」处理，并用一条断言钉住。
6. **路径表示要贯穿到脏文件判定**：`sidecar.ts` 的 `isDirty()` 若用 `path.relative` 与坑 4 同因失效，
   脏文件保护会变成「看起来在、其实没在」—— 这类保护必须有一条能被故意弄脏触发的断言。

## 6. 判据（可复跑）

| 命令 | 钉住什么 |
|---|---|
| `npm run smoke` | 桩加载构建产物：逐项断言 8 个选项的**顺序与图标**、顶层项只 `preventDefault`、右键文件不出现选项 |
| `npm test` | `tests/test-annex-functions.cjs`：多对本地/远程 annex 仓库上的 6 个命令，判「无异常」+「不丢数据」 |
| `npm run verify:annex` | 6 个操作在真 annex 仓库上的行为与报告（含插件路径：菜单 → 弹窗 → 真丢） |
| `npm run verify:sidecar` | 生成元数据重跑的四条路径：`--plan` / 只补缺失 / `--overwrite` / 脏文件保护，加插件侧覆盖提示弹窗 |

顶层入口的其它入口（命令面板、ribbon）各有自己的口径，见 [`docs/commands.md`](commands.md) 等文档。
