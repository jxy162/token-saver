---
name: token-efficiency
description: "Cut LLM token consumption and improve token utilization in AI features, agents, and API integrations: prompt/context budgeting, compaction, prefix caching, output limits, retrieval trimming, model routing, and agent-workflow hygiene. Use when the user wants to lower token or API cost, fit a context window, speed up or cheapen a model call, design caching, or audit why an AI app is expensive. 降低 token 消耗、提升 token 利用率、上下文与成本优化。"
metadata:
  short-description: "Cut token usage and cost in LLM apps and agents"
---

# Token Efficiency

降低 token 消耗的**顺序**是：先测量，再选杠杆，改完再验证。凭空"精简提示词"通常既没用又掉质量。

## 何时使用

- 用户抱怨 AI 应用/智能体太贵、太慢、上下文被截断、`context_length_exceeded`。
- 要设计或评审一次模型调用的参数（`max_tokens`、缓存、路由、批处理）。
- 要让当前会话/工作流少吃 token（工具输出、子代理、检索、历史膨胀）。
- 要给出一份可执行的降耗方案或审计报告。

不适用：模型选型/价格对比本身（另见 `references/06-routing-and-batching.md` 的边界）、与 LLM 无关的通用性能优化。

## 三条铁律

1. **先量化再动手。** 用 `scripts/estimate-tokens.mjs`（无需 API key、零依赖）或真实 `usage` 字段建立基线。没有基线的"优化"无法验证。
2. **可逆优先。** 排序为：改调用参数（输出上限/缓存/路由） > 改结构（检索/预算/压缩历史） > 改文案（提示词精简）。有损压缩只用于可再生的内容（日志、重复检索文本、已完成步骤的中间输出）。
3. **不许破坏正确性。** 不得删除会改变答案的信息：输出 schema、工具定义、当前任务约束、精确数值/ID 必须原样保留（`locked`）。压缩后必须复核一次答案质量。

## 三档模式（按用户诉求选一档，可叠加）

**A. 改代码**：用户在优化自己的 AI 应用/接口调用。产出最小 diff：加上下文预算、`max_tokens` 上限、前缀缓存/结果缓存、模型级联、用量埋点。落点见 `references/10-harness-adapters.md`。

**B. 改工作流**：在智能体会话中省 token。动作：搜索先行不要全量读文件、工具输出先过滤再进上下文、长任务丢给子代理（只回收结论）、历史按需压缩。见 `references/07-agent-workflow.md`。

**C. 出方案/审计**：先要一段真实调用样本或 `usage` 日志，再给"症状 → 杠杆 → 预期收益 → 验证方式"的清单，并标注哪些是猜测、需要实测。用 `scripts/token-report.mjs` 汇总。

## 症状 → 杠杆（先查这张表）

| 症状 | 首选杠杆 | 参考 |
|---|---|---|
| 每轮输入都在涨，成本近似平方增长 | 历史压缩 + 前缀缓存（稳定前缀放最前） | 03 / 04 |
| 单次请求超窗口 / 被截断 | 优先级预算裁剪 + 检索片段收缩 | 01(03) |
| 输出又长又跑题 | `max_tokens` 上限 + 结构化输出 + 禁止项 | 02 |
| 同一上下文被反复发送 | 前缀缓存（`cache_control` / 自动缓存） | 04 |
| 相同问题重复付费 | 结果缓存（精确键 + 归一化） | 04 |
| 简单请求也用大模型 | 级联路由：便宜模型先跑，低置信度再升级 | 06 |
| 智能体读了一大堆无关文件 | 搜索先行、工具输出过滤、子代理隔离 | 07 |
| 检索塞了 20 段只有 1 段有用 | 先重排再截断，限制片段数与单段长度 | 05 |
| 说不清钱花在哪 | 用量埋点：按模型/标签/缓存命中率统计 | 08 |
| 每次都很贵但没人改 | 预算守门（CI 里的 token 上限）+ 回归对比 | 08 |

## 脚本（零依赖，`node` 直接跑，也可被 import）

```bash
# 测量：估算 token 数；--check 超预算即退出 1，可做 CI 守门
node scripts/estimate-tokens.mjs prompt.md log.txt --check 4000
node scripts/estimate-tokens.mjs --exact prompt.md        # 装了 gpt-tokenizer 时用真实分词器

# 压缩：空白归一化 / 去填充词 / 折叠重复行 / 截断超长日志块（自动保护代码块）
node scripts/compress-text.mjs tool-output.log --report --out compact.log

# 预算裁剪：按优先级和 locked 标记裁剪多段上下文
node scripts/trim-context.mjs context.json --budget 12000 --out trimmed.json

# 前缀缓存：把消息重排成"稳定前缀 + 易变尾部"，并给出可缓存前缀长度
node scripts/prompt-cache-plan.mjs messages.json --out plan.json

# 报告：把用量 JSONL 汇总成成本/节省看板
node scripts/token-report.mjs usage.jsonl --pricing assets/pricing.example.json
```

脚本是**确定性工具**，不是必须品：逻辑简单时直接在用户代码里实现更合适。

## 参考文件

按需读取，不要一次全读：

- [references/00-method-catalog.md](references/00-method-catalog.md) — 方法总览（收益量级 × 代价 × 落地方式），用来快速选杠杆。
- [references/01-measurement.md](references/01-measurement.md) — 计量口径、估算公式与误差、真实 usage 字段、基线建立。
- [references/02-prompt-and-output.md](references/02-prompt-and-output.md) — 提示词结构与输出控制的参数级节省。
- [references/03-context-compaction.md](references/03-context-compaction.md) — 压缩、裁剪、摘要、记忆分层。
- [references/04-caching.md](references/04-caching.md) — 前缀缓存（各家 API 写法）与结果缓存。
- [references/05-retrieval.md](references/05-retrieval.md) — 检索注入的 token 成本控制。
- [references/06-routing-and-batching.md](references/06-routing-and-batching.md) — 模型路由、级联、批处理、流式。
- [references/07-agent-workflow.md](references/07-agent-workflow.md) — 智能体工作流卫生（工具输出、子代理、技能）。
- [references/08-governance.md](references/08-governance.md) — 埋点、预算守门、回归测试、报告。
- [references/09-antipatterns.md](references/09-antipatterns.md) — token 泄漏反模式清单。
- [references/10-harness-adapters.md](references/10-harness-adapters.md) — 落到 Codex / Claude Code / Cursor / 通用 API 的映射。

## 交付要求

给出建议时必须带上：**基线 → 改动 → 预期节省量级 → 验证方法**。没有实测数据的地方明确写"待验证"，不要编造百分比。