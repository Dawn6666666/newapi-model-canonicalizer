# NewAPI Model Canonicalizer 使用指南（用户向）

本文档只讲“怎么用”。规则原理与字段含义请看 `userscript/README.md`。

---

## Canonicalization（归一化）是什么？这个脚本到底在干嘛？

一句话：**把“同一个模型的不同叫法”折叠成一个统一的标准名（canonical key）**，然后把这个标准名映射到每个渠道真实存在的模型名（actual）。

你在下游只需要记住统一的 canonical key，比如：

- `claude-4.5-sonnet`
- `gemini-2.5-pro`
- `gpt-4.1-mini`

脚本会在每个渠道里生成/更新 `model_mapping`，让 New-API 按映射把请求路由到该渠道的真实模型名。

### 归一化的核心规则（只讲用户关心的）

1. **同系列 + 同版本 + 同 tier（+可选 mode/批次）** 才会被折叠到同一个 canonical  
   目的：既“统一入口”，又尽量不误伤不同用途的模型。
2. **canonical 只做 key（标准名）**，value 必须是该渠道 `models` 里真实存在的字符串  
   目的：避免写回一个渠道根本没有的模型名（这会导致无法命中/路由失败）。
3. **禁止互映/回环**  
   目的：避免出现 `A->B` 同时 `B->A`，或更长链条循环。

### 例子 1：Claude 的别名折叠（同模型不同叫法）

渠道的 `models` 里可能出现这些写法（语义等价）：

- `anthropic/claude-sonnet-4.5`
- `claude-sonnet-4-5`
- `claude-4.5-sonnet`

脚本会统一成 canonical key：

```text
claude-4.5-sonnet
```

并写回类似映射（每个渠道可能不同，以该渠道实际 models 为准）：

```json
{
  "claude-4.5-sonnet": "anthropic/claude-sonnet-4.5"
}
```

### 例子 2：Gemini 的前缀/大小写差异（仍归一到同 canonical）

可能出现：

- `google/gemini-2.5-pro`
- `Gemini-2.5-Pro`

归一后：

```json
{
  "gemini-2.5-pro": "google/gemini-2.5-pro"
}
```

### 例子 3：锁批次（pinned）让你精确指定“某个批次/发布日期”

同一模型可能有不同批次（例如末尾 `0528`、`0905`、`2507` 等）。

如果你开启「锁批次」：

- base key：`deepseek-r1`
- pinned key：`deepseek-r1-0528`

写回可能是：

```json
{
  "deepseek-r1": "deepseek-ai/deepseek-r1-0528",
  "deepseek-r1-0528": "deepseek-ai/deepseek-r1-0528"
}
```

为什么要 pinned：同款模型不同批次可能表现不同，你可以显式指定批次，避免“升级后效果变了”。

### 例子 4：什么不会被归一化（避免误伤）

下面这种通常是“专项用途/包装前缀/限额标注/路由标签”，脚本倾向于**不**把它们归到标准模型里：

- `image/xxx`、`embedding/xxx`、`流式抗截断/xxx`
- `openrouter/free`、`switchpoint/router`（更像路由/标签）
- `gpt-5-nano [渠道id:33][輸出3k上限]`（明显是特殊用途）

如果你要用这类模型：建议直接用渠道 `models` 中的完整名字调用，不走重定向。

---

## 0. 你会得到什么

你在 New-API 下游只需要调用一套**标准模型名（canonical key）**，脚本会为每个渠道生成：

- `canonical_key -> actual_model_full_name`

并满足这些安全约束：

- 不写回不存在于该渠道 `models` 列表里的 value
- 禁止别名互映/回环
- 同一个 actual（value）默认不会被多个 key 重复占用（pinned key 例外）

---

## 1. 安装与前置条件

### 1.1 安装脚本

1. 安装 Tampermonkey（或同类 Userscript 扩展）
2. 新建脚本，把仓库里的 Userscript 粘贴进去，或直接用 `@updateURL` 安装

图片占位符（待你补）：

- `【图：Tampermonkey 安装页】`
  - 截图位置：浏览器扩展商店 / Tampermonkey 详情页
  - 用途：告诉用户在哪里安装

### 1.2 登录 New-API 控制台

