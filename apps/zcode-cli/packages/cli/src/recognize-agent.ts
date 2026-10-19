import type { AgentProfile } from "@zcode/shared";

/**
 * `zcode recognize` 的内置子代理 profile（image-recognition-cli.md「Sub-agent Profile」节）。
 *
 * 为什么是 TS 常量而不是 `agents/*.md`：agent profile 的发现根只有
 * `<storageRoot>/agents`、`<cwd>/.zcode/agents` 和「已启用插件的 `agents/`」
 * （`bootstrap/src/subagents.ts` 的 `loadZCodeAgentProfiles` / `loadPluginAgentTemplates`），
 * CLI 包自身的 `agents/` 不在其中；而 build 只 stage `dist/provider/zcode-builtin.json`
 * （`scripts/build.mjs`），SEA 单文件里也不存在可读的 md。写成常量后 profile 与命令同生共死，
 * 与打包形态无关。
 */

export const IMAGE_RECOGNIZER_AGENT_TYPE = "image-recognizer";

/**
 * 单图识别的系统提示。刻意极短：dispatch message 里已经带了 `mode` / `jsonSchema` /
 * 任务正文，profile 只负责钉死「一次一张图、只读、只回 JSON」这三条不变量。
 */
const IMAGE_RECOGNIZER_SYSTEM_PROMPT = [
  "You are the image-recognizer agent. You are invoked once per image by the `zcode recognize` CLI. Your entire job is to read ONE image file and reply with one JSON object.",
  "",
  "## Rules",
  "",
  "- Use the Read tool to load the image at the path given in the dispatch message. Do not call any other tool. Do not modify any file. Do not browse the web.",
  "- Look at the image carefully and produce the output required by `mode`.",
  "- Reply with JSON only. No prose, no markdown fences, no trailing commentary.",
  '- If you cannot read the image or cannot produce the required output, reply with the error shape: {"status":"error","reason":"unreadable","message":"<one short sentence>"}',
  "",
  "## Required output",
  "",
  '- `description` — one primary `description` sentence/paragraph, optional `observations` bullets, optional `confidence` (0..1).',
  '- `qa` — answer every question in `questions` as a list of { "q": …, "a": … }, plus optional `confidence`.',
  "- `structured` — extract the named `fields` as a flat object; every field name from `fields` must be present with a string/number/boolean/null value.",
  "",
  "Your reply MUST conform exactly to the `jsonSchema` in the dispatch message. Output the JSON object and nothing else.",
].join("\n");

export function createImageRecognizerAgentProfile(): AgentProfile {
  return {
    name: IMAGE_RECOGNIZER_AGENT_TYPE,
    description:
      "Single-image multimodal recognizer used by the `zcode recognize` CLI. Reads one local image via the Read tool and replies with exactly one JSON object matching the schema embedded in the dispatch message. Read-only.",
    color: "cyan",
    // 识别只吃 dispatch message 里的图像路径与 schema；注入项目 AGENTS.md 只会稀释指令。
    injectAgentsMd: false,
    source: "built-in",
    systemPrompt: IMAGE_RECOGNIZER_SYSTEM_PROMPT,
    tools: ["Read"],
  };
}
