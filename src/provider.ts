/**
 * The subagent provider.
 *
 * A provider is the only seam that can vary a child's environment per run, so
 * this is where "fetch a route-group key, then start the child" happens. The
 * shipped `subagent-claude-code` provider takes `env` as static plugin config
 * and therefore cannot do it — that is the whole reason this package exists.
 *
 * Transport: Claude Code in print mode over `--output-format stream-json`.
 * That is a deliberate choice over the official Agent SDK: it keeps this
 * package free of the SDK's own bundling and spawn hooks, and it is the same
 * shape the repository's own OAR runtime drives ("OAR drives claude in print
 * mode over stream-json already"). Swapping in the SDK is a one-file change.
 */

import { randomUUID } from 'node:crypto'
import type { Context } from '@deepseek-ai/cordis'
import type {
  ResolvedSubagentStartRequest,
  SubagentProvider,
  SubagentResult,
  SubagentRun,
} from '@deepseek-ai/dsh-subagent'
import type { RouterAccount } from './account.ts'
import type { KeyBroker } from './broker.ts'

export interface RouterProviderOptions {
  readonly name: string
  readonly account: RouterAccount
  readonly broker: KeyBroker
  /** Executable to spawn, default `claude`. */
  readonly command: string
  /** Extra argv appended after the managed flags. */
  readonly extraArgs: readonly string[]
  readonly model: string | undefined
  readonly permissionMode: string
  /** Environment names the child reads: the relay base URL and the key. */
  readonly baseUrlEnv: string
  readonly keyEnv: string
  /** Extra environment entries layered after the injected pair. */
  readonly env: Readonly<Record<string, string>>
  readonly graceMs: number
}

/** Diagnostics are bounded and scrubbed; keep the tail of stderr only. */
const STDERR_TAIL_BYTES = 8 * 1024

const SECRET_SHAPE = /(sk-[A-Za-z0-9_-]{8,}|Bearer\s+[A-Za-z0-9._-]{8,})/g

export class RouterProvider implements SubagentProvider {
  readonly name: string
  readonly capabilities = {
    agentOptions: false,
    agentPreset: false,
    outputSchema: false,
    depthLimit: true,
  } as const
  readonly inheritsParentContext = false

  constructor(
    private readonly ctx: Context,
    private readonly options: RouterProviderOptions,
  ) {
    this.name = options.name
  }

  async start(request: ResolvedSubagentStartRequest): Promise<SubagentRun> {
    // Resolve both halves per run. Any failure here is fatal for this run: a
    // child must never start without the credential it was configured for.
    const accessToken = await this.options.account.accessToken()
    const { key } = await this.options.broker.keyFor(accessToken)

    const env: NodeJS.ProcessEnv = {
      [this.options.baseUrlEnv]: this.options.account.endpoint,
      [this.options.keyEnv]: key,
      ...(this.options.model === undefined ? {} : { ANTHROPIC_MODEL: this.options.model }),
      ...this.options.env,
    }

    const prompt = request.prompt
      .filter((block): block is { type: 'text'; text: string } => block.type === 'text')
      .map((block) => block.text)
      .join('\n\n')
    if (prompt.trim().length === 0) {
      throw new Error('dsh-router: refusing to start a child with an empty textual task')
    }

    const argv = [
      this.options.command,
      '-p',
      prompt,
      '--output-format',
      'stream-json',
      '--verbose',
      '--permission-mode',
      this.options.permissionMode,
      ...(this.options.model === undefined ? [] : ['--model', this.options.model]),
      ...this.options.extraArgs,
    ]

    const handle = this.ctx.subprocess.spawn({
      argv,
      cwd: request.cwd,
      env,
      graceMs: this.options.graceMs,
      stdio: { stdin: 'ignore', stdout: 'pipe', stderr: 'pipe' },
    })

    const id = randomUUID() as SubagentRun['id']
    const result = this.collect(handle, key)
    return {
      id,
      result,
      dispose: async () => {
        handle.terminate()
        await handle.waitForExit()
      },
    }
  }

  /** Fold the child's NDJSON stream into one terminal result. */
  private async collect(
    handle: ReturnType<Context['subprocess']['spawn']>,
    secret: string,
  ): Promise<SubagentResult> {
    let answer = ''
    let diagnostic = ''
    let terminal = false
    let buffer = ''

    const scrub = (text: string): string =>
      text.replace(SECRET_SHAPE, '[redacted]').split(secret).join('[redacted]')

    handle.stdout?.setEncoding('utf8')
    handle.stdout?.on('data', (chunk: string) => {
      buffer += chunk
      let index = buffer.indexOf('\n')
      while (index !== -1) {
        const line = buffer.slice(0, index).trim()
        buffer = buffer.slice(index + 1)
        index = buffer.indexOf('\n')
        if (line.length === 0) continue
        let frame: Record<string, unknown>
        try {
          frame = JSON.parse(line) as Record<string, unknown>
        } catch {
          continue // non-JSON banner lines are not part of the contract
        }
        if (frame['type'] !== 'result') continue
        terminal = true
        if (frame['is_error'] === true || frame['subtype'] !== 'success') {
          diagnostic = scrub(String(frame['result'] ?? frame['subtype'] ?? 'child reported failure'))
        } else {
          answer = String(frame['result'] ?? '')
        }
      }
    })

    let stderr = ''
    handle.stderr?.setEncoding('utf8')
    handle.stderr?.on('data', (chunk: string) => {
      stderr = (stderr + chunk).slice(-STDERR_TAIL_BYTES)
    })

    const outcome = await handle.done
    if (stderr.length > 0) {
      this.ctx.logger.debug('dsh-router: child stderr tail: %s', scrub(stderr))
    }

    if (!terminal) {
      return {
        output: [],
        stopReason: 'error',
        diagnostic: scrub(
          `child exited (${String(outcome.exitCode ?? outcome.signal)}) without a result frame`,
        ),
      }
    }
    if (diagnostic.length > 0) {
      return { output: [], stopReason: 'error', diagnostic: diagnostic.slice(0, 4096) }
    }
    if (answer.trim().length === 0) {
      return { output: [], stopReason: 'error', diagnostic: 'child reported success with no text' }
    }
    return {
      output: [{ type: 'text', text: answer }] as SubagentResult['output'],
      stopReason: 'completed',
    }
  }
}
