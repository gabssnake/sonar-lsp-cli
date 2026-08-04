import { spawn } from 'node:child_process'
import { readFile, appendFile } from 'node:fs/promises'
import path from 'node:path'

const ANALYSIS_TIMEOUT_MS = 60000

function detectLanguage(filePath) {
    const ext = path.extname(filePath).toLowerCase()
    const map = {
        '.js': 'javascript',
        '.jsx': 'javascriptreact',
        '.ts': 'typescript',
        '.tsx': 'typescriptreact',
        '.py': 'python',
        '.java': 'java',
        '.html': 'html',
        '.htm': 'html',
        '.css': 'css',
        '.scss': 'scss',
        '.less': 'less',
    }
    return map[ext] || 'plaintext'
}

class LSPClient {
    constructor(debug = false) {
        this.debug = debug
        this.process = null
        this.messageId = 0
        this.buffer = Buffer.alloc(0)
        this.responseHandlers = new Map()
        this.requestHandlers = new Map()
        this.notificationHandlers = new Map()
    }

    async start(command, args) {
        this.process = spawn(command, args, { stdio: ['pipe', 'pipe', 'pipe'] })
        this.process.stdout.on('data', data => this.handleData(data))
        this.process.stderr.on('data', data => this.log('error', data.toString()))
        this.log('start', `${command} ${args.join(' ')}`)
    }

    sendRequest(method, params) {
        return new Promise((resolve, reject) => {
            const id = ++this.messageId
            this.responseHandlers.set(id, { resolve, reject })
            this.send({ jsonrpc: '2.0', id, method, params })
        })
    }

    sendNotification(method, params) {
        this.send({ jsonrpc: '2.0', method, params })
    }

    send(message) {
        const content = JSON.stringify(message)
        const data = `Content-Length: ${Buffer.byteLength(content)}\r\n\r\n${content}`
        this.log('send', content)
        this.process.stdin.write(data)
    }

    onRequest(method, handler) { this.requestHandlers.set(method, handler) }
    onNotification(method, handler) { this.notificationHandlers.set(method, handler) }

    log(type, message) {
        if (this.debug) {
            const time = new Date().toISOString().slice(11, 19)
            appendFile('sonarlint-debug.log', `${time} ${type}: ${message}\n`).catch(() => {})
        }
    }

    handleResponse(message) {
        const { resolve, reject } = this.responseHandlers.get(message.id)
        this.responseHandlers.delete(message.id)
        if (message.error) {
            reject(new Error(message.error.message))
        } else {
            resolve(message.result)
        }
    }

    handleMethod(message) {
        const handlers = message.id ? this.requestHandlers : this.notificationHandlers
        const handler = handlers.get(message.method)
        if (!handler) return
        const result = handler(message.params)
        if (message.id) {
            this.send({ jsonrpc: '2.0', id: message.id, result })
        }
    }

    handleMessage(content) {
        try {
            const message = JSON.parse(content)
            if (message.id && this.responseHandlers.has(message.id)) {
                this.handleResponse(message)
            } else if (message.method) {
                this.handleMethod(message)
            }
        } catch (e) {
            this.log('parse-error', `${e.message}: ${content.slice(0, 100)}`)
        }
    }

    handleData(data) {
        // Accumulate raw bytes. Content-Length is a byte count, so all framing
        // must use byte offsets: decoding to a string first makes multi-byte
        // characters (e.g. a "→" in a server log message) drift every offset
        // and silently swallow later messages.
        this.buffer = Buffer.concat([this.buffer, data])
        this.log('recv', data.toString().trim())

        while (true) {
            const headerEnd = this.buffer.indexOf('\r\n\r\n')
            if (headerEnd === -1) break

            const header = this.buffer.toString('ascii', 0, headerEnd)
            const match = /Content-Length: (\d+)/i.exec(header)
            if (!match) {
                // Unframeable header, drop it so the stream cannot get stuck.
                this.buffer = this.buffer.subarray(headerEnd + 4)
                continue
            }

            const length = Number.parseInt(match[1], 10)
            const start = headerEnd + 4
            if (this.buffer.length < start + length) break

            const content = this.buffer.toString('utf8', start, start + length)
            this.buffer = this.buffer.subarray(start + length)
            this.handleMessage(content)
        }
    }

    async stop() {
        if (this.process && !this.process.killed) {
            this.sendNotification('shutdown', {})
            this.sendNotification('exit', {})
            await new Promise(r => setTimeout(r, 100))
            this.process.kill()
        }
    }
}

class SonarLintClient {
    constructor(options) {
        this.lsp = new LSPClient(options.debug)
        this.java = options.java || 'java'
        this.jar = options.sonarlintLsp
        this.analyzers = options.analyzers || []
        this.disabledRules = options.disabledRules
        this.rules = []
        this.errors = false

        this.lsp.onRequest('workspace/configuration', () => {
            const rules = {}
            if (this.disabledRules) {
                for (const rule of this.disabledRules) {
                    rules[rule] = { level: 'off' }
                }
            }
            return [{ rules }]
        })

        this.lsp.onRequest('sonarlint/isOpenInEditor', () => true)
    }

    async start() {
        await this.lsp.start(this.java, ['-jar', this.jar, '-stdio', '-analyzers', ...this.analyzers])

        await this.lsp.sendRequest('initialize', { initializationOptions: { productKey: '', productVersion: '' } })
        this.lsp.sendNotification('initialized', {})
        this.lsp.sendNotification('workspace/didChangeConfiguration', {})

        const response = await this.lsp.sendRequest('sonarlint/listAllRules')
        this.rules = Object.values(response || {}).flat().map(rule => rule.key)
    }

    async analyzeFiles(files) {
        this.errors = false
        const pending = new Map()
        const seen = new Set()

        this.lsp.onNotification('textDocument/publishDiagnostics', params => {
            const file = params.uri.replace('file://', '')
            for (const diag of params.diagnostics) {
                const msg = `${file}:${diag.range.start.line + 1}:${diag.range.start.character + 1} - ${diag.message} (${diag.code})`
                if (!seen.has(msg)) {
                    seen.add(msg)
                    console.log(msg)
                    this.errors = true
                }
            }
            pending.get(file)?.()
        })

        await Promise.all(files.map(async file => {
            const filePath = path.resolve(file)
            const done = new Promise(resolve => pending.set(filePath, resolve))
            this.lsp.sendNotification('textDocument/didOpen', {
                textDocument: {
                    uri: `file://${filePath}`,
                    text: await readFile(file, 'utf8'),
                    languageId: detectLanguage(filePath),
                    version: 1
                }
            })

            // Never block forever: if diagnostics never arrive for this file,
            // warn and move on so one file cannot freeze the whole batch.
            let timer
            const timeout = new Promise(resolve => {
                timer = setTimeout(() => {
                    console.error(`Warning: analysis timed out for ${file}`)
                    resolve()
                }, ANALYSIS_TIMEOUT_MS)
            })
            await Promise.race([done, timeout])
            clearTimeout(timer)
        }))
    }

    listRules() { return this.rules }
    stop() { return this.lsp.stop() }
}

export { SonarLintClient }
