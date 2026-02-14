# New-API Model Redirect Toolkit (Userscript)

这是一个运行在浏览器里的 Userscript（Tampermonkey/Violentmonkey），用于在 `New-API` 的渠道管理页（`/console/channel`）中：

- 拉取所有渠道的 `models` 原始模型列表（快照）。
- 对模型名进行归一化（canonicalization），把“同系列同版本同 tier(+mode/+build)”的各种别名折叠到同一套标准 key。
- 生成每个渠道的 `standard(canonical) -> actual(真实模型名)` 的重定向映射计划（dry-run）。
- 在你审阅后，将计划写回渠道的 `model_mapping` 字段（apply）。

核心目标：在上游命名参差不齐的情况下，让下游始终用统一模型名调用，同时 **禁止别名互映/回环**，并尽量避免“专项模型/路由标签/用途标记”污染重定向。

---

## 适用场景

- 你有很多供应商渠道，模型名存在前缀/后缀/大小写/分隔符差异（如 `anthropic/claude-sonnet-4.5`、`claude-sonnet-4-5`、`claude-4.5-sonnet`）。
- 你希望把它们统一到一个“标准调用名”（canonical key），例如统一用 `claude-4.5-sonnet` 调用。
- 你已经启用了 New-API 的负载均衡/权重/优先级，希望模型命名统一后由 New-API 做路由与容灾。

---

## 安全与边界

1. 本脚本 **不需要你输入密码**。
2. 请求 New-API 的方式：
   - 使用浏览器当前已登录的会话 Cookie（`credentials: include`）。
   - 从 `localStorage.user` 读取 `user.id` 与 `user.token`（如存在）并拼接请求头：
     - `New-Api-User: <id>`
     - `Authorization: Bearer <token>`（如果 `token` 存在）
3. 本脚本只在本地存储以下缓存（IndexedDB）：
   - `settings`：`pinnedKeys`、`theme`
   - `snapshot`：全量渠道快照（`channels[]`）
   - `plan`：dry-run 的结果（每渠道 before/after/diff/reasons/warnings）
4. 本脚本不会上传你的 Token/渠道数据到第三方；所有计算在浏览器本地完成。
5. 权限要求：
   - 仅“预览 / dry-run”：能访问 `GET /api/channel/` 即可（通常是已登录后台可见渠道列表的权限）。
   - “写入数据库”：需要你当前登录用户对渠道有 `PUT /api/channel/` 的更新权限，否则会写入失败。

---

## 接口与字段（New-API）

本脚本当前依赖的接口（以相对路径表示）：

1. 拉取渠道列表（分页）
   - `GET /api/channel/?p=<page>&page_size=<N>&id_sort=true&tag_mode=false&status=-1`
   - 关键字段使用：
     - `id` / `name` / `group` / `status`
     - `models`：逗号分隔字符串或数组（脚本统一转成 `models[]`）
     - `model_mapping`：JSON 字符串（脚本解析为对象；非法 JSON 当作 `{}`）
2. 写回渠道映射
   - `PUT /api/channel/`
   - payload：
     - `{ id: <number>, model_mapping: "<json-string>" }`

鉴权与请求头：

- `credentials: "include"`（使用当前浏览器登录态 Cookie）
- `New-Api-User: <user.id>`（来自 `localStorage.user`）
- `Authorization: Bearer <user.token>`（如果 `localStorage.user.token` 存在）

兼容性提醒：

- 如果 New-API 未来调整了 `localStorage.user` 的结构或 `/api/channel/` 参数/字段名，需要同步更新脚本里的 `mustGetUser()` / `newApiHeaders()` / `loadSnapshot()`。

---

## UI 结构

脚本提供两种 UI：

1. **右下角小浮窗（预览页）**
   - 用于快速：刷新快照、运行 dry-run、打开仪表盘。
   - 只显示少量摘要信息（避免信息噪音）。

2. **仪表盘（新窗口 about:blank）**
   - 三栏布局：渠道列表 / 映射视图（Diff/Plan/DB）/ 详情与操作。
   - 支持搜索、分页、只看 enabled、只看有变更、只看异常。
   - 写库动作（apply）只在仪表盘里执行，并在执行前再次确认。

