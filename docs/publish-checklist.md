# 提交到 Obsidian 社区目录 —— 要求与判据

> 本文只写**要求是什么、怎么判、坑在哪**，不记录某一刻的 ✓/✗ 状态：状态会过期，命令不会。
> 想知道「现在能不能提交」，跑表里的判据，别读结论。

## 0. 目录读什么、安装时取什么

三条规则决定了「哪一份文件才是公开面」：

1. 目录读的是**默认分支 HEAD 上的 `manifest.json`** ⇒ 只在功能分支上改的字段等于没改。
2. 安装插件时，下载的是**release tag 与 `manifest.json` 的 `version` 逐字相等**的那个 release 里的
   `main.js` / `manifest.json` / `styles.css` ⇒ tag 与 `version` 差一个字符就装不上。
3. 提交入口是**网页**（community.obsidian.md → 登录 → 连 GitHub → Add your plugin），
   不是往 `obsidian-releases` 提 PR 改 `community-plugins.json`（那个文件现在由 bot 镜像维护）。

判据：先读官方 `docs.obsidian.md` → Community directory → *Set up and claim* 一页；再用命令确认镜像这件事仍然成立：

```bash
gh api "repos/obsidianmd/obsidian-releases/commits?path=community-plugins.json&per_page=5" \
  --jq '.[].commit.message'
```

若最近几条都是 bot 的镜像提交，说明手改该文件不是路线。**流程会变**：每次动手前用官方页 + 上面的命令确认一遍，
不要按记忆里的步骤走。

## 1. 硬要求与判据

| # | 要求 | 为什么（原则） | 判据 |
|---|---|---|---|
| 1 | 根目录 `README.md` 说明用途与用法 | 目录会把 README 摘录当作**公开简介**抓取 | 读一遍根 README：是否只写安装 / 依赖 / 用法 / 披露，有没有内部开发笔记、绝对路径 |
| 2 | 根目录 `LICENSE`，且 README 里标明 | 许可证要在**默认分支**上可见，否则目录侧等于没有 | `gh repo view <owner>/<repo> --json licenseInfo` + README 有 License 段 |
| 3 | 用了 Node/Electron API ⇒ `manifest.json` 的 `isDesktopOnly: true` | 声明不实会在移动端崩，是最常见的打回原因 | 查 `manifest.json`；再 grep 代码里的 `child_process` / `fs` / `TMPDIR` |
| 4 | `id` 全目录唯一，且不含 `obsidian` | 目录按 `id` 认插件，重名即冲突 | 见下方「id 唯一性」命令 |
| 5 | 命令 `id` 不带插件 `id`、命令 `name` 不带插件名 | 命令面板已经按插件分组，前缀是重复信息 | grep `addCommand`：应为 `id: "init-gallery"` 这种，而不是 `annex-gallery:init-gallery` |
| 6 | `description` ≤250 字符、**以英文句点 `.` 结尾**、无 emoji、专有名词大小写正确 | 自动审查按英文 style guide 判句末标点 | `python3 -c "import json;print(len(json.load(open('manifest.json'))['description']))"` + 看末字符 |
| 7 | `minAppVersion` 取真正需要的最低版本 | 报高了没人能装，报低了在旧版本上崩 | manifest vs 用到的 API 首次出现的版本；不知道就用当前 stable |
| 8 | 不收捐款就不要 `fundingUrl` | 没有的键胜过多余的键 | 看 `manifest.json` 没有这个键 |
| 9 | 有 tag == `version` 的 release，附 `main.js` / `manifest.json` / `styles.css` | 装上的就是它 | `gh release list -R <owner>/<repo>`；下载 asset 核对 `manifest.json` 里的 `version` |
| 10 | 仓库对审查者与目录可见 | 两者都要读默认分支 | `gh repo view <owner>/<repo> --json visibility` |
| 11 | 不把 `main.js` 提交进仓库 | 构建产物入库 = 审查看不出它由哪份源码生成 | `git ls-files \| grep main.js` 应为空；`.gitignore` 里有 `main.js` |
| 12 | 提交 lockfile，且与 `package.json` 同步 | CI 与本地构建要可复现 | `npm ci --dry-run`（能过 = 同步；不要用 `npm install` 判） |
| 13 | 不硬编码样式（no hardcoded styling） | 主题切换会瞎 | `grep -Ei '#[0-9a-f]{3,8}\b' styles.css` 应为空；颜色走 `var(--…)`。少量 `px`（间距 / 线宽）可接受 |
| 14 | Disclosures：网络使用、访问 vault 之外的文件，必须写进 README | 插件连了什么、碰了什么属于必须公开的信息 | 把代码里的子进程 / 网络 / 写盘点列一遍，逐条对到 README 的 Disclosures 段 |

**id 唯一性**（判据，不写结论）：

```bash
curl -s "https://raw.githubusercontent.com/obsidianmd/obsidian-releases/master/community-plugins.json" \
  | python3 -c "import json,sys; ps=json.load(sys.stdin); print(sum('annex' in p['id'] for p in ps), 'hit(s)')"
```

