/**
 * 图片附件扩展名白名单的单一来源。
 *
 * 历史上 `prompt-command.ts` 与 `recognize-walker.ts` 各持有一份 `IMAGE_EXTENSIONS`，
 * 仅靠注释互相对齐——两处独立扩展时会出现静默失配（recognize 扫到的图 prompt 拒收，
 * 或反向）。统一从这里 import，不再各自定义。
 */

/** 可作为图片附件 / 识别输入的扩展名（小写、含点）。 */
export const IMAGE_EXTENSIONS: ReadonlySet<string> = new Set([
  ".gif",
  ".jpeg",
  ".jpg",
  ".png",
  ".webp",
]);
