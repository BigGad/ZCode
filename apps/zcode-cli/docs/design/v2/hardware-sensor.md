# Hardware Sensor Input

## 背景

`stream-input.md` 已定义本地 capture（麦克 / 摄像头 / 屏幕 / 系统音频）的通路。ZCode 还需支持更广义的**硬件传感器**输入：

- 移动端：GPS / 加速度 / 陀螺仪 / 气压 / 光线 / 接近
- 桌面端：电源状态 / 网络状态 / 系统资源使用率
- 扩展：蓝牙 / NFC / 串口（phase 2）

这些数据有共同形态**：单次读 / 持续采样的时间序列**；统一走 `HardwareSensorPort`。

## 当前实现状态

Status as of 2026-10-15: 本文为新建 spec，处于"设计完成、待落地"状态。相关分 spec：

- [`multimodal-platform.md`](./multimodal-platform.md)：总体架构。
- [`stream-input.md`](./stream-input.md)：live capture 通路（相邻形态）。

## 目标

1. **HardwareSensorPort 抽象**：单次读 / 持续采样的统一契约。
2. **平台 adapter 隔离**（Node / Web / Native / Mobile），小图标 走 IPlatformService。
3. **采样数据走 workspace resource index**：以 `kind: "hardware"` 的 entry 持久化；后续 agent 可以查询 / 引用。

## 非目标

- 不在本期交付实时事件流（push-based）；只支持一次读 + 后续 pull-based 持续采样。
- 不在本期交付 BLE / NFC / 串口；后续 spec 单独提案。
- 不在本期交付 raw 字节处理（图像 / audio）；保留 structured JSON 数据。
- 不在本期交付 sensor fusion / 滤波；上层结构化仅采样本。

## 端口契约

```typescript
// contracts/src/interfaces/hardware-sensor.port.ts
export type HardwareSensorKind =
  | "gps" | "accelerometer" | "gyroscope" | "magnetometer"
  | "barometer" | "ambient-light" | "proximity"
  | "battery" | "network" | "cpu" | "memory" | "storage"
  | "system-info";

export interface HardwareSensorReadRequest {
  kind: HardwareSensorKind;
  durationMs?: number;          // 0 = 单次；>0 = 持续采样
  intervalMs?: number;           // 持续采样间隔
  trace: TraceContext;
}

export interface HardwareSensorSample {
  kind: HardwareSensorKind;
  timestampMs: number;
  // 各类 sensor 的量值
  gps?: { latitude: number; longitude: number; altitude?: number;
          accuracy?: number; speed?: number; heading?: number };
  accelerometer?: { x: number; y: number; z: number };
  gyroscope?: { x: number; y: number; z: number };
  magnetometer?: { x: number; y: number; z: number };
  barometer?: { hPa: number };
  ambientLight?: { lux: number };
  proximity?: { cm?: number; near: boolean };
  battery?: { level: number; charging: boolean; chargingTime?: number; dischargingTime?: number };
  network?: { type: "wifi" | "cellular" | "ethernet" | "none"; downlinkMbps?: number; rssi?: number };
  cpu?: { usagePercent: number; coresUsed: number; coresTotal: number };
  memory?: { usedBytes: number; totalBytes: number; pressure?: "low" | "medium" | "high" };
  storage?: { usedBytes: number; totalBytes: number };
  systemInfo?: { os: string; arch: string; locale: string; timezone: string };
}

export type HardwareSensorErrorCode =
  | "hardware_sensor_unavailable"
  | "hardware_sensor_denied"          // 平台权限拒绝
  | "hardware_sensor_invalid_request"
  | "cancelled" | "io_error"
  | "permission_denied"
  | "process_failed" | "timeout"
  | "unavailable";

export class HardwareSensorPortError extends Error {
  constructor(
    readonly code: HardwareSensorErrorCode,
    message: string,
    options?: ErrorOptions,
  ) {
    super(message, options);
    this.name = "HardwareSensorPortError";
  }
}

export interface HardwareSensorPort {
  read(
    req: HardwareSensorReadRequest,
    options?: { signal?: AbortSignal },
  ): Promise<{
    samples: HardwareSensorSample[];
    summary?: Record<string, unknown>;  // 平均、最大、最小 等
  }>;
}
```

## runtime 集成

### HardwareSensor Skill

skill 文件 `apps/zcode-cli/packages/hardware-plugin/skills/sensors/SKILL.md`：

```yaml
---
name: hardware-sensors
description: |
  读取设备硬件传感器 (GPS、加速度、电池、网络等)。
  Use when: 用户要求 "记录我的位置" / "看下当前电量" / "监测一段时间的网络状态"。
  Do not use when: 用户只是要 device 资料。
---
```

### 入口适配

- Desktop：CLI / TUI 可调用；GUI 不暴露。
- Mobile：GUI / 触屏 / 地理感知场景。
- Web：仅支持 `system-info` / 部分 Web APIs（Geolocation API 等）。

## Workspace Resource Index 集成

### Entry

