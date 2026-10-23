#!/usr/bin/env node
/**
 * trim-context.mjs — 按优先级把多段上下文裁进 token 预算（可 CLI，也可 import）。
 *
 * 输入（JSON）：
 *   { "budget": 12000, "reserveOutput": 1024, "segments": [
 *       { "id": "system", "text": "...", "kind": "system", "locked": true },
 *       { "id": "docs-1", "text": "...", "kind": "retrieval", "priority": 60, "minTokens": 200 },
 *       { "id": "history", "text": "...", "kind": "history", "recency": 3 } ] }
 *   也可以只给数组并用 --budget N。
 *
 * 规则：priority 大的先保；locked 段要么完整保留要么整体丢弃；可裁剪段按 head/tail 折中截断；
 *       放弃的内容会写进 report（reason=budget），便于审计"为什么这段没了"。
 *
 * 用法：
 *   node trim-context.mjs context.json --budget 12000 [--reserve-output 1024] [--out trimmed.json]
 *                          [--print-text] [--json] [--no-marker] [--strategy head|tail|head-tail]
 */

import { readFileSync, writeFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { estimateTokens } from './estimate-tokens.mjs';

export const DEFAULT_PRIORITY = {
  policy: 100, system: 95, task: 90, schema: 80, tool: 60, retrieval: 50, example: 25, history: 20,
};

/** 截断到 maxTokens：按行贪心取 head / tail。 */
export function trimToTokens(text, maxTokens, strategy = 'head-tail', marker = '[... 已裁剪 {n} 行 ...]') {
  if (maxTokens <= 0) return { text: '', droppedLines: 0 };
  if (estimateTokens(text) <= maxTokens) return { text, droppedLines: 0 };
  const lines = text.split('\n');
  const headBudget = strategy === 'head' ? maxTokens : strategy === 'tail' ? 0 : Math.ceil(maxTokens * 0.6);
  const tailBudget = strategy === 'tail' ? maxTokens : strategy === 'head' ? 0 : maxTokens - headBudget;

  const take = (from, budget, step) => {
    const kept = [];
    let used = 0;
    let cursor = from;
    while (cursor >= 0 && cursor < lines.length) {
      const cost = estimateTokens(lines[cursor]);
      if (used + cost > budget) break;
      kept.push(lines[cursor]);
      used += cost;
      cursor += step;
    }
    return { kept, cursor };
  };

  const head = take(0, headBudget, 1);
  let tailLines = [];
  let tailStart = lines.length;
  if (tailBudget > 0) {
    const tail = take(lines.length - 1, tailBudget, -1);
    tailLines = tail.kept.reverse();
    tailStart = tail.cursor + 1;
  }
  const droppedLines = Math.max(0, tailStart - head.cursor);
  if (droppedLines <= 0) return { text, droppedLines: 0 };
  const parts = [...head.kept];
  if (marker) parts.push(marker.replace('{n}', String(droppedLines)));
  parts.push(...tailLines);
  let result = parts.join('\n');
  // 退化场景（例如段落就是一行超长文本）：按字符比例硬截断，保证结果落在预算内。
  const keptAnyContent = head.kept.length > 0 || tailLines.length > 0;
  if (!keptAnyContent || result.trim() === '' || estimateTokens(result) > maxTokens) {
    const perChar = estimateTokens(text) / Math.max(1, text.length);
    const markerCost = marker ? estimateTokens(marker.replace('{n}', String(droppedLines))) : 0;
    const contentBudget = Math.max(0, maxTokens - markerCost);
    let keepChars = Math.max(8, Math.min(text.length, Math.floor(contentBudget / Math.max(perChar, 0.2))));
    const build = (chars) => {
      const headText = text.slice(0, chars);
      return marker ? headText + '\n' + marker.replace('{n}', String(droppedLines)) : headText;
    };
    result = build(keepChars);
    let guard = 0;
    while (estimateTokens(result) > maxTokens && keepChars > 8 && guard < 8) {
      keepChars = Math.max(8, Math.floor(keepChars * 0.85));
      result = build(keepChars);
      guard += 1;
    }
  }
  return { text: result, droppedLines };
}

export function allocate(segments, budgetTokens, options = {}) {
  const { strategy = 'head-tail', marker = '[... 已裁剪 {n} 行 ...]', minPartialTokens = 48 } = options;
  const items = segments.map((s) => {
    const kind = s.kind ?? 'task';
    return {
      id: s.id ?? kind,
      kind,
      text: String(s.text ?? ''),
      priority: s.priority ?? DEFAULT_PRIORITY[kind] ?? 50,
      locked: Boolean(s.locked),
      minTokens: s.minTokens ?? 0,
      recency: s.recency ?? 0,
      tokens: estimateTokens(String(s.text ?? '')),
    };
  });

  const totalBefore = items.reduce((s, i) => s + i.tokens, 0);
  const report = [];
  const kept = [];
  let used = 0;

  if (totalBefore <= budgetTokens) {
    for (const item of items) {
      kept.push({ id: item.id, kind: item.kind, text: item.text, tokens: item.tokens });
      report.push({ id: item.id, kind: item.kind, priority: item.priority, action: 'keep', tokensBefore: item.tokens, tokensAfter: item.tokens });
    }
    return { budget: budgetTokens, used: totalBefore, kept, report, tokensBefore: totalBefore, tokensAfter: totalBefore };
  }

  const ordered = [...items].sort((a, b) =>
    b.priority - a.priority || b.recency - a.recency || a.tokens - b.tokens);
  const decisions = new Map();

  for (const item of ordered) {
    const remaining = budgetTokens - used;
    if (item.tokens <= remaining) {
      decisions.set(item.id, { action: 'keep', text: item.text, tokensAfter: item.tokens });
      used += item.tokens;
      continue;
    }
    const floor = item.minTokens || minPartialTokens;
    if (!item.locked && remaining >= floor) {
      const trimmed = trimToTokens(item.text, remaining, strategy, marker).text;
      const tokensAfter = estimateTokens(trimmed);
      decisions.set(item.id, { action: trimmed === item.text ? 'keep' : 'trimmed', text: trimmed, tokensAfter });
      used += tokensAfter;
      continue;
    }
    decisions.set(item.id, {
      action: 'dropped',
      text: '',
      tokensAfter: 0,
      reason: item.locked ? 'locked-segment-does-not-fit' : 'budget-exhausted',
    });
  }

  for (const item of items) {
    const d = decisions.get(item.id) ?? { action: 'dropped', text: '', tokensAfter: 0, reason: 'budget-exhausted' };
    if (d.action !== 'dropped') kept.push({ id: item.id, kind: item.kind, text: d.text, tokens: d.tokensAfter });
    report.push({
      id: item.id, kind: item.kind, priority: item.priority, action: d.action,
      tokensBefore: item.tokens, tokensAfter: d.tokensAfter, reason: d.reason ?? null,
    });
  }

  const tokensAfter = kept.reduce((s, k) => s + k.tokens, 0);
  return { budget: budgetTokens, used: tokensAfter, kept, report, tokensBefore: totalBefore, tokensAfter };
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
    console.error('用法: node trim-context.mjs context.json --budget 12000 [--reserve-output 1024] [--out out.json] [--print-text]');
    process.exit(2);
  }
  const raw = files[0] === '-' ? readFileSync(0, 'utf8') : readFileSync(files[0], 'utf8');
  const parsed = JSON.parse(raw);
  const segments = Array.isArray(parsed) ? parsed : parsed.segments ?? [];
  const reserve = flags['reserve-output'] !== undefined ? Number(flags['reserve-output']) : Number(parsed.reserveOutput ?? 0);
  const budgetRaw = flags.budget !== undefined ? Number(flags.budget) : Number(parsed.budget ?? NaN);
  if (!Number.isFinite(budgetRaw)) {
    console.error('缺少预算：用 --budget N，或在输入 JSON 里给 budget。');
    process.exit(2);
  }
  const budget = budgetRaw - (Number.isFinite(reserve) ? reserve : 0);
  if (budget <= 0) {
    console.error('预算减去输出预留后 <= 0：budget=' + budgetRaw + '，reserveOutput=' + reserve + '。请增大 --budget，或加 --reserve-output 0 忽略预留。');
    process.exit(2);
  }

  const marker = flags['no-marker'] ? '' : '[... 已裁剪 {n} 行 ...]';
  const result = allocate(segments, budget, {
    strategy: flags.strategy ? String(flags.strategy) : 'head-tail',
    marker,
  });
  const payload = {
    budget, reserveOutput: Number.isFinite(reserve) ? reserve : 0,
    tokensBefore: result.tokensBefore, tokensAfter: result.tokensAfter,
    kept: result.kept.map((k) => ({ id: k.id, kind: k.kind, tokens: k.tokens, text: k.text })),
    report: result.report,
  };

  if (flags.out) writeFileSync(String(flags.out), JSON.stringify(payload, null, 2), 'utf8');
  if (flags['print-text']) {
    process.stdout.write(result.kept.map((k) => k.text).join('\n\n'));
    return;
  }
  if (flags.json) {
    console.log(JSON.stringify(payload, null, 2));
    return;
  }
  console.log('budget: ' + budget + '  tokens: ' + result.tokensBefore + ' -> ' + result.tokensAfter);
  const width = Math.max(8, ...result.report.map((r) => String(r.id).length));
  for (const r of result.report) {
    const reason = r.reason ? ' (' + r.reason + ')' : '';
    console.log(String(r.id).padEnd(width) + '  ' + String(r.kind).padEnd(10) + '  p=' + String(r.priority).padStart(3) +
      '  ' + String(r.action).padEnd(8) + '  ' + String(r.tokensBefore).padStart(8) + ' -> ' + String(r.tokensAfter).padStart(8) + reason);
  }
  if (flags.out) console.log('written: ' + flags.out);
}

if (process.argv[1] && process.argv[1] === fileURLToPath(import.meta.url)) {
  try {
    main();
  } catch (err) {
    console.error('[trim-context] ' + (err?.message ?? err));
    process.exit(2);
  }
}