# 更新记录

版本号跟着 Cindy 插件清单（`plugin/ghost.json` 的 `version`）走。

## 未发布（审查修复）

本节记录审查分支的最小修复，不修改清单版本；下方历史记录保留为当时发布说明，不代表本轮验证结果。本轮代码完成，待最终验证，尚未发布 / 安装。

- 旧 issue #7（stream 默认值）与 #12（Responses reasoning）同属本轮剩余问题范围，不再暂缓：三协议仅 `stream === true` 返回 SSE，缺省或 `false` 返回单个 JSON；上游仍可 `stream: true` 后聚合。Responses 流式 / 非流式提供含 `summary_text` 的 reasoning item；流式使用标准 `response.reasoning_summary_part.*` / `response.reasoning_summary_text.*` 事件，不虚构推理内容或 usage。依赖旧默认流式行为的调用方需显式传 `stream: true`。
- 新增 `test/protocol-defaults-reasoning.js`，覆盖协议默认值与 Responses reasoning 回归；实际结果以测试命令输出为准，不固定断言数，不把未运行 / SKIP 记作通过。

- 共享适配器流中错误统一走 worker `formatError` 中文分类，保留已获 usage，并以失败终止。
- 更新强制校验合法的 64 位十六进制 SHA-256，不再允许 size 降级。新增 `download.cjs`：严格限制 GitHub HTTPS repo / tag / asset、逐跳重定向域名、32 MiB 包大小及最多 5 跳。
- 新增 `bootstrap.cjs`，清单 `node.entry` 为 `node/bootstrap.cjs`：先由 `ownership.cjs` 按 `INSTALL_DIR`（`install`）→ `DATA_DIR`（`data`）固定顺序取得 OS 独占锁，之后才加载全部业务模块 / worker。同一安装目录即使数据目录不同也拒绝同时运行；多实例的安装目录和数据目录必须都不同，换端口不能绕过。Windows 命名管道，Linux abstract socket 仅供 offline CI；不扩大权限或平台支持。
- 安装器等待旧 PID 退出，未退出则停止；退出后同样按 install → data 顺序取得双锁并在安装全过程持有。取得两锁后校验 `latest-attempt.json` 的 attempt 身份，迟到脚本若指针换代或不存在即拒绝复制。持久化每次 journal attempt / result；复制失败尝试回滚，rollback 不覆盖 journal，失败保留诊断与 backup。
- 持久更新目录统一为 `UPDATE_DIR = canonicalDirectory(INSTALL_DIR) + '.updates'`，即规范化安装目录同级的 `<安装目录>.updates`，不再使用数据目录的 `update/`。bootstrap、worker 与安装器都检查此 journal，与 `DATA_DIR` 无关，换数据目录不能绕过。
- 新增 `update-status.cjs`：中断的 copy / rollback 阻止 boot；journal `begin` 与 `applyUpdate` 禁止覆盖尚未恢复的 attempt 指针，`begin` 拒绝 previous `handed_off`。pending handoff 未确认结果时不能新更新，要先检查 `<安装目录>.updates/install.log`，不承诺自动重试。
- **恢复步骤**：Cindy 原生导入完整包不会清除安装目录同级的 journal，也不会自动解除阻断。中断 copy / rollback 失败后保留所有日志与 backup；原生导入完整 `.cindy` 包并确认成功后，停用插件，将 `<安装目录>.updates/latest-attempt.json` 重命名保留诊断，再启用。不要删除备份和日志。
- **不再自动同步 Cindy 宿主安装快照**：移除直接修改 `ghost-install-state` 安装收据以及通过 `process.execPath` 执行同步脚本的做法。运行文件更新成功不等于宿主安装记录刷新；Cindy 0.1.128 没有已验证的公开插件自写收据 API，用户须通过 Cindy 原生导入完整 `.cindy` 包刷新记录。
- 新增登记为 offline 的 `test/bootstrap.js`：以临时安装副本、临时数据目录与独立端口隔离，验证双锁前不加载业务模块 / worker 及目录冲突拒绝启动，不触碰真实安装或依赖登录态。新增 `test/ownership.js`、`test/update-download.js`、`test/update-install-results.js`、`test/update-status.js`；更新共享回归、打包与 CI 登记。执行 `node .github/scripts/ci-run.cjs --mode offline` 及 README 所列脚本获取实际结果，不沿用旧测试计数。
- 验证边界：Cindy 0.1.128 以 `require` 加载 Node entry，已验证 bootstrap 与该方式兼容，不等于本轮已发布 / 安装。Windows 故障测试使用真实临时目录，不是真实插件安装；没有真实用户登录 / 退出测试。未运行 / SKIP 不等于通过，不承诺无 bug。

