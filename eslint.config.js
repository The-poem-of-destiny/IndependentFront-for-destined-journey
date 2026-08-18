import pluginVue from 'eslint-plugin-vue';
import vueTsEslintConfig from '@vue/eslint-config-typescript';
import prettierConfig from 'eslint-config-prettier';
import unusedImports from 'eslint-plugin-unused-imports';

// ESLint 9 flat config。风格问题交给 Prettier（prettierConfig 放最后关掉 eslint 的格式规则）。
// 风格不在 review 里争（治理规范 §5.1）。
//
// 🔴 **这份配置是闸门，不是提示板**（2026-08-05 收紧）。`npm run lint` 带 `--max-warnings 0`，
//    任何一条 warning 都会让 CI 挂红。收紧之前它有 193 条 warning 却 exit 0 —— 等于没有闸门。
export default [
  {
    ignores: [
      'dist/**',
      'dist-ui/**',
      'node_modules/**',
      'coverage/**',
      'public/**',
      'docs/reference/**',
      'docs/planning/**',
    ],
  },
  ...pluginVue.configs['flat/recommended'],
  ...vueTsEslintConfig(),
  prettierConfig,
  {
    /**
     * 🔴 **类型感知规则**（2026-08-05 新增）—— 这一档是当初上 lint 时漏掉的那半边。
     *
     * 不带类型信息时 `no-floating-promises` 这类规则根本无法工作，于是「promise 被丢掉、
     * 没人等也没人接错」这一整类缺陷对 lint 完全隐形。开起来当场逮到 4 处真的。
     *
     * 只对 `.ts` 开，且必须**两个 tsconfig 都列上**：主 tsconfig 只 include `src/**`，
     * `server/` `tests/` 在 tsconfig.tools.json 里 —— 少列一个，那些文件会以
     * 「was not found by the project service」整片报解析错误。
     *
     * 不对 `.vue` 开：类型感知要给 vue 单配 extraFileExtensions、解析开销也翻倍，
     * 而 SFC 里的 promise 绝大多数经由 store / composable（都是 `.ts`）落地。
     */
    files: ['src/**/*.ts', 'server/**/*.ts', 'tests/**/*.ts'],
    languageOptions: {
      parserOptions: {
        project: ['./tsconfig.json', './tsconfig.tools.json'],
        tsconfigRootDir: import.meta.dirname,
      },
    },
    rules: {
      '@typescript-eslint/no-floating-promises': 'error',
      '@typescript-eslint/no-misused-promises': 'error',
      '@typescript-eslint/await-thenable': 'error',
    },
  },
  {
    plugins: { 'unused-imports': unusedImports },
    rules: {
      // 项目定制：现有代码量大，这两条先放宽不阻塞
      'vue/multi-word-component-names': 'off', // 允许单词组件名
      '@typescript-eslint/no-explicit-any': 'off', // 项目仍在类型漂移修复中

      /**
       * 未引用导入交给 `unused-imports`：它**能自动修**（`npm run lint:fix` 直接删掉），
       * 而 `@typescript-eslint/no-unused-vars` 只报不修。收紧那天 186 条里约 122 条
       * 是未引用导入，靠这条一次扫干净。
       */
      'unused-imports/no-unused-imports': 'error',

      /**
       * 其余未引用变量。四个 `^_` 豁免是**有意的表达手段**：`_` 前缀 = 「我知道它没用，
       * 但这个位置必须占着」（接口要求的形参、解构里要丢掉的字段、catch 绑定）。
       * 没有豁免的话这些位置只能靠 eslint-disable 注释，那比 `_` 前缀更吵。
       */
      '@typescript-eslint/no-unused-vars': [
        'error',
        {
          argsIgnorePattern: '^_',
          varsIgnorePattern: '^_',
          caughtErrorsIgnorePattern: '^_',
          destructuredArrayIgnorePattern: '^_',
        },
      ],

      /**
       * 🔴 **空 catch 不再放行**（原先是 `allowEmptyCatch: true`）。
       * 「异常被 catch 咽掉、没人看见」正是 PR #22 评审逮到的缺陷之一 ——
       * 而当时的配置**明文允许**它。真要吞就在 catch 体里写一句注释说明理由：
       * 那句注释本身就是审查时要看的交代。
       */
      'no-empty': ['error', { allowEmptyCatch: false }],
    },
  },
  {
    /**
     * 🔴 **分层闸门：引擎不许 import 前端**（2026-08-17 收口）。
     *
     * 起因：`src/sillytavern/` 下曾有 6 条反向边 —— 4 个内容注册表消费方
     * （agent-tools / bloodlines / location-db / random-tables）import `content-store`、
     * `content-source` import `ui/lib/media-hash`、`database` type-only import
     * `create-store` 的 `CreatePreset`。每一条都能编译、能跑、测试全绿，
     * 代价是**引擎从此依赖 Vue + Pinia + Dexie 整条前端链**：headless 跑批与引擎单测
     * 都得把整个 store 拖起来，而「哪一层能依赖哪一层」这件事没有任何一处机器在管。
     *
     * 现在的正确形状是**注入缝**（`content-registry-runtime.ts` / `engine-settings.ts` /
     * `map-runtime.ts` / `random-event-runtime.ts`）：前端往缝里装，引擎只读。
     * 要在引擎里用前端的某个东西，答案永远是「把它搬进引擎，或者开一条缝」，
     * 不是「再 import 一次」。
     *
     * 🔴 `vue` / `pinia` 一并封死：引擎里出现 `ref()` / `defineStore()` 是同一条边的
     *    另一种写法，而它比路径 import 更难在 review 里看出来。
     *
     * 本条只管 `import`/`export from` 的**静态**边。动态 `import()`、`import.meta.glob`
     * 与字符串路径由 `tests/layering-gate.test.ts` 的源码扫描兜住 —— 两道网互补，
     * 少任何一道都留着一条静默的路。
     */
    files: ['src/sillytavern/**/*.ts'],
    rules: {
      'no-restricted-imports': [
        'error',
        {
          patterns: [
            {
              group: ['../ui', '../ui/*', '../../ui', '../../ui/*', '**/src/ui/*', '@ui', '@ui/*'],
              message:
                '引擎不许 import 前端（src/ui）。把它搬进 src/sillytavern，或照 content-registry-runtime.ts / engine-settings.ts 开一条注入缝，由前端往缝里装。',
            },
            {
              group: ['vue', 'vue/*', 'pinia', 'pinia/*'],
              message:
                '引擎不许依赖 Vue / Pinia。响应式与 store 属于 src/ui；引擎侧用模块级注入缝（见 content-registry-runtime.ts）。',
            },
          ],
        },
      ],
    },
  },
  {
    // Q-15 补网：lint 从 src/** 扩到 {src,server,tests,scripts}/**。
    // .cjs 是**有意**的 CommonJS 一次性脚本（node 直跑，不进构建），require 是它唯一的导入方式。
    files: ['**/*.cjs'],
    languageOptions: { sourceType: 'commonjs' },
    rules: { '@typescript-eslint/no-require-imports': 'off' },
  },
];
