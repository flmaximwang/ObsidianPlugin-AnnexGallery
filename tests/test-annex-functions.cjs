#!/usr/bin/env node
/**
 * test-annex-functions —— 6 个 largefiles 命令的「无异常 + 不丢数据」测试。
 *
 * 每个场景都是一**对**（或一对多）**本地仓库 + 远程 annex 仓库**，从两个角度判定：
 *
 *   · 有没有异常：命令行退出码、`--json` 里逐文件的 `success`、以及 `git annex fsck`
 *   · 有没有丢数据：每一步之后都复核 ——
 *       ① 原始图片的内容哈希（在本地有内容时必须等于原始字节）
 *       ② 远程仓库里的那份内容**始终**等于原始字节（本地命令绝不该动远程）
 *       ③ `.md` / `.thumbnail.png`（进 git 那一侧）始终逐字节不变
 *       ④ `unannex` 出来的文件不再受 `drop` 影响（drop 不许碰它）
 *
 * 场景：
 *   A 远程有副本      —— 6 个命令全跑一遍（add → unlock → lock → drop → get → unannex → drop）
 *   B 本地唯一副本    —— drop 必须被拒绝、内容原地不动；get 是空操作
 *   C 内容只在远程    —— get 必须真的把内容取回来（取回后哈希要等于原始字节）
 *   D 两个远程仓库    —— 副本只在 remote2 上时，drop / get 仍然安全
 *
 *   node tests/test-annex-functions.cjs
 *
 * 需要 `git` 与 `git annex`（缺 annex 时打印 SKIP 并以 0 退出）。
 * 全程只动 `os.tmpdir()` 下的临时目录，跑完删掉。
 */
const { spawnSync } = require("child_process");
const crypto = require("crypto");
const fs = require("fs");
const os = require("os");
const path = require("path");

const repoRootDir = path.resolve(__dirname, "..");
const cli = path.join(repoRootDir, "tools", "annex-gallery.mjs");
const GITATTRIBUTES = [
  "# 默认都进 annex",
  "*               annex.largefiles=anything",
  "# 缩略图不进 annex",
  "*.thumbnail.png annex.largefiles=nothing",
  "# .md 作为每个文件的 metadata, 进 git",
  "*.md            annex.largefiles=nothing",
  "# .base 作为文件展示的视图，进 git",
  "*.base          annex.largefiles=nothing",
  "",
].join("\n");

let pass = 0;
let fail = 0;
const failures = [];
function check(cond, msg) {
  if (cond) {
    pass += 1;
    console.log(`  ✓ ${msg}`);
  } else {
    fail += 1;
    failures.push(msg);
    console.log(`  ✗ ${msg}`);
  }
}
function section(title) {
  console.log(`\n${"═".repeat(4)} ${title} ${"═".repeat(4)}`);
}

function sh(cmd, args, cwd) {
  return spawnSync(cmd, args, { cwd, encoding: "utf8", maxBuffer: 256 * 1024 * 1024 });
}
const git = (args, cwd) => sh("git", args, cwd);
const annex = (args, cwd) => git(["annex", ...args], cwd);
function commit(cwd, message) {
  return git(["-c", "user.email=test@local", "-c", "user.name=test", "commit", "-qm", message], cwd);
}
function annexFind(cwd, extra = []) {
  return annex(["find", "--format=${file}\\n", ...extra], cwd)
    .stdout.split(/\r?\n/)
    .filter((line) => line !== "");
}
/** 仓库相对路径列表（给 annex 用；annex 不认绝对路径，实测过）。 */
function indexMode(cwd, file) {
  const out = git(["ls-files", "-s", "--", file], cwd).stdout.trim();
  return out === "" ? "(不在 index)" : out.split(/\s+/)[0];
}
function sha256(file) {
  // 跟随软链：locked 的 annex 文件在工作树里是软链，跟随才能读到真实内容。
  return crypto.createHash("sha256").update(fs.readFileSync(file)).digest("hex");
}
function hashOrNull(file) {
  try {
    return sha256(file);
  } catch {
    return null;
  }
}
function exists(file) {
  try {
    fs.statSync(file);
    return true;
  } catch {
    return false;
  }
}
function writeRandom(file, bytes) {
  fs.mkdirSync(path.dirname(file), { recursive: true });
  fs.writeFileSync(file, crypto.randomBytes(bytes));
}
function writeText(file, text) {
  fs.mkdirSync(path.dirname(file), { recursive: true });
  fs.writeFileSync(file, text);
}
/** 跑一条命令，返回 {report, status, stderr}；JSON 解析失败也算「异常」。 */
function runOp(localDir, op, extra = []) {
  const r = sh(process.execPath, [cli, "annex", op, localDir, ...extra, "--json"]);
  let report = null;
  try {
    report = JSON.parse(r.stdout);
  } catch {
    report = null;
  }
  return { report, status: r.status, stderr: r.stderr, stdout: r.stdout };
}

