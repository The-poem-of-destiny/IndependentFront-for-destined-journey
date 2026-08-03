/**
 * Main exports
 *
 * Q-04：删除 v3 世界书栈僵尸（lorebook-engine / prompt-assembler / importer）的导出。
 * 这三个模块零生产引用，仅通过本 barrel 对外存活，随文件删除一并移除。
 */

export * from './types';
export * from './database';
export * from './variables';
export * from './marker-protocol';
export * from './story-output';
export * from './char-gen-agent';
export * from './agent-tools';
export * from './random-tables';
export * from './beautifier';

export const VERSION = '4.0.0';
