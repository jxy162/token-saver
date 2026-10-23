#!/usr/bin/env node
/**
 * validate-skill.mjs — 技能自检（不依赖 Python，可直接在 CI 里跑）。
 *
 *   node tools/validate-skill.mjs [skills/token-efficiency]
 *
 * 检查：frontmatter(name/description)、命名规范、描述长度、未完成占位符、
 * SKILL.md 里的相对链接是否存在、scripts/*.mjs 语法是否有效。
 */

import { existsSync, readdirSync, readFileSync } from 'node:fs';
import { execFileSync } from 'node:child_process';
import { join, resolve, dirname } from 'node:path';

const skillDir = resolve(process.argv[2] ?? 'skills/token-efficiency');
const errors = [];
const warnings = [];

const skillFile = join(skillDir, 'SKILL.md');
if (!existsSync(skillFile)) {
  console.error('缺少 SKILL.md: ' + skillFile);
  process.exit(1);
}
const raw = readFileSync(skillFile, 'utf8');

const fmMatch = /^---\r?\n([\s\S]*?)\r?\n---\r?\n/.exec(raw);
if (!fmMatch) errors.push('SKILL.md 缺少 YAML frontmatter（--- 包围的头部）。');
const frontmatter = fmMatch ? fmMatch[1] : '';
const body = fmMatch ? raw.slice(fmMatch[0].length) : raw;

const pick = (key) => {
  const m = new RegExp('^' + key + ':\\s*(.+)$', 'm').exec(frontmatter);
  return m ? m[1].trim().replace(/^["']|["']$/g, '') : null;
};

const name = pick('name');
const description = pick('description');
if (!name) errors.push('frontmatter 缺少 name。');
if (!description) errors.push('frontmatter 缺少 description。');
if (name && !/^[a-z0-9-]+$/.test(name)) errors.push('name 只能包含小写字母/数字/连字符: ' + name);
if (name && name.length > 64) errors.push('name 超过 64 字符。');
if (name && name !== skillDir.split(/[\\/]/).pop()) warnings.push('name (' + name + ') 与目录名不一致，安装时可能需要 --name。');
if (description && description.length < 40) warnings.push('description 过短，可能难以被正确路由。');
if (description && description.length > 1024) errors.push('description 超过 1024 字符。');
if (description && !/[.。!！]/.test(description)) warnings.push('description 建议是完整句子。');

for (const placeholder of ['TODO', 'FIXME', '<placeholder>', 'XXX']) {
  if (raw.includes(placeholder)) errors.push('SKILL.md 里还有未完成的占位符: ' + placeholder);
}

const linkRe = /\]\(([^)\s]+)\)/g;
for (const m of body.matchAll(linkRe)) {
  const target = m[1];
  if (/^https?:/.test(target) || target.startsWith('#')) continue;
  const targetPath = join(skillDir, target.split('#')[0]);
  if (!existsSync(targetPath)) errors.push('SKILL.md 链接指向不存在的文件: ' + target);
}

const refDir = join(skillDir, 'references');
if (existsSync(refDir)) {
  const refs = readdirSync(refDir).filter((f) => f.endsWith('.md'));
  if (refs.length === 0) warnings.push('references/ 为空。');
  for (const ref of refs) {
    if (!body.includes(ref)) warnings.push('references/' + ref + ' 没有被 SKILL.md 引用。');
    const content = readFileSync(join(refDir, ref), 'utf8');
    if (content.length < 400) warnings.push('references/' + ref + ' 内容过短（可能只是占位）。');
  }
}

const scriptDir = join(skillDir, 'scripts');
if (existsSync(scriptDir)) {
  for (const file of readdirSync(scriptDir).filter((f) => f.endsWith('.mjs'))) {
    try {
      execFileSync(process.execPath, ['--check', join(scriptDir, file)], { stdio: 'pipe' });
    } catch (err) {
      errors.push('scripts/' + file + ' 语法检查失败: ' + String(err.stderr ?? err.message).slice(0, 200));
    }
  }
}

for (const w of warnings) console.log('warning: ' + w);
for (const e of errors) console.error('error: ' + e);
console.log(errors.length === 0 ? '\nOK: ' + dirname(join(skillDir, 'SKILL.md')) + ' 通过自检（' + warnings.length + ' 个警告）' : '\nFAILED: ' + errors.length + ' 个错误');
process.exit(errors.length === 0 ? 0 : 1);