## 0.1.12

**2026-11-04** · 工程质量版本：七个已确认缺陷修复 + CI/CD 门禁 + 可复现构建

与 qoder-bridge 0.1.20 同期发布。两份 `update.cjs` 逐字相同，构建规范同源。

### 更新器安全性（改动最大）

**digest 校验不再降级放行。** 以前 `verifyDigest` 遇到两种"信息不全"的情况会静默放行：digest 给了但格式非法会退回"只看文件大小"；digest 与 size 都没有则零校验安装。现在一律 fail-closed：校验不过就一个字节都不写进安装目录。

**安装脚本失败会回滚。** 覆盖中途失败时清空安装目录并从备份恢复，不再留下新旧混杂的目录。

**备份不再陈旧。** 每次覆盖前先删旧备份再建，同版本重试不会沿用过期的回滚点。

### 凭据安全（本仓特有）

**自动登出后的旧凭据续期。** 自动重读发现 `no-auth-key` / `not-found` 时会清理账号凭据与 identity 并递增 generation，阻止登出前发起的晚到续期写回。以前会出现"已经登出了，旧 token 又被续回来"的状态。

**暂时读取失败仍保留凭据。** 只在确认登出时才清理，避免网络抖动导致误清。

### 并发与错误处理

**更新按钮双处理器并发。** `panel.js` 里 `addEventListener` 与 `btn.onclick` 并存，进入"安装"状态后点一次按钮会同时触发检查和安装；worker 侧 `applyUpdate` 无互斥。现在面板是单一状态机，worker 侧加 `updateInFlight` 在途锁。

**Chat 非流式聚合中途出错回通用 500。** 上游中途断流或回错误帧时不再冒泡成裸 500，走 `errorStatusOf/errorBodyOf` 统一映射，与开流前错误同口径。

### 面板与输入健壮性

**JSON `null` 请求体会 500 并泄漏内部异常。** 现在 payload 归一化，非对象一律当空对象，让后续校验按 400 回。实测验证：`null` / `{}` / `42` 三种输入都返回 400，不再泄漏 `TypeError`。

**reqId 去重丢结果。** 缓存已发出的结果，重发时有结果就重发、还在算就等它算完，不再让面板误报超时。

**e2e-brain 未登录环境误判。** 失败打印不再自身崩溃（`JSON.stringify(undefined).slice` 会抛 TypeError），账号类断言改为跟随登录态判定。

### 额度

**无效额度响应误判。** 保留旧值并标记 `stale`，不再把有效额度覆盖成 0；JSON 解析异常不再被 `postWeb` 吞成空对象。

### CI/CD 建设（本版首次引入）

与 qoder-bridge 同一套骨架：

| 工作流 | 作用 |
| --- | --- |
| `ci.yml` | 语法/清单/版本一致性 → 8 个离线测试矩阵 → 打包 + 14 项产物校验；另含 actionlint 与 CodeQL |
| `release.yml` | 只能手动发起；推 `v*` tag 只建草稿 |
| `shared-drift.yml` | 与 qoder 仓库比对共享骨架是否同构 |

### 可复现构建（从本版开始）

**从 0.1.12 起，正式资产在同一提交上是字节级可复现的**：任何时区都产出相同 sha256。

两处修正（与 qoder-bridge 同源）：

1. **zip 时间戳改用 UTC 分量。** 以前用 `getHours()` 等本地时间字段，同一个提交在北京打出 08:00、在 UTC 机器打出 00:00，哈希不同。
2. **产物校验对比 git blob，而非工作区文件。** 工作区被存成 CRLF 时，包会比提交内容多字节却照样"校验通过"。

已验证：本地（Asia/Shanghai）与 GitHub Actions（UTC）打出的包 sha256 完全一致。

### 关于历史版本资产

