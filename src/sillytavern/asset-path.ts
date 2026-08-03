/**
 * 素材文件路径解析 —— **唯一实现**（Q-16）。
 *
 * 起因：`asset-import-plan.ts`（引擎侧导入计划）与 `asset-zip.ts`（UI 侧 zip 往返）
 * 各存一份逐字符相同的 `normalizeSlashes` / `basenameOf`，连注释都一样；扩展名归一化
 * 是第三份（`asset-types.ts` 的私有 `normalizeExtension`）。
 *
 * 这里是把用户真实文件名映射成库内主键的地方，口径分叉的表现是「导入了但库里查不到」，
 * 排查成本很高。而且**已经咬过一次**：`"苏婉_头像.png "` 的字面扩展名是 `"png "`，
 * 直接查表查不着，整条被当噪音丢掉 —— 引擎的 `isAssetExtension` 内部本来就 trim，
 * zip 侧曾经比它更严，那就是漂移。
 *
 * 素材命名不变式 `<name>[_<type>][_<variant>].<ext>` 只允许有一个解析实现。
 */

/** 斜杠归一化: 部分 Windows 工具会写反斜杠分隔符 */
export function normalizeSlashes(path: string): string {
  return (path ?? '').replace(/\\/g, '/');
}

/** 取 basename（拍平嵌套目录）；纯路径返回空串 */
export function basenameOf(path: string): string {
  const norm = normalizeSlashes(path);
  const idx = norm.lastIndexOf('/');
  return idx === -1 ? norm : norm.slice(idx + 1);
}

/**
 * 扩展名**原样**（不含点，保留大小写与空白）；无真尾缀返回空串。
 *
 * `dot > 0` 而不是 `dot >= 0`：排除 `.png` 这种整串就是「扩展名」的 dotfile。
 *
 * 🔴 与 {@link normalizedExtensionOf} **不可合并成一个函数**。两侧此前刻意不同：
 * 引擎侧当场小写、zip 侧保留原样把归一化推迟到判据处。合成一个就等于在抽取过程中
 * 引入它本要消灭的那种漂移 —— 所以两个都导出，调用点显式选一个。
 */
export function extensionOf(basename: string): string {
  const dot = basename.lastIndexOf('.');
  return dot > 0 ? basename.slice(dot + 1) : '';
}

/** 归一化后的扩展名（去点 + trim + 小写）；无扩展名返回空串。**名字本身绝不动** */
export function normalizedExtensionOf(basename: string): string {
  return normalizeExtension(extensionOf(basename));
}

/** 归一化一个扩展名字符串本身（去前导点、trim、小写）。查表前一律先过这里 */
export function normalizeExtension(ext: string): string {
  const trimmed = (ext ?? '').trim().toLowerCase();
  return trimmed.startsWith('.') ? trimmed.slice(1) : trimmed;
}
