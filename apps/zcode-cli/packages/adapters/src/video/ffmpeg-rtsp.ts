import { mkdir, readFile, readdir, rename, unlink, writeFile } from "node:fs/promises";
import { join } from "node:path";
import {
  LiveCapturePortError,
  type BackgroundExecutionSnapshot,
  type ExecutionPort,
  type TraceContext,
} from "@zcode/contracts";
import { probeFfmpegAvailable } from "./ffmpeg-frames.js";

export const RTSP_SEGMENT_POLL_INTERVAL_MS = 1_000;
/** 文件名前缀与 %05d 序列号（与 ffmpeg -f segment 输出模板一致）。 */
const SEGMENT_FILE_PREFIX = "seg";
const SEGMENT_FILE_SUFFIX = ".mp4";
const SEGMENT_SEQUENCE_PATTERN = /^seg(\d{5,})\.mp4$/u;
/**
 * 下一个起始编号持久化文件（outDir 内；点前缀不会命中 segment 文件名模式）。
 * ffmpeg 每次重启都从 %05d 的 0 开始覆盖写，而 watch-state 游标 / 告警去重键
 * 都假设 seq 全局单调——不持久化起始编号，重启后新内容会被游标跳过、
 * 旧告警 seq 会被错误去重（2026-10-16 实测 analyze 超时根因）。
 */
const SEGMENT_NEXT_SEQ_MARKER = ".segment-next-seq";
const SEGMENT_MARKER_TMP_SUFFIX = ".tmp";
/** 测试与运维需要直接读取 marker 内容，导出文件名。 */
export const SEGMENT_MARKER_FILE_NAME = SEGMENT_NEXT_SEQ_MARKER;

export interface FfmpegRtspSegmenterOptions {
  executionPort: ExecutionPort;
  /** 覆盖 ffmpeg 可执行文件发现（spec：ZCODE_STREAM_FFMPEG_PATH）。 */
  ffmpegPath?: string;
  /** segment 目录扫描间隔，默认 RTSP_SEGMENT_POLL_INTERVAL_MS。 */
  pollIntervalMs?: number;
}

export interface RtspSegmenterStartRequest {
  /**
   * 受控配置持有的原始 URL；只经 mode:"argv" 传给 ffmpeg 子进程，
   * 不进日志 / 事件 / 错误文本（stream-input.md 凭据管理节）。
   */
  sourceUrl: string;
  /** segment 输出目录（私有 stream-cache）。 */
  outDir: string;
  segmentSeconds: number;
  transport: "tcp" | "udp";
  trace: TraceContext;
}

export interface RtspClosedSegment {
  seq: number;
  path: string;
}

/**
 * RTSP segmenter：ffmpeg -f segment 长驻后台子进程的薄封装。
 *
 * 关段判定（原子性）：seq 视为已关闭当且仅当 seq+1 的文件已出现，
 * 或 ffmpeg 进程已结束（退出前最后写入的文件不再变化，全部视为关闭）。
 * 正在写入的 segment 绝不进入就绪集合（安全红线：live chunk 不进模型输入）。
 */
export interface RtspSegmenter {
  start(request: RtspSegmenterStartRequest, options?: { signal?: AbortSignal }): Promise<void>;
  /** 持续产出已关闭 segment；ffmpeg 退出或 signal abort 后结束。 */
  watchClosedSegments(signal: AbortSignal): AsyncIterable<RtspClosedSegment>;
  /** 读取已关闭 segment 的原始字节（I/O 收敛在本 adapter，core 不直接触 fs）。 */
  readSegment(path: string): Promise<Uint8Array>;
  /** 删除已处理 segment 文件（长驻 watch 防磁盘无限增长；best-effort）。 */
  deleteSegment(path: string): Promise<void>;
  /** 终止 ffmpeg 子进程（cancelBackgroundTask）。 */
  stop(): Promise<void>;
}

export function createFfmpegRtspSegmenter(options: FfmpegRtspSegmenterOptions): RtspSegmenter {
  return new FfmpegRtspSegmenter(options);
}

