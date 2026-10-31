/**
 * dsh-router — route DeepSeek Harness subagents through sub2api.
 *
 * The plugin contributes one `ctx.subagents` provider. Sign in once (v0.1: a
 * bootstrap token from the environment; v0.2: the plugin page), then every
 * delegated run resolves a key for the configured route group and injects it
 * into the child process together with the relay base URL.
 *
 * Security posture, in one paragraph: the account grant lives in the
 * credentials seam as an owner-opaque record, the relay key lives only in
 * memory with a TTL, neither value ever enters session state or plugin
 * configuration, and a run that cannot obtain a key fails closed rather than
 * falling back to an unauthenticated child.
 */

import type { Context } from '@deepseek-ai/cordis'
import z from '@deepseek-ai/schemastery'
import { RouterAccount } from './account.ts'
import { KeyBroker } from './broker.ts'
import { RouterProvider } from './provider.ts'

export const name = 'dsh-router'
export const inject = ['subagents', 'credentials', 'subprocess']

export interface Config {
  /** sub2api origin, e.g. `https://sub2api.example.com`. */
  endpoint: string
  /** Route group the delegated runs bill against. */
  groupId: number
  /** Registered name on `ctx.subagents`. */
  providerName?: string
  /** Executable that speaks Claude Code's print/stream-json contract. */
  command?: string
  /** Extra argv appended after the managed flags. */
  args?: string[]
  /** Fixed upstream model; omitted inherits the child CLI's own default. */
  model?: string
  /** Non-interactive approval mode passed to the child. */
  permissionMode?: string
  /** Environment name carrying the relay key. */
  keyEnv?: string
  /** Environment name carrying the relay origin. */
  baseUrlEnv?: string
  /** Extra child environment entries, layered last. */
  env?: Record<string, string>
  /** How long one fetched relay key is reused. */
  keyTtlMs?: number
  /** Lifetime requested when this plugin mints its own key. */
  mintExpiresInDays?: number
  /** Grace before escalating child termination. */
  graceMs?: number
  /** Prove a fetched relay key against `GET /v1/models` before using it. */
  preflight?: boolean
  /**
   * Development escape hatch: the *name* of an environment variable holding a
   * sub2api access token. Never stored; a real login always wins.
   */
  bootstrapTokenEnv?: string
}

export const Config: z<Config> = z.object({
  endpoint: z.string().required(),
  groupId: z.number().required(),
  providerName: z.string().default('router'),
  command: z.string().default('claude'),
  args: z.array(z.string()).default([]),
  model: z.string(),
  permissionMode: z.string().default('dontAsk'),
  keyEnv: z.string().default('ANTHROPIC_AUTH_TOKEN'),
  baseUrlEnv: z.string().default('ANTHROPIC_BASE_URL'),
  env: z.dict(z.string()).default({}),
  keyTtlMs: z.number().default(5 * 60_000),
  mintExpiresInDays: z.number().default(30),
  graceMs: z.number().default(5_000),
  preflight: z.boolean().default(true),
  bootstrapTokenEnv: z.string(),
})

export function apply(ctx: Context, config: Config): void {
  const bootstrapToken =
    config.bootstrapTokenEnv === undefined
      ? undefined
      : process.env[config.bootstrapTokenEnv]

  const account = new RouterAccount(ctx, config.endpoint, bootstrapToken)
  const broker = new KeyBroker(ctx, {
    endpoint: config.endpoint,
    groupId: config.groupId,
    ttlMs: config.keyTtlMs ?? 5 * 60_000,
    mintExpiresInDays: config.mintExpiresInDays,
    preflight: config.preflight ?? true,
  })

  ctx.subagents.registerProvider(
    new RouterProvider(ctx, {
      name: config.providerName ?? 'router',
      account,
      broker,
      command: config.command ?? 'claude',
      extraArgs: config.args ?? [],
      model: config.model,
      permissionMode: config.permissionMode ?? 'dontAsk',
      baseUrlEnv: config.baseUrlEnv ?? 'ANTHROPIC_BASE_URL',
      keyEnv: config.keyEnv ?? 'ANTHROPIC_AUTH_TOKEN',
      env: config.env ?? {},
      graceMs: config.graceMs ?? 5_000,
    }),
  )

  if (bootstrapToken !== undefined) {
    ctx.logger.warn(
      'dsh-router: using a bootstrap token from %s; sign in for real before distributing this profile',
      config.bootstrapTokenEnv,
    )
  }
}