主题：
- 支持暗色/亮色两套（Claude 风格暖纸张/暖暗色），右上角太阳/月亮图标切换。
- 主题选择会持久化到 `IndexedDB(settings.theme)`。

---

## 工作流（推荐）

1. 打开 New-API 渠道管理页：`/console/channel`
2. 右下角点击「模型重定向」打开浮窗
3. 点击「刷新全量渠道」
   - 拉取 `/api/channel/?p=...&page_size=...` 分页数据
   - 解析 `models` 为数组、`model_mapping` 为 JSON
   - 生成并缓存快照（IndexedDB: `snapshot`）
4. 点击「运行 dry-run」
   - 使用 Web Worker 在浏览器里计算每个渠道的重定向计划
   - 输出 `plan` 并缓存（IndexedDB: `plan`）
5. 点击「打开仪表盘」
   - 左侧选渠道，查看 Diff/Plan/DB
   - 确认无误后再「写入此渠道」或「写入数据库」

缓存与一致性提示：

- `plan` 会记录 `script_version` 与 `snapshot_ts`。
- 当脚本版本变化或快照变化时，仪表盘会提示“建议重跑”，避免你拿旧 plan 写入新快照导致不一致。

写入前检查清单（建议每次 apply 前扫一遍）：

- Diff 视图里没有明显“误伤”的专项模型（tts/embed/rerank/robotics/computer-use 等）。
- `仅异常`（anom）为空，或你能解释清楚异常来源（value 不在 models 会写回失败或产生不可用映射）。
- `pinned key` 开关符合你的预期：
  - 需要“锁批次”时开启（会生成 `*-2025xxxx` / `*-0414` / `*-2507` 等 key）
  - 只想要基础基准模型时关闭

---

## 数据结构（关键字段）

### 1) snapshot（快照）

每个渠道记录（简化）：

- `id`：渠道 ID
- `name`：渠道名
- `group`：分组字符串（可能包含多个）
- `status`：1 启用，其它为禁用
- `models[]`：渠道上报的原始模型列表（字符串数组）
- `model_mapping{}`：数据库当前的映射 JSON（key/value）

### 2) plan（计划）

每个渠道都会得到一个 `rec`（简化）：

- `before{}`：写入前映射（合并/清理前）
- `after{}`：写入后映射（canonical key -> actual full name）
- `diff`：
  - `added{}`：新增条目
  - `removed{}`：移除条目
  - `changed{}`：变更条目（同 key 不同 value）
- `reasons`：解释某条 key 为什么选了某个候选（用于 Diff 的 tag）
- `warnings[]`：潜在风险或非致命问题

仪表盘里 `Diff/Plan/DB` 的含义：
- `Diff`：展示 `before -> after` 的变化（更适合审阅）
- `Plan`：展示将要写入的 `after{}`
- `DB`：展示当前数据库已有的 `model_mapping{}`

### Diff 标签（reasons）说明：date/org/pinned/mode 等

仪表盘的 Diff 视图中，`to` 列右侧会附带一些小标签（chip）。它们来自 `rec.reasons[key].reasons[]`，用于快速解释“为什么选了这个 actual 候选 / 为什么保留旧值 / 为什么生成 pinned key”。

常见标签含义（覆盖脚本当前实现）：

- `keep_old`
  - 表示该条映射来自“保留旧映射”逻辑：旧 key 本身是标准 canonical，旧 value 在本渠道真实 `models` 中存在，且不会导致互映/回环/复用冲突。
- `old`
  - 表示在候选 actual 选择阶段，该候选正好是旧映射里出现过的 value（倾向于保留，减少 churn）。
- `org`
  - 表示候选 actual 含组织前缀（如 `anthropic/...`、`google/...`、`openai/...`），通常更像真实模型名，因此会提高候选评分。
- `date`
  - 表示候选 actual 名称中包含明显的日期后缀（形如 `-20250807` / `-20250929` 等），脚本倾向选择更“官方版本化”的命名。
- `build`
  - 表示候选 actual 中包含 4 位 buildTag（如 `0528`/`0414`/`0905`/`2507`），脚本会略微加分；该 token 也可能被用于 pinned key（取决于 family profile）。
- `mode`
  - 表示候选 actual 明确包含 mode token（如 `-thinking` 或 `:thinking`），属于“同款模型的 mode”而非专项模型。