**此前认为"历史资产不可复现"，实测后需要修正**：`v0.1.11` 完全可以用 tag 源码复现，只需还原当时的时区。

| 资产 | 复现条件 | 实测结果 |
| --- | --- | --- |
| `v0.1.11` | tag 源码 + Asia/Shanghai 时区 | 得到 `16e814d7…`，与 Release 完全一致 |

本仓所有文件都是 LF（逐文件核对 CRLF 计数为 0），所以唯一变量就是时区。

**这说明历史资产没有损坏**。从 0.1.12 起改用 UTC 时间戳，任何时区都产出相同字节——这是更强的可复现性。旧包与新包哈希必然不同（时间戳字段变了），**不代表代码变更**。

### 测试

离线 8 个脚本全绿（253 项）。需要真实登录态的 5 个 live 脚本本机实测通过（78 项）。Windows 实机验证了安装、回滚、旧进程占位、陈旧备份四种场景，以及装后启动。

### 仍未解决

- **#7 三协议 `stream` 默认值**：与 qoder-bridge 同源，调查报告见该 Issue。
- **#12 Responses 链路丢弃 reasoning 内容**：已实证，修复需先确定 Responses 输出形态。

---

## 0.1.11

**2026-11-04** · 修缓存命中率被算低（缓存 token 被算了两遍）

### 现象

「缓存拆分」那一行能看到读数，但命中率明显偏低。缓存实际上并没有那么差，是我们的映射问题。

### 原因

Cindy 算命中率用的是（见 `app.asar` 里的 `sI()`）：

```
命中率 = cacheRead / (input_tokens + cacheRead + cacheWrite)
```

两套协议的 `input_tokens` 语义不一样：

| 协议 | 含义 |
| --- | --- |
| OpenAI | `prompt_tokens` = 输入**总量**，已经包含命中缓存的部分 |
| Anthropic | `input_tokens` = 输入里**没走缓存**的净额 |

旧实现把 `prompt_tokens` 直接当 `input_tokens` 发出去，同一批缓存 token 在分子和分母各算一次。

### 实测证据（qoder 侧）

```
修复前：读=2355  输入=2361  → 2355/(2361+2355) = 49.94%
修复后：读=2355  输入=6     → 2355/(6+2355)    = 99.75%  ← 真值
```

总量守恒：`6 + 2355 = 2361`，与冷启动那轮的 2361 完全一致。

### 改了什么

1. **`anthropicUsage` 扣除缓存**（P1）。`input_tokens = max(0, prompt_tokens - cached - write)`，夹 0 是防上游计价边界出现负数。
2. **两个缓存字段无条件带上**（P1）。Cindy 用 `hasOwnProperty` 检查四个字段，缺一个就 `complete=false`，那一轮被当成未结算，连命中率都不显示。
3. **Chat 路径也总是带 `prompt_tokens_details`**（P2）。以前只在缓存非零时才写这个对象，导致三条协议的 usage 字段形状不一致；Cindy 的 `parseChunkUsage` 用 `??0` 兜底不会崩，但「时有时无」让人排查时没法定调。现在三条协议形状统一。

### 边界说明

trae 上游**完全不提供缓存数据**。实测三次全新前缀的冷启动请求，紧接着重复同一前缀，`cache_read_input_tokens` 与 `cache_creation_input_tokens` 始终为 0。所以这个桥的命中率会一直是 0%，是数据源本身没有，不是映射问题，这一版改不了。

### 测试

`review-regressions` 新增 9 条断言（含「旧的 49.94% 必须不再出现」这条防回退）、37/37 通过。另：`host-guard 13/0`、`responses-status 19/0`、`upstream-contract 16/0`、`update-chain 51/0`、`feature-offline 39/0`、`features 51/0`、`e2e-package 25/0`、`e2e-panel 17/17`、`e2e-brain 13/13`、`verify-manifest PASS`。

---

## 0.1.10

**2026-11-04** · 修两处「数字变成 0」的假象，以及一条永不消失的红字

### 修了什么

