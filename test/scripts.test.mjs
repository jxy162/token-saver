import { test } from 'node:test';
import assert from 'node:assert/strict';

import {
  estimateTokens, countMessagesTokens, formatTokens, tokenFeatures, loadExactTokenizer,
} from '../skills/token-efficiency/scripts/estimate-tokens.mjs';
import {
  compressText, splitCodeBlocks, normalizeWhitespace, stripFiller, FILLER_SAFE, FILLER_EMPHASIS,
} from '../skills/token-efficiency/scripts/compress-text.mjs';
import { allocate, trimToTokens, DEFAULT_PRIORITY } from '../skills/token-efficiency/scripts/trim-context.mjs';
import { planCacheOrder, toAnthropicPayload } from '../skills/token-efficiency/scripts/prompt-cache-plan.mjs';
import { summarize, recordCost, findPrice } from '../skills/token-efficiency/scripts/token-report.mjs';

const longTokenText = (n) => 'word '.repeat(n);

test('estimateTokens: 边界与单调性', () => {
  assert.equal(estimateTokens(''), 0);
  assert.equal(estimateTokens('   \n  '), 0);
  assert.ok(estimateTokens('hello') >= 1);
  const base = estimateTokens('summarize this diff');
  assert.ok(estimateTokens('summarize this diff and list breaking changes') > base);
});

test('estimateTokens: 特征提取符合直觉', () => {
  const f = tokenFeatures('中文 abc 123 ,,!');
  assert.equal(f.cjk, 2);
  assert.equal(f.words, 1);
  assert.equal(f.digits, 3);
  assert.ok(f.punct >= 3);
  assert.equal(f.extraWs, 2); // 3 个空格里只隔出 1 个词，多出的 2 个算额外空白
});

test('estimateTokens: 与真实分词器误差在 25% 内', async () => {
  const exact = await loadExactTokenizer();
  if (!exact) return; // 没装 gpt-tokenizer 时跳过
  for (const sample of [
    'Summarize the following diff and list breaking changes.',
    '请帮我分析这段日志，找出内存泄漏的根本原因，并给出修复建议。',
    JSON.stringify({ users: [{ id: 1, name: 'a', tags: ['x'] }] }),
  ]) {
    const real = exact.count(sample);
    const guess = estimateTokens(sample);
    assert.ok(Math.abs(guess - real) / real < 0.25, sample + ': est=' + guess + ' exact=' + real);
  }
});

test('countMessagesTokens 计入消息开销', () => {
  const messages = [{ role: 'system', content: 'x' }, { role: 'user', content: 'y' }];
  assert.equal(countMessagesTokens(messages, () => 1), 3 + (4 + 1 + 1) * 2);
  assert.equal(countMessagesTokens([], () => 1), 3);
});

test('formatTokens', () => {
  assert.equal(formatTokens(999), '999');
  assert.equal(formatTokens(1500), '1.50k');
  assert.equal(formatTokens(25000), '25.0k');
  assert.equal(formatTokens(2_500_000), '2.50M');
});

test('splitCodeBlocks: 识别 fenced 代码块', () => {
  const chunks = splitCodeBlocks('text\n```js\ncode\n```\nafter');
  assert.equal(chunks.length, 3);
  assert.equal(chunks[0].code, false);
  assert.equal(chunks[1].code, true);
  assert.equal(chunks[2].code, false);
  assert.ok(chunks[1].text.includes('```js'));
});

test('compressText: 代码块内容逐字保留', () => {
  const fenced = '```js\nconst a = 1;   \nconst a = 1;\nconst a = 1;\n```';
  const input = 'Please note that 这里有重复行。\n' + fenced + '\n';
  const out = compressText(input, { aggressive: true });
  assert.ok(out.text.includes(fenced), '代码块被改写了: ' + out.text);
});

test('compressText: 折叠连续重复行与去填充词', () => {
  const input = Array.from({ length: 6 }, () => '2026-10-23 ERROR connection refused').join('\n');
  const out = compressText(input);
  assert.equal(out.text.split('\n').length, 1);
  assert.ok(out.savedTokens > 0);

  const filled = compressText('Please note that the answer is 42.');
  assert.ok(!/please note that/i.test(filled.text));
  assert.ok(filled.text.includes('42'));

  const emphasis = '请务必在修改前备份数据库。';
  assert.ok(compressText(emphasis).text.includes('请务必'));
  assert.ok(!compressText(emphasis, { aggressive: true }).text.includes('请务必'));
  assert.ok(FILLER_SAFE.length > 0 && FILLER_EMPHASIS.length > 0);
});

test('compressText: 幂等（二次压缩不再省）', () => {
  const input = 'Please note that this is a test.\n\n\n\n另外\n另外\n另外\n另外\n';
  const once = compressText(input, { aggressive: true });
  const twice = compressText(once.text, { aggressive: true });
  assert.equal(twice.savedTokens, 0);
});

test('normalizeWhitespace / stripFiller 直接可用', () => {
  assert.equal(normalizeWhitespace('a  \n\n\n\nb   '), 'a\n\nb');
  const r = stripFiller('in other words, 就是慢。', FILLER_SAFE);
  assert.ok(!/in other words/i.test(r.text));
  assert.equal(r.hits, 1);
});

