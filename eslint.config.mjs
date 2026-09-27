import { defineConfig, globalIgnores } from 'eslint/config';
import nextVitals from 'eslint-config-next/core-web-vitals';
import nextTypes from 'eslint-config-next/typescript';
export default defineConfig([...nextVitals, ...nextTypes, globalIgnores(['.next/**', 'dist/**', 'node_modules/**', 'graft/**', '.local/**', 'test-results/**', 'playwright-report/**', 'mobile/**']), { rules: { '@next/next/no-img-element': 'off' } }]);
