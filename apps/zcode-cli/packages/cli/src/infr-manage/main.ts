import { runInfrManage } from "./index.js";

/**
 * `zcode-infr-manage` 的进程入口。
 *
 * ⚠️ **只设置 `process.exitCode`，不调 `process.exit`** —— 让 Node 自己收尾，
 * 保证 stdout 被完整刷出（stdout 是单个 JSON 对象，半截输出等于契约破损）。
 *
 * ⚠️ **不得 import `run.ts` / `@zcode/bootstrap` / `@zcode/core`** ——
 * 那会求值 Agent 运行时、工具注册表与工作流模块，把整套业务依赖打进这个
 * 独立二进制（M1 / §7.3 的唯一可执行约束）。
 */
void runInfrManage({ stdout: process.stdout, stderr: process.stderr }, process.argv.slice(2)).then(
  (exitCode) => {
    process.exitCode = exitCode;
  },
  (error: unknown) => {
    const message = error instanceof Error ? error.message : String(error);
    process.stderr.write(`${message}\n`);
    process.exitCode = 1;
  },
);
