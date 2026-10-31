/**
 * The short-lived half: the relay key for one route group.
 *
 * Keys are cached in memory only. A relay key is revocable upstream, so a
 * durable copy buys nothing and costs a leak surface; the TTL bounds how long
 * a revocation takes to reach this process.
 *
 * Every key that enters the cache is first proven against `GET /v1/models`,
 * which the relay authenticates with the key itself. That turns "the key was
 * revoked overnight" into one clear failure at the boundary instead of an
 * opaque child error.
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
  /** Prove a key before handing it to a child. */
  readonly preflight: boolean
}

interface Cached {
  readonly key: string
  readonly keyId: number
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
   * Order: a live cached key, then an existing key bound to the group, then a
   * freshly minted key named after this host so it can be revoked without
   * touching the user's other keys.
   */
  async keyFor(accessToken: string): Promise<{ key: string; keyId: number }> {
    const groupId = this.options.groupId
    const cached = this.cache.get(groupId)
    if (cached !== undefined && Date.now() - cached.at < this.options.ttlMs) {
      return { key: cached.key, keyId: cached.keyId }
    }

    const keys = await api.listKeys(this.options.endpoint, accessToken)
    const usable = keys.find(
      (row) =>
        row.groupId === groupId &&
        row.status === 'active' &&
        (row.expiresAt === null || Date.parse(row.expiresAt) > Date.now()),
    )
    if (usable !== undefined && (await this.verify(usable.key))) {
      this.cache.set(groupId, { key: usable.key, keyId: usable.id, at: Date.now() })
      return { key: usable.key, keyId: usable.id }
    }

    const minted = await api.createKey(this.options.endpoint, accessToken, {
      name: `dsh-router-${hostname()}-${String(groupId)}`,
      groupId,
      ...(this.options.mintExpiresInDays === undefined
        ? {}
        : { expiresInDays: this.options.mintExpiresInDays }),
    })
    if (!(await this.verify(minted.key))) {
      throw new Error(
        `dsh-router: a freshly minted key for group ${String(groupId)} was rejected by the relay`,
      )
    }
    this.cache.set(groupId, { key: minted.key, keyId: minted.id, at: Date.now() })
    this.ctx.logger.info('dsh-router: minted relay key %d for group %d', minted.id, groupId)
    return { key: minted.key, keyId: minted.id }
  }

  /** `GET /v1/models` is authenticated by the relay key itself. */
  private async verify(key: string): Promise<boolean> {
    if (!this.options.preflight) return true
    try {
      const models = await api.listModels(this.options.endpoint, key)
      this.ctx.logger.debug('dsh-router: relay accepted the key (%d models)', models.length)
      return true
    } catch (error) {
      this.ctx.logger.warn('dsh-router: relay rejected a key: %s', String(error))
      return false
    }
  }
}

function hostname(): string {
  try {
    return process.env.HOSTNAME ?? process.env.COMPUTERNAME ?? 'local'
  } catch {
    return 'local'
  }
}
