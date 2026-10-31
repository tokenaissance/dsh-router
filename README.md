# dsh-router

把 DeepSeek Harness 的**子智能体调用**接到 [sub2api](https://github.com/Wei-Shaw/sub2api) 上：登录一次，之后每次开子智能体时按**路由组**取一把 relay key，连同中继地址一起注入子进程。

```
DSH  ──subagent_router()──▶  dsh-router provider
                                  ├─ 取 access token（credentials 里的 grant 记录）
                                  ├─ 取路由组 key（内存缓存，5 分钟）
                                  └─ spawn `claude -p …`
                                        env: ANTHROPIC_BASE_URL=<sub2api>
                                             ANTHROPIC_AUTH_TOKEN=<relay key>
                                                  │
                                                  ▼
                                             sub2api /v1/messages
                                                  │
                                                  ▼
                                             上游订阅账号池
```

## 为什么不是改配置就行

三件事叠加，把"配置注入"这条路堵死了：

1. 内置 provider 的 `env` 是**静态配置**（`subagent-claude-code/src/index.ts:47`、`subagent-codex/src/index.ts:44`），构造时解析一次；
2. 子进程环境默认按名字**擦除**（`subprocess/src/index.ts:47`：`/KEY|PASSWORD|SECRET|TOKEN/i`）；
3. 所以 key 只能走显式 `env`，而显式 `env` 只在配置里。

要"每次 start 现取 key"，只能自己实现 `SubagentProvider.start()`——这就是本包。

## 状态

| 能力 | 状态 |
|---|---|
| 宿主侧 provider（Claude Code / stream-json） | ✅ v0.1 |
| 凭据落 `ctx.credentials`（grant 记录）、relay key 仅内存 | ✅ v0.1 |
| 环境变量令牌引导（开发用） | ✅ v0.1 |
| 插件页登录（`plugins.detail.section` + `@Remote`） | ⏳ v0.2，接口已定，见 `docs/design.md` §3.4 |
| Codex（`OPENAI_BASE_URL` + `OPENAI_API_KEY`） | ⏳ v0.2 |
| 任意 ACP agent | ⏳ v0.2 |

## 挂载

### 方式一：作为 DSH 仓库内的一个包（推荐开发时）

`pnpm-workspace.yaml` 已覆盖 `packages/*/*`，所以把它放进 `packages/router/dsh-router/`，然后：

```sh
pnpm install
pnpm run build
```

### 方式二：作为外部插件安装

```sh
dsh plugin install /path/to/dsh-router
```

包里的 `dsh.bundle.patch` 指向 `cordis.patch.yml`，装进来后会插入两行：

```yaml
- id: subagent-router                 # provider
- id: tool-subagent-router            # 模型可见的 subagent_router 工具
```

### 配置

在 profile 的 `cordis.patch.yml` 里覆盖那一行：

```yaml
- id: subagent-router
  config:
    endpoint: https://sub2api.example.com
    groupId: 12                 # 见 GET /api/v1/groups/available
    model: claude-sonnet-4-5    # 走中继时以 sub2api 的映射为准
    permissionMode: dontAsk
```

| 字段 | 默认 | 说明 |
|---|---|---|
| `endpoint` | — | sub2api origin，**必须** |
| `groupId` | — | 计费/路由分组，**必须**；组是有类型的，见下 |
| `providerName` | `router` | `ctx.subagents` 上的名字 |
| `command` | `claude` | 子进程可执行文件 |
| `model` | 继承 | 固定上游模型 |
| `permissionMode` | `dontAsk` | 透传给子 CLI |
| `keyEnv` / `baseUrlEnv` | `ANTHROPIC_AUTH_TOKEN` / `ANTHROPIC_BASE_URL` | 注入位置 |
| `keyTtlMs` | 5 分钟 | relay key 内存缓存时长 |
| `mintExpiresInDays` | 30 | 需要自建 key 时的有效期 |
| `bootstrapTokenEnv` | — | **开发用**：存放 access token 的环境变量名 |

## sub2api 契约（已核）

| 用途 | 调用 |
|---|---|
| 登录 | `POST /api/v1/auth/login` `{email,password}` → `{access_token, refresh_token, expires_in}` |
| 刷新 | `POST /api/v1/auth/refresh` |
| 可用路由组 | `GET /api/v1/groups/available` |
| 取 Key（含明文） | `GET /api/v1/api-keys` |
| 建 Key | `POST /api/v1/api-keys` `{name, group_id, expires_in_days, quota}` |
| 中继 | `POST {origin}/v1/messages`（Anthropic 形态） |

**分组是有类型的**：有的组只接受 `/v1/messages`（Claude Code 形态，服务端会报 `This group is restricted to Claude Code clients`）。所以"给 Claude Code 用哪个组"和"给 Codex 用哪个组"是两个不同的组。

## 安全姿态

- **两把钥匙分开**：登录 grant 进 `ctx.credentials`（`GrantRecord`，owner-opaque；`modifyRecord` 是串行读改写，两个进程同时刷新不会互相覆盖）；relay key **只在内存**，TTL 到期重取。
- **失败关闭**：取不到 key 就抛错，绝不启动一个没有凭证的子进程。
- **脱敏**：子进程 stderr 只保留尾部 8 KiB，且 `sk-…`/`Bearer …` 与本次注入的 key 一律替换为 `[redacted]` 后才落日志。
- **不进配置、不进会话**：密码与 token 都不出现在 profile 配置里；也不进 prompt 或工具参数。

## 三步验证（别倒过来）

1. **先 curl**：`/auth/login` → `/groups/available` → `/api-keys`，拿一把 key；然后
   ```sh
   ANTHROPIC_BASE_URL=https://sub2api.example.com \
   ANTHROPIC_AUTH_TOKEN=sk-xxx \
   claude -p "say hi"
   ```
   这步不通，后面全白做。
2. **再验 provider**：用 `bootstrapTokenEnv` 把 token 从环境喂进来，跑一次 `subagent_router`。
3. **最后做页面**：v0.2 的登录页把第 2 步硬编码的东西搬上去。

## 版本对齐（重要）

本包的类型是按 DSH 仓库的 `0.2.2-alpha.2` 写的，而 npm 上 `@deepseek-ai/dsh-*` 目前是 `0.0.1-rc.1` 一代。两者间 `SubagentProvider` / `SubagentResult` 的字段可能已变。

两种做法，选一个：

- **随仓库开发**：把包放进 DSH 的 `packages/router/dsh-router/`，`workspace:*` 依赖天然对齐；
- **出树发布**：把 `peerDependencies` 钉到你实际运行的那个 DSH 版本，并在 `pnpm run build` 后跑一次真实子智能体调用验证签名。

## 已知限制

- v0.1 只实现了 Claude Code 的 print/stream-json 传输。Codex 需要另一套 app-server JSON-RPC 客户端（可参考 DSH 的 `subagent-codex/src/wire.ts`）。
- 页面部分（`plugins.detail.section` + `@Remote`）需要 Typert 生成流水线与 DSH 的 client 构建预设；出树构建要自己复现，见 `docs/design.md` §3.4。
- 登录若撞上验证码（`VerifyCaptcha`，`auth_handler.go:247`）或 2FA，v0.1 会明确报错；请改用 token 引导，等 v0.2 的页面。

## License

MIT
