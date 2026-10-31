#!/usr/bin/env node
/**
 * End-to-end verification for the sub2api path this plugin depends on.
 *
 * Run this BEFORE mounting the plugin. It performs the exact call sequence the
 * provider performs at runtime, then optionally sends one real relay request:
 *
 *   login → GET /api/v1/groups/available → GET /api/v1/keys
 *         → POST /api/v1/keys (only when no key is bound to the group)
 *         → GET /v1/models  (proves the key)
 *         → POST /v1/messages (proves the relay, unless --dry-run)
 *
 * Usage:
 *   SUB2API_ORIGIN=https://sub2api.example.com \
 *   SUB2API_EMAIL=me@example.com SUB2API_PASSWORD=... \
 *   SUB2API_GROUP=12 node scripts/verify.mjs
 *
 * Flags:
 *   --group <id>      route group (or SUB2API_GROUP)
 *   --model <id>      relay model (default: first entry of GET /v1/models)
 *   --dry-run         stop after the key is proven; do not spend a request
 *   --json            machine-readable output
 *   --token <jwt>     skip login with an existing access token
 *   --help
 */

const ORIGIN = (process.env.SUB2API_ORIGIN ?? '').replace(/\/+$/, '')

function parseArgs(argv) {
  const out = { dryRun: false, json: false }
  for (let i = 0; i < argv.length; i += 1) {
    const flag = argv[i]
    if (flag === '--dry-run') out.dryRun = true
    else if (flag === '--json') out.json = true
    else if (flag === '--help' || flag === '-h') out.help = true
    else if (flag === '--group') out.group = argv[++i]
    else if (flag === '--model') out.model = argv[++i]
    else if (flag === '--token') out.token = argv[++i]
    else throw new Error(`unknown argument: ${flag}`)
  }
  return out
}

function usage() {
  console.log(`Usage: SUB2API_ORIGIN=... SUB2API_EMAIL=... SUB2API_PASSWORD=... node scripts/verify.mjs [--group N] [--model M] [--dry-run] [--json] [--token JWT]`)
}

async function call(path, { method = 'GET', token, body, idempotencyKey, raw = false } = {}) {
  const headers = { accept: 'application/json' }
  if (body !== undefined) headers['content-type'] = 'application/json'
  if (token !== undefined) headers.authorization = `Bearer ${token}`
  if (idempotencyKey !== undefined) headers['idempotency-key'] = idempotencyKey

  const response = await fetch(`${ORIGIN}${path}`, {
    method,
    headers,
    body: body === undefined ? undefined : JSON.stringify(body),
    signal: AbortSignal.timeout(30_000),
  })
  const text = await response.text()
  let payload
  try {
    payload = text.length === 0 ? {} : JSON.parse(text)
  } catch {
    throw new Error(`${method} ${path} -> non-JSON (${response.status}): ${text.slice(0, 200)}`)
  }
  if (raw) {
    if (!response.ok) throw new Error(`${method} ${path} -> ${response.status}: ${JSON.stringify(payload).slice(0, 300)}`)
    return payload
  }
  if (!response.ok || (typeof payload.code === 'number' && payload.code !== 0)) {
    const message = payload.message ?? response.statusText
    const hint = response.status === 404
      ? '\n  hint: a deployment in backend mode disables all non-admin panel APIs; check GET /api/v1/settings/public'
      : response.status === 401
        ? '\n  hint: wrong credentials, or the token expired'
        : ''
    throw new Error(`${method} ${path} -> ${response.status}: ${message}${hint}`)
  }
  return payload.data
}

function log(step, detail) {
  if (json) return
  console.log(`${step.padEnd(28)} ${detail}`)
}

let json = false