1. **缓存命中率恒为 0，但上游其实命中了**（P1）。Cindy 里「缓存 读 0 · 写 0 · 命中 0%」看着像上游不支持缓存，实际是适配层把真值丢了：`input_tokens_details.cached_tokens` 和 `output_tokens_details.reasoning_tokens` 都硬编码成 0。实测同一个前缀连发三次，`cached_tokens` 稳定为 **1792 / 2034（命中 88%）**。现在 `census()` 把两项原样透传，只在上游真没给时才落 0。

2. **Anthropic 协议根本不报缓存命中**。`/v1/messages` 的 `message_delta` 以前只有 `input_tokens` / `output_tokens`，而 Cindy 算命中率读的是 `cache_read_input_tokens`，字段不存在自然就是 0%。现在补上；该字段只在真有命中时出现，避免把「不支持缓存」和「命中 0」混为一谈。

3. **一条瞬时失败会永久挂在面板上**（P2）。线上实测：worker 启动后 10 秒后台补额度失败一次（`fetch failed`），此后即使额度已经刷新成功（`quota.stale = false`、数字是新的），面板那行红字仍在——因为 `lastError` 在整个文件里**只有赋值，没有任何一处清空**。现在按来源分别记账（`models` / `usage` / `checkin`）：

   - 成功刷新只清自己那一项，模型成功不会误清额度错误；
   - 错误带时间戳，显示成「（12 分钟前）额度读取失败：…」；
   - 额度是旧值时面板在数字后标「（旧值）」。

### 加了什么

- 8 项离线回归：缓存/推理明细必须透传、真实 0 不能被当成缺失、Anthropic 必须报 `cache_read_input_tokens`、成功刷新必须清掉自己的失败、不同来源互不误清、时间戳分档、`quotaStale` 标记。
- `adapters.cjs` 导出 `anthropicUsage` / `responsesUsage` / `census` 以便测试。

### 测试

`review-regressions 30/30`、`update-chain 51/0`、`host-guard 13/0`、`responses-status 19/0`、`upstream-contract 16/0（1 跳过）`、`features 51/0`、`feature-offline 39/0`、`e2e-package 25/0`、`e2e-brain 13/13`、`verify-manifest PASS`。

**边界**：命中率是否真在 Cindy 界面显示出来，需要桌面端实际对话一次才看得到；本轮只验证到端点返回的 usage 已带真值。

## 0.1.9

**2026-11-03** · 修续期 token 被旧磁盘凭据覆盖，以及输入用量与自更新的两个假象（issue #2）

### 修了什么

1. **续期拿到的新 token 会被磁盘上的旧票冲掉**（P1）。这是个只在「磁盘票已过期」时才发作的状态机 bug，但发作后表现为「明明刚换到有效 token，下一个请求却 401」。复现链：`renewCredential()` 换到新 token **只写内存**（这是故意的，`storage.json` 归 Trae 客户端管，从外面改会被它 flush 覆盖）；几秒后 5 分钟缓存过期或有人强制刷新，`refreshCredential()` 重新读盘拿到**早已过期的 R0**，旧代码无条件 `credential = r.credential` 覆盖，新 token 就没了；再拿 R0 去换票，轮换过的服务端直接拒绝，于是只能报登录失效。

   现在给磁盘凭据算一个指纹（`storagePath` + userId + accountName + edition + host + token + refreshToken 做 SHA-256），只有**指纹变化**（即磁盘上真的是另一份登录态）才覆盖内存并 `credentialGeneration += 1`；磁盘没变就不动内存。所以：磁盘换票 → 指纹变 → 采用；换账号 → 指纹变 → 采用；明确退出 / 读到失败 → 清空；而「同一份磁盘票 + 内存里更新的 token」→ 保留内存。

2. **迟到的续期结果会写进另一个账号**（P1 相关）。换票是异步的，用户可能在等待期间重新登录换号。现在续期开始时记下当时的代次，回来时若代次已变（说明换了登录态）就丢弃结果，不写入新账号。

3. **同代续期并发没合并干净**（P1 相关）。`renewing` 原来只有一个槽位，不同代次的续期会互相串。现在按代次存，同代共用一个请求，异代各走各的；清理时只在槽位仍是自己时置空，不会误清新请求。

4. **输入用量记的是估算值**（P2）。同 qoder 0.1.17：优先 `usage.prompt_tokens`，缺失才估算，`??` 保留真实 0，Anthropic 流式 `message_delta` 补 `input_tokens`。