/**
 * 造一对仓库：`local` + 若干个 `remoteN`（都是真 annex 仓库），
 * 图片进 annex、md/缩略图进 git，内容按 `copyTo` 拷给指定远程。
 */
function makePair(label, images, { remotes = 1, copyTo = ["remote1"] } = {}) {
  const lab = fs.mkdtempSync(path.join(os.tmpdir(), `annex-fn-${label}-`));
  const local = path.join(lab, "local");
  fs.mkdirSync(local, { recursive: true });
  git(["init", "-q", "."], local);
  annex(["init", "-q", `local-${label}`], local);
  writeText(path.join(local, ".gitattributes"), GITATTRIBUTES);

  const originals = new Map();
  for (const image of images) {
    writeRandom(path.join(local, image), 160 * 1024);
    originals.set(image, sha256(path.join(local, image)));
    const stem = image.replace(/\.tif$/, "");
    writeText(path.join(local, `${stem}.md`), `---\nsample: "${label}"\n---\n`);
    writeRandom(path.join(local, `${stem}.thumbnail.png`), 4096);
  }
  annex(["add", "--", "images"], local);
  commit(local, "add images");

  const remoteDirs = [];
  for (let i = 1; i <= remotes; i += 1) {
    const dir = path.join(lab, `remote${i}`);
    git(["clone", "-q", local, dir], undefined);
    annex(["init", "-q", `remote${i}-${label}`], dir);
    git(["remote", "add", `remote${i}`, dir], local);
    remoteDirs.push(dir);
  }
  for (const [i, dir] of remoteDirs.entries()) {
    if (!copyTo.includes(`remote${i + 1}`)) continue;
    annex(["copy", "--to", `remote${i + 1}`, "--", "images"], local);
  }
  return { lab, local, remoteDirs, originals };
}

/** 每一步之后都跑的复核：远程没被动过、git 侧文件没被改过。 */
function checkPairIntegrity(name, pair, label) {
  const { local, remoteDirs } = pair;
  for (const [i, dir] of remoteDirs.entries()) {
    for (const [image, hash] of pair.originals) {
      const remoteFile = path.join(dir, image);
      if (!exists(remoteFile)) continue; // 该远程本来就没拿这份副本
      check(hashOrNull(remoteFile) === hash, `${name}｜${label}：remote${i + 1} 里 ${path.basename(image)} 仍是原始字节`);
    }
  }
  for (const [image] of pair.originals) {
    const stem = image.replace(/\.tif$/, "");
    for (const side of [`${stem}.md`, `${stem}.thumbnail.png`]) {
      const file = path.join(local, side);
      const original = pair.gitSide.get(side);
      check(hashOrNull(file) === original, `${name}｜${label}：${path.basename(side)} 逐字节未变`);
    }
  }
}
/** 记录 git 侧（md / 缩略图）的原始哈希。 */
function snapshotGitSide(pair) {
  pair.gitSide = new Map();
  for (const [image] of pair.originals) {
    const stem = image.replace(/\.tif$/, "");
    for (const side of [`${stem}.md`, `${stem}.thumbnail.png`]) {
      pair.gitSide.set(side, hashOrNull(path.join(pair.local, side)));
    }
  }
}
/** 一条命令的「没异常」判定。 */
function checkNoError(name, label, result) {
  check(result.status === 0, `${name}｜${label}：退出码 0（没有异常）`);
  check(result.report !== null, `${name}｜${label}：输出是合法 JSON`);
  if (result.report !== null) {
    check(result.report.failed === 0, `${name}｜${label}：failed=0`);
  }
}
/** `git annex fsck`：内容完整性的最终判定。 */
function checkFsck(name, label, dir) {
  const r = annex(["fsck", "--quiet"], dir);
  const complaints = `${r.stdout}${r.stderr}`.split(/\r?\n/).filter((line) => line.includes("** "));
  check(r.status === 0 && complaints.length === 0, `${name}｜${label}：git annex fsck 干净（${complaints.length} 条抱怨）`);
  if (complaints.length > 0) for (const line of complaints.slice(0, 3)) console.log(`      ${line}`);
}

