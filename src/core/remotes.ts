/**
 * 设置页「remote 设置」的执行体：把配好的 remote 写进仓库（git remote add / set-url）。
 *
 * 口径：一条 remote = 名称 + 地址，列表可以有多条。
 *   - 空行（刚点了「添加 remote」还没填）直接忽略；
 *   - 名称或地址为空、名称里有空白字符 ⇒ skipped，并在结果里写明原因；
 *   - 同名多次出现 ⇒ 只有第一次生效；
 *   - 幂等：先 `git remote get-url <名字>` —— 已有且地址相同 ⇒ unchanged（一个字节都不碰），
 *     已有但地址不同 ⇒ `git remote set-url`，没有 ⇒ `git remote add`；
 *   - **不 fetch、不 push**：这一步只写 remote 配置。
 */
import { git } from "./git";
import { Progress } from "./types";

export interface RemoteEntry {
  /** remote 名字，如 origin。 */
  name: string;
  /** remote 地址：ssh://… / https://… / 本地路径都可以。 */
  url: string;
}

export type RemoteAction = "added" | "updated" | "unchanged" | "skipped" | "failed";

export interface RemoteResult {
  name: string;
  url: string;
  action: RemoteAction;
  /** 说明（跳过原因、失败原因、dry-run 提示）。 */
  detail?: string;
  /** 仓库里原来的地址（updated / unchanged 时有）。 */
  previous?: string;
}

export interface ApplyRemoteOptions {
  dryRun?: boolean;
  progress?: Progress;
}

/** 读仓库里已配置的 remote（`git remote -v` 两列去重；取 fetch 的地址）。 */
export function scanRemotes(root: string): RemoteEntry[] {
  const result = git(["remote", "-v"], root);
  if (result.code !== 0) return [];
  const seen = new Map<string, string>();
  for (const line of result.stdout.split("\n")) {
    const match = /^(\S+)\s+(\S+)\s+\((fetch|push)\)\s*$/.exec(line.trim());
    if (match === null) continue;
    if (!seen.has(match[1])) seen.set(match[1], match[2]);
  }
  return [...seen.entries()].map(([name, url]) => ({ name, url }));
}

/**
 * 把「仓库里已经有、设置里还没有」的 remote 补进设置列表（插件加载时自动扫描用）。
 *
 * 只补空缺，**不覆盖**同名那条 —— 用户刚在设置页改过地址（还没跑「初始化 gallery」）时，
 * 不该被仓库里的旧地址盖回去。空行（草稿行）不算已配置，不参与去重对比。
 */
export function mergeScannedRemotes(
  existing: RemoteEntry[],
  scanned: RemoteEntry[],
): { remotes: RemoteEntry[]; added: string[] } {
  const known = new Set(existing.map((entry) => entry.name.trim()).filter((name) => name !== ""));
  const added: string[] = [];
  const remotes = existing.map((entry) => ({ ...entry }));
  for (const entry of scanned) {
    if (known.has(entry.name)) continue;
    known.add(entry.name);
    added.push(entry.name);
    remotes.push({ name: entry.name, url: entry.url });
  }
  return { remotes, added };
}

/** git remote 名字里不能有空白；空名/空地址都不生效。 */
function invalidReason(name: string, url: string): string | undefined {
  if (name === "") return "名称为空";
  if (/\s/.test(name)) return "名称里有空白字符";
  if (url === "") return "地址为空";
  return undefined;
}

export function applyRemotes(root: string, remotes: RemoteEntry[], opts: ApplyRemoteOptions = {}): RemoteResult[] {
  const dryRun = opts.dryRun === true;
  const progress: Progress = opts.progress ?? ((): void => undefined);
  const results: RemoteResult[] = [];
  const seen = new Set<string>();

  for (const raw of remotes ?? []) {
    const name = String(raw?.name ?? "").trim();
    const url = String(raw?.url ?? "").trim();
    if (name === "" && url === "") continue; // 空行：忽略，不当错误

    const bad = invalidReason(name, url);
    if (bad !== undefined) {
      results.push({ name, url, action: "skipped", detail: bad });
      progress(`remote ${name === "" ? "(空)" : name}：跳过（${bad}）`);
      continue;
    }
    if (seen.has(name)) {
      results.push({ name, url, action: "skipped", detail: "同名出现多次，只按第一次生效" });
      progress(`remote ${name}：跳过（同名重复）`);
      continue;
    }
    seen.add(name);

    const existing = git(["remote", "get-url", name], root);
    if (existing.code === 0) {
      const previous = existing.stdout.trim();
      if (previous === url) {
        results.push({ name, url, action: "unchanged", previous });
        progress(`remote ${name}：地址未变，跳过`);
        continue;
      }
      if (dryRun) {
        results.push({ name, url, action: "updated", previous, detail: "dry-run：未执行 git remote set-url" });
        progress(`remote ${name}：将改地址 → ${url}（dry-run：未执行）`);
        continue;
      }
      const changed = git(["remote", "set-url", name, url], root);
      if (changed.code !== 0) {
        const detail = (changed.stderr || changed.stdout).trim();
        results.push({ name, url, action: "failed", previous, detail });
        progress(`remote ${name}：改地址失败（${detail}）`);
        continue;
      }
      results.push({ name, url, action: "updated", previous });
      progress(`remote ${name}：改地址 ${previous} → ${url}`);
      continue;
    }

    if (dryRun) {
      results.push({ name, url, action: "added", detail: "dry-run：未执行 git remote add" });
      progress(`remote ${name}：将新增 ${url}（dry-run：未执行）`);
      continue;
    }
    const added = git(["remote", "add", name, url], root);
    if (added.code !== 0) {
      const detail = (added.stderr || added.stdout).trim();
      results.push({ name, url, action: "failed", detail });
      progress(`remote ${name}：新增失败（${detail}）`);
      continue;
    }
    results.push({ name, url, action: "added" });
    progress(`remote ${name}：新增 ${url}`);
  }

  return results;
}