export function segmentFileName(seq: number): string {
  return `${SEGMENT_FILE_PREFIX}${String(seq).padStart(5, "0")}${SEGMENT_FILE_SUFFIX}`;
}

class FfmpegRtspSegmenter implements RtspSegmenter {
  private taskId?: string;
  private outDir?: string;

  constructor(private readonly options: FfmpegRtspSegmenterOptions) {}

  async start(
    request: RtspSegmenterStartRequest,
    options?: { signal?: AbortSignal },
  ): Promise<void> {
    const { executionPort } = this.options;
    if (
      typeof executionPort.start !== "function" ||
      typeof executionPort.cancelBackgroundTask !== "function"
    ) {
      throw new LiveCapturePortError(
        "unavailable",
        "ExecutionPort does not support background execution; RTSP segmentation requires it.",
      );
    }
    await probeFfmpegAvailable(executionPort, this.ffmpegPath(), options?.signal);
    await mkdir(request.outDir, { recursive: true });
    this.outDir = request.outDir;
    // 跨重启单调编号：起始编号 = max(持久化 marker, 现存文件 max + 1)。
    // 先落 marker 再启动 ffmpeg：进程刚启动即崩溃也不会回卷编号。
    const startNumber = await resolveSegmentStartNumber(request.outDir);
    await writeMarkerNextSeq(request.outDir, startNumber);
    try {
      const started = await executionPort.start(
        {
          command: {
            mode: "argv",
            file: this.ffmpegPath(),
            // 凭据只经 argv 进子进程（ps 可见性残余风险已在 spec 安全节声明）。
            args: [
              "-hide_banner",
              "-loglevel",
              "warning",
              // -rtsp_transport 是 RTSP demuxer 私有选项，非 rtsp 输入（如 http-flv）
              // 会报 "Option rtsp_transport not found" 直接失败（spec 输入 URL 节）。
              ...(isRtspUrl(request.sourceUrl) ? ["-rtsp_transport", request.transport] : []),
              "-i",
              request.sourceUrl,
              "-c",
              "copy",
              "-f",
              "segment",
              "-segment_time",
              String(Math.max(1, Math.floor(request.segmentSeconds))),
              "-segment_start_number",
              String(startNumber),
              "-segment_format",
              "mp4",
              "-reset_timestamps",
              "1",
              join(request.outDir, `${SEGMENT_FILE_PREFIX}%05d${SEGMENT_FILE_SUFFIX}`),
            ],
          },
          trace: request.trace,
        },
        options?.signal ? { signal: options.signal } : undefined,
      );
      this.taskId = started.taskId;
    } catch (error) {
      // 不把 sourceUrl 泄漏进错误文本：包装为端口错误，cause 仅进受控日志路径。
      throw new LiveCapturePortError("live_capture_failed", "Failed to start RTSP segmentation.", {
        cause: error,
      });
    }
  }

  async *watchClosedSegments(signal: AbortSignal): AsyncIterable<RtspClosedSegment> {
    const { executionPort } = this.options;
    if (this.taskId === undefined || this.outDir === undefined) {
      throw new LiveCapturePortError("live_capture_not_found", "Segmenter has not been started.");
    }
    const outDir = this.outDir;
    const pollIntervalMs = this.options.pollIntervalMs ?? RTSP_SEGMENT_POLL_INTERVAL_MS;
    const yielded = new Set<number>();
    let persistedNextSeq = (await readMarkerNextSeq(outDir)) ?? 0;
    let processEnded = false;
    while (!signal.aborted && !processEnded) {
      const snapshot = await executionPort.getBackgroundTask?.(this.taskId);
      if (snapshot && backgroundTaskFinished(snapshot)) {
        processEnded = true;
      }
      const closed = await listClosedSegments(outDir, processEnded);
      let maxClosedSeq: number | undefined;
      for (const segment of closed) {
        maxClosedSeq = maxClosedSeq === undefined ? segment.seq : Math.max(maxClosedSeq, segment.seq);
        if (yielded.has(segment.seq)) continue;
        yielded.add(segment.seq);
        yield segment;
      }
      // marker 随关段推进：即使全部现存文件被清理（处理成功后删除），
      // 下次重启也能从正确编号继续，不与 watch-state 游标 / 告警去重键撞号。
      if (maxClosedSeq !== undefined && maxClosedSeq + 1 > persistedNextSeq) {
        persistedNextSeq = maxClosedSeq + 1;
        await writeMarkerNextSeq(outDir, persistedNextSeq);
      }
      if (!processEnded) {
        await delay(pollIntervalMs, signal);
      }
    }
  }

