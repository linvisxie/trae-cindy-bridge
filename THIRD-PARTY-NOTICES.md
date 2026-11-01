# 第三方声明

本项目包含来自下列第三方作品的研究成果与代码。原文版权与许可如下，**分发本项目时必须一并保留本文件**。

---

## 一、骨架移植来源

### cindy-qoder-bridge

- 版本：`0.1.12`（骨架取自该版本）
- 作者：linvis（本项目作者本人）
- 许可：MIT
- 说明：本项目是从作者自己的 `cindy-qoder-bridge` 整体复制骨架后改造而来，不是独立从零编写。

#### 本项目用到了它的哪些部分

| 内容 | 说明 |
|---|---|
| 插件清单结构（`ghost.json` 的 `schemaVersion` 3 / `launch: "resident"` / `node.entry` / `tools` / `panel` 形状） | 结构沿用，字段值全部换成 Trae 的 |
| worker 启动与端口复用判定（首选端口、等待宽限、探测对方是否健康后让位） | 逻辑沿用 |
| JSON-RPC-stdio 的请求/响应封装，以及面板 ↔ 电子脑的双层信封剥离 | 逻辑沿用 |
| 三协议适配层的骨架（OpenAI Chat ↔ Anthropic Messages ↔ OpenAI Responses 的请求/流式翻译） | 结构沿用，上游对接全部重写 |
| 日志落盘与轮转、本地用量账本（按天按模型、原子写） | 逻辑沿用 |
| 打包脚本与清单静态校验脚本 | 沿用 |

上游协议层（身份头、请求体整形、凭据解密、模型目录、额度/签到端点）**不来自该项目**，是本次按 Trae 的实际接口重新实现的。

#### 原许可全文

```
MIT License

Copyright (c) 2026 linvis

Permission is hereby granted, free of charge, to any person obtaining a copy
of this software and associated documentation files (the "Software"), to deal
in the Software without restriction, including without limitation the rights
to use, copy, modify, merge, publish, distribute, sublicense, and/or sell
copies of the Software, and to permit persons to whom the Software is
furnished to do so, subject to the following conditions:

The above copyright notice and this permission notice shall be included in all
copies or substantial portions of the Software.

THE SOFTWARE IS PROVIDED "AS IS", WITHOUT WARRANTY OF ANY KIND, EXPRESS OR
IMPLIED, INCLUDING BUT NOT LIMITED TO THE WARRANTIES OF MERCHANTABILITY,
FITNESS FOR A PARTICULAR PURPOSE AND NONINFRINGEMENT. IN NO EVENT SHALL THE
AUTHORS OR COPYRIGHT HOLDERS BE LIABLE FOR ANY CLAIM, DAMAGES OR OTHER
LIABILITY, WHETHER IN AN ACTION OF CONTRACT, TORT OR OTHERWISE, ARISING FROM,
OUT OF OR IN CONNECTION WITH THE SOFTWARE OR THE USE OR OTHER DEALINGS IN THE
SOFTWARE.
```

---

## 二、协议研究参照

下列项目的实现与文档是 Trae 侧协议事实的来源。本项目的代码为独立编写，未直接复制其源码；但端点、身份头集合、请求体形状、凭据封装格式、模型通道顺序、错误码语义等结论来自对它们的阅读与实测核对。**这些项目的版权声明同样需要保留**。

### dsh-connect-trae

- 版权：Copyright (c) 2026 LaoDing
- 许可：MIT
- 仓库：<https://github.com/dingminhua/dsh-connect-trae>

借鉴的内容：

| 内容 | 说明 |
|---|---|
| 对话端点 `https://trae-api-cn.mchost.guru/api/agent/v3/llm_utils_chat` 与 `Cloud-IDE-JWT` 身份头体系 | 端点与头名 |
| 请求体形状（`messages` / `model` / `config_name` / `function` / `stream` / `tools` / `reasoning_effort`） | 字段口径 |
| `tools[].function.parameters` 必须序列化成字符串 | 上游约束 |
| 凭据 `iCubeAuthInfo://icube.cloudide` 的自有 AES-128-CBC 封装结构与 `sha512(sha512(random) || salt)` 派生方式 | 解密算法 |
| 模型目录按函数通道逐个问 `get_detail_param` 的通道顺序与并集合并策略 | 通道列表 |
| 额度 / 签到 / 活动端点与「按北京日幂等」的领取语义 | 端点与判据 |
| 错误码语义（`1005` / `2001` / `4001` / `4008` / `4011` / `4023` / `4222`） | 码表含义 |
| 「失败藏在 HTTP 200 的 SSE body 里」这一现象及 peek 头部的应对 | 行为事实 |

该项目的产品化能力（文生图、账号池、上下文预算档位等）**本项目没有实现**。

### dsh-trae-api

- 版权：Copyright (c) 2026 Wang-JQ77
- 许可：MIT
- 仓库：<https://github.com/Wang-JQ77/dsh-trae-api>

借鉴的内容：Trae 网关的请求/响应形状与流式分帧行为、工具调用在 SSE 里的表达方式、模型通道与模型的对应关系。`dsh-connect-trae` 的 README 亦致谢该项目，两者在协议事实上互相印证。

#### 上述两个项目的 MIT 许可全文

```
MIT License

Copyright (c) 2026 LaoDing
Copyright (c) 2026 Wang-JQ77

Permission is hereby granted, free of charge, to any person obtaining a copy
of this software and associated documentation files (the "Software"), to deal
in the Software without restriction, including without limitation the rights
to use, copy, modify, merge, publish, distribute, sublicense, and/or sell
copies of the Software, and to permit persons to whom the Software is
furnished to do so, subject to the following conditions:

The above copyright notice and this permission notice shall be included in all
copies or substantial portions of the Software.

THE SOFTWARE IS PROVIDED "AS IS", WITHOUT WARRANTY OF ANY KIND, EXPRESS OR
IMPLIED, INCLUDING BUT NOT LIMITED TO THE WARRANTIES OF MERCHANTABILITY,
FITNESS FOR A PARTICULAR PURPOSE AND NONINFRINGEMENT. IN NO EVENT SHALL THE
AUTHORS OR COPYRIGHT HOLDERS BE LIABLE FOR ANY CLAIM, DAMAGES OR OTHER
LIABILITY, WHETHER IN AN ACTION OF CONTRACT, TORT OR OTHERWISE, ARISING FROM,
OUT OF OR IN CONNECTION WITH THE SOFTWARE OR THE USE OR OTHER DEALINGS IN THE
SOFTWARE.
```

---

## 三、名称与商标

「Trae」「Trae CN」「Cindy」等名称与商标归各自所有者所有。本项目仅将其用于指代相应的软件与服务，不表示任何隶属、赞助或背书关系。
