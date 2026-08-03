/**
 * Main exports
 *
 * Q-04：删除 v3 世界书栈僵尸（lorebook-engine / prompt-assembler / importer）的导出。
 * 这三个模块零生产引用，仅通过本 barrel 对外存活，随文件删除一并移除。
 *
 * Q-12：`./variables` 同上 —— 它最后一个活着的导出 `formatVariablesForPrompt` 的
 * 唯一消费方正是上面删掉的 prompt-assembler，随之归零；其余四个导出
 * （extractVariables / mergeVariables / USER_ROLE / applyParsedToChat）本就零调用。
 * 连带删掉它唯一的依赖 `vars-merger.ts` —— 那里那个 `applyVarsPatch` 与
 * `var-resolver` 的同名函数契约互斥（只认 merge / 只认路径 ops），是 auto-import
 * 最容易点错的一类陷阱。宿主一死，陷阱就没了。
 */

export * from './types';
export * from './database';
export * from './marker-protocol';
export * from './story-output';
export * from './char-gen-agent';
export * from './agent-tools';
export * from './random-tables';
export * from './beautifier';

export const VERSION = '4.0.0';
