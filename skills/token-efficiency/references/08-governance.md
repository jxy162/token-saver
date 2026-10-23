# 08 治理：埋点、守门、回归

优化一次容易，**保持住**难。这一层负责让 token 成本可见、可控、不反弹。

## 埋点：需要记录什么

每次调用至少记：

```json
{"ts":"2026-10-23T09:05:00Z","label":"code-review","model":"claude-sonnet-4",
 "inputTokens":48000,"outputTokens":900,"cachedInputTokens":40000,
 "baselineInputTokens":62000,"baselineOutputTokens":1400,"latencyMs":8200,
 "promptVersion":"v7","retries":0}
```

- `label`：业务归因的关键（哪条产品线/哪个任务在烧钱）。
- `promptVersion`：改了 prompt 之后成本变化能不能解释。
- `baseline*`：优化前的同一次调用（同输入的历史对照），这样报告才能算出真实节省。
- `cachedInputTokens`：算缓存命中率与缓存收益。
- `retries`：识别"重试税"。

汇总：

```bash
node scripts/token-report.mjs usage.jsonl --pricing pricing.json --top 10
```

输出会给出总花费、缓存命中率、按模型/标签的分解、以及相对 baseline 的节省；`_note` 与 `_default` 兜底提醒你替换成真实价格。

## 三层守门

| 层 | 阈值示例 | 动作 |
| --- | --- | --- |
| 单请求 | input > 预算（如 32k） | 拒绝或强制裁剪（`trim-context.mjs`），并记录告警 |
| 会话/任务 | 累计 token > 上限 | 强制压缩历史或换新会话 |
| 每日/每标签 | 成本超预算 | 降级到小模型 / 熔断 / 通知负责人 |

守门要在**代码路径上**，不是文档里。CI 里可以加静态守门：

```bash
node scripts/estimate-tokens.mjs prompts/*.md --check 5000   # 提示词文件的 token 上限
```

## 回归：成本与质量必须一起测

任何 prompt/上下文改动都用同一批用例跑双指标：

| 指标 | 看什么 |
| --- | --- |
| 质量 | 通过率/准确率/人工评分 —— **先确认没有下降** |
| 成本 | tokens/task（不是 tokens/request）、p95 输入、缓存命中率 |
| 稳定性 | 输出格式失败率、重试率 |

"省了 30% 但通过率从 91% 掉到 84%"不是优化，是转移成本。评测集跑分尽量走 batch 接口（离线折扣）。

## 告警

- p95 输入 tokens 环比上涨 > 20%（通常是有人往前缀里加了动态内容，或检索片段数变大）
- 缓存命中率环比下跌 > 10 个百分点（前缀被破坏的最早信号）
- 单次成本超阈值 / 出现超大请求（长尾）
- 重试率上升（重试税）

## 成本归因与责任

- 每个调用必须有 `label`；没有 label 的流量按"未知"汇总，并推动补齐。
- 按产品功能而非按模型看账单：同一功能可能同时用多个模型档位。
- 每月回看 top 3 花销的 label，做一次"还能不能再降一档"的评估。

## 检查清单

- [ ] 每次调用都有 label 与 promptVersion 吗？
- [ ] 有单请求/会话/日预算守门吗（且写在代码里）？
- [ ] 改动前后是否有质量+成本双回归？
- [ ] 有缓存命中率与 p95 输入的告警吗？
- [ ] 价格表是定期更新的真实价格吗（不是示例值）？