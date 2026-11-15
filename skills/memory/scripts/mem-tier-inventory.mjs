#!/usr/bin/env node
// Read-only, deterministic Markdown inventory. Run from the brain root:
// node mem-tier-inventory.mjs . [--check INVENTORY_OR_REPORT.md]
import { constants, openSync, closeSync, fstatSync, lstatSync, readdirSync, readFileSync } from 'node:fs'
import { resolve, join } from 'node:path'
import { pathToFileURL } from 'node:url'

const tiers = ['core', 'semantic', 'episodic', 'procedural']
const heading = '## Tier Inventory'

function optionalStat(path) {
  try { return lstatSync(path) } catch (error) {
    if (error.code === 'ENOENT') return null
    throw error
  }
}

function requireDirectory(path, info = lstatSync(path)) {
  if (!info.isDirectory() || info.isSymbolicLink()) throw new Error(`unsafe inventory directory: ${path}`)
}

export function tierInventory(brain) {
  const root = resolve(brain)
  requireDirectory(root)
  const memory = join(root, 'memory')
  requireDirectory(memory)
  const inventory = { version: 1, tiers: [], totalFiles: 0, totalBytes: 0 }
  for (const tier of tiers) {
    const directory = join(memory, tier)
    const info = optionalStat(directory)
    const files = []
    function scan(path, relative) {
      requireDirectory(path)
      for (const name of readdirSync(path).sort()) {
        const target = join(path, name)
        const file = `${relative}/${name}`
        const entry = lstatSync(target)
        if (entry.isSymbolicLink()) throw new Error(`symlink in tier inventory: ${file}`)
        if (entry.isDirectory()) scan(target, file)
        else if (!entry.isFile()) throw new Error(`unsupported tier inventory entry: ${file}`)
        else if (name.endsWith('.md')) {
          // Do not follow a file link substituted since lstat, or read a FIFO.
          const fd = openSync(target, constants.O_RDONLY | constants.O_NOFOLLOW | constants.O_NONBLOCK)
          try {
            if (!fstatSync(fd).isFile()) throw new Error(`unsafe inventory file: ${file}`)
            const bytes = readFileSync(fd)
            new TextDecoder('utf-8', { fatal: true }).decode(bytes)
            files.push({ path: file, bytes: bytes.length })
          } catch (error) {
            throw new Error(`cannot inventory ${file}: ${error.message}`)
          } finally { closeSync(fd) }
        }
      }
    }
    if (info) {
      requireDirectory(directory, info)
      scan(directory, tier)
    }
    // Sort whole relative paths, independent of directory creation order/locale.
    files.sort((a, b) => a.path < b.path ? -1 : a.path > b.path ? 1 : 0)
    const bytes = files.reduce((sum, file) => sum + file.bytes, 0)
    inventory.tiers.push({ tier, status: !info ? 'missing' : files.length ? 'present' : 'empty', count: files.length, bytes, files })
    inventory.totalFiles += files.length
    inventory.totalBytes += bytes
  }
  return inventory
}

export function renderInventory(brain) {
  return `${heading}\n\n\`\`\`json\n${JSON.stringify(tierInventory(brain), null, 2)}\n\`\`\`\n`
}

export function verifyInventory(brain, report) {
  const starts = [...report.matchAll(/^## Tier Inventory$/gm)]
  if (starts.length !== 1) throw new Error('expected exactly one ## Tier Inventory section')
  const section = report.slice(starts[0].index)
  const next = section.slice(heading.length).search(/^#{1,2} /m)
  const block = next < 0 ? section : section.slice(0, heading.length + next)
  if (block.trimEnd() !== renderInventory(brain).trimEnd()) throw new Error('tier inventory differs from current tier tree; regenerate and verify')
}

if (process.argv[1] && import.meta.url === pathToFileURL(resolve(process.argv[1])).href) {
  try {
    const [brain, flag, report, ...extra] = process.argv.slice(2)
    if (!brain || (flag !== undefined && (flag !== '--check' || !report)) || extra.length) {
      throw new Error('usage: node mem-tier-inventory.mjs BRAIN_DIR [--check INVENTORY_OR_REPORT.md]')
    }
    if (flag) verifyInventory(brain, readFileSync(report, 'utf8'))
    else process.stdout.write(renderInventory(brain))
  } catch (error) {
    console.error(`tier inventory failed: ${error.message}`)
    process.exitCode = 1
  }
}
