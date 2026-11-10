import {
  DEFAULT_DEGRADATION_POLICY,
  type DegradationPolicy,
  type LocalInfraConfig,
  type MineruProxyPolicy,
} from "@zcode/contracts";
import { loadFileConfig } from "./file-config.adapter.js";
import { loadProjectConfigs } from "./project-config.adapter.js";

/**
 * `ocr.*` 配置段的运行期视图（spec：docs/design/v2/capability-provisioning.md §8.2）。
 *
 * ⚠️ **机器级**（不是 workspace 级）：就绪状态是「这台机器上能不能用」，
 * 放在 workspace 配置里会让同一台机器的不同 workspace 得到不同的就绪结论。
 */
export interface OcrRuntimeSettings {
  /** 引擎定位与代理策略（喂给 `LocalInfraPort`）。 */
  readonly infra: LocalInfraConfig;
  /** 降级策略（默认 `error`）。 */
  readonly degradation: DegradationPolicy;
}

/**
 * 读 `ocr.*` 配置段。
 *
 * ⚠️ **层级**：项目级配置 > 用户级配置（`~/.zcode/cli/config.json`）。
 * 项目级走既有的配置发现（`.agents` 协议 / `.zcode/config.json` / `zcode.json`），
 * 不自己拼路径 —— **配置发现只有一处所有者**。
 *
 * ⚠️ 这里同时服务两个消费方：`zcode ocr` 命令组与 runtime 的能力供给层 ——
 * 两边必须看到**同一份**引擎路径与降级策略，否则命令面体检出来的环境和实际用的不是一套。
 *
 * ⚠️ `userConfigPath` 让宿主（桌面 / 测试）能指定用户级配置文件位置 ——
 * 与 app 其它配置读同一份，避免「命令面读 A 文件、runtime 读 B 文件」。
 */
export function loadOcrRuntimeSettings(
  workingDirectory: string,
  options: { readonly userConfigPath?: string } = {},
): OcrRuntimeSettings {
  const user = loadFileConfig(options.userConfigPath, { scope: "user" });
  const project = loadProjectConfigs(workingDirectory);

  let infra: LocalInfraConfig = {};
  let degradation: DegradationPolicy = DEFAULT_DEGRADATION_POLICY;
  for (const layer of [user.config.ocr, ...project.files.map((file) => file.config.ocr)]) {
    if (layer === undefined) continue;
    infra = {
      ...infra,
      ...(layer.mineruPath !== undefined ? { mineruPath: layer.mineruPath } : {}),
      ...(layer.mineruProxy !== undefined ? { mineruProxy: layer.mineruProxy } : {}),
    };
    if (layer.degradation !== undefined) degradation = layer.degradation;
  }
  return { infra, degradation };
}
