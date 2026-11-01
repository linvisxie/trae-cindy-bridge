# 更新记录

版本号跟着 Cindy 插件清单（`plugin/ghost.json` 的 `version`）走。

---

## 0.1.4

**2026-11-02** · 修「未登录 / 发不出消息」—— 选错了凭据文件

### 现象
面板显示「未登录」，额度那栏报 `Trae usage endpoint ... returned HTTP 401`，发消息直接失败（上游 `{"code":1001, ...not able to authenticate you...}`）。可 Trae CN 客户端明明刚登录过。

### 原因
本机 `%APPDATA%` 下同时存在两份 Trae 的 storage.json：

| 目录 | 登录态 |
| --- | --- |
| `Trae CN` | 2026-11-02 05:39 刚登录，token 有效到 11-15 |
| `TRAE SOLO` | 2026-10-09 的老文件，`vis lin`，token 早就失效 |

`readTraeCredential()` 原来是「按候选目录名的先后顺序，碰到第一份带登录态的就返回」。目录名顺序是 `Trae CN` 在前，但 worker 有 5 分钟凭据缓存，只在读取**成功**时覆盖——早先拿到的那份 `TRAE SOLO` 旧凭据被一直沿用，重新登录 Trae CN 也不会纠正。

### 改法
`readTraeCredential()` 改成遍历**全部**候选，收集所有能解出凭据的文件，然后：
1. 只要有过期时间的，先剔掉已过期的；
2. 剩下的按 storage.json 的 **mtime 从新到旧**排序，取最新登录的那份。

顺带修 `buildStatus()` 的登录判定。原表达式是 `cred && cred.expiresAtMs ? cred.expiresAtMs > Date.now() : cred`——凭据里没有 `expiresAtMs` 时反而落到「已过期」分支，永远显示未登录。现在是「有凭据，且没有过期时间或尚未过期」。

### 效果
`/status` 恢复 `signedIn: true`，`sourcePath` 指向 `Trae CN`，额度、模型目录、对话一起恢复。

---

## 0.1.3

**2026-11-02** · 修模型选择器被撑开、整排控件被推离麦克风

### 现象
Cindy 输入框那排控件（模型选择器、麦克风）整体左移，模型选择器不再贴着麦克风。

### 原因
我们把推理档位拼进了模型显示名，例如 `Kimi-K2.8-Preview · x0.8 · 档位 high/low/max`，长达 42 字符。Cindy 的模型选择器按名字宽度撑开，名字一长就把整排控件往左挤。

### 改法
`worker.cjs` 的 `modelLabel` 去掉档位段，只留倍率：`GLM-5.3 · x0.78`、`Qwen3.8-Flash · 免费`。
档位没丢——它本来就通过 `/v1/models` 的 `reasoning.supported_efforts` 交给 Cindy 渲染成独立的下拉控件，名字里再写一遍是纯冗余。

### 效果
最长名字从 42 字符降到 28 字符。

---

## 0.1.2

**2026-11-02** · 包名、1M 上下文、模型列表收敛

### 包名改成 `trae-cindy-bridge`

Cindy 不认 `cindy-` 打头的插件包名，所以产物固定叫 `dist\trae-cindy-bridge.cindy`（`pack.cjs` 与 `e2e-package.js` 同步改）。`plugin/package.json` 的 `name` 也跟着改成 `trae-cindy-bridge`。

### 上下文按实测填，不再是 200K

- 目录里的 `context_window_tokens.dev`（200000）只是**上游给客户端的建议值**，不是硬上限。
- 真打上游按 `4022`（prompt tokens exceeded）/ `4026`（context length exceeded）扫边界：glm 系 / deepseek 系 / kimi 系 / minimax / qwen / mimo / step 的可用输入约 **1M**。
- 验证不止「不报错」：给 `deepseek-v4.1-flash` 灌 1.06M 输入（实测 `prompt_tokens=942282`），正文开头埋的 `ALPHA1060000` 被准确读出来，耗时 118 秒。
- 新增 `MEASURED_CONTEXT` 实测表覆盖目录值：1M 档 17 个模型；Doubao 系列按实测降档（`2.1-Pro` / `Evolving` 600K，`2.1-Turbo` 262144）；未实测的仍回落 `dev`，不吹。
- `FALLBACK_MODELS` 里的窗口同步改（`DeepSeek-V4-Pro-Official` / `glm-5.2` / `kimi-k2.6` → 1M）。

### 模型列表只留能聊的

- 按 `usage === 'chat_completion'` 过滤：83 个 id → 32 个可选模型。
- 去掉 20 个 `custom_model_*`（用户自建槽）与 5 个 IDE 内部工具模型（`summary` / `title_generation` / `input_optimization` / `fast_apply` / `fast_apply_new`）。
- 理由：那批在本机 12 个回 `3003 all models failed`、1 个回 `4023`，留着只会让人点到死模型。上游自己的注释原话是「none of those belong in a model picker」。

### 新增三条人话错误