test('trimToTokens: 单行超长文本也能落进预算', () => {
  const text = longTokenText(2000);
  const trimmed = trimToTokens(text, 300);
  assert.ok(estimateTokens(trimmed.text) <= 300, 'tokens=' + estimateTokens(trimmed.text));
  assert.ok(trimmed.droppedLines >= 1);
  const noMarker = trimToTokens(text, 300, 'head-tail', '');
  assert.ok(estimateTokens(noMarker.text) <= 300);
});

test('allocate: 预算内保留、超预算丢弃低优先级', () => {
  const locked = { id: 'schema', kind: 'schema', locked: true, text: longTokenText(300) };
  const retrieval = { id: 'docs', kind: 'retrieval', text: longTokenText(200) };
  const history = { id: 'h1', kind: 'history', text: longTokenText(50) };
  const lockedTokens = estimateTokens(locked.text);
  const budget = lockedTokens + 20;

  const result = allocate([locked, retrieval, history], budget);
  assert.ok(result.tokensAfter <= budget, 'used=' + result.tokensAfter + ' budget=' + budget);
  const byId = Object.fromEntries(result.report.map((r) => [r.id, r]));
  assert.equal(byId.schema.action, 'keep');
  assert.equal(byId.h1.action, 'dropped');
  assert.ok(byId.docs.action !== 'keep');
  assert.equal(result.report[0].id, 'schema', 'report 应保持输入顺序');
});

test('allocate: locked 段放不下时整体丢弃，不截断', () => {
  const locked = { id: 'schema', kind: 'schema', locked: true, text: longTokenText(300) };
  const result = allocate([locked], 50);
  assert.equal(result.report[0].action, 'dropped');
  assert.equal(result.report[0].tokensAfter, 0);
  assert.match(result.report[0].reason, /locked/);
});

test('allocate: 全部装得下时不改动', () => {
  const segments = [{ id: 'a', kind: 'task', text: 'hello world' }];
  const result = allocate(segments, 10000);
  assert.equal(result.report[0].action, 'keep');
  assert.equal(result.tokensAfter, result.tokensBefore);
  assert.ok(DEFAULT_PRIORITY.schema > DEFAULT_PRIORITY.history);
});

test('planCacheOrder: 稳定块前置并给出断点', () => {
  const blocks = [
    { id: 'q', role: 'user', content: '问题', stability: 'volatile' },
    { id: 'policy', role: 'system', content: 'x'.repeat(200), stability: 'static' },
  ];
  const plan = planCacheOrder(blocks, { minPrefixTokens: 1 });
  assert.equal(plan.ordered[0].id, 'policy');
  assert.ok(plan.cacheablePrefixTokens > 0);
  assert.equal(plan.breakpoints.length, 1);
  const payload = toAnthropicPayload(plan);
  assert.ok(payload.system.length === 1);
});

test('planCacheOrder: 对可疑动态内容与缺失尾部给出警告', () => {
  const withTimestamp = planCacheOrder([
    { id: 'sys', role: 'system', content: '现在是 {{now}}，规则如下' + 'y'.repeat(100), stability: 'static' },
    { id: 'q', role: 'user', content: '问题', stability: 'volatile' },
  ], { minPrefixTokens: 1 });
  assert.ok(withTimestamp.warnings.some((w) => w.includes('时间戳') || w.includes('随机值')));

  const noVolatile = planCacheOrder([{ id: 'sys', role: 'system', content: 'y'.repeat(100), stability: 'static' }], { minPrefixTokens: 1 });
  assert.ok(noVolatile.warnings.some((w) => w.includes('volatile')));
});

test('token-report: 成本、缓存折扣与 baseline 节省', () => {
  const pricing = { 'gpt-4o-mini': { in: 1, out: 10, cachedIn: 0.5 } };
  const record = { model: 'gpt-4o-mini', inputTokens: 1000, outputTokens: 100, cachedInputTokens: 500, baselineInputTokens: 2000, baselineOutputTokens: 100 };
  const calc = recordCost(record, pricing);
  const expected = (500 / 1e6) * 1 + (500 / 1e6) * 0.5 + (100 / 1e6) * 10;
  assert.ok(Math.abs(calc.cost - expected) < 1e-12, String(calc.cost));
  assert.ok(Math.abs(calc.cacheSavings - (500 / 1e6) * 0.5) < 1e-12);

  const summary = summarize([record], pricing);
  assert.equal(summary.total.calls, 1);
  assert.equal(summary.total.cacheHitRate, 0.5);
  assert.ok(Math.abs(summary.total.savings - ((2000 / 1e6) * 1 + (100 / 1e6) * 10 - expected)) < 1e-12);
  assert.equal(summary.byModel[0].key, 'gpt-4o-mini');
});

test('token-report: 价格前缀匹配与兜底', () => {
  const pricing = { 'gpt-4o-mini': { in: 1, out: 2 }, _default: { in: 9, out: 9 } };
  const [price, matched, approximated] = findPrice('gpt-4o-mini-2024-07-18', pricing);
  assert.equal(matched, 'gpt-4o-mini');
  assert.equal(approximated, true);
  assert.equal(price.in, 1);
  const [fallback, key] = findPrice('totally-unknown-model', pricing);
  assert.equal(key, '_default');
  assert.equal(fallback.in, 9);
});