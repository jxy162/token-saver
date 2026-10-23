#!/usr/bin/env node
/**
 * token-report.mjs — 把用量 JSONL 汇总成成本/节省看板（可 CLI，也可 import）。
 *
 * 输入：JSONL，每行一次调用（字段缺失按 0 处理）：
 *   {"ts":"2026-10-23T10:00:00Z","label":"classify","model":"gpt-4o-mini",
 *    "inputTokens":1200,"outputTokens":80,"cachedInputTokens":900,
 *    "baselineInputTokens":3000,"baselineOutputTokens":80}
 *   - cost 字段存在时直接采用，否则按 --pricing 计算
 *   - baseline* 表示"没做优化前的同一次调用"，用于算节省
 *
 * 用法：
 *   node token-report.mjs usage.jsonl [--pricing pricing.json] [--top 5] [--json]
 *   import { summarize } from './token-report.mjs'
 */

import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';

/** 示例价（USD / 1M token）。仅用于跑通报告，务必替换为你的实际价格。 */
export const EXAMPLE_PRICING = {
  _note: '示例价，可能过时，请以官方定价页为准',
  _default: { in: 1.0, out: 3.0, cachedIn: 0.3 },
  'gpt-4o-mini': { in: 0.15, out: 0.6, cachedIn: 0.075 },
  'gpt-4o': { in: 2.5, out: 10.0, cachedIn: 1.25 },
  'gpt-4.1-mini': { in: 0.4, out: 1.6, cachedIn: 0.1 },
  'gpt-4.1': { in: 2.0, out: 8.0, cachedIn: 0.5 },
  'o4-mini': { in: 1.1, out: 4.4, cachedIn: 0.275 },
  'claude-3-5-haiku': { in: 0.8, out: 4.0, cachedIn: 0.08 },
  'claude-sonnet-4': { in: 3.0, out: 15.0, cachedIn: 0.3 },
  'claude-opus-4': { in: 15.0, out: 75.0, cachedIn: 1.5 },
  'deepseek-chat': { in: 0.27, out: 1.1, cachedIn: 0.07 },
  'deepseek-reasoner': { in: 0.55, out: 2.19, cachedIn: 0.14 },
  'qwen-plus': { in: 0.4, out: 1.2, cachedIn: 0.16 },
  'glm-4-flash': { in: 0.0, out: 0.0, cachedIn: 0.0 },
  'gemini-2.5-flash': { in: 0.3, out: 2.5, cachedIn: 0.075 },
  'gemini-2.5-pro': { in: 1.25, out: 10.0, cachedIn: 0.31 },
};

/** 精确匹配 -> 最长前缀匹配 -> _default；返回 [price, matchedKey, approximated]。 */
export function findPrice(model, pricing = EXAMPLE_PRICING) {
  if (pricing[model]) return [pricing[model], model, false];
  const keys = Object.keys(pricing).filter((k) => !k.startsWith('_') && model.startsWith(k));
  keys.sort((a, b) => b.length - a.length);
  if (keys.length > 0) return [pricing[keys[0]], keys[0], true];
  if (pricing._default) return [pricing._default, '_default', true];
  return [null, null, true];
}

export function recordCost(record, pricing = EXAMPLE_PRICING) {
  if (typeof record.cost === 'number') return { cost: record.cost, matched: 'record.cost', approximated: false, warnings: [] };
  const [price, matched, approximated] = findPrice(String(record.model ?? ''), pricing);
  const warnings = [];
  if (!price) return { cost: 0, matched: null, approximated: true, warnings: ['模型 "' + record.model + '" 没有价格，按 0 计。'] };
  if (approximated) warnings.push('模型 "' + record.model + '" 用 "' + matched + '" 的价格近似。');
  if ((record.cachedInputTokens ?? 0) > 0 && price.cachedIn === undefined) warnings.push('价格表没有 cachedIn，缓存命中未打折。');
  const cached = Number(record.cachedInputTokens ?? 0);
  const cachedRate = price.cachedIn ?? price.in;
  const cost =
    (Math.max(0, Number(record.inputTokens ?? 0) - cached) / 1e6) * price.in +
    (cached / 1e6) * cachedRate +
    (Number(record.outputTokens ?? 0) / 1e6) * price.out;
  const baseline = Number(record.baselineInputTokens ?? 0) > 0
    ? (Number(record.baselineInputTokens) / 1e6) * price.in + (Number(record.baselineOutputTokens ?? record.outputTokens ?? 0) / 1e6) * price.out
    : null;
  const cacheSavings = (cached / 1e6) * Math.max(0, price.in - cachedRate);
  return { cost, matched, approximated, warnings, baselineCost: baseline, cacheSavings };
}

