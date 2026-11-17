/**
 * `build-portable.mjs` 的类型声明 —— 让 `tests/build-portable.test.ts` 能在
 * `typecheck:tools`（strict，无 allowJs）下解析这个 .mjs 模块。
 */

export interface ZipEntry {
  /** zip 内路径，用 `/` 分隔 */
  name: string;
  /** 磁盘上的源文件 */
  file: string;
}

export declare function shouldStore(name: string): boolean;
export declare function findDevLaunchers(names: readonly string[]): string[];

export declare function writeZip(outFile: string, entries: ZipEntry[]): Promise<void>;

export declare function parseNulSeparated(output: string): string[];

export declare function ignoredPublicTargets(webDir: string, gitOutput: string): string[];

export declare function stripIgnoredPublicFiles(webDir: string, gitOutput: string): number;

export declare function findPackServerEnv(
  root: string,
  modes: string[],
): Promise<Array<{ mode: string; value: string }>>;

export declare function filesContaining(files: string[], needles: string[]): string[];
