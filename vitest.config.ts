import { defineConfig } from 'vitest/config';
import { resolve } from 'path';
import { cpus } from 'os';
import vue from '@vitejs/plugin-vue';

/**
 * 并发上限 —— 修 `create-store` 大纲生成用例的负载 flake（2026-08-01）。
 *
 * ## 症状
 * 「score >= 6 时一次调用即产出大纲」单跑 93ms，全量跑 **3291ms**，
 * 稳定卡在 5000ms 默认 timeout 上。CI（核少）不复现，只在多核开发机上出现。
 *
 * ## 根因：过订阅，不是这条用例的问题
 * 那条用例会做一次**真实的提示装配**（世界书 + EJS pass），本身约 90ms 的 CPU ——
 * 在 5s 预算下本该有 50 倍余量。而 vitest 默认 `maxWorkers = 核数`，
 * 16 个 worker 里还夹着几个加载 wasm 的 EJS 测试文件（内存重），
 * 一个 90ms 的 CPU 突发被拉长 35 倍，余量塌到 1.5 倍。
 *
 * ## 实测（16 核开发机，全量 185 文件）
 * | maxWorkers | 全量耗时 | 该用例 |
 * |---|---|---|
 * | 16（默认） | 26.03s | 3291ms ❌ |
 * | 8 | **24.27s** | 133ms ✅ |
 * | 4 | 33.31s | 84ms ✅ |
 *
 * 8 个**整体还更快** —— 过订阅本身在拖后腿。
 *
 * ## 为什么不是调高 testTimeout
 * 调高只会把「真卡住」和「被抢 CPU」这两件事一起藏起来。余量该靠不过订阅拿回来，
 * 不是靠放宽判据。
 *
 * ## 只在多核机上收敛
 * CI 跑在 2-4 核的 runner 上，本来就不会过订阅；对半砍反而白白拖慢 CI。
 * 故只在核数 > 8 时才设上限。
 */
const cpuCount = cpus().length;
const maxWorkers = cpuCount > 8 ? Math.floor(cpuCount / 2) : undefined;

export default defineConfig({
  plugins: [vue()],
  resolve: {
    alias: {
      '@engine': resolve(__dirname, 'src/sillytavern'),
      '@ui': resolve(__dirname, 'src/ui'),
    },
  },
  test: {
    environment: 'node',
    include: ['src/**/*.test.ts', 'tests/**/*.test.ts'],
    setupFiles: ['src/test-setup.ts'],
    globals: true,
    ...(maxWorkers ? { maxWorkers } : {}),
  },
});
