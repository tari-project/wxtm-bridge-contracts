import { defineConfig, globalIgnores } from 'eslint/config';
import eslintJS from '@eslint/js';
import prettierConfig from 'eslint-config-prettier';
import prettierPluginConfig from 'eslint-plugin-prettier/recommended';

export default defineConfig([
    eslintJS.configs.recommended,
    prettierConfig,
    prettierPluginConfig,
    globalIgnores([
        '**/artifacts',
        '**/typechain',
        '**/cache',
        '**/dist',
        '**/node_modules',
        '**/out',
        '**/*.log',
        '**/*.sol',
        '**/*.yaml',
        '**/*.lock',
        '**/package-lock.json',
    ]),
]);
