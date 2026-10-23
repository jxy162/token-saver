#!/usr/bin/env node
/**
 * calibrate-estimator.mjs — 用真实分词器校准 estimate-tokens.mjs 的启发式系数。
 *
 *   node tools/calibrate-estimator.mjs           # 报告当前系数在样本集上的误差
 *   node tools/calibrate-estimator.mjs --fit     # 用带先验的岭回归重新拟合系数并打印
 *   node tools/calibrate-estimator.mjs --samples # 打印样本集
 *
 * 需要 gpt-tokenizer（npm i -D gpt-tokenizer）。换了模型族（例如 o200k -> cl100k）或
 * 换了主要语种时，重新跑一次 --fit 是合理的。
 */

import { estimateTokens, tokenFeatures } from '../skills/token-efficiency/scripts/estimate-tokens.mjs';

const CURRENT = { cjk: 0.782, words: 1.081, punct: 0.297, digits: 0.842, astral: 2.301, extraWs: 0.654 };
const FEATURES = ['cjk', 'words', 'punct', 'digits', 'astral', 'extraWs'];
const PRIOR = { cjk: 0.85, words: 1.0, punct: 0.5, digits: 0.7, astral: 2.5, extraWs: 0.3 };

export const SAMPLES = [
  '请帮我分析这段日志，找出内存泄漏的根本原因，并给出修复建议。需要注意，修复方案要保持向后兼容。',
  'Summarize the following diff and list breaking changes.',
  'The quick brown fox jumps over the lazy dog. '.repeat(20),
  'function add(a, b) {\n  return a + b;\n}\n\nconst total = items.reduce((acc, x) => acc + x.price, 0);\n',
  JSON.stringify({ users: Array.from({ length: 20 }, (_, i) => ({ id: i, name: 'user-' + i, tags: ['a', 'b'] })) }),
  '把 src/pipeline.ts 里的 cache 逻辑抽成一个独立的 CacheMiddleware 类，写完补单元测试。',
  Array.from({ length: 50 }, (_, i) => '2026-10-23T10:00:' + String(i).padStart(2, '0') + 'Z ERROR handler.ts:' + (100 + i) + " TypeError: cannot read property 'x' of undefined").join('\n'),
  '结果 done 但覆盖率 fail 需要 >= 90%.',
  'Explain how prompt caching reduces cost, in 2 sentences.',
  '请用一句话说明什么是前缀缓存。',
  'def f(x):\n    return x * 2 if x > 0 else -x\n',
  JSON.stringify({ status: 'ok', items: [{ sku: 'A-100', qty: 3, price: 19.9 }], total: 59.7 }, null, 2),
  '上下文窗口管理是降低 token 消耗的核心：只保留与当前任务相关的片段，丢弃已完成步骤的冗长中间输出，并把长历史压缩成结构化摘要。这样做可以把每轮对话的输入从数万 token 降到几千 token，同时保持任务成功率。',
  'When you send a request to a large language model, the entire conversation history is re-sent every time. That means a long chat accumulates cost quadratically unless you compact it. Compaction, summarization and prefix caching are the three main levers you have.',
  JSON.stringify(Array.from({ length: 30 }, (_, i) => ({ id: i, email: 'person' + i + '@example.com', active: i % 3 === 0, score: (i * 37) % 100 }))),
  'Write a Python function that parses a CSV file, validates each row against a schema, and returns a list of errors with line numbers.',
  '这段代码为什么会在高并发下出现死锁？请结合锁的获取顺序解释，并给出两种修复方案及其权衡。',
];

async function loadReal() {
  const mod = await import('gpt-tokenizer');
  const encode = mod.encode ?? mod.default?.encode;
  if (typeof encode !== 'function') throw new Error('gpt-tokenizer 没有导出 encode');
  return { name: 'gpt-tokenizer:o200k_base', count: (t) => encode(t).length };
}

