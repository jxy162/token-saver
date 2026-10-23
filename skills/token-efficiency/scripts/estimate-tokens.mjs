#!/usr/bin/env node
/**
 * estimate-tokens.mjs — 零依赖 token 计量（可 CLI，也可 import）。
 *
 * 两种模式：
 *   heuristic（默认）：线性特征模型，对 英文/中文/代码/JSON/日志 校准过，
 *                      在 17 个混合样本上 max |误差| 约 19%，平均约 6%。
 *   exact（--exact）  ：gpt-tokenizer（o200k_base）真实分词；未安装时回退启发式并提示。
 *
 * 特征与系数（tools/calibrate-estimator.mjs 可重新拟合）：
 *   cjk 汉字/假名/全角 0.782/字 | 词 1.081/词 | 标点 0.297/字
 *   数字 0.842/字 | astral(emoji) 2.301/字 | 额外空白 0.654/字
 * 直觉：一个英文词约 1 token；一个中文字约 0.8 token；词间空格几乎不花钱，缩进/换行才花钱。
 *
 * 用法：
 *   node estimate-tokens.mjs <file... | -> [--exact] [--json] [--check N] [--quiet]
 *   import { estimateTokens, countMessagesTokens } from './estimate-tokens.mjs'
 */

import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';

const COEF = { cjk: 0.782, word: 1.081, punct: 0.297, digit: 0.842, astral: 2.301, extraWs: 0.654 };

const CJK_RE =
  /[\u1100-\u11ff\u2e80-\u303f\u3040-\u30ff\u3130-\u318f\u3400-\u4dbf\u4e00-\u9fff\uac00-\ud7af\uf900-\ufaff\uff01-\uff60]/;

/** 提取计量特征。 */
export function tokenFeatures(text) {
  let cjk = 0, words = 0, punct = 0, digits = 0, astral = 0, ws = 0;
  let inWord = false;
  const endWord = () => { if (inWord) { words += 1; inWord = false; } };
  for (const ch of text) {
    const cp = ch.codePointAt(0);
    if (cp > 0xffff) { endWord(); astral += 1; continue; }
    if (cp <= 0x7f) {
      if ((ch >= 'a' && ch <= 'z') || (ch >= 'A' && ch <= 'Z')) { inWord = true; continue; }
      endWord();
      if (ch >= '0' && ch <= '9') digits += 1;
      else if (ch === ' ' || ch === '\t' || ch === '\n' || ch === '\r' || ch === '\f') ws += 1;
      else punct += 1;
      continue;
    }
    endWord();
    if (CJK_RE.test(ch)) cjk += 1;
    else if (/\p{L}/u.test(ch)) words += 1;
    else if (/\p{N}/u.test(ch)) digits += 1;
    else if (/\s/u.test(ch)) ws += 1;
    else punct += 1;
  }
  endWord();
  return { cjk, words, punct, digits, astral, extraWs: Math.max(0, ws - words) };
}

/** 启发式 token 估算（同步、离线、无依赖）。 */
export function estimateTokens(text) {
  if (!text) return 0;
  const body = text.trim();
  if (body === '') return 0;
  const f = tokenFeatures(body);
  const raw =
    COEF.cjk * f.cjk +
    COEF.word * f.words +
    COEF.punct * f.punct +
    COEF.digit * f.digits +
    COEF.astral * f.astral +
    COEF.extraWs * f.extraWs;
  return Math.max(1, Math.ceil(raw));
}

/** chat 请求的 prompt token（含每条消息固定开销 4 与末尾 priming 3）。 */
export function countMessagesTokens(messages, counter = estimateTokens) {
  let total = 3;
  for (const m of messages) total += 4 + counter(String(m.role ?? '')) + counter(String(m.content ?? ''));
  return total;
}

export function formatTokens(n) {
  if (!Number.isFinite(n)) return String(n);
  const abs = Math.abs(n);
  if (abs < 1000) return String(Math.round(n));
  if (abs < 1000000) return (n / 1000).toFixed(abs < 10000 ? 2 : 1) + 'k';
  return (n / 1000000).toFixed(2) + 'M';
}

/** 尝试用 gpt-tokenizer 精确计数；不可用返回 null。 */
export async function loadExactTokenizer() {
  try {
    const mod = await import('gpt-tokenizer');
    const encode = mod.encode ?? mod.default?.encode;
    if (typeof encode !== 'function') return null;
    return { name: 'gpt-tokenizer:o200k_base', count: (t) => (t ? encode(t).length : 0) };
  } catch {
    return null;
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

async function main() {
  const { files, flags } = parseArgs(process.argv.slice(2));
  const inputs = files.length > 0 ? files : ['-'];
  const json = Boolean(flags.json);
  const quiet = Boolean(flags.quiet);
  const checkRaw = flags.check !== undefined ? flags.check : flags.budget;
  const check = checkRaw === undefined ? null : Number(checkRaw);

  let counter = estimateTokens;
  let tokenizerName = 'heuristic';
  if (flags.exact) {
    const tok = await loadExactTokenizer();
    if (tok) { counter = tok.count; tokenizerName = tok.name; }
    else if (!quiet) {
      console.error('[estimate-tokens] 未找到 gpt-tokenizer，已回退启发式（npm i -D gpt-tokenizer 可启用 --exact）');
    }
  }

  const rows = [];
  for (const path of inputs) {
    const text = path === '-' ? readFileSync(0, 'utf8') : readFileSync(path, 'utf8');
    rows.push({
      source: path === '-' ? '<stdin>' : path,
      chars: text.length,
      lines: text === '' ? 0 : text.split('\n').length,
      tokens: counter(text),
    });
  }
  const totalTokens = rows.reduce((s, r) => s + r.tokens, 0);
  const totalChars = rows.reduce((s, r) => s + r.chars, 0);

  if (json) {
    console.log(JSON.stringify({ tokenizer: tokenizerName, rows, totalTokens, totalChars }, null, 2));
  } else {
    const width = Math.max(6, ...rows.map((r) => r.source.length));
    console.log('tokenizer: ' + tokenizerName);
    console.log('source'.padEnd(width) + '  ' + 'chars'.padStart(9) + '  ' + 'lines'.padStart(7) + '  ' + 'tokens'.padStart(9));
    for (const r of rows) {
      console.log(r.source.padEnd(width) + '  ' + String(r.chars).padStart(9) + '  ' + String(r.lines).padStart(7) + '  ' + String(r.tokens).padStart(9));
    }
    if (rows.length > 1) {
      console.log('TOTAL'.padEnd(width) + '  ' + String(totalChars).padStart(9) + '  ' + ' '.padStart(7) + '  ' + String(totalTokens).padStart(9));
    }
  }

  if (check !== null && Number.isFinite(check) && totalTokens > check) {
    console.error('[estimate-tokens] 超出预算: ' + totalTokens + ' > ' + check);
    process.exit(1);
  }
}

if (process.argv[1] && process.argv[1] === fileURLToPath(import.meta.url)) {
  main().catch((err) => {
    console.error('[estimate-tokens] ' + (err?.message ?? err));
    process.exit(2);
  });
}