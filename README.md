# token_saver

把"使用 AI 时降低 token 消耗、提升 token 利用率"的方法整合成**一个可被各类 harness 使用的技能包**（skill），而不是一个运行时框架。

- 知识层：`skills/token-efficiency/SKILL.md` + 11 篇按需加载的 `references/`，harness 无关（Codex / Claude Code / Cursor / 任何 API key 直连的项目都能用）。
- 工具层：5 个零依赖 Node 脚本（估算、压缩、预算裁剪、前缀缓存规划、用量报告），可 CLI 调用，也可被 `import`。
- 校准层：`tools/calibrate-estimator.mjs` 用真实分词器（o200k_base）校准估算器系数；`tools/validate-skill.mjs` 做技能自检。

## 30 秒上手

```bash
# 1) 我这次请求大概花多少 token？（零依赖，无需 API key）
node skills/token-efficiency/scripts/estimate-tokens.mjs prompts/system.md prompts/user.md --check 4000

# 2) 把塞满重复行和客套话的工具输出压掉（代码块自动保护）
node skills/token-efficiency/scripts/compress-text.mjs tool-output.log --report --out compact.log

# 3) 把多段上下文按优先级裁进预算（schema/工具定义 locked，不截断）
node skills/token-efficiency/scripts/trim-context.mjs context.json --budget 12000 --print-text
```

## 目录结构

```
token_saver/
├── skills/token-efficiency/          # 技能本体（可直接整目录复制到任何 harness）
│   ├── SKILL.md                      # 入口：何时用、三条铁律、症状→杠杆决策表、脚本用法
│   ├── agents/openai.yaml            # Codex 的 UI 元数据（其他 harness 会忽略）
│   ├── references/                   # 11 篇按需加载的方法文档（00 总览 ~ 10 harness 落点）
│   ├── scripts/                      # 5 个零依赖脚本（见下表）
│   └── assets/                       # 示例输入：pricing / usage.jsonl / context / messages
├── tools/
│   ├── calibrate-estimator.mjs       # 用真实分词器校准估算系数（--fit 重新拟合）
│   └── validate-skill.mjs            # 技能自检：frontmatter、命名、链接、脚本语法
├── test/scripts.test.mjs             # 18 个行为测试（node --test）
└── package.json                      # 仅开发用（唯一依赖 gpt-tokenizer，且是可选）
```

## 脚本

| 脚本 | 用途 | 典型收益 |
| --- | --- | --- |
| `estimate-tokens.mjs` | token 计量：启发式（±20%）/ `--exact` 真实分词 / `--check N` CI 守门 | 让优化可验证 |
| `compress-text.mjs` | 确定性压缩：空白归一化、去填充词、折叠重复行、截断长块（代码块不改写） | 日志/工具输出 -10%~60% |
| `trim-context.mjs` | 按优先级 + `locked` 标记把多段上下文裁进预算，输出审计报告 | 长任务输入 -30%~90% |
| `prompt-cache-plan.mjs` | 重排为"稳定前缀 + 易变尾部"，给出 `cache_control` 断点与风险告警 | 命中前缀按 0.1x 计价 |
| `token-report.mjs` | 用量 JSONL → 成本/缓存命中率/相对 baseline 的节省看板 | 让节省可归因 |

所有脚本都支持 `--help` 式的用法提示（无参数运行会打印用法），并且都是**纯 ESM、无第三方依赖**，可以被业务代码 `import`。

## 安装到各 harness

| harness | 放置位置 | 备注 |
| --- | --- | --- |
| Codex | `${CODEX_HOME:-~/.codex}/skills/token-efficiency` | 目录名需等于 frontmatter 的 `name` |
| Claude Code / 其他 Agent Skills 兼容 harness | `~/.claude/skills/token-efficiency` 或项目内 `.claude/skills/` | `SKILL.md` 的 `name`/`description` 是通用约定 |
| Cursor | 把 `references/09-antipatterns.md` 的清单与 `02` 的输出契约模板摘进 `.cursor/rules/*.mdc` | 不要整包常驻，用 glob 限定 |
| 通用 API 项目 | 直接读 `references/`，脚本按需调用 | 参数级方法落在请求构造处（02/04/06），治理落在中间件（08） |

```bash
# 复制安装（macOS/Linux 示例；Windows 用等价的目录复制）
cp -r skills/token-efficiency "${CODEX_HOME:-$HOME/.codex}/skills/token-efficiency"

# 或从 GitHub 用 skill-installer 安装： --path skills/token-efficiency
```

## 开发

```bash
npm test          # 18 个行为测试（node --test）
npm run validate  # 技能自检（frontmatter/命名/链接/脚本语法）
npm run calibrate # 看估算器误差；加 --fit 重新拟合系数（需 gpt-tokenizer）
```

## 设计取舍

- **为什么不是框架**：token 优化高度依赖业务上下文（哪些内容可丢、哪些必须精确）。框架会把"策略"固化，反而让人绕过它；技能包给的是可判断的方法 + 确定性的小工具，落点由使用者的 harness 决定。
- **为什么脚本零依赖**：安装到别人的 harness 时不能要求 `npm install`。只有校准估算器需要 `gpt-tokenizer`，且它是可选的开发依赖。
- **为什么估算器要校准**：字符数/4 这类经验公式在中英混排、JSON、日志上误差可达 2 倍，用它做预算会失真。这里的系数是用真实分词器在混合样本上拟合的（max ≈ 18%，mean ≈ 5%），并且可重跑。
- **为什么强调"先测量"**：没有基线的压缩是猜测；文档里所有百分比都标了量级区间，不承诺具体收益。

## 边界（不要误用）

- `assets/pricing.example.json` 与脚本内置价格是**示例值**，务必替换为你的真实价格；价格与缓存机制（最小前缀长度、TTL、写入成本）以平台官方文档为准。
- 估算器对以英文/中文为主、混排代码与日志的语料最准；其他语种或超长数字表格请用 `--exact`。
- 压缩是有损操作：不要压 schema、工具定义、精确 ID/数值；压缩后必须做一次质量回归（见 `references/08-governance.md`）。

## 扩展点

- 按 harness 补 adapter 示例（Claude Code hooks 截断工具输出、Cursor 规则模板）。
- 网关侧的最小实现样例：结果缓存 + 路由 + 用量埋点（`references/10-harness-adapters.md` 已给落点）。
- 把 `token-report.mjs` 的输入字段接进你现有的观测系统。