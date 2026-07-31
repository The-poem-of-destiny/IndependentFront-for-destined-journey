import pluginVue from 'eslint-plugin-vue'
import vueTsEslintConfig from '@vue/eslint-config-typescript'
import prettierConfig from 'eslint-config-prettier'

// ESLint 9 flat config。风格问题交给 Prettier（prettierConfig 放最后关掉 eslint 的格式规则）。
// 风格不在 review 里争（治理规范 §5.1）。
export default [
  {
    ignores: [
      'dist/**',
      'node_modules/**',
      'coverage/**',
      'public/**',
      'reference/**',
      'docs/reference/**',
      'docs/planning/**',
    ],
  },
  ...pluginVue.configs['flat/recommended'],
  ...vueTsEslintConfig(),
  prettierConfig,
  {
    rules: {
      // 项目定制：现有代码量大，先放宽不阻塞，后续逐步收紧
      'vue/multi-word-component-names': 'off', // 允许单词组件名
      '@typescript-eslint/no-explicit-any': 'off', // 项目仍在类型漂移修复中
      '@typescript-eslint/no-unused-vars': ['warn', { argsIgnorePattern: '^_' }],
      'no-empty': ['warn', { allowEmptyCatch: true }],
    },
  },
]