5. **自更新只看摘要，不校验包的身份**（P2），以及 **安装器没启动却报 applied 并退出**（P2），修法与 qoder 0.1.17 相同（两仓库共用 `update.cjs`）：解包前校验插件 ID / 版本 / schema / 声明入口与必需运行依赖；唯一 staging 目录；`waitForSpawn()` 等 `spawn`/`error`，失败清理并保活。

### 加了什么

- **`test/review-regressions.js`**，22 项离线行为回归，其中续期部分覆盖：缓存过期与强制刷新后新 token 仍在、磁盘换票生效、换账号生效、退出生效、迟到续期不覆盖新登录、同代并发只换一次票。
- `updater` 导出 `validatePackage` 与 `waitForSpawn`。

### 测试

`review-regressions 22/22`（新）、`update-chain 51/0`、`host-guard 13/0`、`responses-status 19/0`、`upstream-contract 16/0（1 跳过）`、`features 51/0`、`feature-offline 39/0`、`e2e-package 25/0`、`e2e-panel 17/17`、`e2e-brain 13/13`、`verify-manifest PASS`。

**边界**：真实上游是否轮换 refreshToken 未在本机验证；客户端「丢弃有效内存凭据」这个状态转移是用轮换 fixture 复现并钉住的。Windows 真机覆盖升级与真实账号换票同样未验证。

## 0.1.8

**2026-11-03** · 把自更新链路补成可靠的，修文生图的图片地址，加英文 README

### 修了什么

1. **自更新不校验下载包**（P1）。`applyUpdate()` 以前下载完直接 `extractZipTo` 覆盖安装目录，没有任何完整性校验 —— CDN 截断或中间人替换时，worker 已经 `process.exit(0)`，Cindy 拉起的就是一份坏代码，只能靠 `.bak-<旧版本>` 手工回滚。现在下载后先比 `asset.digest`（GitHub Releases 自带 `sha256:…`，与本机 dist 包、Cindy 记的 `packageSha256` 三方一致），不一致就抛错、**一个字节都不写进安装目录**。没有 digest 时退回按 `size` 校验。

2. **自更新成功后不刷新 Cindy 的清单快照**（P1）。Cindy 的「插件管理」页读的是 `ghost-install-state` 下的快照，不是运行中的 `ghost.json`。自更新只覆盖运行文件，管理页会退回旧版本 —— 正是 0.1.7 那条 CHANGELOG 自己写的问题。现在替换脚本会在装完后调一个自动生成的 node 脚本同步 `manifest` / `packageSha256` / `receiptRevision`，owner 目录从安装位置反推。

3. **文生图返回的图片地址是 Windows 反斜杠**（P2）。`main.js` 以前把 `C:\Users\...\a.png` 直接拼进 `![]()`。虽然 CommonMark 只对 ASCII 标点做反斜杠转义、本例路径碰巧不坏，但用户名或目录名一旦带 `_ * [ ]` 就会被吃掉，空格也会截断语法。现在统一转成 `file:///C:/...` 形式，并对 `% # ? 空格` 做百分号编码；回退文本里另起一行给原始 Windows 路径，渲染器不认 `file://` 时能直接复制。

4. **暂存目录与下载包失败时残留**（P2）。清理放进 `finally`，下载包和临时同步脚本也一并删。

### 加了什么

- **`plugin/node/update.cjs`**。把版本比较、digest 校验、zip 解包、脚本生成、快照同步脚本生成抽成纯函数，这样能离线回归。
- **`test/update-chain.js`**，50 项离线回归（版本比较按段比、哈希不符拒绝、zip slip 防护、脚本生成、单引号转义、双仓库一致性）。
- **`test/feature-offline.js`**，39 项离线回归：`imageSizeOk` 的 `[3686400, 16777216]` 像素区间（512×512 / 1024×1024 必须被拒）、`buildImageBody` 只带 `{prompt, image_size?}`、扁平应答解析、**DeviceProof 六段必须用 `\n` 连接**（用空格会回 `20403`）、EC 签名能签出、以及图片 URL 转换。
- **英文 README**（`README.en.md`），两个语言版本顶部互相可点切换。

### 顺带