**Disclosures 的示例写法**（这个插件真实涉及的三项，逐条列而不是笼统说「会访问文件」）：

- 起 `git` / `git annex` 子进程执行仓库操作；
- `git annex get` / `drop` 会走已配的 remote ⇒ **网络**；
- 外部编辑用的缓冲文件落在系统临时目录（`TMPDIR`）⇒ **vault 之外**。

## 2. 代码卫生（不阻塞，但会被 review 挑）

原则：目录 review 判的是「陌生人能不能读懂并信任」，不是功能多少。

- `as any` 只应出现在**公开 typings 缺 API** 的地方，并在旁边写清为什么（示例：`setSubmenu()` 不在 `obsidian.d.ts` 里）。
  其它位置的 `as any` 会被当成「作者没搞清类型」。
- 进度类 `console.log` 收到一个 debug 开关后面（默认静默），不要散落在各个操作里。

## 3. 发布流水线原则

- **一条路径**：`npm ci` → `npm run build` → 产三件产物 → `gh release create --draft`。不要同时维护「手工构建」和「CI 构建」两套流程。
- **由 Actions 在 tag 触发时发版**，而不是本机手工上传：可复现，且能带上构件的 provenance attestation（`actions/attest`）。
  仓库里已有一份这样的 workflow：tag 触发 → `npm ci` + `npm run build` → `actions/attest@v4` → `gh release create --draft` 传三件产物。
- **版本号三处同步**：`manifest.json` 的 `version`、`package.json` 的 `version`、tag 名。判据：`git tag --points-at HEAD` 与 manifest 对齐。
- **不要凭记忆钉 Action 版本**：以官方 *Release your plugin with GitHub Actions* 示例为准（示例用 `actions/attest@v4`）。

## 4. 发一版的标准序列（示例，占位符按实际替换）

```bash
# 0) 合到默认分支 —— 目录只读默认分支
git checkout main && git merge --ff-only <prep-branch> && git push origin main

# 1) 三处版本号同步（manifest.json / package.json / 待打的 tag），同时核对 description
#    （≤250 字符、英文句点结尾、无 emoji）

# 2) 打 tag。配了 Actions 就会建一个 draft release
git tag -a <version> -m "<version>" && git push origin <version>
#    备选：手工上传三件产物
npm run build && gh release create <version> --title "<version>" main.js manifest.json styles.css

# 3) 在 GitHub 上补 release 说明并 Publish release

# 4) 转 public —— 必须在提交之前
gh repo edit <owner>/<repo> --visibility public --accept-visibility-change-consequences

# 5) 网页提交：community.obsidian.md → Sign in → GitHub Connect → Add your plugin
#    字段：repo=<owner>/<repo>、id=<manifest 里的 id，逐字>、name=<manifest 里的 name>、author=<作者>
#    登录作者账号这一步不代劳。

# 6) 等自动审查。有失败就修，然后发一个**版本号更大**的 release（不能原地改已发布的 tag）
```

## 5. 提交之后（官方 Next steps）

- 论坛 Share & showcase 发帖；
- Discord `#updates` 频道宣布（需要 `developer` 角色）。

## 6. 常见坑（按后果排序）

1. **tag 与 `version` 不逐字相等**：目录能收录、却装不上（下载链接对不上或版本不符）。
2. **先提交、后转 public**：审查者读不到仓库，白等一轮。顺序是「release → public → 网页提交」。
3. **只在功能分支上有 `LICENSE` / 改过 `manifest.json`**：默认分支没跟上 ⇒ 目录侧看不到。
4. **`description` 用中文句号「。」/ 带 emoji / 超 250**：自动审查失败；且改完要**发新版本**，否则安装包里的 manifest 与目录展示不一致。
5. **`main.js` 入库、或没有 lockfile**：review 会直接问构建来源。
6. **README 混着开发笔记**：目录摘要会把内部路径 / 内部流程带上公开页。
7. **转 public = 全历史公开**：先把历史里的本机绝对路径、库名 / 样本名扫一遍再转。

## 7. 只有维护者能做的决定

判据回答「对不对」，回答不了「选哪个」。下面几项是取舍而不是技术判断，且一旦落地就写进仓库、跟着版本发出去，
所以只能在发布之前定：

| 事项 | 为什么必须由维护者定 | 落在哪 |
|---|---|---|
| 仓库转 public | 不转就无法提交；转 = **全历史公开**，且这一步排在提交之前 | `gh repo edit --visibility public` |
| `description` 用什么语言 | 目录列表与搜索用的就是它。「句末必须是英文句点」是明文；**是否允许非英文没有找到明文规定（未核实）** | `manifest.json` |
| 根 README 的定位：面向安装者，还是保留开发文档 | 目录会把 README 摘录当公开简介 | 根 `README.md` |
| 初版版本号 | 决定 tag 名，而 tag 必须与 `version` 逐字相等 | tag + `manifest.json` + `package.json` |
| 网页提交由谁点 | 需要插件作者账号登录 + GitHub 授权，只有作者本人能做 | community.obsidian.md |

共同点：这些都不能被脚本替掉 —— 脚本负责把它们落成命令与文件，取舍本身留在维护者手里。