- `pinned`
  - 表示该条 key 是 pinned key（`base + "-" + buildTag`），用于锁定到某个批次/发布日期；它会映射到同一个 actual value（允许复用）。
- `wrapper`
  - 表示候选 actual 带有 wrapper 痕迹（例如包含 `cursor2`）。该标签通常意味着“特殊入口”，脚本会尽量避免把它归并到基础模型（具体行为以 normalize / dropWrapperTokens 为准）。

提示：

- 这些标签是“解释性信息”，不参与写库本身；但对你判断是否误伤/是否需要加黑名单非常有用。
- `pinned/date/build` 相关标签通常会一起出现（因为 pinned 的来源往往是日期/buildTag）。

### 异常（anom）说明：为什么某些行会变红

Diff/Plan/DB 视图里，脚本会校验当前展示的 value 是否真实存在于渠道 `models` 列表：

- 如果某条 value 不在 `models` 中，会标记为异常（行底色偏红）。
- “仅异常”开关会只保留这些异常行，方便你定位“写回了不存在模型名”的风险。

---

## 本地缓存（IndexedDB）与清理

脚本使用 IndexedDB（默认库名 `na_mr_toolkit`，store `kv`）做三类缓存：

- `settings`：`{ pinnedKeys, theme }`
- `snapshot`：全量渠道快照（渠道数多时体积较大）
- `plan`：dry-run 结果（可能非常大，取决于渠道数量与 diff 规模）

清理方式（两种选一）：

1. 在浏览器开发者工具中：
   - Application / 存储（Storage） -> IndexedDB -> `na_mr_toolkit` -> 删除
2. 直接点击「刷新快照」强制拉取，并重新 dry-run：
   - 会覆盖旧缓存；写入成功后脚本也会把 `snapshot` 置空，提示你下次刷新。

提示：如果你发现“plan 还是旧的 / 主题不对 / 显示异常”，优先清理缓存或强制刷新快照。

---

## Canonicalization（归一化）原则

### 目标（一句话）

只把 **“同系列、同版本、同 tier（可选 +mode、可选 +build/date）”** 的别名折叠到同一个 canonical key，并保证重定向写回后满足“不互映/不回环/不写不存在模型”。

例如（同语义）：
- `claude-4.5-sonnet`
- `claude-sonnet-4-5`
- `anthropic/claude-sonnet-4.5`

统一 canonical key：
- `claude-4.5-sonnet`

### 输入/输出（规范化定义）

脚本在归一化阶段会把原始字符串 `rawModelName` 转成一个结构化结果（概念上）：

- `family`：归属家族（claude/gemini/gpt/qwen/deepseek/grok/glm/kimi/llama/mistral）
- `canonical`：标准 key（最终写回 `model_mapping` 的 key 只能用这个）
- `annotated`：是否“用途/限额/渠道标注”模型（是则直接排除，不参与重定向）
- `specialized`：是否专项/模态/管道模型（如 robotics/tts/embed/rerank 等，是则排除）
- `buildTag`：可选的批次号/发布日期（用于 pinned key）
- `modes[]`：可选模式 token（thinking/reasoning/high/low/medium），会被并入 canonical（属于同款模型的 mode）

最终写回数据库时：

- key：只使用 `canonical`（或 `canonical + "-" + buildTag` 的 pinned key）
- value：必须使用渠道 `models` 里真实存在的原始字符串（actual full name）

### 标准集合（standard set）从哪里来

脚本在 dry-run 时需要一组“标准模型 canonical key”作为重定向的 key 来源：

1. **内置标准集合**：`DEFAULT_STANDARDS`
   - 这是一个稳定的默认清单，覆盖常用大模型家族的主流基准模型。
2. **自动补全标准集合**：从渠道 `models` 中推导
   - 脚本会扫描快照里所有渠道的原始 `models`，对每个模型做归一化后，将得到的 canonical 作为候选标准名；
   - 但会排除：
     - 用途/限额标注（`annotated=true`）
     - 专项/模态/管道模型（robotics/tts/embed/rerank 等）
     - 硬 wrapper 前缀（`image/`、`embedding/`、`假流式/` 等）
   - 最终对候选 canonical 进行 `canonicalOk()` 校验：形态不合法（含 `/`、含非法字符、前缀不匹配 family）会被丢弃。

你可以把它理解为：