脚本依赖当前浏览器里 New-API 的登录态（cookie + localStorage 的 user 信息）。

你需要先打开并登录：

- `http(s)://<你的NewAPI域名>/console/channel`

图片占位符（待你补）：

- `【图：New-API 渠道管理页 /console/channel】`
  - 截图位置：New-API 控制台 -> 渠道管理
  - 用途：告诉用户进入哪里用脚本

---

## 2. 快速上手（推荐流程）

### Step A：刷新全量渠道快照

在 `/console/channel` 页面右下角会出现脚本按钮 `模型重定向`，点开后：

1. 点击 `刷新全量渠道`
2. 等待完成（会显示渠道数、快照时间）

图片占位符（待你补）：

- `【图：小浮窗 - 刷新全量渠道】`
  - 截图位置：/console/channel 页面右下角脚本浮窗
  - 用途：让用户知道先点哪个按钮

说明：

- “快照”是脚本本地缓存（IndexedDB）的渠道列表与 `models/model_mapping`，用于加速 dry-run 与存档。
- 如果你刚同步过模型列表或改过映射，建议先刷新快照。

### Step B：选择家族 + 锁批次（可选）

浮窗里有 `Families` 选择：

- 勾选你要处理的家族（例如 `claude/gemini/gpt/qwen/...`）

“锁批次（pinned）”开关建议：

- 默认可以开启：会额外生成带日期/批次的 key（例如 `deepseek-r1-0528`）
- 如果你只想维护最少 key：可以关闭

举例：

- 关闭锁批次：只会写 `deepseek-r1 -> deepseek-ai/deepseek-r1-0528`（举例）
- 开启锁批次：还会写 `deepseek-r1-0528 -> deepseek-ai/deepseek-r1-0528`（便于精确指定批次）

图片占位符（待你补）：

- `【图：仪表盘顶栏 - 锁批次开关位置】`
  - 截图位置：点击“打开仪表盘”后的页面顶栏
  - 用途：告诉用户 pinned 开关在哪里、有什么效果

### Step C：运行 dry-run（只计算，不写库）

点击 `运行 dry-run`：

- dry-run 会在浏览器本地计算所有渠道的“计划写入映射”
- 不会修改数据库

你会得到：

- 每个渠道的 Diff（新增/删除/变更）
- 风险提示（例如 value 不在 models）

图片占位符（待你补）：

- `【图：dry-run 进度条与完成提示】`
  - 截图位置：仪表盘顶栏 / 浮窗进度条
  - 用途：告诉用户 dry-run 过程中看到什么

### Step D：打开仪表盘审阅（强烈建议）

点击 `打开仪表盘`，进入三栏审阅界面：

1. 左侧：渠道列表（支持搜索、仅 enabled、仅有变更、分页）
2. 中间：Diff / Plan / DB 三种视图
3. 右侧：操作详情（写入、存档点、回滚、JSON 预览）

图片占位符（待你补）：

- `【图：仪表盘全局布局总览】`
  - 截图位置：仪表盘首页
  - 用途：让用户建立“左中右三栏”的心智模型

### Step E：写入数据库（Apply）

写入前建议检查两件事：

1. 中间 `Diff` 视图里是否存在红色高亮行（异常）
2. 右侧 `风险` 是否为 0，或你是否确认这些风险可接受

写入有两种方式：

- `写入数据库`：按 dry-run 计划，写入**所有有变更**的渠道
- `写入此渠道`：只写当前选中的渠道（推荐先用它做灰度验证）

图片占位符（待你补）：

- `【图：右侧操作详情 - 写入此渠道 / 写入数据库】`
  - 截图位置：仪表盘右侧“操作详情”
  - 用途：告诉用户在哪里写入

---

## 3. 仪表盘怎么读（最常用的 3 个视图）

### 3.1 Diff（最常用）

Diff 是“DB 当前值”和“计划写入值”的差异列表，列含义：

- `op`：`+` 新增、`-` 删除、`~` 变更
- `key`：canonical key（写入 DB 的 key）
- `from`：写入前 value（DB 里原来的 value）
- `to`：计划写入 value（渠道真实模型全名）

示例：

```text
+  claude-4.5-sonnet   -> anthropic/claude-sonnet-4.5
~  gpt-5               gpt-5-2025-08-07 -> gpt-5
```

