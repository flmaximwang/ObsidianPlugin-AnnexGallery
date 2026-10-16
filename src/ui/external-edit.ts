/**
 * 「打开」按钮的执行体（spec: 打开为使用默认外部应用打开编辑，自动同步外部应用更改）。
 *
 * 一条 profile 在磁盘上本来没有独立文件，所以这里把它的 JSON 写进一个临时缓冲文件
 * （`<os.tmpdir()>/annex-gallery-profiles/<id>.json`），再用系统默认外部应用打开它；
 * 之后每 700ms 看一次该文件的 mtime+size，变了就把内容回灌给面板（面板负责校验、
 * 更新状态胶囊、并把合法内容写进 data.json）。
 *
 * 为什么不用 fs.watch：编辑器保存多半是「写临时文件 + rename」的原子替换，watch 挂在
 * 旧 inode 上就再也不会触发；轮询 stat 对这种替换免疫。
 *
 * 生命周期：每次 render() 先 stopAll()，设置页隐藏时 destroy() → stopAll()，不留定时器。
 */
import * as fs from "fs";
import * as os from "os";
import * as path from "path";

/** 轮询间隔（ms）。够快、又不至于让 stat 成为负担。 */
const POLL_MS = 700;

export interface ExternalEditHost {
  /** 用系统默认外部应用打开一个文件；失败时 throw。 */
  openWithDefaultApp(filePath: string): Promise<void>;
}

interface Session {
  file: string;
  mtimeMs: number;
  size: number;
  timer: ReturnType<typeof setInterval>;
}

/** 临时缓冲文件所在目录（每条 profile 一个 `<id>.json`）。 */
export function bufferDir(): string {
  return path.join(os.tmpdir(), "annex-gallery-profiles");
}

/** profile.id 可能被人改成任意字符串，落成文件名前先收敛。 */
export function bufferPath(id: string): string {
  const cleaned = id.replace(/[^A-Za-z0-9._-]+/g, "_");
  return path.join(bufferDir(), `${cleaned === "" ? "profile" : cleaned}.json`);
}

export class ExternalEditSessions {
  private readonly sessions = new Map<string, Session>();

  constructor(private readonly host: ExternalEditHost) {}

  /** 写出内容 → 打开 → 开始轮询。返回实际落盘的文件路径（供 Notice 显示）。 */
  async open(id: string, content: string, onExternalChange: (text: string) => void): Promise<string> {
    const dir = bufferDir();
    fs.mkdirSync(dir, { recursive: true });
    const file = bufferPath(id);
    fs.writeFileSync(file, content, "utf8");
    const stat = fs.statSync(file);
    this.stop(id);
    await this.host.openWithDefaultApp(file);
    this.sessions.set(id, {
      file,
      mtimeMs: stat.mtimeMs,
      size: stat.size,
      timer: setInterval(() => this.poll(id, onExternalChange), POLL_MS),
    });
    return file;
  }

  private poll(id: string, onExternalChange: (text: string) => void): void {
    const session = this.sessions.get(id);
    if (session === undefined) return;
    try {
      const stat = fs.statSync(session.file);
      if (stat.mtimeMs === session.mtimeMs && stat.size === session.size) return;
      session.mtimeMs = stat.mtimeMs;
      session.size = stat.size;
      onExternalChange(fs.readFileSync(session.file, "utf8"));
    } catch {
      // 文件被外部应用删掉/换名：下一个 tick 再看，绝不抛给调用方。
    }
  }

  /** 面板里的内容变了（点了「保存」）→ 回写缓冲文件，免得外部应用把旧内容盖回来。 */
  sync(id: string, content: string): void {
    const session = this.sessions.get(id);
    if (session === undefined) return;
    try {
      fs.writeFileSync(session.file, content, "utf8");
      const stat = fs.statSync(session.file);
      session.mtimeMs = stat.mtimeMs;
      session.size = stat.size;
    } catch {
      // 缓冲文件没了就算了：这不影响面板自己的状态。
    }
  }

  stop(id: string): void {
    const session = this.sessions.get(id);
    if (session === undefined) return;
    clearInterval(session.timer);
    this.sessions.delete(id);
  }

  stopAll(): void {
    for (const id of [...this.sessions.keys()]) this.stop(id);
  }
}
