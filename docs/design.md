# dsh-plugin-sub2api：登录 sub2api → 取路由组 Key → 注入子智能体

> 目标：在 DSH 的插件页登录 sub2api，之后每次开子智能体时，按目标 client 与路由组取一把 key，注入子进程环境，用来跑 Claude Code / Codex / 任意 ACP agent。
> 本文的每个外部端点都在 `Wei-Shaw/sub2api` 里核过，每个 DSH 接口都在本仓核过。

---

## 0. 为什么必须自己实现 provider（而不是改配置）

三件事叠加，把"配置注入"这条路堵死了：

1. 内置 provider 的 `env` 是**静态配置**：`subagent-claude-code/src/index.ts:47`、`subagent-codex/src/index.ts:44`，在插件构造时解析一次。
2. 子进程环境默认被**按名字擦除**：`subprocess/src/index.ts:47` 的 `SENSITIVE_ENV_PATTERN = /KEY|PASSWORD|SECRET|TOKEN/i`，所以 `ANTHROPIC_API_KEY` 这类名字只能靠显式 `env` 传。
3. 显式 `env` 又只存在于配置里。

⇒ 想让 key **每次 start 现取**，就必须自己实现 `SubagentProvider.start()`。

代价：需要一段 transport。Claude Code 用官方 SDK（`@anthropic-ai/claude-agent-sdk` 的 `query()`，`env` 是它的 `Options` 字段），Codex 用 app-server JSON-RPC（现成范例 `subagent-codex/src/wire.ts`，MIT 可拷）。ACP 则是 `subagent-acp/src/run.ts` 那 150 行。

---

## 1. sub2api 契约（已验证）

| 用途 | 调用 | 证据 |
|---|---|---|
| 登录 | `POST {origin}/api/v1/auth/login`，body `{ email, password }` → `{ access_token, refresh_token, expires_in, token_type:"Bearer", user }` | `backend/internal/handler/auth_handler.go:238`、`:118` |
| 刷新 | `POST {origin}/api/v1/auth/refresh` | `auth_handler.go:684` |
| 可用路由组 | `GET {origin}/api/v1/groups/available`（Bearer） | `api_key_handler.go:321` |
| 列出 Key | `GET {origin}/api/v1/keys`（Bearer）→ 含 **明文 key** 与 `group_id` | 路由 `routes/user.go`；`api_key_handler.go:105`、`dto/mappers.go:87` |
| 创建 Key | `POST {origin}/api/v1/keys`，body `{ name, group_id, expires_in_days, quota, custom_key, rate_limit_5h/1d/7d }`，需 `Idempotency-Key` | `api_key_handler.go:34`、`:181` |
| 探活 | `GET {origin}/v1/models`（用 relay key 认证） | relay 路由 |
| 中转调用 | `POST {origin}/v1/messages`（Anthropic 形态）· `/v1/chat/completions` · `/v1/responses` | `gateway_handler.go:124` |

> 修正：用户 key 的挂载点是 `/api/v1/keys`；`/api/v1/api-keys` 只出现在 handler 注释里，已过期。

两个必须注意的约束：

- **分组是有类型的**。`group.platform` 决定这个组能服务哪种客户端（anthropic / openai / gemini / grok / composite …）。有的分组只接受 `/v1/messages`（Claude Code 形态），代码里直接报 "This group is restricted to Claude Code clients (/v1/messages only)"（`gateway_handler_responses.go:117`）。所以"client × 分组"是一个配对，不是两个独立选项。未绑定分组的 key 会在中继处 403。
- **面板可能整体关闭**。部署开了 backend mode 时会禁用所有非 admin 面板 API（登录与建 key 一起失效）；上线前先查 `GET /api/v1/settings/public`。
- **登录可能撞验证码**。`Login` 里先 `VerifyCaptcha`（`auth_handler.go:247`），Deployment 开了 Turnstile/腾讯验证码时，纯密码登录会失败——插件页要么做验证码，要么引导用户改用 access token 登录。
- 2FA 走 `POST /api/v1/auth/login/2fa`，返回 `{ requires_2fa, temp_token }`。

---

## 2. 插件结构

```
dsh-plugin-sub2api/
├─ package.json          # dsh.bundle 指向 cordis.patch.yml；dsh.client 指向 ./client
├─ cordis.patch.yml      # 注册 provider 与 tool
└─ src/
   ├─ index.ts           # Cordis 插件：Config、装配、注册 provider
   ├─ sub2api.ts         # 纯 HTTP 客户端（登录/刷新/分组/取 key/建 key）
   ├─ account.ts         # token 落 ctx.credentials；刷新；登出
   ├─ broker.ts         # 路由组 → key 的内存缓存 + 失效重取
   ├─ provider.ts       # SubagentProvider.start()：组 env、spawn、返回 run
   ├─ controller.ts      # @Remote：给插件页的 login/status/logout/groups
   └─ client.tsx         # plugins.detail.section：登录表单 + 分组选择
```