| 码 | 之前 | 现在 |
| --- | --- | --- |
| `3003` | 直译 `We're sorry, something went wrong` | 「这个模型当前账号没有可用通道（3003 = all models failed）。不是网络问题、不用挂代理，换个模型就行。」 |
| `4022` | 无专门文案 | 「这次带上去的内容超出了 Trae 的输入上限（4022）。清掉一些历史对话、或者少贴点长文件再发。」 |
| `4026` | 无专门文案 | 「这个模型的上下文窗口放不下这次的对话（4026）。换一个窗口更大的模型，或者清掉历史再发。」 |

> 用户报的「claude 一直网络重连」就是 `custom_model_claude` 的 `3003`，秒回、与代理无关。0.1.2 起它已不在模型列表里。

### 测试

- `test/features.js` 增：`有模型报到 1M 上下文`、`模型列表里没有自建槽/工具模型`。
- 「真打一次 chat 成功」与本地账本三条改成**额度耗尽时 SKIP**（上游 `4008`），避免额度用完的几天被误报成回归。
- `smoke-protocols` / `smoke-tools` / `wire-quirks` / `e2e-package` 同样处理：上游 `4008` 一律降级成 SKIP 并单独计数；纯本地的断言（鉴权 401、路径折叠、`count_tokens`、包结构、面板、电子脑）照旧必须真跑，不受额度影响。

---

## 0.1.1

**2026-11-02** · 修上下文窗口与推理档位

用户反馈「上下文怎么都是 168K」「档位调不了」，两条都查实并修好。

### 上下文窗口报小了

- 之前取的是 `model_detail_list[0].prompt_max_tokens`（168000），那是上游给的**保守可用输入**，不是窗口。
- 改取 `context_window_tokens.dev`（200000）。glm-5.3 / deepseek-v4.1-flash 这一大批因此从 168K 回到正确的 200K。
- `display_config.max_mode === true` 的模型另报 `max_context_window`；跨通道借 max 时加了「不得小于当前窗口」的保护，避免出现「最大窗口比窗口还小」。
- **真 1M 只有 3 个**：`custom_model_1M_text` / `custom_model_1M` / `custom_model_doubao_1M`。其余模型上游发布的就是 200K / 256K 档，不是这里设小。
- 55 个模型现在的窗口分布：200000 ×32、256000 ×6、1000000 ×3、300000 ×2、272000 ×2、128000 ×2、40000 ×2、44096 ×2，以及 53192 / 120192 / 184000 / 816000 各 1。

### 推理档位调了没反应

两个独立原因，都修了：

1. **档位名没映射**。我们内部的 `low` / `xhigh` 直接发给了上游，但 Trae 线上认的是 `light` / `extra_high`。发错名字**不报错、不生效**，静默丢弃。现在过 `WIRE_EFFORT_MAP`（`low→light / medium→medium / high→high / xhigh→extra_high / max→max`）。
2. **档位只在 2 个模型上露出来**。之前只认行级 `reasoning_effort_config.support_thinking === true`（本机只有 `minimax-m3.1-flash`、`Doubao-Seed-Code`）。实测 6 个模型 × 全档位全程 HTTP 200，`deepseek-v4.1-flash` 的思考长度随 low→high→xhigh 单调上升（completion 23→24→27），说明上游其实收。现在补一条判据：`model_capability === 'reasoning_model'` 或 `reasoning.enable === true` 的模型报全套五档，`custom_model_*` / `title_generation` / `fast_apply` 这些工具模型仍给空。
- 带档位的模型从 2 个增加到 35 个。

### 其它

- `test/features.js` 增补断言：档位名必须在五档白名单里、窗口不能一刀切、不能把 `prompt_max_tokens` 当窗口、`max_context_window` 不得小于 `context_window`。
- 删掉 `dist/trae-cindy-bridge.cindy` 这个包名写错的残留产物。

---

## 0.1.0

**2026-11-02** · 首个版本

把本机已登录的 Trae CN 额度桥成一个 OpenAI / Anthropic 兼容的本地 HTTP 服务，供 Cindy 的「自定义供应商」接入。

### 端点与协议

- `127.0.0.1:47822` 本地 HTTP 服务，只绑 loopback。
- 三条协议同时实现：`POST /v1/chat/completions`（OpenAI Chat）、`POST /v1/responses`（OpenAI Responses）、`POST /v1/messages` 与 `/v1/messages/count_tokens`（Anthropic Messages）。Cindy 的 `pi` / `claude-code` / `codex` 三个引擎都能接。
- `GET /v1/models` 模型目录；`GET /status`（`/v1/status` 同义）完整状态；`GET /healthz` 免鉴权探活，只回 `{ok, port, modelCount}`。
- 除 `/healthz` 外全部要求 `Authorization: Bearer <Token>`。

### 上游适配

