# 提交到 Obsidian 社区目录 —— 要求逐条核对

这份文件把官方三页要求（Submit your plugin / Submission requirements for plugins / Developer policies）
逐条对到本仓库的**实测现状**，并留下「拍板后要跑的完整序列」。口径：能用命令量的一律给命令和数字，不猜。

## 0. 流程已经变了（直接观测）

- 老的「往 `obsidianmd/obsidian-releases` 提 PR 改 `community-plugins.json`」不再是文档路线：
  那个文件现在由 **Obsidian Bot 镜像**维护 ——
  `gh api "repos/obsidianmd/obsidian-releases/commits?path=community-plugins.json&per_page=5"` 最近 5 次提交
  全是 `chore: Mirror community plugins and themes (-x/+y plugins, -0/+0 themes) [Obsidian Bot]`（2026-10-16）。
- 现在的入口是网页：**community.obsidian.md → Sign in（Obsidian 账号）→ GitHub 连上 → Add your plugin**。
  判据文档：`docs.obsidian.md` → Community directory → **Set up and claim**（`en/Community directory/Set up and claim.md`）。
- 目录读的是**默认分支 HEAD 上的 `manifest.json`**；用户装插件时下载的是 **tag 与 `manifest.json` 的 `version` 逐字相等**的那个 release 里的
  `main.js` / `manifest.json` / `styles.css`。

## 1. 硬要求 → 现状

| # | 要求（出处） | 现状 | 判据 |
|---|---|---|---|
| 1 | 根目录有 `README.md` 说明用途与用法（Submit §Before you begin） | ⚠️ 有 `README.md` 36 KB，但混着内部开发文档（loomerto 计划命令、worktree、真机复核、本机绝对路径）；目录会把它的摘录当**公开简介** | `wc -c README.md` |
| 2 | 根目录有 `LICENSE` 且 README 里标明（Developer policies §Copyright and licensing） | ⚠️ **本分支已补**（MIT）；默认分支上还没有，GitHub 侧 `licenseInfo: null` | `gh repo view --json licenseInfo` |
| 3 | Node/Electron API ⇒ `isDesktopOnly: true` | ✓ `true`（用了 `child_process` / `fs` / `TMPDIR`） | `manifest.json` |
| 4 | `id` 全目录唯一、不含 `obsidian` | ✓ `annex-gallery`；8960 条目录里 **没有任何** id 含 `annex` | `curl -s .../community-plugins.json \| python3 -c ...` |
| 5 | 命令 id 不带插件 id、命令名不带插件名 | ✓ 只有 1 条：`id: "init-gallery"`、`name: "初始化 gallery"` | `main.ts:327` |
| 6 | `description` ≤250 字、**以 `.` 结尾**、无 emoji、注意专有名词大小写（Submission requirements） | ✗ 现为中文 100 字、结尾是 **「。」**；**是否允许非英文未找到明文规定（未核实）**，但「句末必须是英文句点」是明文 | `python3 -c "import json;print(len(json.load(open('manifest.json'))['description']))"` |
| 7 | `minAppVersion` 取合适值（不知道就用当前 stable） | ✓ `1.14.4` = 本机跑着的 stable | `manifest.json` / Obsidian 窗口标题 |
| 8 | 不发捐款就不要 `fundingUrl` | ✓ 没有这个键 | `manifest.json` |
| 9 | tag == manifest `version` 的 release，附 `main.js` / `manifest.json` / `styles.css` | ✗ 一个 release 都没有（只有 tag `snapshot-pre-worktrees-20261017`） | `gh release list -R flmaximwang/ObsidianPlugin-AnnexGallery` |
| 10 | 仓库对审查者/目录可见 | ✗ **PRIVATE** | `gh repo view ... --json visibility` |
| 11 | 仓库里不放 `main.js` | ✓ 已被 `.gitignore` 忽略、未跟踪 | `git ls-files \| grep main.js` |
| 12 | 提交 lockfile | ✓ `package-lock.json` 已提交，且与 `package.json` 同步（`npm ci --dry-run` → added 24 packages） | — |
| 13 | 不硬编码样式（no hardcoded styling） | ✓ `styles.css` 里 0 处十六进制颜色、58 处 `var(--…)`，10 处 `px` | `grep -c` |
| 14 | Disclosures：网络使用 / 访问 vault 外文件必须写进 README（Developer policies） | ✗ 还没写。事实：起 `git` / `git annex` 子进程；`git annex get/drop` 走 remote = **网络**；编辑缓冲文件落在 `TMPDIR` = **vault 外** | `src/core/git.ts:1,32,65`、`src/core/status.ts:1,44`、`main.ts` 的 external-edit |