- `DEFAULT_STANDARDS` 提供“基础基准模型清单”
- “自动补全”提供“从语料中长出来的增量基准模型清单”

两者合并后，才是该次 dry-run 的标准集合（也会写进 `plan.standardsByFamily`，便于复现/审计）。

### canonical 的形态约束（硬规则）

canonical key 必须满足：

1. **只能包含**：`a-z`、`0-9`、`.`、`-`（并且全小写）
2. **不允许出现**：`/`（组织前缀永远不能进入 canonical key）
3. **不允许出现**：空 token（例如 `deepseek-` 这种）
4. 推荐形态（可执行规格）：
   - `family + "-" + version + "-" + tier + ( "-" + mode )? + ( "-" + buildTag )?`

示例：

- `claude-4.5-sonnet`
- `claude-3.7-sonnet-thinking`
- `deepseek-r1-0528`（pinned）
- `qwen-3-235b-a22b-instruct-2507`（pinned）
- `glm-4-32b-0414`（pinned，base 为 `glm-4-32b`）

### 归一化流程（从 raw 到 canonical）

为了减少误伤，脚本采用“先清洗、再识别家族、再按家族解析版本/形态”的流程。你可以把它理解为：

1. **用途备注清洗（不改变 actual，仅影响 canonical）**
   - 先移除中括号/小括号的备注文本：
     - `gpt-5-nano [渠道id:33][輸出3k上限]` -> `gpt-5-nano`
   - 但只要检测到“用途/限额/渠道标注”，就直接标记为 `annotated=true`，后续 **不参与重定向**。

2. **统一分隔符**
   - 全小写
   - `_` / `.` / 空格 / `:` 等统一折叠为 `-`
   - `:thinking` 会被视作 `-thinking`（进入 mode token 的候选）

3. **提取 wrapper（前缀包装器）**
   - “硬 wrapper”（HARD wrapper）：`image/`、`embedding/`、`假流式/`、`流式抗截断/` 等：
     - 这类模型通常是专项用途入口，你的策略是“直接用完整模型名调用”，因此 **不参与重定向**（避免误伤）。
   - “mode wrapper”（MODE wrapper）：`thinking/`、`reasoning/`、`high/`、`low/` 等：
     - 会剥离前缀，但把 `thinking/reasoning/high/...` 作为 mode token 合入 canonical。
     - 例：`thinking/grok-4.1-thinking-1129` -> mode=`thinking`，主体=`grok-4.1-thinking-1129`

4. **组织/供应商前缀剥离（不进入 canonical）**
   - `anthropic/xxx`、`google/xxx`、`openai/xxx` 等 `/` 前缀只用于辅助识别 family，最终 canonical 不保留 `/`。

5. **publisher dash 前缀剥离（谨慎）**
   - `zai-`、`routeway-`、`groq-`、`deepseek-ai-` 等常见“发布方包装器”：
     - 仅当剥离后能明确落到某个 family 时，才允许剥离；
     - 避免把未知模型误剥离导致 “deepseek-” 这种残缺 key。

6. **token 清洗与折叠**
   - 折叠相邻重复 token：`kimi-k2-thinking-thinking` -> `kimi-k2-thinking`
   - 丢弃一些明确的 wrapper token（例如 `cursor2`）：
     - 你已明确：`cursor2-*` 多为特殊用途入口，不应归并到基础模型，因此默认不进入 canonical。

7. **识别 family**
   - 优先从主体 tokens 判断家族（如 `claude/gemini/gpt/qwen/deepseek/grok/glm/kimi/llama/mistral`）。
   - 对 gpt 家族兼容：`o1/o3/o4` 这类前缀也归到 gpt 体系（canonical 允许 `o1-*` 等）。

8. **按家族解析 version/tier/mode/build**
   - 每个家族都有自己的解析器（`normalizeClaude/normalizeGemini/...`）。
   - 原则：只合并“同版本同 tier”。

### 候选 actual 的选择（为什么会选这个 value）

当某个 standard canonical key 在渠道里不存在同名模型时，脚本会在“同 canonical 分组的原始变体”里挑一个最合适的 `actual`。

当前实现是一个可解释的打分策略（会在 Diff 里用 tags 展示原因）：

