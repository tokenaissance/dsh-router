/**
 * The long-lived half of the credential pair: the sub2api login grant.
 *
 * It is stored as a `GrantRecord` — the credentials seam's owner-opaque record
 * shape — because a token pair plus its refresh state is exactly "the product
 * of one authorization grant, kept verbatim for its owner". `modifyRecord` is
 * the seam's only write path and it is a serialized read-modify-write, which is
 * what makes a refresh safe when two processes rotate at once.
 *
 * The relay key is deliberately NOT stored here: it is short-lived, revocable,
 * and only needed inside one run (see `broker.ts`).
 */

import type { Context } from '@deepseek-ai/cordis'
import { credentialKey } from '@deepseek-ai/dsh-credentials'
import * as api from './sub2api.ts'

/** Owner-defined payload of the stored grant. */
export interface AccountPayload {
  readonly access: string
  readonly refresh: string
  /** Epoch milliseconds when the pair was issued. */
  readonly issuedAt: number
  /** Lifetime in seconds. */
  readonly expiresIn: number
}

/** Refresh this long before the reported expiry. */
const REFRESH_MARGIN_MS = 60_000

export class RouterAccount {
  private readonly key = credentialKey('dsh-router', 'account')

  constructor(
    private readonly ctx: Context,
    readonly endpoint: string,
    /** Development-only access token; never persisted, always outranked by a login. */
    private readonly bootstrapToken: string | undefined = undefined,
  ) {}

  private get credentials() {
    return this.ctx.credentials
  }

  /** Store a fresh pair from an interactive login. */
  async remember(pair: api.TokenPair): Promise<void> {
    const payload: AccountPayload = {
      access: pair.accessToken,
      refresh: pair.refreshToken,
      issuedAt: Date.now(),
      expiresIn: pair.expiresIn,
    }
    await this.credentials.modifyRecord(this.key, async () => ({ kind: 'grant', payload }))
  }

  /** Whether a login is stored at all. Never returns the value. */
  async signedIn(): Promise<boolean> {
    if (this.bootstrapToken !== undefined) return true
    return (await this.credentials.describeRecord(this.key)).configured
  }

  async signOut(): Promise<void> {
    await this.credentials.deleteRecord(this.key)
  }

  /**
   * Resolve an access token for one run.
   *
   * Resolution is per call on purpose: a rotated or revoked grant must reach
   * the next run without a restart. A failure here is fatal for the run — the
   * provider never falls back to an unauthenticated child.
   */
  async accessToken(): Promise<string> {
    const record = await this.credentials.readRecord(this.key)
    if (record === undefined || record.kind !== 'grant') {
      if (this.bootstrapToken !== undefined) return this.bootstrapToken
      throw new Error('dsh-router: not signed in to sub2api')
    }
    const payload = record.payload as AccountPayload
    if (Date.now() < payload.issuedAt + payload.expiresIn * 1000 - REFRESH_MARGIN_MS) {
      return payload.access
    }
    if (payload.refresh.length === 0) {
      throw new Error('dsh-router: sub2api grant expired and carries no refresh token')
    }

    const next = await api.refresh(this.endpoint, payload.refresh)
    // Re-read under the seam's exclusion: another process may have rotated
    // first, and its pair is as good as ours.
    const written = await this.credentials.modifyRecord(this.key, async (current) => {
      const now = current?.kind === 'grant' ? (current.payload as AccountPayload) : undefined
      if (now !== undefined && now.access !== payload.access) return undefined
      return {
        kind: 'grant',
        payload: {
          access: next.accessToken,
          refresh: next.refreshToken.length === 0 ? payload.refresh : next.refreshToken,
          issuedAt: Date.now(),
          expiresIn: next.expiresIn,
        } satisfies AccountPayload,
      }
    })
    const settled = written?.kind === 'grant' ? (written.payload as AccountPayload) : undefined
    return settled?.access ?? next.accessToken
  }
}