- 对话走 `https://trae-api-cn.mchost.guru/api/agent/v3/llm_utils_chat`，`Cloud-IDE-JWT` 身份头 + `X-Ide-Token` / `X-Cloudide-Token` / `x-uid` / `x-plugin-channel` / `x-app-id` / 设备标识头。
- `tools[].function.parameters` 序列化成字符串下发；按 draft-3 兼容规则归一化 schema（去 boolean 型 `required`、把 `properties.X.required: true` 提成父级数组），否则 DeepSeek 后端整条拒（`4027`）。
- **peek 上游 SSE 头部**：Trae 把错误塞在 HTTP 200 的 body 里（`event: error` + `code`），worker 先看头几帧，头部就是错的直接翻成真错误状态码，避免客户端误判成网络故障反复重试。
- 错误码讲人话：`1005` → 402（要付费套餐）、`2001` → 临时性（不用重登录）、`4001` → 400（模型不在通道）、`4008`（SOLO 额度耗尽）、`4011` → 429（限流）、`4023` → 400（路由不认模型名）、`4222`（企业租户额度耗尽）。

### 凭据

- 读 `%APPDATA%\Trae CN\User\globalStorage\storage.json` 的 `iCubeAuthInfo://icube.cloudide`，解自有 AES-128-CBC 封装（类型头 + 32 字节随机数 + 密文；`sha512(sha512(random) || salt)` 派生 key/iv；明文前 64 字节是完整性摘要）。
- 只在内存里用，不写盘、不外发；每次现读现解，缓存 5 分钟。

### 模型目录

- 按函数通道逐个问 `POST /api/ide/v1/get_detail_param`，顺序 `solo_work_remote` → `solo_work_lite` → `solo_agent_remote` → `chat_v3` → `solo_coder`，并集合并、先到先得。
- 可见性按上游语义裁决：该模型所有行都 `is_invisible_to_user` 就不列；当前通道不可见但别处可见就换通道（repin），不删模型。本机 83 个 id 里 55 个至少一行可见。
- 上下文窗口取 `context_window_tokens.dev`（模型真实窗口），不再误用 `model_detail_list[0].prompt_max_tokens`（保守输入上限，168000）。`display_config.max_mode === true` 时报 `max_context_window`，且只在它不小于当前窗口时才借跨通道的 max。修正后 glm-5.3 / deepseek-v4.1-flash 这批从 168K 回到 200K；真 1M 只有 `custom_model_1M_text` / `custom_model_1M` / `custom_model_doubao_1M`。
- 推理档位两条判据：行级 `reasoning_effort_config.support_thinking === true` 且给了 `options` 就只报明说的那几个；否则 `model_capability === 'reasoning_model'` 或 `reasoning.enable === true` 报全套五档；都不满足给空。本机 35 个带档位、20 个工具模型不带。
- 档位下发必须过映射 `low→light / medium→medium / high→high / xhigh→extra_high / max→max`。发 ours 的 `low`/`xhigh` 上游不报错也不生效（静默丢弃），是「调了没反应」的根因。
- 降级：单通道缺口跳过 → 全没拿到读 `models.json` 缓存 → 再没有用内置 4 条兜底（DeepSeek-V4-Flash-Official / DeepSeek-V4-Pro-Official / glm-5.2 / kimi-k2.6）。
- 元数据输出 `context_window` / `max_context_window` / `reasoning: {supported_efforts, default_effort}`。

### 额度与签到

- 额度快照 `/trae/api/v2/pay/web_user_ent_usage`、签到状态 `/trae/api/v2/ug/checkin_credits/status`、领取 `/trae/api/v2/ug/checkin_credits/claim`（带 `x-device-id`，按北京日幂等）、活动 `/trae/api/v2/ug/activity/info`。
- 签到是唯一会变更账号状态的调用，**不自动执行**，面板上手动点。

### 面板与工具

- 右侧栏「Trae 桥」面板：登录态、账号、区域、本地端口、模型数、额度积分、签到、运行时长、本地用量、Base URL / Token（各一个复制按钮，Token 默认打码）、日志文件路径。
- AI 侧四个工具：`trae_status`、`trae_endpoint`、`trae_refresh`、`trae_checkin`。

### 运行数据与日志

- 数据目录 `%APPDATA%\CindyGlobal\trae-bridge`：`state.json`（token + 端口）、`models.json`（模型缓存）、`usage.json`（按天按模型记账，留 60 天，原子写）、`bridge.log`（ISO 时间戳，超 2 MB 滚成 `.1`）。
- 环境变量：`CINDY_TRAE_DATA`（数据目录）、`CINDY_TRAE_PORT`（首选端口，默认 `47822`）。

### 端口与隔离

- 端口咬死 `47822`：被占就等最多 30 秒（等上一个 worker 退干净）；仍被占且探测到是另一个健康的 Trae 桥就让位退出。不顺延，因为 Base URL 是手填一次的。
- 与 `qoder-bridge` **共存但完全隔离**：独立 ghost id、独立端口、独立 token、独立数据目录、独立工具前缀（`trae_*`）、独立面板通道（`trae-bridge-panel`）。模型 id 重名互不影响，在 Cindy 里可作为两个不同的自定义供应商同时挂。两者不合并。