export function summarize(records, pricing = EXAMPLE_PRICING) {
  const total = {
    calls: records.length, inputTokens: 0, outputTokens: 0, cachedInputTokens: 0,
    cost: 0, baselineCost: 0, cacheSavings: 0, savings: 0,
  };
  const byModel = new Map();
  const byLabel = new Map();
  const warnings = new Set();

  for (const record of records) {
    const calc = recordCost(record, pricing);
    for (const w of calc.warnings) warnings.add(w);
    const input = Number(record.inputTokens ?? 0);
    const output = Number(record.outputTokens ?? 0);
    const cached = Number(record.cachedInputTokens ?? 0);
    total.inputTokens += input;
    total.outputTokens += output;
    total.cachedInputTokens += cached;
    total.cost += calc.cost;
    total.cacheSavings += calc.cacheSavings ?? 0;
    if (calc.baselineCost != null) {
      total.baselineCost += calc.baselineCost;
      total.savings += calc.baselineCost - calc.cost;
    }
    const bump = (map, key) => {
      const cur = map.get(key) ?? { key, calls: 0, inputTokens: 0, outputTokens: 0, cachedInputTokens: 0, cost: 0 };
      cur.calls += 1;
      cur.inputTokens += input;
      cur.outputTokens += output;
      cur.cachedInputTokens += cached;
      cur.cost += calc.cost;
      map.set(key, cur);
      return cur;
    };
    bump(byModel, String(record.model ?? 'unknown'));
    bump(byLabel, String(record.label ?? 'unlabeled'));
  }

  const sortByCost = (map) => [...map.values()].sort((a, b) => b.cost - a.cost);
  const totalInput = total.inputTokens + total.outputTokens;
  return {
    total: {
      ...total,
      cacheHitRate: total.inputTokens === 0 ? 0 : total.cachedInputTokens / total.inputTokens,
      avgInputPerCall: total.calls === 0 ? 0 : total.inputTokens / total.calls,
      outputShare: totalInput === 0 ? 0 : total.outputTokens / totalInput,
    },
    byModel: sortByCost(byModel),
    byLabel: sortByCost(byLabel),
    warnings: [...warnings],
  };
}

const usd = (n) => '$' + n.toFixed(n < 1 ? 4 : 2);
const num = (n) => n.toLocaleString('en-US');

function printMarkdown(summary, topN) {
  const t = summary.total;
  console.log('## 总计');
  console.log('| 指标 | 值 |');
  console.log('| --- | --- |');
  console.log('| 调用次数 | ' + num(t.calls) + ' |');
  console.log('| 输入 tokens | ' + num(t.inputTokens) + '（其中缓存命中 ' + num(t.cachedInputTokens) + '，命中率 ' + (t.cacheHitRate * 100).toFixed(1) + '%） |');
  console.log('| 输出 tokens | ' + num(t.outputTokens) + ' |');
  console.log('| 平均输入/次 | ' + num(Math.round(t.avgInputPerCall)) + ' |');
  console.log('| 花费 | ' + usd(t.cost) + ' |');
  if (t.baselineCost > 0) {
    console.log('| 优化前花费（baseline） | ' + usd(t.baselineCost) + ' |');
    console.log('| 节省 | ' + usd(t.savings) + '（' + ((t.savings / t.baselineCost) * 100).toFixed(1) + '%） |');
  }
  console.log('| 缓存带来的节省 | ' + usd(t.cacheSavings) + ' |');
  const table = (title, rows) => {
    if (rows.length === 0) return;
    console.log('');
    console.log('## ' + title);
    console.log('| key | calls | input | cached | output | cost |');
    console.log('| --- | --- | --- | --- | --- | --- |');
    for (const r of rows.slice(0, topN)) {
      console.log('| ' + r.key + ' | ' + num(r.calls) + ' | ' + num(r.inputTokens) + ' | ' + num(r.cachedInputTokens) + ' | ' + num(r.outputTokens) + ' | ' + usd(r.cost) + ' |');
    }
  };
  table('按模型', summary.byModel);
  table('按标签', summary.byLabel);
  if (summary.warnings.length > 0) {
    console.log('');
    console.log('## 提示');
    for (const w of summary.warnings) console.log('- ' + w);
  }
}

function parseArgs(argv) {
  const files = [];
  const flags = {};
  for (let i = 0; i < argv.length; i += 1) {
    const a = argv[i];
    if (a === '-') { files.push('-'); continue; }
    if (a.startsWith('--')) {
      const eq = a.indexOf('=');
      if (eq !== -1) { flags[a.slice(2, eq)] = a.slice(eq + 1); continue; }
      const key = a.slice(2);
      const next = argv[i + 1];
      if (next !== undefined && !next.startsWith('--')) { flags[key] = next; i += 1; } else { flags[key] = true; }
      continue;
    }
    files.push(a);
  }
  return { files, flags };
}

function main() {
  const { files, flags } = parseArgs(process.argv.slice(2));
  if (files.length !== 1) {
    console.error('用法: node token-report.mjs usage.jsonl [--pricing pricing.json] [--top 5] [--json]');
    process.exit(2);
  }
  const raw = files[0] === '-' ? readFileSync(0, 'utf8') : readFileSync(files[0], 'utf8');
  const records = raw.split('\n').map((l) => l.trim()).filter((l) => l !== '' && !l.startsWith('#')).map((l) => JSON.parse(l));
  const pricing = flags.pricing ? JSON.parse(readFileSync(String(flags.pricing), 'utf8')) : EXAMPLE_PRICING;
  const summary = summarize(records, pricing);
  if (flags.json) {
    console.log(JSON.stringify(summary, null, 2));
    return;
  }
  printMarkdown(summary, flags.top !== undefined ? Number(flags.top) : 10);
}

if (process.argv[1] && process.argv[1] === fileURLToPath(import.meta.url)) {
  try {
    main();
  } catch (err) {
    console.error('[token-report] ' + (err?.message ?? err));
    process.exit(2);
  }
}