- `parseDigest` 对 `SHA256:` 大写算法名原本返回 `undefined`（正则没加 `i`），导致合法 digest 被当成「没有 digest」而静默降级。已修并有测试钉住。
- `pack.cjs` 清单加上 `node/update.cjs`；`e2e-package.js` 的必需文件断言同步加。

### 测试

`update-chain 50/0`、`feature-offline 39/0`、`host-guard 13/0`、`responses-status 19/0`、`upstream-contract 16/0`、`e2e-package 25/0`、`e2e-panel 17/17`、`e2e-brain 13/13`、`verify-manifest PASS`。

---

## 0.1.7

**2026-11-03** · 面板与插件描述写全三套协议

### 改了什么

1. **面板「在 Cindy 里接入」不再只写 OpenAI 一种协议**。现在列出 Chat Completions / Responses / Anthropic Messages 三选一，并说明 Responses 保留 Base URL 末尾的 `/v1`、Anthropic 用同一个 Base URL 与同一个 API Key。三套协议本来就都实现了（`/v1/chat/completions`、`/v1/responses`、`/v1/messages`），只是面板文案一直停在最早那一版。
2. **`ghost.json` 的 `description` / `whenToUse` 重写**。说明起的是三协议本地端点、模型 ID 与实测上下文窗口由插件自己公布；适用场景补上「问该选哪个协议」「问上下文窗口填多少」「问能不能画图」「问有没有新版本」。
3. **发布清单与描述对齐**。`releaseNotes` 里点明文生图与自查更新两项能力，不再只有最早那版的三句话。

### 为什么值得单独发一版

Cindy 的「插件管理」页展示的是插件清单快照（`ghost-install-state/_ns/_root/<id>.json` 里的 `manifest`），只覆盖运行文件不会刷新它 —— 于是会出现「代码是新的、管理页还写 v0.1.0、Tools 还是旧的」。这一版把清单一起重写，安装脚本同时更新快照与 `packageSha256`，管理页才对得上。

---

## 0.1.6

**2026-11-03** · 补齐三条以前写在「已知限制」里的能力：token 自动续期、文生图、自查更新

### 新增

1. **token 自动续期**。以前 Trae 的登录凭据一过期就只能重开客户端重登。现在走 Trae 自己的 `POST /trae/api/v3/oauth/ExchangeToken`：DeviceProof 用 `storage.json` 里 `iCubeAuthInfo://icube-dc:*` 的 EC 私钥签（`sign('sha256', …)`，Node 会按 PEM 自动判 ECDSA，写成 `RSA-SHA256` 会直接抛），六段待签串必须用 `\n` 连接，用空格会回 `20403 Token device not match`。快到期（<5 分钟）时提前换；对话撞上 401/1001 时当场换一次再重试同一个请求。换到的票只放内存、不写回 `storage.json`（Trae 客户端自己也在写那个文件，从外面改会被它下一次 flush 覆盖）。老客户端没有设备密钥对时自动退回 legacy 接口（`/cloudide/api/v3/trae/oauth/ExchangeToken`，无 DeviceProof）。
2. **文生图**。新工具 `trae_draw_image`，走 `POST /api/ide/v1/tool_text_to_image`（模型 `seedream_5`，body 只允许 `{prompt, image_size?}`，多带一个字段就被网关 400 拒），再 `POST /api/ide/v1/get_resource_url` 换签名地址，最后裸 GET 下载（签名在 query 里，不能带 Trae 头）。图片落到数据目录 `images/trae-<时间戳>-<随机>.<ext>`，返回路径与体积。尺寸总像素必须落在 `[3686400, 16777216]`，默认 `1920x1920`。
3. **自查更新**。面板新增「检查更新」按钮，工具侧新增 `trae_update`（`action=check` / `apply`）。读 GitHub Releases 的 REST 接口（公开仓库匿名可读，不依赖 gh CLI 与代理配置），下载 `.cindy`、解到暂存目录，然后交给一个 detached PowerShell 脚本等本进程退出后再替换安装目录 —— Windows 上正在运行的 `.js` 被锁，自己覆盖自己一定 EBUSY／EPERM。替换前整目录备份成 `<安装目录>.bak-<旧版本>`，Cindy 约 24 秒后用新文件重新拉起 worker。

### 顺带