- 倾向保留旧 value（`old` / `keep_old`）：减少无意义 churn，保护手工配置
- 倾向选择带组织前缀的真实名（`org`）：例如 `anthropic/...`、`google/...`
- 倾向选择带明显日期后缀的版本化名（`date`）：例如 `-20250929`
- 轻微偏好带 4 位批次号的版本（`build`）：例如 `-0528`/`-0414`
- 识别并保留同款模型 mode（`mode`）：例如 `-thinking` / `:thinking`
- 强烈避开 wrapper 型入口（例如 `假流式/`、`流式抗截断/` 会被显著降权）

注意：无论打分多高，候选必须满足硬约束：

- 必须是渠道 `models` 中真实存在的原始字符串
- 不能落入标准集合（避免别名互映/回环温床）
- 默认不能复用同一个 actual value（pinned key 例外）

### pinned key（批次锁定）规则

启用 pinned key 后，一个 base canonical 可能会产出两类 key：

1. **base key**（永远存在）
   - 例：`claude-4.5-sonnet`
2. **pinned key**（可选，带 buildTag）
   - 例：`claude-4.5-sonnet-20250929`、`deepseek-r1-0528`、`glm-4-32b-0414`

buildTag 的来源：

- 末尾纯数字 token，按 family profile 决定接受长度：
  - 8 位：`20250807`（常见于 GPT/Claude/Gemini 的发布日期）
  - 4 位：`0414`、`0905`、`2507`（常见于 GLM/Kimi/Qwen/Deepseek 的批次）

pinned key 的语义：

- pinned 只做“批次锁定”，不会改变 base canonical（base 仍用于通用调用/负载均衡）。
- pinned key 允许复用同一个 actual value（不受 “actual 不复用” 限制），因为它本质上是同一条实际模型的“锁定别名”。

### 明确排除（不参与重定向的模型名）

下面这些 raw 模型名会被排除（不加入标准集合、不作为候选 value 的匹配对象）：

1. **route/tag 精确黑名单**
   - 例如：`openrouter/free`、`openrouter/auto`、`switchpoint/router` 等。
2. **硬 wrapper 前缀**
   - 例如：`image/xxx`、`embedding/xxx`、`假流式/xxx`、`流式抗截断/xxx`
3. **用途/限额/渠道标注**
   - 例如包含：`[渠道id:xx]`、`[輸出3k上限]`、`翻译`、`限速` 等
4. **专项/模态/管道模型**
   - robotics、computer-use、tts/asr/stt/speech/transcription、embed/rerank/moderation、image-generation/video-generation 等

你的策略是：这些模型如果要用，直接调用它们在渠道 `models` 中的完整名字，不走重定向。

### “同义折叠”的判定：只折叠同系列同版本同 tier(+mode/+build)

允许折叠（同语义）：

- Claude：
  - `anthropic/claude-sonnet-4.5`
  - `claude-4.5-sonnet`
  - `claude-sonnet-4-5`
  -> `claude-4.5-sonnet`

- Thinking wrapper（mode 保留）：
  - `thinking/grok-4.1-thinking-1129`
  - `grok-4-1-thinking-1129`
  -> base：`grok-4.1-thinking`
  -> pinned（开启 pinned 时）：`grok-4.1-thinking-1129`

- Kimi pinned：
  - `Pro/moonshotai/Kimi-K2-Instruct-0905`
  - `moonshotai/kimi-k2-instruct-0905`
  -> base：`kimi-k2-instruct`
  -> pinned：`kimi-k2-instruct-0905`

不允许折叠（避免误伤）：

- Gemini 专项：
  - `gemini-2.5-pro-preview-tts` 不应折叠到 `gemini-2.5-pro`
- 硬 wrapper：
  - `image/grok-imagine-1.0` 不应生成 `grok-imagine-1.0` 的标准映射
- cursor2 特殊入口：
  - `cursor2-grok-3` 不应折叠到 `grok-3`

### 关键不变量（Invariant）

本脚本的映射生成必须满足：

1. **canonical key 只来自标准集合**（不会用原始别名作为 key）
2. **不允许别名互映/回环**
   - 不允许 `A->B` 且 `B->A`
   - 不允许 `A->B->C->A`
3. **actual value 不复用**
   - 同一个渠道内，一个 actual 模型名默认只会被一个 canonical key 使用
4. **候选 actual 必须来自渠道真实 models 列表**
   - 不会把 canonical/别名写成 value（避免“写回不存在的模型名”）
