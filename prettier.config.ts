import { type Config } from 'prettier'

const config: Config = {
    trailingComma: 'es5',
    tabWidth: 4,
    printWidth: 120,
    singleQuote: true,
    overrides: [
        {
            files: '*.sol',
            options: {
                bracketSpacing: true,
                useTabs: false,
                singleQuote: false,
            },
        },
        {
            files: ['*.ts', '*.mts'],
            options: {
                semi: false,
                singleQuote: true,
                useTabs: false,
            },
        },
        {
            files: ['*.js', '*.cjs', '*.mjs'],
            options: {
                semi: true,
                singleQuote: true,
                useTabs: false,
            },
        },
        {
            files: ['*.json'],
            options: {
                trailingComma: 'none',
            },
        },
    ],
}

export default config
