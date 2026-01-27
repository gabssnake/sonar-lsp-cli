import { spawn } from 'node:child_process'
import { readFile, appendFile } from 'node:fs/promises'
import path from 'node:path'

class LSPClient {
    constructor(debug = false) {
        this.debug = debug
        this.process = null
        this.messageId = 0
        this.buffer = ''
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

    handleData(data) {
        this.buffer += data.toString()
        this.log('recv', data.toString().trim())

        // LSP header can include Content-Type after Content-Length
        let match
        while ((match = this.buffer.match(/Content-Length: (\d+)\r\n(?:[^\r]*\r\n)*\r\n/))) {
            const length = parseInt(match[1])
            const start = match.index + match[0].length

            if (this.buffer.length < start + length) break

            const content = this.buffer.slice(start, start + length)
            this.buffer = this.buffer.slice(start + length)

            try {
                const message = JSON.parse(content)
                if (message.id && this.responseHandlers.has(message.id)) {
                    const { resolve, reject } = this.responseHandlers.get(message.id)
                    this.responseHandlers.delete(message.id)
                    message.error ? reject(new Error(message.error.message)) : resolve(message.result)
                } else if (message.method) {
                    const handler = message.id ? this.requestHandlers.get(message.method) : this.notificationHandlers.get(message.method)
                    if (handler) {
                        const result = handler(message.params)
                        if (message.id) this.send({ jsonrpc: '2.0', id: message.id, result })
                    }
                }
            } catch (e) {
                this.log('parse-error', `${e.message}: ${content.slice(0, 100)}`)
            }
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
                    languageId: 'javascript',
                    version: 1
                }
            })
            await done
        }))
    }

    listRules() { return this.rules }
    stop() { return this.lsp.stop() }
}

export { SonarLintClient }
