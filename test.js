#!/usr/bin/env node

import { spawn } from 'node:child_process'
import { strictEqual, ok } from 'node:assert'
import { test } from 'node:test'

const run = (args) => {
    return new Promise((resolve, reject) => {
        const proc = spawn('node', ['cli.js', ...args], { stdio: ['pipe', 'pipe', 'pipe'] })
        let stdout = ''
        let stderr = ''
        proc.stdout.on('data', d => stdout += d)
        proc.stderr.on('data', d => stderr += d)
        proc.on('close', code => resolve({ code, stdout, stderr }))
        proc.on('error', reject)
    })
}

test('--help shows usage', async () => {
    const { code, stdout } = await run(['--help'])
    strictEqual(code, 0)
    ok(stdout.includes('Usage:'))
    ok(stdout.includes('--disable-rules'))
    ok(stdout.includes('--list-rules'))
})

test('--list-rules returns rules', async () => {
    const { code, stdout } = await run(['--list-rules'])
    strictEqual(code, 0)
    ok(stdout.includes('javascript:'))
    ok(stdout.includes('typescript:'))
    // should have many rules
    ok(stdout.split('\n').length > 100)
})

test('analyzes file and finds issues', async () => {
    const { code, stdout } = await run(['test-samples/test-simple.js'])
    strictEqual(code, 1, 'should exit 1 when issues found')
    ok(stdout.includes('javascript:S3504'), 'should find var usage issue')
    ok(stdout.includes('test-simple.js:1:1'), 'should include file location')
})

test('analyzes multiple files', async () => {
    const { code, stdout } = await run(['test-samples/test-simple.js', 'test-samples/test-issues.js'])
    strictEqual(code, 1)
    ok(stdout.includes('test-simple.js'))
    ok(stdout.includes('test-issues.js'))
})

test('--disable-rules excludes specified rules', async () => {
    const { code, stdout } = await run(['--disable-rules', 'javascript:S3504', 'test-samples/test-simple.js'])
    strictEqual(code, 0, 'should exit 0 when no issues after disabling rule')
    ok(!stdout.includes('S3504'), 'should not report disabled rule')
})

test('--disable-rules with multiple rules', async () => {
    const { code, stdout } = await run([
        '--disable-rules', 'javascript:S3504,javascript:S108,javascript:S2589',
        'test-samples/test-issues.js'
    ])
    strictEqual(code, 0, 'should exit 0 when all triggered rules are disabled')
})

test('exits 1 with no files specified', async () => {
    const { code, stderr } = await run([])
    strictEqual(code, 1)
    ok(stderr.includes('No files specified'))
})

test('handles non-existent file', async () => {
    const { code, stderr } = await run(['nonexistent.js'])
    strictEqual(code, 1)
})
