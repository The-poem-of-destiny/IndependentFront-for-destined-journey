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
    // Q-15 补网：lint 从 src/** 扩到 {src,server,tests,scripts}/**。
    // .cjs 是**有意**的 CommonJS 一次性脚本（node 直跑，不进构建），require 是它唯一的导入方式。
    files: ['**/*.cjs'],
    languageOptions: { sourceType: 'commonjs' },
    rules: { '@typescript-eslint/no-require-imports': 'off' },
  },
];