- `main.js` 的 `callWorker` 现在能带 `params`（文生图的 prompt/size 与更新的 action 都要传参）；面板侧新增 `checkUpdate` / `applyUpdate` / `drawImage` 三个 action。
- `worker.cjs` 顶部补 `zlib` / `spawn` / `existsSync` 的 require（解 zip 与起后台脚本用）。

### 测试

`features 51/0`、`host-guard 13/0`、`responses-status 19/0`、`upstream-contract 16/0`、`smoke-protocols 19/0`、`smoke-tools 11/0`、`wire-quirks 10/0`、`e2e-package 24/0`、`e2e-panel 17/17`、`e2e-brain 13/13`、`verify-manifest PASS`。

---

## 0.1.5

**2026-11-03** · 修代码审查（issue #1）报的 7 项

### 修了什么

1. **并行工具调用被拆坏**（P1）。上游把两次工具调用的分片交错着发：首帧 A/B 各带 id 和半截参数，次帧只带参数增量、`name` 是空串。旧实现的 `writeAnthropicStream` 见到新 index 就 `closeOpen()` 把已开的块全关掉，结果是 4 个 `tool_use` 块、后两个名字是空。现在按上游 index 独立累计 id/name/arguments，整轮读完再逐个吐完整块；文本仍照常流式。
2. **缺结束信号就 EOF 被当成正常说完**（P1）。只吐一段文本然后断流、既没有 `finish_reason` 也没有结束事件时，旧实现照常收尾，半截回答会被当完整结果交给 Cindy。现在四个出口（Anthropic 流/非流、Responses 流/非流）都要求见到明确结束信号，否则抛「上游在结束信号到达前就断开了连接」。
3. **下游断开不取消上游**（P2）。原先只听 `req` 的 `close`，但客户端断开时请求流往往已经 end 过、事件早发完了。现在同时听 `res` 的 `close`，且只在 `!res.writableEnded` 时 abort；正常结束时摘掉监听。
4. **Anthropic / Responses 两路本地账本漏记输出 token**（P2）。之前无论上游给不给 usage，这两路都固定记 `输出 = 0`。现在适配器把真实 usage 回传，worker 优先记真实值，缺失才当 0。
5. **上游明确的 4xx/5xx 被一律盖成 502**（P2）。`errorStatusOf()` 先看能不能排队重试（→503），再看 `err.status` 是不是合法 4xx/5xx（照原样透出），实在分不清才 502。`trae.cjs` 的 `statusOfTraeCode` 补上 `4008/4222 → 402`（额度耗尽）、`2001 → 503`（服务端临时缺口），`humanizeUpstreamError` 的 `1005` 分支不再抢 `status === 402`，免得把额度用尽说成「需要付费套餐」。
6. **.cindy 包里没有许可与第三方声明**（P2）。MIT 要求分发时随附许可与版权声明，而装到别人机器上的包才算真分发。`pack.cjs` 的清单改成 `{from, name}` 结构，从仓库根一并打进 `LICENSE` / `NOTICE` / `THIRD-PARTY-NOTICES.md`。
7. **模型缓存二次归一化**（P1）。`models.json` 里存的是已经 `normalizeModel` 过的对象，无凭据分支读缓存时又 `.map(normalizeModel)`，把 `key` / `effortLevels` / `priceFactor` 全抹成 `undefined`，表现为模型名变成 `undefined`、档位消失、倍率丢失。现在读缓存直接用。

### 另外

- `trae.cjs` 的上游请求补 180 秒总超时（与 qoder 桥一致）；流 reader 用 `finally` 主动 `cancel()`，不再留悬挂连接。
- 新增 `test/upstream-contract.js`：把上面第 1、2、4 项做成纯离线回归（交错分片、四种出口的截断判定、usage 回传），不需要登录态和额度。
- `test/e2e-package.js` 增加三条断言：包里必须含 `LICENSE`、`NOTICE`、`THIRD-PARTY-NOTICES.md`。

### 测试

`features 51/0`、`host-guard 13/0`、`responses-status 19/0`、`upstream-contract 16/0`、`smoke-protocols 19/0`、`smoke-tools 11/0`、`wire-quirks 10/0`、`e2e-package 24/0`、`e2e-panel 17/17`、`e2e-brain 13/13`、`verify-manifest PASS`。

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
