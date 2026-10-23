# 10 落到具体 harness

技能内容与 harness 无关，**落点**不同。先确认你的 harness 具备哪些能力，再把对应方法放到对应位置。

## 映射表

| 能力 | Codex | Claude Code | Cursor | 通用 API 项目 |
| --- | --- | --- | --- | --- |
| 常驻规则文件 | `AGENTS.md` | `CLAUDE.md` | `.cursor/rules/*.mdc` | 代码里的 system prompt 常量 |
| 技能/知识包 | `$CODEX_HOME/skills/<name>/` 或仓库内 `skills/` | `~/.claude/skills/<name>/` 或 `.claude/skills/` | 规则文件里引用 `references/` | 文档 + 你自己的模板目录 |
| 按需加载文档 | `references/*.md` | 同左（Agent Skills 用同一 `SKILL.md` 格式） | 规则 `@file` 引用，避免全文常驻 | 检索式注入 |
| 上下文压缩 | 会话压缩/新开线程 + 检查点文件 | `/compact` + 检查点文件 | 新会话 | 历史摘要 + 预算裁剪（03） |
| 子代理隔离 | subagents（只回收结论） | subagents | 不适用 | 独立调用链 |
| 工具输出治理 | 工具封装里截断/过滤 | hooks（PreToolUse）截断输出 | 不适用 | 工具层中间件 |
| 缓存与路由 | 在业务代码/网关里做 | 同左 | 同左 | provider 参数 + 网关 |

## 安装到各 harness

**Codex**（本仓库就是技能源）：

```bash
# 方式一：直接复制（技能目录名必须等于 frontmatter 的 name）
cp -r skills/token-efficiency "${CODEX_HOME:-$HOME/.codex}/skills/token-efficiency"

# 方式二：用 skill-installer 从 GitHub 安装
#   --repo <owner>/<repo> --path skills/token-efficiency
```

**Claude Code / 其他 Agent Skills 兼容 harness**：`SKILL.md` 的 `name` + `description` frontmatter 是通用约定，直接把同一目录复制进对应 skills 目录即可。`agents/openai.yaml` 是 Codex 专有的 UI 元数据，其他 harness 会忽略它（可安全保留）。

**Cursor**：不要整包常驻。把 `references/09-antipatterns.md` 的检查清单与 `references/02-prompt-and-output.md` 的"输出契约模板"摘进 `.cursor/rules/*.mdc`（限定 glob，避免 alwaysApply 全量注入），其余靠按需引用。

**通用 API 项目**（含用 API key 直连的场景）：方法落在三处——

1. **请求构造处**：`max_tokens`、`response_format`、`stop`、消息顺序（稳定前缀在前）、`cache_control`（Anthropic）、推理预算。
2. **中间件**：结果缓存（键归一化 + TTL + LRU）、用量埋点、预算守门、上下文预算裁剪。
3. **网关/代理**（如 LiteLLM 一类，或自建）：前缀缓存重排、模型路由与级联、按标签限流。放到网关的好处是业务代码零侵入，坏处是多一跳与调试复杂度。

## 组合建议（按 harness 能力）

| 你的情况 | 优先做 |
| --- | --- |
| 只有聊天窗口，改不了代码 | 07（工作流卫生）+ 09（反模式自查） |
| 能改业务代码，用的是 API key 直连 | 02（参数）+ 03（预算）+ 04（缓存）+ 08（埋点） |
| 有网关/代理层 | 04 + 06（路由）+ 08，业务代码只补 label |
| 团队多人协作 | 先做 08，再谈其他 —— 没有埋点和守卫，优化不会保留 |

## 注意

- 在**没有测量能力**的 harness 里不要做激进压缩：无法验证质量是否下降。
- 别把通用最佳实践塞进常驻规则文件（例如 `AGENTS.md`）：它每轮都在上下文里，成本按轮数放大。
- 跨 harness 迁移时，先迁移"方法"，再迁移"脚本"。脚本依赖 Node ≥ 18；没有 Node 的环境直接用 `--exact` 之外的推理逻辑手工执行（公式见 01）。
## 附：API key 直连的请求骨架

把本节的方法落到一次真实请求上。所有"省 token"的开关都在这 30 行里，字段名以你所用平台的官方文档为准。

```js
// 1) key 只从环境变量读，永不进代码/仓库
const apiKey = process.env.ANTHROPIC_API_KEY ?? process.env.OPENAI_API_KEY;
if (!apiKey) throw new Error('缺少 API key');

// 2) 顺序 = 稳定前缀 + 易变尾部（见 04）。数组顺序就是计费顺序。
const systemBlocks = [
  { type: 'text', text: POLICY, cache_control: { type: 'ephemeral' } },   // 断点 1：规则（Anthropic 写法）
  { type: 'text', text: SCHEMA, cache_control: { type: 'ephemeral' } },   // 断点 2：输出 schema
];
const messages = [
  { role: 'user', content: [{ type: 'text', text: STATIC_DOC }] },        // 长期文档（稳定）
  { role: 'user', content: [{ type: 'text', text: retrievedChunk }] },    // 本轮检索（易变）
  { role: 'user', content: [{ type: 'text', text: userQuestion }] },      // 本轮问题（易变）
];

const res = await fetch('https://api.anthropic.com/v1/messages', {
  method: 'POST',
  headers: {
    'content-type': 'application/json',
    'x-api-key': apiKey,                       // OpenAI 兼容端点是 Authorization: Bearer <key>
    'anthropic-version': '2023-06-01',
  },
  body: JSON.stringify({
    model: 'claude-sonnet-4',
    max_tokens: 400,                           // 3) 输出上限：按合格答案 p95 × 1.2，别用默认大值
    temperature: 0,
    system: systemBlocks,
    messages,
    stop_sequences: ['\n###'],                  // 4) 早停标记（可选）
  }),
});

const data = await res.json();
// 5) 埋点：务必记录缓存命中量，否则无法验证节省（见 08）
console.log(JSON.stringify({
  model: data.model,
  inputTokens: data.usage.input_tokens,
  outputTokens: data.usage.output_tokens,
  cachedInputTokens: data.usage.cache_read_input_tokens ?? 0,     // OpenAI 兼容：usage.prompt_tokens_details.cached_tokens
  label: 'code-review',
  promptVersion: 'v7',
}));
```

落地检查：

1. 先跑 `scripts/estimate-tokens.mjs --check <预算>`，确认这次上下文真的在预算内，再发请求。
2. 首次调用会产生缓存写入（可能 1.25x），第二次起才体现收益——别用单次调用评估缓存效果。
3. 用 `scripts/token-report.mjs` 汇总多次调用，看缓存命中率与 tokens/task，而不是单次账单。
4. 改 prompt 后把 `promptVersion` 一起改，否则历史对比无法归因。