#!/usr/bin/env node
// `zcode-infr-manage` 的发行包入口（spec：apps/zcode-cli/docs/design/v2/local-infra.md §7.3）。
//
// ⚠️ 与主 runner 分开的理由：主 runner 的 argv 语义是 "zcode [--web]"，
// 而本命令的 argv 语义是 "doctor | parse | models download"。塞进同一个
// runner 会让两套语义互相污染（旗标冲突、分派表混在一起）。
import { dirname, join, resolve } from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";

const root = resolve(dirname(fileURLToPath(import.meta.url)), "..");
const agentEntry = join(root, "agent", "zcode-infr-manage.cjs");

try {
  // CLI 自启动子进程依赖 argv[1]；统一指向真正的引擎管理入口，保留全部原始参数。
  process.argv[1] = agentEntry;
  await import(pathToFileURL(agentEntry).href);
} catch (error) {
  console.error(error instanceof Error ? error.message : String(error));
  process.exit(1);
}