function evaluate(coef, coefName) {
  const counter = (text) => {
    const f = tokenFeatures(text);
    const sum = FEATURES.reduce((s, k) => s + coef[k] * f[k], 0);
    return Math.max(text.trim() === '' ? 0 : 1, Math.ceil(sum));
  };
  let worst = 0;
  let sum = 0;
  const rows = [];
  for (const [i, sample] of SAMPLES.entries()) {
    const exact = REAL.count(sample);
    const guess = counter(sample);
    const err = exact === 0 ? 0 : (guess - exact) / exact;
    worst = Math.max(worst, Math.abs(err));
    sum += Math.abs(err);
    rows.push({ i, exact, guess, err, sample });
  }
  rows.sort((a, b) => Math.abs(b.err) - Math.abs(a.err));
  console.log('== ' + coefName + ' ==');
  for (const r of rows.slice(0, 5)) {
    console.log('  ' + String(r.i).padStart(3) + ' exact=' + String(r.exact).padStart(6) + ' est=' + String(r.guess).padStart(6) +
      ' ' + (r.err * 100).toFixed(1).padStart(7) + '%  ' + r.sample.slice(0, 40).replace(/\n/g, ' '));
  }
  console.log('  max=' + (worst * 100).toFixed(1) + '%  mean=' + ((sum / rows.length) * 100).toFixed(1) + '%  (样本 ' + rows.length + ')');
  return { worst, mean: sum / rows.length };
}

function fit(lambda = 0.05) {
  const X = SAMPLES.map((s) => FEATURES.map((k) => tokenFeatures(s)[k]));
  const y = SAMPLES.map((s) => REAL.count(s));
  const n = FEATURES.length;
  const A = Array.from({ length: n }, () => new Array(n + 1).fill(0));
  const prior = FEATURES.map((k) => PRIOR[k]);
  for (let i = 0; i < n; i += 1) {
    for (let j = 0; j < n; j += 1) A[i][j] = X.reduce((s, x) => s + x[i] * x[j], 0) + (i === j ? lambda : 0);
    A[i][n] = X.reduce((s, x, k) => s + x[i] * y[k], 0) + lambda * prior[i];
  }
  for (let c = 0; c < n; c += 1) {
    let p = c;
    for (let r = c + 1; r < n; r += 1) if (Math.abs(A[r][c]) > Math.abs(A[p][c])) p = r;
    [A[c], A[p]] = [A[p], A[c]];
    for (let r = 0; r < n; r += 1) {
      if (r === c || A[c][c] === 0) continue;
      const factor = A[r][c] / A[c][c];
      for (let k = c; k <= n; k += 1) A[r][k] -= factor * A[c][k];
    }
  }
  const coef = {};
  FEATURES.forEach((k, i) => { coef[k] = Number((A[i][n] / A[i][i]).toFixed(3)); });
  return coef;
}

const REAL = await loadReal();

if (process.argv.includes('--samples')) {
  SAMPLES.forEach((s, i) => console.log('--- ' + i + ' (exact ' + REAL.count(s) + ') ---\n' + s.slice(0, 200)));
  process.exit(0);
}

console.log('tokenizer: ' + REAL.name + '\n');
const current = evaluate(CURRENT, '当前系数 (estimate-tokens.mjs)');
if (process.argv.includes('--fit')) {
  const coef = fit(0.05);
  console.log('\n拟合结果（岭回归 lambda=0.05，先验见 PRIOR）：');
  console.log('const COEF = ' + JSON.stringify(coef) + ';');
  evaluate(coef, '拟合系数');
} else {
  const inline = evaluate(CURRENT, 'estimate-tokens.mjs 实际输出');
  console.log('\n提示：加 --fit 可重新拟合；当前实现与样本误差 max=' + (current.worst * 100).toFixed(1) + '%, mean=' + (inline.mean * 100).toFixed(1) + '%。');
}
console.log('\n注：样本集是混合语料的抽样，不代表所有领域；换领域后请用你自己的真实流量重跑。');