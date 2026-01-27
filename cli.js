#!/usr/bin/env node

import { execSync } from 'node:child_process'
import { existsSync, mkdirSync, readdirSync } from 'node:fs'
import { homedir } from 'node:os'
import { join } from 'node:path'
import { parseArgs } from 'node:util'
import { SonarLintClient } from './scan.js'

const VERSION = '4.40.0'
const BUILD = '79805'
const BASE_URL = 'https://github.com/SonarSource/sonarlint-vscode/releases/download'
const CACHE_DIR = join(homedir(), '.sonarx')

function getPlatform() {
    const platform = process.platform
    const arch = process.arch
    if (platform === 'darwin') return arch === 'arm64' ? 'darwin-arm64' : 'darwin-x64'
    if (platform === 'linux') return 'linux-x64'
    return null
}

function findJava(dir) {
    // recursively find java executable in jre directory
    const search = (d) => {
        for (const entry of readdirSync(d, { withFileTypes: true })) {
            const full = join(d, entry.name)
            if (entry.isDirectory()) {
                const found = search(full)
                if (found) return found
            } else if (entry.name === 'java') {
                return full
            }
        }
        return null
    }
    return search(dir)
}

function setup() {
    const lspJar = join(CACHE_DIR, 'server', 'sonarlint-ls.jar')
    if (existsSync(lspJar)) return

    const platform = getPlatform()
    const vsixName = platform
        ? `sonarlint-vscode-${platform}-${VERSION}.vsix`
        : `sonarlint-vscode-${VERSION}.vsix`
    const url = `${BASE_URL}/${VERSION}%2B${BUILD}/${vsixName}`

    console.error(`Downloading ${vsixName}...`)
    mkdirSync(CACHE_DIR, { recursive: true })

    const commands = [
        `curl -fsSL "${url}" -o "${join(CACHE_DIR, 'sonar.zip')}"`,
        `unzip -q "${join(CACHE_DIR, 'sonar.zip')}" -d "${join(CACHE_DIR, 'tmp')}"`,
        `mv "${join(CACHE_DIR, 'tmp', 'extension', 'analyzers')}" "${CACHE_DIR}"`,
        `mv "${join(CACHE_DIR, 'tmp', 'extension', 'server')}" "${CACHE_DIR}"`,
    ]

    // jre is only in platform-specific builds
    if (platform) {
        commands.push(`mv "${join(CACHE_DIR, 'tmp', 'extension', 'jre')}" "${CACHE_DIR}" 2>/dev/null || true`)
    }

    commands.push(`rm -rf "${join(CACHE_DIR, 'sonar.zip')}" "${join(CACHE_DIR, 'tmp')}"`)

    execSync(commands.join(' && '), { stdio: 'inherit' })
    console.error('Setup complete.')
}

function getJavaPath() {
    const jreDir = join(CACHE_DIR, 'jre')
    if (existsSync(jreDir)) {
        const java = findJava(jreDir)
        if (java) return java
    }
    return 'java'
}

async function main() {
    const { values, positionals } = parseArgs({
        options: {
            debug: { type: 'boolean', short: 'd', default: false },
            'disable-rules': { type: 'string' },
            'list-rules': { type: 'boolean', default: false },
            help: { type: 'boolean', short: 'h', default: false },
        },
        allowPositionals: true,
        strict: false,
    })

    if (values.help) {
        console.log(`Usage: snr [options] <files...>

Options:
  --disable-rules <rules>   Disable specific rules (comma-separated)
  --list-rules              List all available rules
  -d, --debug               Enable debug logging
  -h, --help                Show this help

Examples:
  snr src/*.js                              Analyze files
  snr --disable-rules javascript:S3504 .    Skip specific rules
  snr --list-rules                          List all 600+ rules`)
        process.exit(0)
    }

    setup()

    const client = new SonarLintClient({
        debug: values.debug,
        java: getJavaPath(),
        sonarlintLsp: join(CACHE_DIR, 'server', 'sonarlint-ls.jar'),
        analyzers: [join(CACHE_DIR, 'analyzers', 'sonarjs.jar')],
        disabledRules: values['disable-rules']?.split(','),
    })

    try {
        await client.start()

        if (values['list-rules']) {
            console.log(client.listRules().join('\n'))
        } else {
            if (!positionals.length) {
                console.error('Error: No files specified')
                process.exit(1)
            }
            await client.analyzeFiles(positionals)
        }

        await client.stop()
        process.exit(client.errors ? 1 : 0)
    } catch (error) {
        console.error('Error:', error.message)
        await client.stop()
        process.exit(1)
    }
}

main().catch(console.error)
