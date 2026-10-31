/**
 * Minimal sub2api HTTP client.
 *
 * Contract verified against `Wei-Shaw/sub2api` (default branch `main`, 2026-10):
 *   POST /api/v1/auth/login          -> AuthResponse { access_token, refresh_token, expires_in }
 *   POST /api/v1/auth/refresh        -> same pair
 *   GET  /api/v1/groups/available    -> Group[]  (route groups the account may use)
 *   GET  /api/v1/keys                -> APIKey[] (includes the plaintext key)
 *   POST /api/v1/keys                -> APIKey   (send Idempotency-Key)
 *   GET  {origin}/v1/models          -> relay catalogue, authenticated by the key
 *   POST {origin}/v1/messages        -> the relay itself (Anthropic-shaped)
 *
 * The user key mount is `/api/v1/keys`; the `/api/v1/api-keys` string in some
 * handler doc comments is stale (the route is registered in routes/user.go).
 *
 * Every success is wrapped as `{ code: 0, message: "success", data }`; failures
 * use the HTTP status plus `{ code, message }`.
 */

export class Sub2ApiError extends Error {
  constructor(
    readonly stage: 'login' | 'refresh' | 'groups' | 'keys' | 'create-key' | 'transport',
    readonly status: number,
    message: string,
  ) {
    super(`sub2api ${stage} failed (${status}): ${message}`)
    this.name = 'Sub2ApiError'
  }
}

export interface TokenPair {
  readonly accessToken: string
  readonly refreshToken: string
  /** Lifetime in seconds as the server reports it. */
  readonly expiresIn: number
}

export interface RouteGroup {
  readonly id: number
  readonly name: string
  /** Server-side constraints, e.g. a group restricted to `/v1/messages`. */
  readonly raw: Readonly<Record<string, unknown>>
}

export interface ApiKeyRow {
  readonly id: number
  readonly key: string
  readonly groupId: number | null
  readonly status: string
  readonly expiresAt: string | null
  readonly raw: Readonly<Record<string, unknown>>
}

const REQUEST_TIMEOUT_MS = 15_000

function join(endpoint: string, path: string): string {
  return `${endpoint.replace(/\/+$/, '')}${path}`
}

function string(value: unknown, field: string): string {
  if (typeof value !== 'string' || value.length === 0) {
    throw new Sub2ApiError('transport', 0, `response is missing "${field}"`)
  }
  return value
}

function number(value: unknown, field: string): number {
  if (typeof value !== 'number' || !Number.isFinite(value)) {
    throw new Sub2ApiError('transport', 0, `response is missing "${field}"`)
  }
  return value
}

async function request(
  stage: Sub2ApiError['stage'],
  endpoint: string,
  path: string,
  init: {
    method: 'GET' | 'POST'
    token?: string | undefined
    body?: unknown
    idempotencyKey?: string | undefined
  },
): Promise<unknown> {
  const headers: Record<string, string> = { accept: 'application/json' }
  if (init.body !== undefined) headers['content-type'] = 'application/json'
  if (init.token !== undefined) headers.authorization = `Bearer ${init.token}`
  if (init.idempotencyKey !== undefined) headers['idempotency-key'] = init.idempotencyKey

  let response: Response
  try {
    response = await fetch(join(endpoint, path), {
      method: init.method,
      headers,
      body: init.body === undefined ? undefined : JSON.stringify(init.body),
      signal: AbortSignal.timeout(REQUEST_TIMEOUT_MS),
    })
  } catch (cause) {
    throw new Sub2ApiError(stage, 0, `network: ${String(cause)}`)
  }

  const text = await response.text()
  let payload: unknown
  try {
    payload = text.length === 0 ? {} : JSON.parse(text)
  } catch {
    throw new Sub2ApiError(stage, response.status, 'response is not JSON')
  }

  const envelope = payload as { code?: unknown; message?: unknown; data?: unknown }
  if (!response.ok || (typeof envelope.code === 'number' && envelope.code !== 0)) {
    const message = typeof envelope.message === 'string' ? envelope.message : response.statusText
    throw new Sub2ApiError(stage, response.status, message)
  }
  return envelope.data
}

function tokenPair(data: unknown): TokenPair {
  const row = data as Record<string, unknown>
  return {
    accessToken: string(row.access_token, 'access_token'),
    refreshToken: typeof row.refresh_token === 'string' ? row.refresh_token : '',
    expiresIn: typeof row.expires_in === 'number' ? row.expires_in : 0,
  }
}