### 3.2 Plan（计划写入后的完整 mapping）

Plan 视图展示“本次 dry-run 计算出的完整 mapping”，你可以把它理解为“写入后应当长什么样”。

示例（节选）：

```json
{
  "claude-4.5-sonnet": "anthropic/claude-sonnet-4.5",
  "gpt-4.1-mini": "openai/gpt-4.1-mini"
}
```

### 3.3 DB（当前数据库 mapping）

DB 视图展示“当前数据库里的 `model_mapping`”。

用途：

- 写入后复核：你可以切到 DB 视图确认 key/value 是否已经落库

---

## 4. 异常与风险怎么处理

### 4.1 为什么有的行会被红色高亮？

红色高亮表示**异常/风险**。

最常见的一种是：

- `value_not_in_models`：脚本计划写入的 value 不存在于该渠道 `models` 列表中

举例（这条不建议直接写入）：

```text
key: grok-4
to:  grok-4-heavy
```

如果 `grok-4-heavy` 不在该渠道 `models` 里，写入后可能导致无法命中实际模型。

处理办法（任选其一）：

1. 先做“模型同步/更新渠道 models”，让该 value 真正出现在 `models` 中
2. 或调整你选择的渠道/家族开关，再跑 dry-run

图片占位符（待你补）：

- `【图：异常高亮示例 - value_not_in_models】`
  - 截图位置：仪表盘 Diff 视图
  - 用途：让用户能一眼对照自己的情况

### 4.2 右侧 “风险” 面板是什么意思？

风险面板会汇总当前选中渠道的风险样本，例如：

- value 不在 models
- 规则告警（warnings）

你可以把它当作“写入前最后的安全检查清单”。

---

## 5. 存档点与回滚（强烈建议学会）

### 5.1 写入前会自动存档吗？

会。脚本在写入前会强制创建“存档点”，记录：

- `before`：写入前该渠道的 `model_mapping`
- `after`：本次计划写入的 `model_mapping`
- `diff`：差异统计

注意：

- 为避免 429 限流，`before` 默认使用“快照中的 DB 值”。所以写入前最好先 `刷新快照` 一次。

### 5.2 怎么回滚？

两种方式：

1. `回滚上次`：一键回滚到最近一次写入对应的存档点（整批）
2. `存档点`：打开列表，选择任意存档点执行回滚

图片占位符（待你补）：

- `【图：存档点列表 - 回滚/删除/导出】`
  - 截图位置：仪表盘点击“存档点”后的 modal
  - 用途：告诉用户回滚入口与按钮位置

---

## 6. 推荐用法（给新手的）

如果你是第一次用，建议按“灰度”走：

1. 刷新快照
2. 勾选 1-2 个家族（例如先 `claude`）
3. dry-run
4. 在仪表盘挑 1 个渠道 `写入此渠道`
5. 验证 OK 后，再 `写入数据库` 批量写入

---

## 7. 常见问题（FAQ）

### Q1：为什么我点了写入，提示 429 Too Many Requests？

说明 New-API 管理端限流了。脚本会自动做退避重试，但你也可以：

- 先少量写入（单渠道）验证
- 写入前刷新快照
- 避免同时在多个浏览器/多个账号并发写入

### Q2：为什么计划里没有某些模型？

常见原因：

- 该模型属于 route/tag（路由标签）或 wrapper（如 `image/xxx`），脚本默认不参与重定向
- 该渠道 `models` 列表里不存在可匹配的候选

### Q3：我想用 `image/xxx`、`翻译`、`[输出上限]` 这种怎么办？

这类“专项用途模型”建议直接用**完整模型名**调用，不走重定向。

---

## 8. 截图清单（方便你后续补图）

建议你补以下几张图，用户基本就能无障碍上手：

1. `【图：/console/channel 页面】`
2. `【图：小浮窗（刷新快照/运行 dry-run/打开仪表盘）】`
3. `【图：仪表盘总览（左渠道列表 + 中 Diff + 右操作详情）】`
4. `【图：异常高亮示例（value_not_in_models）】`
5. `【图：存档点 modal（回滚/删除/导出）】`
6. `【图：写入此渠道 vs 写入数据库】`
