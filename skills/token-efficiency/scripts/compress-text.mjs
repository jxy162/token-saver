#!/usr/bin/env node
/**
 * compress-text.mjs — 确定性、可审计的文本压缩（可 CLI，也可 import）。
 *
 * 做四件事（都不改写 fenced code block 内部）：
 *   1. 空白归一化：折叠多余空格/空行、去行尾空白
 *   2. 去填充词：中英冗余套话（--aggressive 才会去掉可能承载约束的强调语）
 *   3. 折叠连续重复行（工具输出/日志里非常常见）
 *   4. 截断超长块：保留头尾、中间省略（--max-block-lines 或 --aggressive 启用）
 *
 * 不会做：改写语义、重排内容、删除结构化字段。这些都是有损且不可审计的，交给调用方决定。
 *
 * 用法：
 *   node compress-text.mjs <file | -> [--out file] [--report] [--json] [--aggressive]
 *                                [--keep-markers] [--max-block-lines N] [--head N] [--tail N]
 *   import { compressText } from './compress-text.mjs'
 */

import { readFileSync, writeFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { estimateTokens } from './estimate-tokens.mjs';

/** 纯套话，删掉不改变含义。 */
export const FILLER_SAFE = [
  'please note that', 'it is important to note that', 'it should be noted that',
  'needless to say', 'as you know', 'as we all know', 'as an ai language model',
  'i would like you to', 'i want you to', 'in other words', 'to put it another way',
  'at the end of the day', 'for what it is worth', 'it is worth noting that',
  '需要注意的是', '值得注意的是', '众所周知', '正如你所知', '换句话说',
  '简单来说', '总而言之', '一般来说', '基本上', '说白了',
];

/** 强调语：可能承载约束（"请务必…"），只在 --aggressive 下删除。 */
export const FILLER_EMPHASIS = [
  'make sure to', 'be sure to', 'please make sure that', 'keep in mind that',
  '请务必', '请注意', '尽量不要', '希望你', '我想要你', '务必', '千万',
];

const escapeRe = (s) => s.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');

/** 把文本切成代码块/非代码块，代码块内部永不改写。 */
export function splitCodeBlocks(text) {
  const lines = text.split('\n');
  const chunks = [];
  let current = { code: false, lines: [] };
  let fenceChar = null;
  for (const line of lines) {
    const open = /^\s{0,3}(`{3,}|~{3,})/.exec(line);
    if (fenceChar === null && open) {
      if (current.lines.length > 0) chunks.push(current);
      fenceChar = open[1][0];
      current = { code: true, lines: [line] };
      continue;
    }
    if (fenceChar !== null) {
      current.lines.push(line);
      const closing = new RegExp('^\\s{0,3}' + (fenceChar === '`' ? '`{3,}' : '~{3,}') + '\\s*$');
      if (closing.test(line)) {
        chunks.push(current);
        current = { code: false, lines: [] };
        fenceChar = null;
      }
      continue;
    }
    current.lines.push(line);
  }
  if (current.lines.length > 0) chunks.push(current);
  return chunks.map((c) => ({ code: c.code, text: c.lines.join('\n') }));
}

const joinChunks = (chunks) => chunks.map((c) => c.text).join('\n');

export function normalizeWhitespace(text) {
  return text
    .replace(/[ \t\u00a0]{2,}/g, ' ')
    .replace(/[ \t]+$/gm, '')
    .replace(/\n{3,}/g, '\n\n')
    .replace(/^\n+/, '')
    .replace(/\n+$/, '');
}

export function stripFiller(text, phrases) {
  let result = text;
  let hits = 0;
  for (const phrase of phrases) {
    const isAscii = /^[\x20-\x7e]+$/.test(phrase);
    const pattern = isAscii
      ? new RegExp('\\b' + escapeRe(phrase) + '\\b[,\\s]*', 'gi')
      : new RegExp(escapeRe(phrase) + '[，,、：:]?[ \\t]*', 'g');
    result = result.replace(pattern, () => { hits += 1; return ''; });
  }
  return { text: result.replace(/[ \t]{2,}/g, ' ').replace(/^[ \t]+/gm, '').replace(/[ \t]+$/gm, ''), hits };
}

export function collapseRepeatedLines(text, { minRepeat = 3, marker = '[... 连续重复行已折叠 x{n} ...]', keepMarkers = false } = {}) {
  const lines = text.split('\n');
  const out = [];
  let hits = 0;
  let i = 0;
  while (i < lines.length) {
    const key = lines[i].trim();
    if (key === '') { out.push(lines[i]); i += 1; continue; }
    let j = i + 1;
    while (j < lines.length && lines[j].trim() === key) j += 1;
    const count = j - i;
    if (count >= minRepeat) {
      out.push(lines[i].replace(/[ \t]+$/, ''));
      if (keepMarkers) out.push(marker.replace('{n}', String(count)));
      hits += count - 1;
    } else {
      for (let k = i; k < j; k += 1) out.push(lines[k]);
    }
    i = j;
  }
  return { text: out.join('\n'), hits };
}

export function dedupeParagraphs(text, { marker = '[... 重复段落已省略 ...]', keepMarkers = false } = {}) {
  const parts = text.split(/\n{2,}/);
  const seen = new Set();
  const out = [];
  let hits = 0;
  for (const part of parts) {
    const key = part.replace(/\s+/g, ' ').trim();
    if (key.length >= 40 && seen.has(key)) {
      hits += 1;
      if (keepMarkers) out.push(marker);
      continue;
    }
    if (key.length >= 40) seen.add(key);
    out.push(part);
  }
  return { text: out.join('\n\n'), hits };
}

export function truncateLongBlocks(chunks, { maxLines = 200, head = 80, tail = 20, marker = '[... 省略 {n} 行 ...]' } = {}) {
  let hits = 0;
  const out = chunks.map((chunk) => {
    const lines = chunk.text.split('\n');
    if (lines.length <= maxLines || lines.length <= head + tail + 1) return chunk;
    const omitted = lines.length - head - tail;
    hits += 1;
    return {
      code: chunk.code,
      text: [...lines.slice(0, head), marker.replace('{n}', String(omitted)), ...lines.slice(-tail)].join('\n'),
    };
  });
  return { chunks: out, hits };
}

export function compressText(input, options = {}) {
  const {
    aggressive = false,
    keepMarkers = false,
    maxBlockLines = null,
    headLines = 80,
    tailLines = 20,
    normalize = true,
    stripFillerWords = true,
    collapseRepeats = true,
    dedupeBlocks = null,
    truncateBlocks = null,
  } = options;

  const doDedupe = dedupeBlocks ?? aggressive;
  const doTruncate = truncateBlocks ?? (maxBlockLines !== null || aggressive);

  const report = [];
  let text = input;
  const step = (name, fn) => {
    const before = estimateTokens(text);
    const res = fn(text);
    text = res.text;
    report.push({ step: name, tokensBefore: before, tokensAfter: estimateTokens(text), hits: res.hits ?? null });
  };

  if (normalize) {
    const chunks = splitCodeBlocks(text).map((c) => (c.code ? c : { ...c, text: normalizeWhitespace(c.text) }));
    step('normalize-whitespace', () => ({ text: joinChunks(chunks) }));
  }
  if (stripFillerWords) {
    const phrases = aggressive ? [...FILLER_SAFE, ...FILLER_EMPHASIS] : FILLER_SAFE;
    let hits = 0;
    const chunks = splitCodeBlocks(text).map((c) => {
      if (c.code) return c;
      const res = stripFiller(c.text, phrases);
      hits += res.hits;
      return { ...c, text: res.text };
    });
    step('strip-filler', () => ({ text: joinChunks(chunks), hits }));
  }
  if (collapseRepeats) {
    let hits = 0;
    const chunks = splitCodeBlocks(text).map((c) => {
      if (c.code) return c;
      const res = collapseRepeatedLines(c.text, { keepMarkers, minRepeat: 3 });
      hits += res.hits;
      return { ...c, text: res.text };
    });
    step('collapse-repeated-lines', () => ({ text: joinChunks(chunks), hits }));
  }
  if (doDedupe) {
    let hits = 0;
    const chunks = splitCodeBlocks(text).map((c) => {
      if (c.code) return c;
      const res = dedupeParagraphs(c.text, { keepMarkers });
      hits += res.hits;
      return { ...c, text: res.text };
    });
    step('dedupe-paragraphs', () => ({ text: joinChunks(chunks), hits }));
  }
  if (doTruncate) {
    const res = truncateLongBlocks(splitCodeBlocks(text), {
      maxLines: maxBlockLines ?? 200,
      head: headLines,
      tail: tailLines,
    });
    step('truncate-long-blocks', () => ({ text: joinChunks(res.chunks), hits: res.hits }));
  }

  const tokensBefore = estimateTokens(input);
  const tokensAfter = estimateTokens(text);
  return {
    text,
    tokensBefore,
    tokensAfter,
    savedTokens: tokensBefore - tokensAfter,
    savedRatio: tokensBefore === 0 ? 0 : (tokensBefore - tokensAfter) / tokensBefore,
    report,
  };
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
  if (files.length === 0) {
    console.error('用法: node compress-text.mjs <file | -> [--out file] [--report] [--json] [--aggressive]');
    process.exit(2);
  }
  if (files.length > 1) {
    console.error('一次只处理一个输入（多个输入请分别调用）。');
    process.exit(2);
  }
  const source = files[0] === '-' ? readFileSync(0, 'utf8') : readFileSync(files[0], 'utf8');
  const result = compressText(source, {
    aggressive: Boolean(flags.aggressive),
    keepMarkers: Boolean(flags['keep-markers']),
    maxBlockLines: flags['max-block-lines'] !== undefined ? Number(flags['max-block-lines']) : null,
    headLines: flags.head !== undefined ? Number(flags.head) : 80,
    tailLines: flags.tail !== undefined ? Number(flags.tail) : 20,
  });

  if (flags.out) writeFileSync(String(flags.out), result.text, 'utf8');

  if (flags.json) {
    console.log(JSON.stringify({
      tokensBefore: result.tokensBefore,
      tokensAfter: result.tokensAfter,
      savedTokens: result.savedTokens,
      savedRatio: Number(result.savedRatio.toFixed(4)),
      steps: result.report,
      out: flags.out ?? null,
      text: flags.out ? undefined : result.text,
    }, null, 2));
    return;
  }

  if (!flags.out) process.stdout.write(result.text + (result.text.endsWith('\n') ? '' : '\n'));
  if (flags.report || !flags.out) {
    const pct = (result.savedRatio * 100).toFixed(1);
    console.error('token: ' + result.tokensBefore + ' -> ' + result.tokensAfter + ' (节省 ' + pct + '%)');
    for (const s of result.report) {
      const delta = s.tokensBefore - s.tokensAfter;
      console.error('  - ' + s.step + ': -' + delta + (s.hits ? ' (命中 ' + s.hits + ')' : ''));
    }
  }
}

if (process.argv[1] && process.argv[1] === fileURLToPath(import.meta.url)) {
  try {
    main();
  } catch (err) {
    console.error('[compress-text] ' + (err?.message ?? err));
    process.exit(2);
  }
}