一次运行的时序：

```
插件页登录 ──remote──▶ Sub2ApiController ──HTTP──▶ /auth/login
                              │
                              └─▶ credentials.modifyRecord('sub2api/account', …)   ← token 长期存

模型调用子智能体 ──▶ provider.start(req)
                        ├─ credentials.readRecord('sub2api/account')  → access_token
                        ├─ (401 时) /auth/refresh → 新 token 写回
                        ├─ broker.keyFor(groupId)  → GET /api/v1/api-keys 里挑/建
                        └─ spawn(child, env: { ANTHROPIC_BASE_URL, ANTHROPIC_AUTH_TOKEN })
```

---

## 3. 三条主链路的骨架

### 3.1 账号（token 是长期凭证，进 credentials）

```ts
import { credentialKey } from '@deepseek-ai/dsh-credentials'

const ACCOUNT = credentialKey('sub2api/account')   // <scope>/<id>，scope 必须是本插件名

export class Account {
  constructor(private readonly ctx: Context, private readonly endpoint: string) {}

  async login(email: string, password: string): Promise<void> {
    const pair = await api.login(this.endpoint, { email, password })
    await this.ctx.credentials.modifyRecord(ACCOUNT, async () => ({
      // 记录由属主自己解释载荷，插件想存什么就存什么
      payload: { access: pair.access_token, refresh: pair.refresh_token, at: Date.now(), exp: pair.expires_in },
    }))
  }

  /** 每 run 现取；过期就刷；刷失败就抛，不静默降级 */
  async accessToken(): Promise<string> {
    const rec = await this.ctx.credentials.readRecord(ACCOUNT)
    if (!rec) throw new Error('sub2api 未登录')
    const { access, refresh, at, exp } = rec.payload as AccountPayload
    if (Date.now() < at + exp * 1000 - 60_000) return access
    const next = await api.refresh(this.endpoint, refresh)
    await this.ctx.credentials.modifyRecord(ACCOUNT, async () => ({ payload: { ...next } }))
    return next.access_token
  }
}
```

`modifyRecord` 是**唯一**的写路径，且是跨进程串行的读—改—写（`credentials/src/index.ts:245`），所以两个进程同时刷 token 不会互相覆盖。

### 3.2 取 Key（短期凭证，只在内存）

```ts
export class KeyBroker {
  private cache = new Map<string, { key: string; at: number }>()
  private readonly TTL = 5 * 60_000

  async keyFor(groupId: number, token: string): Promise<string> {
    const hit = this.cache.get(String(groupId))
    if (hit && Date.now() - hit.at < this.TTL) return hit.key

    // ① 先在既有 key 里找同一个组的（列表里带明文 key）
    const keys = await api.listKeys(this.endpoint, token)
    const found = keys.find(k => k.group_id === groupId && !isExpired(k))
    // ② 没有就建一把专用的，名字带来源便于审计与吊销
    const key = found?.key ?? (await api.createKey(this.endpoint, token, {
      name: `dsh-${hostname()}-${target}`,
      group_id: groupId,
      expires_in_days: 30,
    })).key

    this.cache.set(String(groupId), { key, at: Date.now() })
    return key
  }

  invalidate(groupId: number) { this.cache.delete(String(groupId)) }   // 401 时调用
}
```

**为什么不落盘**：relay key 可随时在 sub2api 侧吊销；缓存进内存，进程退出即消失，泄露面最小。5 分钟 TTL 意味着"吊销后最多 5 分钟生效"，可接受。

### 3.3 Provider（每 run 组 env）

```ts
const provider: SubagentProvider = {
  name: config.providerName,                       // 例如 claude-code-sub2api
  capabilities: { agentOptions: false, agentPreset: false, outputSchema: false, depthLimit: true },
  inheritsParentContext: false,

  async start(request: ResolvedSubagentStartRequest): Promise<SubagentRun> {
    const token = await account.accessToken()
    const key = await broker.keyFor(config.groupId, token)

    const env = {
      ANTHROPIC_BASE_URL: config.endpoint,          // ← 没有这一行，claude 还是打官方
      ANTHROPIC_AUTH_TOKEN: key,
      ...(config.model ? { ANTHROPIC_MODEL: config.model } : {}),
    }

    // transport 二选一：官方 SDK query({ env }) 或拷贝 subagent-claude-code/src/run.ts
    const run = await startClaudeRun({ env, cwd: request.cwd, prompt: request.prompt, permissionMode: config.permissionMode })
    return { id: run.id, result: run.result, dispose: () => run.dispose() }
  },
}
ctx.subagents.registerProvider(provider)           // 返回 disposer，挂在效应系统上
```

