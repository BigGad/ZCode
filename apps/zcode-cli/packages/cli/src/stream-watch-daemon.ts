import { existsSync } from "node:fs";
import { mkdir, open, readFile, rename, rm, writeFile } from "node:fs/promises";
import { homedir, tmpdir } from "node:os";
import { join } from "node:path";
import { spawn } from "node:child_process";

/**
 * `zcode stream watch` 的运行时长与后台常驻支持（stream-input.md「运行时长与后台
 * 常驻」节）。
 *
 * - `--duration <n[s|m|h]>` / `--until <ISO|epoch-ms>`：定时结束（互斥）。
 * - `--forever`：父进程 spawn 自身（detached + 日志重定向）后即返回，子进程
 *   持 `--daemon` 内部旗标真正运行监控并写 pid 文件。
 * - `zcode stream stop --stream <id>`：移除 pid 文件（跨平台优雅停止通道）+
 *   SIGTERM；watch 子进程轮询 pid 文件缺失后走正常 abort 收尾。
 */

/** pid / 日志目录（spec：~/.zcode/cli/stream-run 与 ~/.zcode/cli/stream-logs）。 */
export const STREAM_WATCH_RUN_DIR = join(homedir(), ".zcode", "cli", "stream-run");
export const STREAM_WATCH_LOG_DIR = join(homedir(), ".zcode", "cli", "stream-logs");
/** 停止等待上限：覆盖「进行中的分析 turn 中断 + ffmpeg 回收 + 告警落盘」的最坏路径。 */
export const STREAM_STOP_WAIT_TIMEOUT_MS = 30_000;
const STOP_POLL_INTERVAL_MS = 1_000;
/** 子进程检测 stop 的 pid 文件轮询间隔。 */
const DAEMON_STOP_POLL_INTERVAL_MS = 5_000;

const DURATION_PATTERN = /^(\d+)([smh]?)$/u;
const UNIT_MS: Record<string, number> = { s: 1_000, m: 60_000, h: 3_600_000, "": 1_000 };

/** 截止时刻触发时的 abort 原因；用类型而非错误文本区分停止来源（AGENTS 错误处理规则）。 */
export const WATCH_DEADLINE_ABORT_MESSAGE = "stream watch deadline reached";
export class StreamWatchDeadlineError extends Error {
  constructor() {
    super(WATCH_DEADLINE_ABORT_MESSAGE);
    this.name = "StreamWatchDeadlineError";
  }
}

export function isDeadlineAbort(signal: AbortSignal): boolean {
  return signal.reason instanceof StreamWatchDeadlineError;
}

export function watchPidFilePath(streamId: string): string {
  return join(STREAM_WATCH_RUN_DIR, `${streamId}.pid`);
}

export function watchLogFilePath(streamId: string): string {
  return join(STREAM_WATCH_LOG_DIR, `${streamId}.log`);
}

/**
 * 解析 watch 运行时长旗标为绝对截止时刻（epoch-ms）；未设置返回 undefined。
 * --duration 相对启动时刻，--until 为绝对时刻；两者互斥且必须是未来时间。
 */
export function parseWatchDeadline(input: {
  duration?: string;
  until?: string;
  now?: number;
}): number | undefined {
  const { duration, until } = input;
  if (duration !== undefined && until !== undefined) {
    throw new Error("--duration and --until are mutually exclusive; use one of them.");
  }
  const now = input.now ?? Date.now();
  if (duration !== undefined) {
    const match = DURATION_PATTERN.exec(duration);
    if (match === null) {
      throw new Error(`Invalid --duration "${duration}": expected e.g. 30m, 2h, 90s or plain seconds.`);
    }
    return now + Number(match[1]) * UNIT_MS[match[2]];
  }
  if (until !== undefined) {
    const deadlineMs = /^\d+$/u.test(until) ? Number(until) : Date.parse(until);
    if (!Number.isFinite(deadlineMs)) {
      throw new Error(`Invalid --until "${until}": expected an ISO timestamp or epoch milliseconds.`);
    }
    if (deadlineMs <= now) {
      throw new Error(`--until "${until}" is already in the past.`);
    }
    return deadlineMs;
  }
  return undefined;
}

export async function readWatchPid(streamId: string): Promise<number | undefined> {
  try {
    const value = Number((await readFile(watchPidFilePath(streamId), "utf-8")).trim());
    return Number.isSafeInteger(value) && value > 0 ? value : undefined;
  } catch {
    return undefined;
  }
}

