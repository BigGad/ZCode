import { mkdtemp, readFile, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import {
  VideoFramePortError,
  type ExecutionPort,
  type ExecutionResult,
  type VideoFrame,
  type VideoFramePort,
  type VideoFrameRequest,
} from "@zcode/contracts";

export const FFMPEG_AVAILABILITY_TIMEOUT_MS = 10_000;
export const FFMPEG_EXTRACT_FRAME_TIMEOUT_MS = 30_000;

export interface FfmpegVideoFrameAdapterOptions {
  executionPort: ExecutionPort;
  /** 覆盖 ffmpeg 可执行文件发现（spec：ZCODE_STREAM_FFMPEG_PATH）。 */
  ffmpegPath?: string;
  tempRoot?: string;
}

export function createFfmpegVideoFrameAdapter(
  options: FfmpegVideoFrameAdapterOptions,
): VideoFramePort {
  return new FfmpegVideoFrameAdapter(options);
}

const JPEG_QUALITY_FLAG = "2"; // -q:v 2：可视质量高、体积可控（image/jpeg 输出）

class FfmpegVideoFrameAdapter implements VideoFramePort {
  private availabilityConfirmed = false;

  constructor(private readonly options: FfmpegVideoFrameAdapterOptions) {}

  async probe(signal?: AbortSignal): Promise<void> {
    await this.ensureAvailable(signal);
  }

  async extractFrames(
    request: VideoFrameRequest,
    options?: { signal?: AbortSignal },
  ): Promise<{ frames: VideoFrame[] }> {
    await this.ensureAvailable(options?.signal);
    let directory: string;
    try {
      directory = await mkdtemp(join(this.options.tempRoot ?? tmpdir(), "zcode-video-frames-"));
    } catch (error) {
      throwFrameIoError(error, options?.signal, "Unable to create a scratch directory for frame extraction.");
    }

    try {
      // 逐时间点独立调用（-ss 前置于 -i 走快速 seek）：请求时间超出媒体时长时
      // ffmpeg 不产出文件，跳过该点即可，不必预探测时长（RTSP segment 时长已知近似值）。
      const frames: VideoFrame[] = [];
      for (const timeMs of request.timesMs) {
        if (options?.signal?.aborted) {
          throw new VideoFramePortError("cancelled", "Frame extraction was cancelled.");
        }
        const outputPath = join(directory, `frame-${frames.length.toString().padStart(6, "0")}.jpg`);
        const result = await this.options.executionPort.run(
          {
            command: {
              mode: "argv",
              file: this.ffmpegPath(),
              args: [
                "-hide_banner",
                "-loglevel",
                "error",
                "-ss",
                (timeMs / 1000).toFixed(3),
                "-i",
                request.videoRef,
                "-frames:v",
                "1",
                "-q:v",
                JPEG_QUALITY_FLAG,
                "-f",
                "image2",
                "-y",
                outputPath,
              ],
            },
            timeoutMs: FFMPEG_EXTRACT_FRAME_TIMEOUT_MS,
            trace: request.trace,
          },
          options?.signal ? { signal: options.signal } : undefined,
        );
        if (result.cancelled || options?.signal?.aborted) {
          throw new VideoFramePortError("cancelled", "Frame extraction was cancelled.");
        }
        if (result.timedOut || result.status === "timed_out") {
          throw new VideoFramePortError(
            "timeout",
            `Frame extraction timed out after ${FFMPEG_EXTRACT_FRAME_TIMEOUT_MS}ms.`,
          );
        }
        if (result.status !== "completed" || result.exitCode !== 0) {
          // 单点失败（seek 超出时长、瞬态解码错误）不中断其余帧；全失败时统一抛错。
          continue;
        }
        let data: Uint8Array;
        try {
          data = new Uint8Array(await readFile(outputPath));
        } catch {
          continue;
        }
        const dimensions = jpegDimensions(data);
        if (!dimensions) continue;
        frames.push({
          timeMs,
          imageDataUrl: `data:image/jpeg;base64,${Buffer.from(data).toString("base64")}`,
          width: dimensions.width,
          height: dimensions.height,
        });
      }
      if (frames.length === 0) {
        throw new VideoFramePortError(
          "video_frame_extract_failed",
          "ffmpeg produced no decodable frames at the requested times.",
        );
      }
      return { frames };
    } finally {
      try {
        await rm(directory, { recursive: true, force: true });
      } catch {
        // scratch 目录清理失败不影响主结果；操作系统临时目录会周期性回收。
      }
    }
  }

  private ffmpegPath(): string {
    return this.options.ffmpegPath ?? "ffmpeg";
  }

  private async ensureAvailable(signal?: AbortSignal): Promise<void> {
    if (this.availabilityConfirmed) return;
    await probeFfmpegAvailable(
      this.options.executionPort,
      this.ffmpegPath(),
      signal,
    );
    // 失败结果不缓存；用户安装 ffmpeg 后同一进程应能立即恢复。
    this.availabilityConfirmed = true;
  }
}

/**
 * ffmpeg 可用性探测（`ffmpeg -version`）；frames adapter 与 RTSP segmenter 共用。
 * 正结果由调用方自行缓存。
 */
export async function probeFfmpegAvailable(
  executionPort: ExecutionPort,
  ffmpegPath: string,
  signal?: AbortSignal,
): Promise<void> {
  const result = await executionPort.run(
    {
      command: { mode: "argv", file: ffmpegPath, args: ["-version"] },
      timeoutMs: FFMPEG_AVAILABILITY_TIMEOUT_MS,
    },
    signal ? { signal } : undefined,
  );
  if (result.cancelled || signal?.aborted) {
    throw new VideoFramePortError("cancelled", "ffmpeg availability check was cancelled.");
  }
  if (result.timedOut || result.status === "timed_out") {
    // 可用性探测超时表示命令已启动但未及时响应，不等于缺少 ffmpeg。
    throw new VideoFramePortError(
      "timeout",
      `ffmpeg availability check timed out after ${FFMPEG_AVAILABILITY_TIMEOUT_MS}ms.`,
    );
  }
  if (!isAvailableProbeResult(result)) {
    throw new VideoFramePortError(
      "unavailable",
      "ffmpeg is not installed. Install ffmpeg (e.g. `brew install ffmpeg` or `apt-get install ffmpeg`) to enable video frame extraction.",
      { cause: result.error?.cause },
    );
  }
}

function isAvailableProbeResult(result: ExecutionResult): boolean {
  if (result.status !== "completed" && result.status !== "failed") return false;
  return (
    result.exitCode === 0 ||
    (result.exitCode !== undefined && result.exitCode !== 127 && result.stderr.text.length > 0)
  );
}

function throwFrameIoError(error: unknown, signal: AbortSignal | undefined, message: string): never {
  if (signal?.aborted) {
    throw new VideoFramePortError("cancelled", "Frame extraction was cancelled.", { cause: error });
  }
  throw new VideoFramePortError("io_error", message, { cause: error });
}

/** 解析 JPEG SOF 段取宽高；解析失败返回 undefined（该帧按失败跳过）。 */
function jpegDimensions(data: Uint8Array): { width: number; height: number } | undefined {
  if (data.length < 4 || data[0] !== 0xff || data[1] !== 0xd8) return undefined;
  let offset = 2;
  while (offset + 9 < data.length) {
    if (data[offset] !== 0xff) {
      offset += 1;
      continue;
    }
    const marker = data[offset + 1];
    // SOS（0xda）之后是压缩数据，不再有 SOF。
    if (marker === 0xda || marker === 0xd9) return undefined;
    if (marker >= 0xd0 && marker <= 0xd7) {
      offset += 2;
      continue;
    }
    const length = (data[offset + 2] << 8) | data[offset + 3];
    const isSof =
      (marker >= 0xc0 && marker <= 0xc3) ||
      (marker >= 0xc5 && marker <= 0xc7) ||
      (marker >= 0xc9 && marker <= 0xcb) ||
      (marker >= 0xcd && marker <= 0xcf);
    if (isSof && offset + 9 <= data.length) {
      const height = (data[offset + 5] << 8) | data[offset + 6];
      const width = (data[offset + 7] << 8) | data[offset + 8];
      return width > 0 && height > 0 ? { width, height } : undefined;
    }
    if (length < 2) return undefined;
    offset += 2 + length;
  }
  return undefined;
}
