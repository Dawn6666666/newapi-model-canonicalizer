# Rules Reference (Quick)

这份文档是“规则样例/参考”，用于说明脚本当前默认采取哪些归一化与排除策略。实际生效逻辑以 userscript 代码为准。

## 1) Canonical Key 形态（硬约束）

- 只允许：`a-z`、`0-9`、`.`、`-`（全小写）
- 禁止：`/`（组织前缀不进 key）
- 推荐形态：
  - `family-version-tier(-mode)?(-buildTag)?`

## 2) route/tag 黑名单（exact match）

这些名字代表路由/池化/编排标签，不应参与重定向。

样例（可扩充）：
- `openrouter/free`
- `openrouter/auto`
- `openrouter/bodybuilder`
- `switchpoint/router`
- `switchpoint/auto`
- `switchpoint/free`

## 3) wrapper 前缀（prefix）

### HARD wrapper（直接排除，不生成重定向）

样例：
- `image/`
- `embedding/`
- `rerank/`
- `moderation/`
- `假流式/`
- `流式抗截断/`

### MODE wrapper（剥离前缀，但保留 mode token 进入 canonical）

样例：
- `thinking/`
- `reasoning/`
- `high/`
- `low/`

## 4) 专项模型排除（不参与重定向）

样例关键词：
- `robotics`
- `computer-use`
- `tts` / `asr` / `stt` / `speech` / `transcription`
- `embed` / `embedding`
- `rerank` / `moderation`
- `image-generation` / `video-generation`

## 5) 用途/限额标注排除（不参与重定向）

例如含：
- `[渠道id:xx]`
- `[輸出3k上限]`
- `翻译`

这类模型建议直接调用完整模型名，不走重定向。

## 6) pinned key（批次锁定）

启用 pinned key 时，除 base canonical 外，还会生成 `base-buildTag` 形式的额外 key：
- `deepseek-r1-0528`
- `claude-4.5-sonnet-20250929`
- `kimi-k2-instruct-0905`

并且 pinned key 允许复用同一个 actual value（因为它是同款模型的“批次锁定入口”）。

