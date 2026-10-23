#!/usr/bin/env node
/**
 * prompt-cache-plan.mjs — 把一次请求的块重排成"稳定前缀 + 易变尾部"，并为前缀缓存标出断点。
 *
 * 为什么：前缀缓存按"从头开始完全相同的 token 前缀"命中。只要把易变内容（用户本轮问题、
 * 时间戳、随机 ID、最新检索结果）挪到末尾，同一会话后续调用就能命中缓存，缓存命中的输入
 * 通常只按 10%~50% 计价。
 *
 * 输入（JSON）：
 *   { "maxBreakpoints": 4, "blocks": [
 *       { "id": "policy", "role": "system", "content": "...", "stability": "static" },
 *       { "id": "fewshot", "role": "user", "content": "...", "stability": "static" },
 *       { "id": "question", "role": "user", "content": "...", "stability": "volatile" } ] }
 *
 * 输出：重排后的顺序、可缓存前缀 token 数、建议断点（Anthropic cache_control 最多 4 个；
 *       OpenAI 自动前缀缓存通常要求前缀 >= 1024 token），以及需要注意的风险。
 *
 * 用法：node prompt-cache-plan.mjs messages.json [--out plan.json] [--json] [--min-prefix 1024]
 */

import { readFileSync, writeFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { estimateTokens } from './estimate-tokens.mjs';

const VOLATILE_HINT = /\{\{(?:now|timestamp|uuid|random|request_id|today)\}\}|\d{4}-\d{2}-\d{2}T\d{2}:\d{2}/i;

export function planCacheOrder(blocks, options = {}) {
  const minPrefix = options.minPrefixTokens ?? 1024;
  const maxBreakpoints = options.maxBreakpoints ?? 4;
  const warnings = [];

  const ordered = [...blocks].sort((a, b) => {
    const sa = a.stability === 'volatile' ? 1 : 0;
    const sb = b.stability === 'volatile' ? 1 : 0;
    return sa - sb;
  });

  const tokens = ordered.map((b) => estimateTokens(String(b.content ?? '')));
  const prefixTokens = [];
  let running = 0;
  ordered.forEach((b, i) => {
    running += tokens[i] + 4;
    prefixTokens.push(running);
    if (b.stability !== 'volatile' && VOLATILE_HINT.test(String(b.content ?? ''))) {
      warnings.push('块 "' + b.id + '" 标为 static，但内容里疑似含时间戳/随机值；这类内容会破坏缓存命中，应移到 volatile 尾部。');
    }
  });

  const staticCount = ordered.filter((b) => b.stability !== 'volatile').length;
  const breakpoints = [];
  for (let i = 0; i < staticCount && breakpoints.length < maxBreakpoints; i += 1) {
    if (prefixTokens[i] >= minPrefix) breakpoints.push({ atBlockIndex: i, id: ordered[i].id, prefixTokens: prefixTokens[i] });
  }
  if (staticCount > 0 && prefixTokens[staticCount - 1] < minPrefix) {
    warnings.push('稳定前缀仅 ' + prefixTokens[staticCount - 1] + ' token，低于 min-prefix(' + minPrefix + ')，缓存可能不生效（收益 < 成本）。');
  }
  const volatileTail = ordered.length - staticCount;
  if (volatileTail === 0) warnings.push('没有 volatile 块：如果每次请求内容都不同，前缀缓存不会命中，应把变化部分单独放到末尾。');

  return {
    ordered,
    prefixTokens,
    cacheablePrefixTokens: staticCount === 0 ? 0 : prefixTokens[staticCount - 1],
    staticBlocks: staticCount,
    breakpoints,
    warnings,
  };
}

/** 生成 Anthropic 风格的消息体片段（system 用 cache_control 标记断点）。 */
export function toAnthropicPayload(plan) {
  const systemBlocks = plan.ordered
    .filter((b) => b.role === 'system')
    .map((b) => ({ type: 'text', text: String(b.content) }));
  if (systemBlocks.length > 0 && plan.breakpoints.length > 0) {
    systemBlocks[systemBlocks.length - 1].cache_control = { type: 'ephemeral' };
  }
  const messages = plan.ordered
    .filter((b) => b.role !== 'system')
    .map((b) => {
      const block = { role: b.role === 'assistant' ? 'assistant' : 'user', content: [{ type: 'text', text: String(b.content) }] };
      if (b.stability !== 'volatile' && plan.breakpoints.length > 0) {
        const idx = plan.ordered.findIndex((o) => o.id === b.id);
        if (plan.breakpoints.some((bp) => bp.atBlockIndex === idx)) block.content[0].cache_control = { type: 'ephemeral' };
      }
      return block;
    });
  return { system: systemBlocks, messages };
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
    console.error('用法: node prompt-cache-plan.mjs messages.json [--out plan.json] [--json] [--min-prefix 1024]');
    process.exit(2);
  }
  const raw = files[0] === '-' ? readFileSync(0, 'utf8') : readFileSync(files[0], 'utf8');
  const parsed = JSON.parse(raw);
  const blocks = Array.isArray(parsed) ? parsed : parsed.blocks ?? parsed.messages ?? [];
  if (blocks.length === 0) {
    console.error('输入里没有 blocks/messages。');
    process.exit(2);
  }
  const plan = planCacheOrder(blocks, {
    minPrefixTokens: flags['min-prefix'] !== undefined ? Number(flags['min-prefix']) : 1024,
    maxBreakpoints: flags['max-breakpoints'] !== undefined ? Number(flags['max-breakpoints']) : Number(parsed.maxBreakpoints ?? 4),
  });
  const payload = {
    order: plan.ordered.map((b) => ({ id: b.id, role: b.role, stability: b.stability ?? 'static' })),
    cacheablePrefixTokens: plan.cacheablePrefixTokens,
    staticBlocks: plan.staticBlocks,
    breakpoints: plan.breakpoints,
    warnings: plan.warnings,
    anthropicPayload: toAnthropicPayload(plan),
  };
  if (flags.out) writeFileSync(String(flags.out), JSON.stringify(payload, null, 2), 'utf8');
  if (flags.json || flags.out) {
    console.log(JSON.stringify(payload, null, 2));
    return;
  }
  console.log('可缓存前缀: ' + plan.cacheablePrefixTokens + ' token / 稳定块 ' + plan.staticBlocks + ' 个');
  console.log('建议顺序:');
  plan.ordered.forEach((b, i) => {
    console.log('  ' + String(i + 1).padStart(2) + '. [' + (b.stability ?? 'static') + '] ' + b.id + ' (' + plan.prefixTokens[i] + ' token 累计)');
  });
  if (plan.breakpoints.length > 0) {
    console.log('建议 cache_control 断点: ' + plan.breakpoints.map((b) => b.id + '@' + b.prefixTokens).join(', '));
  }
  for (const w of plan.warnings) console.log('warning: ' + w);
}

if (process.argv[1] && process.argv[1] === fileURLToPath(import.meta.url)) {
  try {
    main();
  } catch (err) {
    console.error('[prompt-cache-plan] ' + (err?.message ?? err));
    process.exit(2);
  }
}