export function isProcessAlive(pid: number): boolean {
  try {
    process.kill(pid, 0);
    return true;
  } catch (error) {
    // EPERM = 进程存在但无权发信号，仍视为存活。
    return (error as NodeJS.ErrnoException).code === "EPERM";
  }
}

async function writePidFile(streamId: string, pid: number): Promise<void> {
  await mkdir(STREAM_WATCH_RUN_DIR, { recursive: true });
  const target = watchPidFilePath(streamId);
  const tmp = join(tmpdir(), `zcode-stream-${streamId}-${pid}.pid.tmp`);
  await writeFile(tmp, `${pid}\n`, "utf-8");
  await rename(tmp, target);
}

/** 仅当 pid 文件仍指向 expectedPid 时删除（避免误删后继进程的 pid 文件）。 */
async function clearPidFile(streamId: string, expectedPid: number): Promise<void> {
  if ((await readWatchPid(streamId)) === expectedPid) {
    await rm(watchPidFilePath(streamId), { force: true });
  }
}

/**
 * `watch --forever` 父进程侧：spawn 自身（附加 --daemon 内部旗标）为 detached
 * 后台子进程，stdout/stderr 追加到日志文件，父进程立即返回。
 * 返回子进程 pid；启动失败（如日志文件不可写）向上抛出。
 */
export async function spawnStreamWatchDaemon(input: {
  streamId: string;
  logPath: string;
  env: NodeJS.ProcessEnv;
  /** 父进程的 process.argv（[node, cliEntry, ...args]），内部追加 --daemon。 */
  parentArgv: readonly string[];
}): Promise<number> {
  await mkdir(STREAM_WATCH_LOG_DIR, { recursive: true });
  // "a" 追加：多次重启不覆盖历史；日志含告警输出，不承诺轮转（spec 声明）。
  const logHandle = await open(input.logPath, "a");
  try {
    const child = spawn(process.execPath, [...input.parentArgv.slice(1), "--daemon"], {
      detached: true,
      stdio: ["ignore", logHandle.fd, logHandle.fd],
      env: input.env,
    });
    child.unref();
    return child.pid ?? -1;
  } finally {
    await logHandle.close();
  }
}

/**
 * watch 子进程侧：登记 pid 文件并启动 stop 检测轮询。pid 文件被移除 =
 * 收到停止请求 → 触发 onStopRequest（调用方接入 abortController 正常收尾）。
 * 返回取消轮询的函数（进程正常退出时调用，同时清理 pid 文件）。
 */
export function registerWatchDaemon(
  streamId: string,
  onStopRequest: () => void,
): { dispose(): Promise<void> } {
  let stopped = false;
  const pid = process.pid;
  // 写入失败不阻断监控：stop 通道退化为仅 SIGTERM（Unix 可用）。
  void writePidFile(streamId, pid).catch(() => undefined);
  const timer = setInterval(() => {
    // existsSync 轮询是轻量调用；pid 文件缺失 = stop 已请求。
    if (!existsSync(watchPidFilePath(streamId))) {
      stopped = true;
      onStopRequest();
    }
  }, DAEMON_STOP_POLL_INTERVAL_MS);
  timer.unref?.();
  return {
    dispose: async () => {
      clearInterval(timer);
      if (!stopped) await clearPidFile(streamId, pid);
    },
  };
}

/**
 * `stream stop`：移除 pid 文件（触发子进程优雅收尾）并发 SIGTERM，
 * 等待进程退出。返回是否成功停止；未在运行返回 undefined 交由调用方提示。
 */
export async function stopStreamWatch(streamId: string): Promise<boolean | undefined> {
  const pid = await readWatchPid(streamId);
  if (pid === undefined) return undefined;
  if (!isProcessAlive(pid)) {
    // 陈旧 pid 文件：上次进程未被清理（如断电），直接移除。
    await rm(watchPidFilePath(streamId), { force: true });
    return undefined;
  }
  // 先移除 pid 文件再发信号：pid 文件轮询是跨平台优雅停止通道（Windows 无
  // 可靠 SIGTERM），信号仅用于 Unix 上更快触发。
  await rm(watchPidFilePath(streamId), { force: true });
  try {
    process.kill(pid, "SIGTERM");
  } catch {
    // 进程在窗口期自行退出：轮询会确认。
  }
  const deadline = Date.now() + STREAM_STOP_WAIT_TIMEOUT_MS;
  while (isProcessAlive(pid) && Date.now() < deadline) {
    await new Promise((resolve) => setTimeout(resolve, STOP_POLL_INTERVAL_MS));
  }
  return !isProcessAlive(pid);
}
