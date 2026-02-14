# New-API Model Canonicalizer

浏览器端 Userscript：为 New-API 渠道自动生成“标准模型 canonical key -> 渠道真实模型名”的 `model_mapping`，并通过强约束避免别名互映/回环。

核心特点
- 所有计算在浏览器本地完成（dry-run -> 审阅 -> 写入）。
- canonical key 只来自标准集合（并可从全量语料自动补全）。
- 禁止互映/回环；actual value 默认不复用（pinned key 例外）。
- 排除 route/tag、硬 wrapper、用途/限额标注、专项模型。
- 自带仪表盘（about:blank）用于审阅 Diff/Plan/DB。

安装与使用
1. 安装 Tampermonkey/Violentmonkey
2. 打开 `userscript/newapi-model-canonicalizer.user.js` 并安装
3. 进入 New-API：`/console/channel`
4. 右下角「模型重定向」：刷新快照 -> dry-run -> 打开仪表盘 -> 写入

详细说明见：`userscript/README.md`