5. **带用途/限额标记的模型不参与重定向**
   - 例如含 `[渠道id:xx][輸出3k上限]` 的模型，建议用户直接用完整模型名调用

---

## 路由/标签（route/tag）处理

部分模型名本质是“路由/池化/编排标签”，不应参与重定向。

- 采用“精确黑名单”的方式排除，例如：
  - `openrouter/free`
  - `openrouter/auto`
  - `openrouter/bodybuilder`
  - `switchpoint/router`
  - `switchpoint/auto`
  - `switchpoint/free`

你可以按实际语料继续扩充列表。

---

## 写库（apply）行为说明

- “写入数据库”只会写入 **有 diff 的渠道**（无变更不写）
- 写入 API：`PUT /api/channel/`，payload 为：
  - `{ id: <channel_id>, model_mapping: "<json-string>" }`
- 写入完成后会清掉本地 `snapshot` 缓存，提示下次刷新快照

---

## 性能设计

1. **本地缓存**
   - 快照/计划缓存到 IndexedDB，减少重复拉取与重复计算
2. **Web Worker**
   - dry-run 在 Worker 里跑，避免卡住主线程
3. **渲染限制**
   - Diff/Plan/DB 视图在极端情况下会做条目上限（防止浏览器崩溃）

---

## 规模与性能参考（来自 Dawn 实例，2026-02-14）

这不是硬指标，只是帮助你估算“dry-run/渲染/写库”会有多重：

- 渠道数：113
- 渠道 models 总实例数（逗号拆分后的总条目）：10197
- 唯一模型名（去重后）：1199

粗略家族命中（按字符串包含判断，仅作参考）：

- qwen: 1541
- gpt: 1277
- gemini: 1029
- deepseek: 821
- claude: 607
- glm: 640
- llama: 551
- kimi: 549
- mistral: 453
- grok: 336

建议：

- 渠道很多时，优先用“左侧搜索 + 每页 10/20”定位；不要一口气把所有视图全展开滚动。
- dry-run 性能主要受“渠道数量 * 每渠道 models 数量 * 标准集合大小”影响；缓存快照能显著减少重复拉取时间。

---

## 常见问题（排错）

1. 控制台提示 `SyntaxError`
   - 通常是浏览器还在执行旧脚本缓存或装了两份脚本。
   - 脚本启动会打印：`[na-mr] userscript loaded, version=...`，先确认版本是否是最新。

2. API 401 / 无权限
   - 确认你已在 New-API 前端登录（浏览器有有效会话）。
   - `localStorage.user` 必须存在且 `user.id` 正常。

3. 搜索结果出现重复渠道
   - 脚本对快照做了按 `id` 去重；如果仍出现，说明 API 返回的数据本身重复或脚本被重复注入。

---

## 维护与扩展（给开发者）

文件：`newapi-model-redirect.user.js` 是一个单文件脚本，包含：

- 归一化核心：`normalizeModel()` 与各家族 `normalizeX()`（claude/gemini/gpt/qwen/deepseek/grok/glm/kimi/llama/mistral）
- 计划生成：`buildPlanForChannel()`（标准集匹配 + 候选选择 + 不变量约束 + diff）
- dry-run：`runDryRun()`（Worker）
- 快照：`loadSnapshot()`（分页拉取并缓存）
- 写库：`applyPlan()` / `applyOneWithOpts()`
- UI：`injectUI()`（小浮窗）与 `openDashboard()`（仪表盘）

推荐扩展方式：

1. 新增家族：在 `DEFAULT_FAMILIES`、`DEFAULT_STANDARDS`、`FAMILY_PROFILES` 增加配置，并实现 `normalizeX()`
2. 增强归一化：优先写“不会误伤”的规则（例如 token 合并、组织前缀剥离、相邻重复 token 折叠）
3. 排除专项/标签：优先补充 `isSpecializedModelName()`、`ROUTE_TAG_EXACT_BLACKLIST`、wrapper 前缀列表

---

## 版本与发布

脚本头部包含：

- `@version`
- `@downloadURL` / `@updateURL`

发布建议：
- 每次改动都 bump `@version` 与 `SCRIPT_VERSION`
- 在浏览器控制台观察 `[na-mr] ... version=...` 确认更新生效
