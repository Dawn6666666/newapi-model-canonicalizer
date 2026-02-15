# Rules Reference（与 Userscript 默认实现对齐）

这份文档用于说明 Userscript 当前默认采取的“归一化 + 排除 + 写库约束”。它更偏 **规则参考/审计**：

- 想了解“怎么用”：看 `docs/USAGE.zh-CN.md`
- 想了解“实现细节 + 设计理由”：看 `userscript/README.md`
- **最终以代码为准**：`userscript/newapi-model-canonicalizer.user.js`

本仓库还提供两份样例 JSON（便于你把规则复制到别处或做二次开发）：

- `examples/rules.sample.json`
- `examples/standards.sample.json`

---

## 1) Canonical Key 形态（硬约束）

canonical key 是写回 `model_mapping` 的 key（标准名），必须满足：

- 只允许：`a-z`、`0-9`、`.`、`-`（全小写）
- 禁止：`/`（组织前缀永远不进 key）
- 代码约束（与 `canonicalOk()` 一致）：
  - 正则：`^[a-z0-9][a-z0-9.-]*[a-z0-9]$`
  - 必须以家族前缀开头：
    - 大多数家族：`${family}-`
    - gpt 家族例外：允许 `gpt-` 以及 `o1/o3/o4` 前缀（见 FAMILY_PROFILES）

推荐形态（不是强制，但建议遵循）：

- `family-version-tier(-mode)?(-buildTag)?`

例：

- `claude-4.5-sonnet`
- `deepseek-v3.1`
- `qwen-3-235b-a22b-instruct-2507`
- `claude-3.7-sonnet-thinking`

---

## 2) 排除规则（不会进入重定向）

### 2.1 route/tag 精确黑名单（exact match）

这些名字本质是路由/池化/编排标签，不应参与重定向：

- `openrouter/free`
- `openrouter/auto`
- `openrouter/bodybuilder`
- `switchpoint/router`
- `switchpoint/auto`
- `switchpoint/free`

（可按你的语料继续扩充，采用 **精确匹配**，避免误杀真实模型。）

### 2.2 pointer aliases（指针别名）

`*-latest/*-default/*-stable/*-current` 这类属于“指针别名”，脚本默认跳过（不参与重定向候选）：

- `openai/chatgpt-4o-latest`
- `anthropic/claude-3.7-sonnet-latest`

实现细节：匹配 `/(?:-|:)(latest|default|stable|current)$/i`

### 2.3 HARD wrapper 前缀（prefix：直接排除）

你希望这类模型“需要时直接调用完整名”，不希望它们进入通用重定向（避免误伤）：

- `image/`
- `embedding/`
- `rerank/`
- `moderation/`
- `stream/`
- `streaming/`
- `假流式/`
- `伪流式/`
- `流式抗截断/`
- `抗截断/`
- `代理/`、`中转/`、`加速/`

### 2.4 MODE wrapper 前缀（prefix：剥离前缀，但保留 mode）

这类表示“同款模型的 mode”，脚本会剥离前缀，并把 mode token 合并到 canonical 后缀：

- `thinking/`
- `reasoning/`
- `high/`
- `medium/`
- `low/`

### 2.5 专项模型（specialized）排除

专项/非通用对话入口默认排除（示例关键词）：

- `robotics`
- `computer-use`
- `tts` / `asr` / `stt` / `speech` / `transcription`
- `embed` / `embedding` / `*-embed`
- `rerank` / `moderation`
- `image-generation` / `video-generation`

### 2.6 用途/限额/渠道标注（annotated）排除

带用途标记的模型（通常出现在括号/中括号里）不参与重定向：

- `gpt-5-nano [渠道id:33][輸出3k上限]`
- `xxx（翻译专用）`

常见关键词（示例）：

- 渠道/channel/channelid/id:
- 上限/limit/quota
- 输出/輸出/output
- 翻译/translate/translation
- 专用/only
- 限速/rate
- 低延迟/latency

---

## 3) 归一化规则（会影响 canonical 的生成）

### 3.1 组织前缀（org/）与发布方包装器（publisher-）

脚本会尽量把 “org/model” 的 org 部分从 canonical 中剥离（canonical 不允许含 `/`），常见组织前缀包括：

- `anthropic/`、`openai/`、`google/`、`x-ai/`
- `deepseek-ai/`、`zai/`、`z-ai/`、`zhipuai/`
- `groq/`、`routeway/`、`moonshotai/`
- `meta-llama/`、`qwen/`、`tngtech/`
- `pro/`、`org/`、`vip/`（常见 wrapper）

另外还存在 dash 连接的发布方前缀包装器（只在“剩余部分能明确识别家族”时才剥离）：

- `zai-`、`groq-`、`routeway-`、`deepseek-ai-`
- `openai-`、`anthropic-`、`google-`
- `meta-`、`x-ai-`、`xai-`
- `openrouter-`、`switchpoint-`

### 3.2 mode tokens（同款模型模式）

这些 token 作为 canonical 后缀的一部分（不是专项模型）：

- `thinking`、`reasoning`、`high`、`medium`、`low`

---

## 4) pinned key（批次锁定）

启用 pinned key 时，脚本除 base canonical 外，还会额外生成 `base-buildTag` 形式的 key：

- `deepseek-r1-0528`
- `claude-4.5-sonnet-20250929`
- `kimi-k2-instruct-0905`

并且 pinned key 允许复用同一个 actual value（因为它是同款模型的“批次锁定入口”）。

buildTag 的来源（与代码一致）：

- Claude/Gemini/GPT：更偏向 8 位发布日期（例如 `20250929`）
- Qwen/DeepSeek/GLM/Kimi：更偏向 4 位批次号（例如 `2507/0528/0414/0905`）

以 `FAMILY_PROFILES.<family>.pinnedPolicy` 为准（accept4/accept6/accept8）。

---

## 5) 写库不变量（Invariants）

脚本生成并写回的 `model_mapping` 必须满足：

1. key 只能是 canonical（标准名），不会把原始别名当作 key
2. value 必须是该渠道 `models` 中真实存在的字符串（actual full name）
3. 禁止互映/回环：
   - 不允许 `A->B` 同时 `B->A`
   - 不允许更长链条循环 `A->B->C->A`
4. actual value 默认不复用（同一渠道内一个 actual 只服务一个 base key）
   - pinned key 例外：允许 base 与 pinned 复用同一个 actual