小项（会被 review 挑、但不阻塞）：`src/ui/settings.ts:71` 一处 `super(app, host as any)`；`main.ts` 7 处 `console.log`（当进度日志用，建议收到一个 debug 开关后）。

## 2. 本分支（`publish-prep`）已经做了什么

- `LICENSE` —— MIT。**依据是仓库自己的 `package.json` 里早就写着 `"license": "MIT"`**（不是我替你选的法律条款）；要换就改这一个文件。
- `.github/workflows/release.yml` —— 照官方 *Release your plugin with GitHub Actions* 那一份：tag 触发 → `npm ci` + `npm run build` → `actions/attest@v4` 生成构件的 provenance attestation → `gh release create --draft` 传三份产物。
  两处核实：`actions/attest` 真实存在且最新为 **v4.2.2**；本仓库 lockfile 与 `package.json` 同步，所以用 `npm ci` 而不是 `npm install`（CI 里更快更可复现）。
- 本文件。

## 3. 还差的：需要你拍板

| 待定 | 影响 |
|---|---|
| 仓库转 **public** | 不改就没法提交（审查者与目录都要能读默认分支）。转 = **全历史公开** |
| `manifest.json` 的 `description` 语言 | 目录列表页与搜索用的就是它；自动审查按英文 style guide 判「句末句点」 |
| 公开面 README（现在是 36 KB 内部开发文档） | 目录会把 README 摘录当公开简介抓取 |
| 初版版本号：`1.0.0`（官方示例）还是保持 `0.1.0` | 决定 tag 名字；tag 必须与 `version` 逐字相等 |
| 网页提交这一步谁来点 | 需要 Obsidian 账号登录 + GitHub 授权 |

**我建议的默认**（你回一句「按默认走」我就全做）：

- `LICENSE` = MIT（照 `package.json`）；
- `description` 改英文、100↔≤250 字、句末句点：
  `Turn git-annex managed image folders into a gallery: initialize a gallery, generate thumbnails, write sidecar Markdown metadata, and merge .gitattributes and .gitignore.`
- README 公开面 = 新写一份英文用户向 README（用途 / 安装（BRAT + 手动）/ 依赖 `git` 与 `git-annex` / 用法 / Disclosures / License），**原来的中文开发文档整体移进 `docs/dev-notes.md`**，一个字不删；
- 版本 `1.0.0`；
- 网页提交：我把字段逐字给你，你自己点（登录你的账号这件事我不代劳）。

## 4. 拍板之后的完整序列（照这个顺序跑）

```bash
# 0) 确认 LICENSE / workflow 在本分支无误后合并到 main
git checkout main && git merge --ff-only publish-prep && git push origin main

# 1) 改 manifest.json：description（英文、句末句点）+ version（例如 1.0.0）；package.json 的 version 同步
# 2) 建 release：tag 必须与 manifest 的 version 逐字相等
git tag -a 1.0.0 -m "1.0.0" && git push origin 1.0.0        # Actions 会建一个 draft release
#    备选（不用 Actions，手工传三份产物）：
#    npm run build && gh release create 1.0.0 --title "1.0.0" main.js manifest.json styles.css
# 3) 到 GitHub 把 draft release 里的说明补上并 Publish release
# 4) 仓库转 public（要在第 5 步之前）
gh repo edit flmaximwang/ObsidianPlugin-AnnexGallery --visibility public --accept-visibility-change-consequences
# 5) 网页提交：community.obsidian.md → Sign in → GitHub Connect → Add your plugin
#    填：repo=flmaximwang/ObsidianPlugin-AnnexGallery；id=annex-gallery；name=Annex Gallery；author=flmaximwang
# 6) 等自动审查结果（有失败就改 + 重新发一个版本号更大的 release）
```

## 5. 提交后（官方 Next steps）

- 论坛 Share & showcase 发帖；
- Discord `#updates` 频道宣布（需要 `developer` 角色）。
