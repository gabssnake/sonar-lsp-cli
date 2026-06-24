#!/usr/bin/env node

import { exec } from 'node:child_process'
import { access, mkdir, readdir } from 'node:fs/promises'
import { homedir } from 'node:os'
import { join } from 'node:path'
import { parseArgs, promisify } from 'node:util'
import { SonarLintClient } from './scan.js'

const execAsync = promisify(exec)

const VERSION = '5.4.0'
const BUILD = '80395'
const BASE_URL = 'https://github.com/SonarSource/sonarlint-vscode/releases/download'
const CACHE_DIR = join(homedir(), '.sonarx')

function getPlatform() {
    const platform = process.platform
    const arch = process.arch
    if (platform === 'darwin') return arch === 'arm64' ? 'darwin-arm64' : 'darwin-x64'
    if (platform === 'linux') return 'linux-x64'
    return null
}

async function findJava(dir) {
    // recursively find java executable in jre directory
    for (const entry of await readdir(dir, { withFileTypes: true })) {
        const full = join(dir, entry.name)
        if (entry.isDirectory()) {
            const found = await findJava(full)
            if (found) return found
        } else if (entry.name === 'java') {
            return full
        }
    }
    return null
}

async function exists(path) {
    try {
        await access(path)
        return true
    } catch {
        return false
    }
}

async function setup() {
    const lspJar = join(CACHE_DIR, 'server', 'sonarlint-ls.jar')
    if (await exists(lspJar)) return

    const platform = getPlatform()
    const vsixName = platform
        ? `sonarlint-vscode-${platform}-${VERSION}.vsix`
        : `sonarlint-vscode-${VERSION}.vsix`
    const url = `${BASE_URL}/${VERSION}%2B${BUILD}/${vsixName}`

    console.error(`Downloading ${vsixName}...`)
    await mkdir(CACHE_DIR, { recursive: true })

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

    await execAsync(commands.join(' && '))
    console.error('Setup complete.')
}

async function getJavaPath() {
    const jreDir = join(CACHE_DIR, 'jre')
    if (await exists(jreDir)) {
        const java = await findJava(jreDir)
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

    await setup()

    const client = new SonarLintClient({
        debug: values.debug,
        java: await getJavaPath(),
        sonarlintLsp: join(CACHE_DIR, 'server', 'sonarlint-ls.jar'),
        analyzers: [
            join(CACHE_DIR, 'analyzers', 'sonarjs.jar'),
            join(CACHE_DIR, 'analyzers', 'sonarpython.jar'),
            join(CACHE_DIR, 'analyzers', 'sonarjava.jar'),
            join(CACHE_DIR, 'analyzers', 'sonarhtml.jar'),
        ],
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

await main()