async function main() {
  if (annex(["version"]).status !== 0) {
    console.log("SKIP：这台机器上没有 git annex，跳过。");
    return;
  }
  const cleanup = [];
  const images = ["images/a.tif", "images/b.tif"];

  // ══ A：远程有副本 —— 6 个命令全跑一遍 ══════════════════════════════════
  section("A 远程有副本：6 个命令全跑");
  {
    const name = "A";
    const pair = makePair("a", images, { remotes: 1, copyTo: ["remote1"] });
    cleanup.push(pair.lab);
    snapshotGitSide(pair);
    const { local, originals } = pair;
    console.log(`  临时仓库 ${pair.lab}`);

    // 0) 起点
    check(annexFind(local, ["--in=here"]).length === 2, "起点：本地 2 个图片都有内容");
    check(indexMode(local, "images/a.tif") === "120000", "起点：图片是 locked 软链");

    // 1) add：一张新图
    writeRandom(path.join(local, "images/new.tif"), 160 * 1024);
    const newHash = sha256(path.join(local, "images/new.tif"));
    let r = runOp(local, "add");
    checkNoError(name, "add", r);
    check(annexFind(local).includes("images/new.tif"), `${name}｜add：新图进了 annex`);
    check(hashOrNull(path.join(local, "images/new.tif")) === newHash, `${name}｜add：新图内容没被动过`);
    checkPairIntegrity(name, pair, "add 之后");

    // 2) unlock：变实文件
    r = runOp(local, "unlock");
    checkNoError(name, "unlock", r);
    check(indexMode(local, "images/a.tif") === "100644", `${name}｜unlock：a.tif 变成实文件（index 100644）`);
    for (const [image, hash] of originals) {
      check(hashOrNull(path.join(local, image)) === hash, `${name}｜unlock：${path.basename(image)} 内容未变`);
    }
    checkPairIntegrity(name, pair, "unlock 之后");

    // 3) lock：变回软链
    r = runOp(local, "lock");
    checkNoError(name, "lock", r);
    check(indexMode(local, "images/a.tif") === "120000", `${name}｜lock：a.tif 又变回软链`);
    for (const [image, hash] of originals) {
      check(hashOrNull(path.join(local, image)) === hash, `${name}｜lock：${path.basename(image)} 内容仍可读且未变`);
    }
    checkPairIntegrity(name, pair, "lock 之后");

    // 4) drop：本地内容丢掉（remote1 还有）
    r = runOp(local, "drop");
    checkNoError(name, "drop", r);
    check(r.report.ok === 2, `${name}｜drop：2 张都丢了（别处有副本）`);
    check(hashOrNull(path.join(local, "images/a.tif")) === null, `${name}｜drop：本地内容真的不在了`);
    checkPairIntegrity(name, pair, "drop 之后");
    for (const [image] of originals) {
      check(
        annex(["whereis", "--format=${uuid}", image], local).stdout.trim() !== "",
        `${name}｜drop：${path.basename(image)} 仍记录着副本（location log）`,
      );
    }

    // 5) get：取回内容
    r = runOp(local, "get");
    checkNoError(name, "get", r);
    check(r.report.ok === 2, `${name}｜get：2 张都取回`);
    for (const [image, hash] of originals) {
      check(hashOrNull(path.join(local, image)) === hash, `${name}｜get：${path.basename(image)} 取回后哈希 = 原始字节`);
    }
    checkPairIntegrity(name, pair, "get 之后");

    // 6) unannex：退出 annex、交给 git
    r = runOp(local, "unannex");
    checkNoError(name, "unannex", r);
    check(annexFind(local).length === 0, `${name}｜unannex：本地 annex 里不再有文件`);
    for (const [image, hash] of originals) {
      check(hashOrNull(path.join(local, image)) === hash, `${name}｜unannex：${path.basename(image)} 内容仍在`);
    }
    commit(local, "unannexed");
    for (const [image] of originals) {
      const size = Number.parseInt(git(["cat-file", "-s", `HEAD:${image}`], local).stdout.trim(), 10);
      check(size === 160 * 1024, `${name}｜unannex：HEAD 里 ${path.basename(image)} 是完整文件（${size} 字节）`);
    }
    checkPairIntegrity(name, pair, "unannex 之后");

    // 7) 再 drop 一次：不得碰 unannex 出来的文件（它们已不在 annex 里）
    r = runOp(local, "drop");
    checkNoError(name, "drop（unannex 之后）", r);
    check(r.report.ok === 0 && r.report.candidates === 0, `${name}｜drop：annex 里已无可丢内容`);
    for (const [image, hash] of originals) {
      check(hashOrNull(path.join(local, image)) === hash, `${name}｜drop：${path.basename(image)}（已 unannex）内容没被删`);
    }
    checkFsck(name, "本地", local);
    checkFsck(name, "remote1", pair.remoteDirs[0]);
  }

  // ══ B：本地唯一副本 —— drop 必须被拒 ═══════════════════════════════════
  section("B 本地唯一副本：drop 必须被拒绝");
  {
    const name = "B";
    // 有远程仓库，但**没有**把内容拷过去 ⇒ 本地是唯一副本
    const pair = makePair("b", images, { remotes: 1, copyTo: [] });
    cleanup.push(pair.lab);
    snapshotGitSide(pair);
    const { local, originals } = pair;
    console.log(`  临时仓库 ${pair.lab}`);

    // add：新图同样只有本地一份
    writeRandom(path.join(local, "images/new.tif"), 160 * 1024);
    let r = runOp(local, "add");
    checkNoError(name, "add", r);

    r = runOp(local, "unlock");
    checkNoError(name, "unlock", r);

    r = runOp(local, "lock");
    checkNoError(name, "lock", r);

    r = runOp(local, "drop");
    check(r.status === 0 && r.report !== null, `${name}｜drop：命令本身没异常`);
    check(r.report.ok === 0, `${name}｜drop：一个都没丢（本地是唯一副本）`);
    check(r.report.skipped === 3, `${name}｜drop：3 个都被 annex 挡下（skipped=3）`);
    for (const [image, hash] of originals) {
      check(hashOrNull(path.join(local, image)) === hash, `${name}｜drop：${path.basename(image)} 内容原地不动（没丢数据）`);
    }
    check(hashOrNull(path.join(local, "images/new.tif")) !== null, `${name}｜drop：新图内容也在`);

    r = runOp(local, "get");
    checkNoError(name, "get", r);
    check(r.report.ok === 0, `${name}｜get：内容本来就在本地（空操作）`);
    checkPairIntegrity(name, pair, "get 之后");
    checkFsck(name, "本地", local);
  }

  // ══ C：内容只在远程 —— get 必须真的取回来 ══════════════════════════════
  section("C 内容只在远程：get 取回");
  {
    const name = "C";
    const pair = makePair("c", images, { remotes: 1, copyTo: ["remote1"] });
    cleanup.push(pair.lab);
    snapshotGitSide(pair);
    const { local, originals } = pair;
    console.log(`  临时仓库 ${pair.lab}`);

    // 先把本地内容丢掉（remote1 有副本）
    let r = runOp(local, "drop");
    checkNoError(name, "drop（起点）", r);
    check(annexFind(local, ["--in=here"]).length === 0, `${name}：起点已无本地内容`);

    r = runOp(local, "get");
    checkNoError(name, "get", r);
    check(r.report.ok === 2, `${name}｜get：2 张都从远程取回`);
    for (const [image, hash] of originals) {
      check(hashOrNull(path.join(local, image)) === hash, `${name}｜get：${path.basename(image)} 取回的内容 = 原始字节`);
    }
    checkPairIntegrity(name, pair, "get 之后");

    r = runOp(local, "unlock");
    checkNoError(name, "unlock", r);
    r = runOp(local, "lock");
    checkNoError(name, "lock", r);
    r = runOp(local, "add");
    checkNoError(name, "add（无新文件）", r);
    for (const [image, hash] of originals) {
      check(hashOrNull(path.join(local, image)) === hash, `${name}｜lock/add 往返后 ${path.basename(image)} 内容未变`);
    }
    checkFsck(name, "本地", local);
    checkFsck(name, "remote1", pair.remoteDirs[0]);
  }

  // ══ D：两个远程仓库 —— 副本只在 remote2 ════════════════════════════════
  section("D 两个远程仓库：副本只在 remote2");
  {
    const name = "D";
    const pair = makePair("d", images, { remotes: 2, copyTo: ["remote2"] });
    cleanup.push(pair.lab);
    snapshotGitSide(pair);
    const { local, originals } = pair;
    console.log(`  临时仓库 ${pair.lab}`);

    let r = runOp(local, "drop");
    checkNoError(name, "drop", r);
    check(r.report.ok === 2, `${name}｜drop：remote2 有副本 ⇒ 2 张都能丢`);
    check(hashOrNull(path.join(local, "images/a.tif")) === null, `${name}｜drop：本地内容真的不在了`);

    r = runOp(local, "get");
    checkNoError(name, "get", r);
    for (const [image, hash] of originals) {
      check(hashOrNull(path.join(local, image)) === hash, `${name}｜get：${path.basename(image)} 从 remote2 取回，哈希 = 原始字节`);
    }
    checkPairIntegrity(name, pair, "get 之后");
    checkFsck(name, "本地", local);
    checkFsck(name, "remote2", pair.remoteDirs[1]);
  }

  console.log(`\nPASS=${pass} FAIL=${fail}`);
  if (fail > 0) {
    console.log("失败项：");
    for (const line of failures) console.log(`  - ${line}`);
    process.exitCode = 1;
  } else {
    console.log("TEST-ANNEX-FUNCTIONS OK");
  }

  // annex 的对象文件是只读的（mode 400/444），Node 的 rmSync 会半途 EACCES；先 chmod 再 rm -rf。
  for (const dir of cleanup) {
    sh("chmod", ["-R", "u+w", dir]);
    sh("rm", ["-rf", dir]);
  }
}

main().catch((error) => {
  console.error("FAILED:", error);
  process.exitCode = 1;
});
