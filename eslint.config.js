import js from '@eslint/js'
import tseslint from 'typescript-eslint'
import hooks from 'eslint-plugin-react-hooks'
export default tseslint.config(
  { ignores: ['dist/**', 'node_modules/**', '.cache/**', 'reports/**', 'test-results/**', 'playwright-report/**'] },
  {files:['scripts/**/*.mjs'],languageOptions:{globals:{console:'readonly',process:'readonly',Buffer:'readonly',TextDecoder:'readonly'}}},
  js.configs.recommended, ...tseslint.configs.recommended,
  { files: ['**/*.{ts,tsx}'], plugins: {'react-hooks': hooks}, rules: {
    'react-hooks/rules-of-hooks': 'error', 'react-hooks/exhaustive-deps': 'warn',
  } },
)
