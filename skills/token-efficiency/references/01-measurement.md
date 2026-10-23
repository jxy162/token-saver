# 01 计量与基线：所有优化的前提

## 口径先对齐

不同厂商对 token 的划分不同，**别混用**：

| 字段 | 含义 | 注意 |
| --- | --- | --- |
| input / prompt tokens | 本次请求的输入总量 | 含 system、工具定义、检索内容、历史 |
| cached input tokens | 命中前缀缓存的部分 | 计价通常为输入的 10%~50%，**不是免费** |
| cache write tokens | 写入缓存的部分 | Anthropic 约为输入的 1.25x，可能影响是否划算 |
| output / completion tokens | 生成量 | 通常比输入贵 3~5 倍 |
| reasoning / thinking tokens | 推理模型的内部推理 | 很多平台按 output 计价，且不可见 → 必须显式限预算 |

字符数、字节数、词数都不是 token 数。中文一字常 ≈ 0.8~1.5 token，英文一个词 ≈ 1~1.3 token，JSON/代码约 3~4 字符/token。

## 三种计量手段

| 手段 | 精度 | 依赖 | 用在 |
| --- | --- | --- | --- |
| 平台返回的 `usage` | 权威 | 必须真调用（花钱） | 计费、报告、回归对比 |
| 本地真实分词器（tiktoken / gpt-tokenizer） | 高（同族模型） | 需安装，需选对编码 | 预算预算、CI 守门、A/B |
| 启发式估算 | ±20% 量级 | 无 | 快速评估、"能不能省"的粗判 |

**陷阱**：用 A 模型的分词器给 B 模型算 token（跨模型族误差可达 30%+）；只统计对话忘了工具定义与检索内容；把 cached tokens 当免费。

## 本技能自带的估算器

`scripts/estimate-tokens.mjs`：零依赖，可 CLI 也可 import。

```bash
node scripts/estimate-tokens.mjs prompt.md tool-output.log --json
node scripts/estimate-tokens.mjs --exact prompt.md     # 装了 gpt-tokenizer 时用真实分词
node scripts/estimate-tokens.mjs prompt.md --check 4000 # 超预算退出码 1，可做 CI 守门
```

模型（线性特征，系数已用 o200k_base 校准）：

| 特征 | 单位成本 | 直觉 |
| --- | --- | --- |
| CJK 汉字/假名/全角字符 | 0.782 | 一个中文字约 0.8 token |
| 词（字母连续串） | 1.081 | 一个英文词约 1 token，与词长基本无关 |
| 标点 | 0.297 | 大部分标点与相邻词合并 |
| 数字 | 0.842 | 数字串切分较碎 |
| astral（emoji 等） | 2.301 | emoji 通常 2~3 token |
| 额外空白（缩进/换行，超出词数的部分） | 0.654 | 词间空格几乎免费，缩进/换行要钱 |

在 17 个混合样本（中英、代码、JSON、日志、emoji）上：**max |误差| ≈ 18%，平均 ≈ 6%**。

不适用场景：以非中英文为主的语言、超长数字/表格、特殊编码。这些用 `--exact`。

chat 请求的固定开销：每条消息 +4 token，末尾 priming +3（`countMessagesTokens()` 已实现）。

重新拟合（换模型族或换语种时）：

```bash
npm i -D gpt-tokenizer
node tools/calibrate-estimator.mjs          # 看当前系数误差
node tools/calibrate-estimator.mjs --fit    # 打印新系数，粘回 estimate-tokens.mjs 的 COEF
```

## 建立基线（没有基线就不要改）

1. 采样 100~1000 条**真实**调用（不要用编造的 prompt），记录：input、output、cached、`max_tokens` 设置、label。
2. 看分布而不是平均：p50 / p95 / p99 的 input tokens；p95 决定你的优化收益上限（长尾最贵）。
3. 拆分固定开销：`system + 工具定义 + schema` 每次都要付 → 这部分靠缓存或精简，而不是靠"压缩对话"。
4. 记录质量基线：同一批用例的通过率/准确率。**优化后必须复测**，否则你不知道省下的是钱还是正确性。

```bash
# 把埋点日志汇总成看板（字段见 08-governance.md）
node scripts/token-report.mjs usage.jsonl --pricing pricing.json
```

## 常见度量错误

- 只看单次请求的 token，不看每完成一个任务的 token（真正的指标是 **tokens/task**）。
- 忽略失败重试：一次超时重试 = 全额重复计费，重试率 20% 就是 20% 的隐形账单。
- 优化了 prompt 却忘了实测：提示词变短后模型可能"想得更久"，output 反而涨。
- 用平均 input 描述被少数长请求拉高的账单 → 用 p95/p99。