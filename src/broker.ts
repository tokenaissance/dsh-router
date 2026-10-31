/**
 * The short-lived half: the relay key for one route group.
 *
 * Keys are cached in memory only. A relay key is revocable upstream, so a
 * durable copy buys nothing and costs a leak surface; the TTL bounds how long
 * a revocation takes to reach this process.
 */

import type { Context } from '@deepseek-ai/cordis'
import * as api from './sub2api.ts'

export interface BrokerOptions {
  readonly endpoint: string
  readonly groupId: number
  /** How long one fetched key is reused, in milliseconds. */
  readonly ttlMs: number
  /** Lifetime requested when this plugin has to mint a key of its own. */
  readonly mintExpiresInDays?: number | undefined
}

interface Cached {
  readonly key: string
  readonly at: number
}

export class KeyBroker {
  private readonly cache = new Map<number, Cached>()

  constructor(
    private readonly ctx: Context,
    private readonly options: BrokerOptions,
  ) {}

  /** Drop one group's cached key, e.g. after the relay answered 401. */
  invalidate(groupId: number = this.options.groupId): void {
    this.cache.delete(groupId)
  }

  /**
   * Resolve a usable key for the configured group.
   *
   * Preference order: a live cached key, then an existing key bound to the
   * group, then a freshly minted key named after this host so it can be
   * revoked without touching the user's other keys.
   */
  async keyFor(accessToken: string): Promise<{ key: string; keyId: number }> {
    const groupId = this.options.groupId
    const cached = this.cache.get(groupId)
    if (cached !== undefined && Date.now() - cached.at < this.options.ttlMs) {
      return { key: cached.key, keyId: -1 }
    }

    const keys = await api.listKeys(this.options.endpoint, accessToken)
    const usable = keys.find(
      (row) =>
        row.groupId === groupId &&
        row.status === 'active' &&
        (row.expiresAt === null || Date.parse(row.expiresAt) > Date.now()),
    )
    if (usable !== undefined) {
      this.cache.set(groupId, { key: usable.key, at: Date.now() })
      return { key: usable.key, keyId: usable.id }
    }

    const minted = await api.createKey(this.options.endpoint, accessToken, {
      name: `dsh-router-${hostname()}-${String(groupId)}`,
      groupId,
      ...(this.options.mintExpiresInDays === undefined
        ? {}
        : { expiresInDays: this.options.mintExpiresInDays }),
    })
    this.cache.set(groupId, { key: minted.key, at: Date.now() })
    this.ctx.logger.info('dsh-router: minted relay key %d for group %d', minted.id, groupId)
    return { key: minted.key, keyId: minted.id }
  }
}

function hostname(): string {
  try {
    return process.env.HOSTNAME ?? process.env.COMPUTERNAME ?? 'local'
  } catch {
    return 'local'
  }
}