  async readSegment(path: string): Promise<Uint8Array> {
    return new Uint8Array(await readFile(path));
  }

  async deleteSegment(path: string): Promise<void> {
    // best-effort：文件已不存在（重放幂等）属正常；删除失败只延迟磁盘回收。
    await unlink(path).catch(() => undefined);
  }

  async stop(): Promise<void> {
    if (this.taskId === undefined) return;
    const { executionPort } = this.options;
    await executionPort.cancelBackgroundTask?.(this.taskId);
    this.taskId = undefined;
  }

  private ffmpegPath(): string {
    return this.options.ffmpegPath ?? "ffmpeg";
  }
}

function isRtspUrl(url: string): boolean {
  return /^rtsps?:\/\//iu.test(url);
}

/** 起始编号 = max(marker, 现存文件 max + 1)：marker 兜底「文件已被清理」，扫描兜底「marker 丢失/落后」。 */
async function resolveSegmentStartNumber(outDir: string): Promise<number> {
  const marker = await readMarkerNextSeq(outDir);
  let maxExisting = -1;
  let names: string[];
  try {
    names = await readdir(outDir);
  } catch {
    names = [];
  }
  for (const name of names) {
    const seq = Number(SEGMENT_SEQUENCE_PATTERN.exec(name)?.[1]);
    if (Number.isSafeInteger(seq) && seq >= 0) maxExisting = Math.max(maxExisting, seq);
  }
  return Math.max(marker ?? 0, maxExisting + 1);
}

async function readMarkerNextSeq(outDir: string): Promise<number | undefined> {
  try {
    const value = Number((await readFile(join(outDir, SEGMENT_NEXT_SEQ_MARKER), "utf-8")).trim());
    return Number.isSafeInteger(value) && value >= 0 ? value : undefined;
  } catch {
    return undefined;
  }
}

/** tmp + rename 原子写（与 watch-state 同一防 torn write 先例）。 */
async function writeMarkerNextSeq(outDir: string, nextSeq: number): Promise<void> {
  const target = join(outDir, SEGMENT_NEXT_SEQ_MARKER);
  const tmp = `${target}${SEGMENT_MARKER_TMP_SUFFIX}`;
  await writeFile(tmp, `${nextSeq}\n`, "utf-8");
  await rename(tmp, target);
}

function backgroundTaskFinished(snapshot: BackgroundExecutionSnapshot): boolean {
  return snapshot.status !== "running";
}

async function listClosedSegments(
  outDir: string,
  processEnded: boolean,
): Promise<RtspClosedSegment[]> {
  let names: string[];
  try {
    names = await readdir(outDir);
  } catch {
    return [];
  }
  const seqs = names
    .map((name) => SEGMENT_SEQUENCE_PATTERN.exec(name)?.[1])
    .filter((value): value is string => value !== undefined)
    .map((value) => Number(value))
    .filter((seq) => Number.isSafeInteger(seq) && seq >= 0)
    .sort((left, right) => left - right);
  const present = new Set(seqs);
  const closed: RtspClosedSegment[] = [];
  for (const seq of seqs) {
    // 关段：下一文件已出现，或进程已结束（退出前文件全部写完）。
    if (present.has(seq + 1) || processEnded) {
      closed.push({ seq, path: join(outDir, segmentFileName(seq)) });
    }
  }
  return closed;
}

function delay(ms: number, signal: AbortSignal): Promise<void> {
  return new Promise((resolve) => {
    const timer = setTimeout(() => {
      signal.removeEventListener("abort", onAbort);
      resolve();
    }, ms);
    const onAbort = () => {
      clearTimeout(timer);
      resolve();
    };
    signal.addEventListener("abort", onAbort, { once: true });
  });
}
