/// <reference types="vite/client" />

/**
 * 引擎版本（D26/D40）—— 由 `vite.config.ts` 与 `vitest.config.ts` 的 `define` 注入，
 * 值取自 `package.json` 的 `version`。内容包的 `minEngineVersion` 拿它做门
 * （`src/sillytavern/content-source.ts` 的 `checkEngineVersion`）。
 *
 * 🔴 **必须以裸标识符引用**（`typeof __ENGINE_VERSION__` / `__ENGINE_VERSION__`）。
 * `define` 是编译期的**标识符**替换 —— 写成 `globalThis.__ENGINE_VERSION__` 那种成员
 * 访问不会被替换，于是注入了也读不到，版本门会安静地一直放行。
 *
 * 裸 `tsc` / 未经打包的宿主里它不存在，读之前一律先 `typeof` 判。
 */
declare const __ENGINE_VERSION__: string | undefined;

declare module '*.vue' {
  import type { DefineComponent } from 'vue';
  const component: DefineComponent<Record<string, unknown>, Record<string, unknown>, any>;
  export default component;
}