async function main() {
  const args = parseArgs(process.argv.slice(2))
  json = args.json
  if (args.help) return usage()
  if (ORIGIN.length === 0) throw new Error('SUB2API_ORIGIN is required')

  const groupId = Number(args.group ?? process.env.SUB2API_GROUP ?? NaN)
  if (!Number.isInteger(groupId)) throw new Error('route group is required (--group or SUB2API_GROUP)')

  const started = Date.now()

  // 0. Is the panel even serving user APIs?
  const settings = await call('/api/v1/settings/public')
  log('panel settings', `ok (${Object.keys(settings ?? {}).length} keys)`)

  // 1. Login (or reuse a token).
  let accessToken = args.token ?? process.env.SUB2API_TOKEN
  if (accessToken === undefined) {
    const email = process.env.SUB2API_EMAIL
    const password = process.env.SUB2API_PASSWORD
    if (!email || !password) throw new Error('SUB2API_EMAIL / SUB2API_PASSWORD, or --token, is required')
    const pair = await call('/api/v1/auth/login', { method: 'POST', body: { email, password } })
    if (pair?.requires_2fa) {
      throw new Error('this account requires 2FA; sign in through the panel and pass --token')
    }
    if (pair?.temp_token) throw new Error('this deployment requires an extra login step (2FA)')
    accessToken = pair.access_token
    log('login', `ok (access token ${String(accessToken).slice(0, 8)}…, expires in ${pair.expires_in}s)`)
  } else {
    log('login', 'skipped (reusing a supplied token)')
  }

  // 2. Route groups the account may use.
  const groups = await call('/api/v1/groups/available', { token: accessToken })
  if (!Array.isArray(groups) || groups.length === 0) {
    throw new Error('no route group is available to this account; ask the operator for a subscription')
  }
  const group = groups.find((row) => Number(row.id) === groupId)
  if (group === undefined) {
    throw new Error(
      `group ${groupId} is not available; offered: ${groups.map((g) => `${g.id}:${g.name ?? ''}`).join(', ')}`,
    )
  }
  log('route group', `${group.id} ${group.name ?? ''} (of ${groups.length})`)

  // 3. Reuse a key bound to the group, or mint one.
  const keys = await call('/api/v1/keys', { token: accessToken })
  const usable = (Array.isArray(keys) ? keys : []).find(
    (row) =>
      Number(row.group_id) === groupId &&
      row.status === 'active' &&
      (row.expires_at == null || Date.parse(row.expires_at) > Date.now()),
  )
  let relayKey = usable?.key
  if (relayKey === undefined) {
    const name = `dsh-router-verify-${Date.now()}`
    const minted = await call('/api/v1/keys', {
      method: 'POST',
      token: accessToken,
      idempotencyKey: `verify-${name}`,
      body: { name, group_id: groupId, expires_in_days: 1 },
    })
    relayKey = minted.key
    log('relay key', `minted ${minted.id} (${String(relayKey).slice(0, 6)}…)`)
  } else {
    log('relay key', `reused ${usable.id} (${String(relayKey).slice(0, 6)}…)`)
  }

  // 4. Prove the key against the relay catalogue.
  const catalogue = await call('/v1/models', { token: relayKey, raw: true })
  const models = (Array.isArray(catalogue) ? catalogue : (catalogue.data ?? []))
    .map((row) => row?.id)
    .filter((id) => typeof id === 'string')
  if (models.length === 0) throw new Error('the relay returned no models for this key')
  log('relay catalogue', `${models.length} models (${models.slice(0, 3).join(', ')}…)`)

  if (args.dryRun) {
    log('done', `dry run, ${Date.now() - started} ms`)
    if (json) console.log(JSON.stringify({ ok: true, groupId, models: models.length, dryRun: true }))
    return
  }

  // 5. One real request through the relay, in the dialect Claude Code uses.
  const model = args.model ?? models[0]
  const body = {
    model,
    max_tokens: 16,
    messages: [{ role: 'user', content: 'Reply with the single word: ok' }],
  }
  const relayed = await fetch(`${ORIGIN}/v1/messages`, {
    method: 'POST',
    headers: {
      'content-type': 'application/json',
      'x-api-key': relayKey,
      'anthropic-version': '2023-06-01',
    },
    body: JSON.stringify(body),
    signal: AbortSignal.timeout(60_000),
  })
  const relayText = await relayResponse(relayed)
  if (!relayed.ok) {
    throw new Error(`POST /v1/messages -> ${relayed.status}: ${relayText.slice(0, 300)}`)
  }
  log('relay /v1/messages', `ok, model ${model}, ${Date.now() - started} ms in total`)

  if (json) {
    console.log(JSON.stringify({ ok: true, groupId, model, models: models.length, sample: relayText.slice(0, 200) }))
  } else {
    console.log('\nSample answer:', relayText.slice(0, 200))
    console.log('\nNow mount the plugin with:')
    console.log(`  endpoint: ${ORIGIN}\n  groupId: ${groupId}\n  model: ${model}`)
  }
}

async function relayResponse(response) {
  const text = await response.text()
  try {
    const parsed = JSON.parse(text)
    const block = Array.isArray(parsed.content)
      ? parsed.content.filter((part) => part?.type === 'text').map((part) => part.text).join('')
      : ''
    return block.length > 0 ? block : text
  } catch {
    return text
  }
}

main().catch((error) => {
  console.error(`\n✗ ${error instanceof Error ? error.message : String(error)}`)
  process.exitCode = 1
})
