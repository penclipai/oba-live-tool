import assert from 'node:assert/strict'
import { execFileSync } from 'node:child_process'
import fs from 'node:fs'
import path from 'node:path'
import test from 'node:test'
import vm from 'node:vm'

const root = path.resolve(import.meta.dirname, '..')
const sourceFile = path.join(root, 'scripts', 'test-video-box-stability.mjs')
const source = fs.readFileSync(sourceFile, 'utf8')

function functionSource(name) {
  const start = source.indexOf(`function ${name}(`)
  assert.notEqual(start, -1, `${name} must remain in the soak harness`)
  const body = source.indexOf('{', start)
  let depth = 0
  for (let index = body; index < source.length; index++) {
    if (source[index] === '{') depth++
    if (source[index] === '}' && --depth === 0) return source.slice(start, index + 1)
  }
  throw new Error(`could not extract ${name}`)
}

function tree(identities, processes) {
  const context = vm.createContext({ ownedIdentities: identities, Date, Set })
  context.input = { processes }
  new vm.Script(
    `${functionSource('creationTime')}; ${functionSource('hasSameCreationTime')}; ${functionSource('relayTree')}; globalThis.result = relayTree(input)`,
  ).runInContext(context)
  return context.result
}

const at = seconds => `2026-01-01T00:00:${String(seconds).padStart(2, '0')}.0000000+00:00`
const cimAt = seconds => `2026-01-01T08:00:${String(seconds).padStart(2, '0')}.000000+08:00`
const makeProcess = (ProcessId, ParentProcessId, CreationDate, Name = 'video-box.exe') => ({
  ProcessId,
  ParentProcessId,
  CreationDate,
  Name,
})

test('relayTree keeps only creation-matched roots and causally newer descendants', () => {
  const identities = [{ label: 'video-box', ProcessId: 100, CreationDate: at(10) }]
  const processes = [
    makeProcess(100, 105, cimAt(10)),
    makeProcess(101, 100, cimAt(10), 'ffmpeg.exe'),
    makeProcess(102, 101, cimAt(11), 'child.exe'),
    makeProcess(21556, 100, cimAt(1), 'EMDriverAssist.exe'),
    makeProcess(103, 102, cimAt(9), 'older-than-parent.exe'),
    makeProcess(104, 100, 'not-a-date', 'invalid-child.exe'),
    makeProcess(105, 100, cimAt(12), 'cycle-a.exe'),
  ]

  assert.deepEqual(
    tree(identities, processes).map(item => item.ProcessId),
    [100, 101, 102, 105],
  )
  assert.deepEqual(
    tree([{ label: 'video-box', ProcessId: 100, CreationDate: at(20) }], processes),
    [],
  )
})

test('ownership command keeps the root identity payload and checks every BFS edge', () => {
  const commandMatch = /const command = `([^`]+Get-CimInstance Win32_Process[^`]+)`/.exec(source)
  assert.ok(commandMatch, 'processMetrics must use the Windows CIM process inventory command')
  const command = commandMatch[1]

  assert.match(command, /FromBase64String\('\$\{rootPayload\}'\)/)
  assert.match(command, /\$child.ParentProcessId -eq \$parent.ProcessId/)
  assert.match(command, /\$toUtcTicks=/)
  assert.match(command, /\$childCreated -ge \$parentCreated/)
  assert.match(command, /\$currentCreated -eq \$rootCreated/)
  assert.match(
    command,
    /CreationDate';Expression=\{\$_.CreationDate.ToUniversalTime\(\).ToString\('o'\)\}/,
  )
})

test('Windows PowerShell ownership BFS filters a synthetic CIM inventory', {
  skip: process.platform !== 'win32',
}, () => {
  const template = /const command = `([^`]+Get-CimInstance Win32_Process[^`]+)`/.exec(source)?.[1]
  assert.ok(template, 'processMetrics command template must be present')

  const run = (roots, inventory) => {
    const rootPayload = Buffer.from(JSON.stringify(roots)).toString('base64')
    const fixturePayload = Buffer.from(JSON.stringify(inventory)).toString('base64')
    const rootPayloadPlaceholder = '$' + '{rootPayload}'
    const command = `$fixture=([Text.Encoding]::UTF8.GetString([Convert]::FromBase64String('${fixturePayload}'))|ConvertFrom-Json); $fixture|%{$_.CreationDate=[datetime]$_.CreationDate}; ${template
      .replace(rootPayloadPlaceholder, rootPayload)
      .replace('$all=@(Get-CimInstance Win32_Process)', '$all=@($fixture)')}`
    const stdout = execFileSync('powershell.exe', ['-NoProfile', '-Command', command], {
      encoding: 'utf8',
      windowsHide: true,
      stdio: ['ignore', 'pipe', 'pipe'],
    })
    const parsed = JSON.parse(stdout.trim() || '[]')
    return Array.isArray(parsed) ? parsed : [parsed]
  }

  const roots = [{ label: 'video-box', ProcessId: 100, CreationDate: at(10) }]
  const inventory = [
    makeProcess(100, 105, cimAt(10)),
    makeProcess(101, 100, cimAt(10), 'ffmpeg.exe'),
    makeProcess(102, 101, cimAt(11), 'grandchild.exe'),
    makeProcess(103, 102, cimAt(9), 'older-grandchild.exe'),
    makeProcess(105, 100, cimAt(12), 'cycle.exe'),
    makeProcess(21556, 100, cimAt(1), 'EMDriverAssist.exe'),
  ]
  assert.deepEqual(
    run(roots, inventory).map(item => item.ProcessId),
    [100, 101, 102, 105],
  )
  assert.deepEqual(run([{ ...roots[0], CreationDate: at(20) }], inventory), [])
  assert.deepEqual(run([], inventory), [])
  assert.deepEqual(run([{ ...roots[0], CreationDate: 'invalid-date' }], inventory), [])
})
