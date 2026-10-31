#!/usr/bin/env node
/**
 * Place this package inside a DeepSeek Harness checkout as
 * `packages/router/dsh-router`, which `pnpm-workspace.yaml` already covers
 * (`packages/* /*`), and rewrite its DSH dependencies to `workspace:*` so pnpm
 * links the local packages instead of the published rc versions.
 *
 * Usage:
 *   node scripts/link-into-dsh.mjs /path/to/deepseek-harness [--link] [--force]
 *
 *   --link   symlink instead of copying (live edits, no rebuild of the copy)
 *   --force  replace an existing packages/router/dsh-router
 */

import { cp, lstat, readFile, readdir, rm, symlink, writeFile } from 'node:fs/promises'
import { existsSync } from 'node:fs'
import path from 'node:path'
import process from 'node:process'
import { fileURLToPath } from 'node:url'

const here = path.dirname(path.dirname(fileURLToPath(import.meta.url)))
const argv = process.argv.slice(2)
const flags = new Set(argv.filter((a) => a.startsWith('--')))
const target = argv.find((a) => !a.startsWith('--'))

if (target === undefined) {
  console.error('usage: node scripts/link-into-dsh.mjs /path/to/deepseek-harness [--link] [--force]')
  process.exit(64)
}

const root = path.resolve(target)
if (!existsSync(path.join(root, 'pnpm-workspace.yaml'))) {
  console.error(`✗ ${root} does not look like a deepseek-harness checkout (no pnpm-workspace.yaml)`)
  process.exit(1)
}
if (!existsSync(path.join(root, 'packages'))) {
  console.error(`✗ ${root}/packages is missing`)
  process.exit(1)
}

const workspace = await readFile(path.join(root, 'pnpm-workspace.yaml'), 'utf8')
if (!workspace.includes('packages/*/*')) {
  console.error(
    '✗ pnpm-workspace.yaml does not cover `packages/*/*`; add it before placing the package',
  )
  process.exit(1)
}

const destination = path.join(root, 'packages', 'router', 'dsh-router')
if (existsSync(destination)) {
  if (!flags.has('--force')) {
    console.error(`✗ ${destination} already exists; pass --force to replace it`)
    process.exit(1)
  }
  const stat = await lstat(destination)
  if (!stat.isSymbolicLink()) await rm(destination, { recursive: true, force: true })
  else await rm(destination, { force: true })
}

// The package must not drag its own lib/ and node_modules into the checkout.
const skip = new Set(['node_modules', 'lib', '.git'])
async function copy(from, to) {
  await cp(from, to, {
    recursive: true,
    filter: (source) => {
      const rel = path.relative(here, source)
      return !rel.split(path.sep).some((segment) => skip.has(segment))
    },
  })
}

if (flags.has('--link')) {
  await symlink(here, destination, 'dir')
  console.error(`→ symlinked ${destination} -> ${here}`)
} else {
  await copy(here, destination)
  console.error(`→ copied into ${destination}`)
}

// Rewrite DSH dependencies to workspace ranges so the local packages win.
const manifestPath = path.join(destination, 'package.json')
const manifest = JSON.parse(await readFile(manifestPath, 'utf8'))
const DSH = /^@deepseek-ai\//
let rewritten = 0
for (const section of ['dependencies', 'peerDependencies', 'devDependencies']) {
  const table = manifest[section]
  if (table === undefined) continue
  for (const name of Object.keys(table)) {
    if (!DSH.test(name) || table[name] === 'workspace:*') continue
    table[name] = 'workspace:*'
    rewritten += 1
  }
}
const vendor = { '@deepseek-ai/schemastery': 'workspace:~' }
manifest.dependencies = { ...(manifest.dependencies ?? {}), ...vendor }
await writeFile(manifestPath, `${JSON.stringify(manifest, null, 2)}\n`)
console.error(`→ rewrote ${rewritten} dsh dependency ranges to workspace:*`)

// Sanity: the package publishes two halves plus the bundle patch.
const files = await readdir(destination)
for (const required of ['cordis.patch.yml', 'package.json', 'src']) {
  if (!files.includes(required)) {
    console.error(`✗ staged package is missing ${required}`)
    process.exit(1)
  }
}

console.log(`
next:
  cd ${root}
  pnpm install
  pnpm run build

  then add a profile patch (for example
  ${path.join('$DSH_HOME', 'profiles', 'web', 'cordis.patch.yml')}):

    - id: subagent-router
      name: '@tokenaissance/dsh-router'
      config:
        endpoint: https://sub2api.example.com
        groupId: 12

  and check it composed:
    dsh --profile web --dump-config | grep -A5 subagent-router
`)
