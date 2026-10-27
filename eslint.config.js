import js from '@eslint/js';
import stylistic from '@stylistic/eslint-plugin';

export default [
    js.configs.recommended,
    {
        files: ['printers@linux-man.org/**/*.js', 'tools/**/*.js'],
        plugins: {'@stylistic': stylistic},
        languageOptions: {
            ecmaVersion: 2022,
            sourceType: 'module',
            globals: {
                // provided by GJS / GNOME Shell
                global: 'readonly',
                log: 'readonly',
                logError: 'readonly',
                print: 'readonly',
                printerr: 'readonly',
                console: 'readonly',
                TextDecoder: 'readonly',
                TextEncoder: 'readonly',
            },
        },
        rules: {
            '@stylistic/indent': ['error', 4],
            '@stylistic/no-tabs': 'error',
            '@stylistic/no-trailing-spaces': 'error',
        },
    },
];