export async function login(
  endpoint: string,
  credentials: { email: string; password: string },
): Promise<TokenPair> {
  const data = await request('login', endpoint, '/api/v1/auth/login', {
    method: 'POST',
    body: { email: credentials.email, password: credentials.password },
  })
  // A deployment with TOTP enabled answers { requires_2fa: true, temp_token }.
  if ((data as { requires_2fa?: unknown }).requires_2fa === true) {
    throw new Sub2ApiError('login', 200, 'this account requires 2FA; use a token bootstrap instead')
  }
  return tokenPair(data)
}

export async function refresh(endpoint: string, refreshToken: string): Promise<TokenPair> {
  const data = await request('refresh', endpoint, '/api/v1/auth/refresh', {
    method: 'POST',
    body: { refresh_token: refreshToken },
  })
  return tokenPair(data)
}

export async function listGroups(endpoint: string, token: string): Promise<RouteGroup[]> {
  const data = await request('groups', endpoint, '/api/v1/groups/available', { method: 'GET', token })
  if (!Array.isArray(data)) throw new Sub2ApiError('groups', 0, 'groups payload is not an array')
  return data.map((entry) => {
    const row = entry as Record<string, unknown>
    return {
      id: number(row.id, 'id'),
      name: typeof row.name === 'string' ? row.name : `group-${String(row.id)}`,
      raw: row,
    }
  })
}

export async function listKeys(endpoint: string, token: string): Promise<ApiKeyRow[]> {
  const data = await request('keys', endpoint, '/api/v1/keys', { method: 'GET', token })
  if (!Array.isArray(data)) throw new Sub2ApiError('keys', 0, 'keys payload is not an array')
  return data.map((entry) => {
    const row = entry as Record<string, unknown>
    return {
      id: number(row.id, 'id'),
      key: string(row.key, 'key'),
      groupId: typeof row.group_id === 'number' ? row.group_id : null,
      status: typeof row.status === 'string' ? row.status : 'unknown',
      expiresAt: typeof row.expires_at === 'string' ? row.expires_at : null,
      raw: row,
    }
  })
}

export async function createKey(
  endpoint: string,
  token: string,
  body: {
    name: string
    groupId: number
    expiresInDays?: number
    quota?: number
  },
): Promise<ApiKeyRow> {
  const data = await request('create-key', endpoint, '/api/v1/keys', {
    method: 'POST',
    token,
    // The route declares this header; the deployment may only observe it, but
    // sending it is always correct and makes a retry safe.
    idempotencyKey: `dsh-router-${body.name}-${String(body.groupId)}-${String(Date.now())}`,
    body: {
      name: body.name,
      group_id: body.groupId,
      ...(body.expiresInDays === undefined ? {} : { expires_in_days: body.expiresInDays }),
      ...(body.quota === undefined ? {} : { quota: body.quota }),
    },
  })
  const row = data as Record<string, unknown>
  return {
    id: number(row.id, 'id'),
    key: string(row.key, 'key'),
    groupId: typeof row.group_id === 'number' ? row.group_id : body.groupId,
    status: typeof row.status === 'string' ? row.status : 'active',
    expiresAt: typeof row.expires_at === 'string' ? row.expires_at : null,
    raw: row,
  }
}

/**
 * Probe the relay with one key. `GET /v1/models` is authenticated by the relay
 * key itself, so a 200 proves the key is live for its group before we ever
 * spawn a child.
 */
export async function listModels(endpoint: string, relayKey: string): Promise<string[]> {
  const data = await request('transport', endpoint, '/v1/models', {
    method: 'GET',
    token: relayKey,
  })
  const rows = Array.isArray(data) ? data : (data as { data?: unknown }).data
  if (!Array.isArray(rows)) return []
  return rows
    .map((row) => (row as { id?: unknown }).id)
    .filter((id): id is string => typeof id === 'string')
}

/**
 * Whether this deployment still serves the user panel at all. A deployment in
 * "backend mode" disables every non-admin panel API, login included, and the
 * only way to tell is this endpoint.
 */
export async function publicSettings(endpoint: string): Promise<Record<string, unknown>> {
  const data = await request('transport', endpoint, '/api/v1/settings/public', { method: 'GET' })
  return (data ?? {}) as Record<string, unknown>
}