```typescript
{
  id: ulid(),
  workspaceIdentity,
  workspacePath,
  kind: "hardware",
  title: "GPS samples during meeting",
  sourceOrigin: "device_stream",        // 区别于 user_upload / bot_attachment / tool_result / screen_capture / recording
  addedAt: now,
  updatedAt: now,
  variants: [
    {
      kind: "original",                 // 原始 JSON samples
      mime: "application/json",
      bytes: ...,
      sha256: ...,
      artifactUri: "zcode-artifact://...",
      meta: { sensor: "gps", samples: 60 },
    },
  ],
  references: 1,
  meta: {
    sensorKind: "gps",
    durationMs: 60000,
    intervalMs: 1000,
    sampleCount: 60,
  },
}
```

### 后续处理

sensor `entries` 不直接走 audio / video worker。

对于**群组数据**（多 sensor）：agent 可以用 tool (`Read`) 读取 artifact URI 的 JSON 内容，转化为自然语言上下文。

## Bundle 装配

`apps/zcode-cli/packages/hardware-plugin/`：

- `package.json`：`{ "name": "@zcode/hardware-plugin", "private": true }`
- `.zcode-plugin/plugin.json`：metadata
- `skills/sensors/SKILL.md`

在 `OFFICIAL_PLUGIN_DEFINITIONS` 加 entry，`defaultEnabled`：

- Desktop：false（需要显式开启）
- Mobile：true（默认）
- Web：true（仅 system-info / Geolocation API）
- TUI / CLI：false

## 安全

### 平台权限

- GPS：iOS / Android 需要定位权限声明；请求失败走 IPlatformService。
- 蓝牙：iOS `NSBluetoothAlwaysUsageDescription`（phase 2 限定）。
- 电池 / 网络 / CPU / memory：受限。

权限拒绝：

```typescript
throw new HardwareSensorPortError("hardware_sensor_denied", ...);
```

### 数据 lifecycle

- sensor data 落 artifact store（私有 namespace），不写入 workspace 公开目录。
- 采样 0 samples / 1 sample / 满 1 个 chunk 等阈值由 adapter 决定；user 看到的 bytes 仅作显示。

### PII / 隐私

- GPS / 精确位置信息特别敏感；debug 日志只记 sample count + sensor kind + durationMs；不记录实际坐标。
- samples 不进日志。

## 错误码

| code | 含义 | 重试 |
| --- | --- | --- |
| `hardware_sensor_unavailable` | sensor 不存在 | 不重试 |
| `hardware_sensor_denied` | 平台权限拒绝 | 不重试（需用户授权） |
| `hardware_sensor_invalid_request` | 参数非法 | 不重试 |
| `cancelled` | 用户取消 | 不重试 |
| `timeout` | sampling 超时 | 不重试 |

## 实施步骤

### Phase 6.1（Phase 6.1 与 stream-input.md 共用）：spec 自审 + fixture

- 完整 spec 自审。

### Phase 6.2：port 契约

- 新文件 `packages/contracts/src/interfaces/hardware-sensor.port.ts`，≤ 100 行。

### Phase 6.3：runtime types

- `runtime/types.ts` 加 `hardwareSensorPort?` 字段。
- `agent-runtime.ts` 同步。

### Phase 6.4：adapter

- `packages/adapters/src/hardware-sensor/{node,electron,web,index}.ts`。

### Phase 6.5：入口

- CLI / TUI / Desktop / Mobile 入口。
- 桌面默认不开启。

### Phase 6.6：bundle

- `packages/hardware-plugin/{package.json,.zcode-plugin/plugin.json,skills/}`。
- `OFFICIAL_PLUGIN_DEFINITIONS` 加 entry。

## 测试要求

```text
pnpm --dir apps/zcode-cli typecheck
pnpm --dir apps/zcode-cli lint
pnpm --dir apps/zcode-cli test
```

必测场景：

### 端口契约

- `HardwareSensorPort.read`：单次 / 持续采样。
- 各 sensor 类型：GPS / 加速度 / 电池 等。
- 权限拒绝：port 报 `hardware_sensor_denied`。
- Cancellation：中断返回空 sample 列表。

### Adapter

- Node adapter：`system-info` / `cpu` / `memory` / `storage`。
- Electron adapter：`battery` / `network`。
- Web adapter：`system-info` / `network`。

### 现状不退化

- 现有工具不被任何影响。

## 提交条件

每个功能级变更单独提交：

1. port 契约 + barrel（commit 1）
2. runtime types + agent runtime wiring（commit 2）
3. Node adapter（commit 3）
4. Electron / Web adapter（commit 4）
5. CLI / TUI / Desktop 入口（commit 5）
6. bundle + OFFICIAL_PLUGIN_DEFINITIONS（commit 6）
7. 单测（commit 7）

每提交后跑：

```text
pnpm --dir apps/zcode-cli typecheck
pnpm --dir apps/zcode-cli lint
pnpm --dir apps/zcode-cli test -- packages/core/tests/hardware-sensor.test.ts
```

## 与 stream-input.md 的关系

- stream-input.md 走 `LiveCapturePort`；hardware-sensor.md 走 `HardwareSensorPort`。两者都是实时 capture，但语义不同：
  - `LiveCapturePort`：media 字节（mp4 / webm）
  - `HardwareSensorPort`：structured JSON samples

两者**共享基础设施**：

- 都走 workspace resource index（同一 `kind` 区分）
- 都走 IPlatformService 平台权限
- 都走 artifact store 存储

两者**不重叠**：

- stream-input 是 media 字节 pipeline；hardware-sensor 是 structured data pipeline
- 不互相依赖，可独立交付