Codex 的对应映射是 `OPENAI_BASE_URL` + `OPENAI_API_KEY`，或给 `CODEX_HOME` 指向一个放了 `auth.json` 的临时目录（用完即删）。

### 3.4 页面 ↔ 宿主

宿主侧（`@Remote`，见 `docs/cookbook/adding-a-remote-api.md`）：

```ts
export class Sub2ApiController extends TypertRemoteService {
  constructor(ctx: Context) { super(ctx, 'sub2api', { namespace: 'sub2api' }) }

  @Remote('login')
  async remoteExportLogin(email: string, password: string, signal: AbortSignal): Promise<LoginState> { … }

  @Remote('status')
  async remoteExportStatus(signal: AbortSignal): Promise<LoginState> { … }

  @Remote('groups')
  async remoteExportGroups(signal: AbortSignal): Promise<GroupRow[]> { … }
}
```

客户端侧，挂在插件详情页（`packages/client/ui-plugin-manager/src/client/slot-contract.ts:168` 的 `plugins.detail.section`）：

```tsx
ctx.slots.inject('plugins.detail.section', () => ctx.slots.register({
  name: 'plugins.detail.section',
  id: 'sub2api-login',
  locale: 'sub2apiLogin',
}, ({ subject }) => subject.kind === 'item' && subject.id === 'subagent-sub2api' ? <Sub2ApiLoginForm /> : null))

// 表单里
const state = await ctx.remote.sub2api.login(email, password, signal)
```

> **不要把密码或 token 放进 Config**。页面上的密码只走 remote 调用，不落 profile 配置；token 落 `ctx.credentials`；页面读到的永远只是 `{ signedIn: true, email }`。

---

## 4. 环境变量映射

| 目标 | 变量 | 说明 |
|---|---|---|
| Claude Code | `ANTHROPIC_BASE_URL` = sub2api origin | DSH 自己的测试就是这么指中继的：`experimental/subagent-oar/tests/permission-mode.e2e.ts:51` |
| Claude Code | `ANTHROPIC_AUTH_TOKEN` = relay key | 同一测试的 `:16` 里把 `ANTHROPIC_AUTH_TOKEN`/`CLAUDE_CODE_OAUTH_TOKEN` 列为凭证类名字 |
| Claude Code | `ANTHROPIC_MODEL`（可选） | 走中继时模型名以 sub2api 的映射为准 |
| Codex | `OPENAI_BASE_URL` + `OPENAI_API_KEY` | 或 `CODEX_HOME` 指向临时 `auth.json` 目录 |
| 任意 ACP | `config.env` 直传（`subagent-acp` 已支持） | 前提是对端 agent 认这套变量 |

---

## 5. 失败与安全

| 风险 | 处理 |
|---|---|
| 取不到 key / 未登录 | **失败关闭**：立刻抛错，禁止"没有 key 也起一个子进程" |
| token 过期 | 用 refresh 换；refresh 失败 → 标记为未登录，页面提示重登 |
| key 被吊销（401） | `broker.invalidate(group)` 后重试一次；再失败就报错 |
| 子进程打印环境 | **stderr 必须脱敏**：`subagent-acp` 直接把子进程 stderr 继承到父流，必须过一层 scrubber 再写 |
| key 落盘 | 不落盘；只存内存。配置里只放 origin / groupId / providerName |
| 审计 | 每次 start 记一条 log-only 事实：`{provider, groupId, keyId(不记 key)}`，进 session 事件或日志 |
| 多租户 | 一个 profile 一份 credentials 记录；不要跨 profile 复用 |

---

## 6. 分三步落地

1. **先不写插件**（半天）：`curl` 走一遍 login → groups → api-keys，拿到一把 key；手工 `ANTHROPIC_BASE_URL=… ANTHROPIC_AUTH_TOKEN=… npx @anthropic-ai/claude-code -p "hi"` 验证中转链路真的通。**这一步不通，后面全白做。**
2. **只写 provider**（2–3 天）：把登录 token 先硬编码进一个 `env` 变量或用 `$DSH_HOME/.env`，验证 `subagent_claude_code` 工具能跑通。此时不需要页面。
3. **再写页面**（3–5 天）：`@Remote` 四个方法 + `plugins.detail.section` 表单 + 状态显示。这一步只是把第 2 步硬编码的东西搬到页面上。

顺序颠倒的代价：先做页面，等于给一条没验证过的链路做 UI。
