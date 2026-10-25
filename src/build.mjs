#!/usr/bin/env node
/**
 * ctdutil 构建脚本（零依赖，ESM）
 * ------------------------------------------------------------------
 * 把 src/core.js 内联进 src/index.template.html，产出单文件 index.html。
 * 交付形态仍是「双击即用、离线、单文件」，而业务规则只有 core.js 一份。
 *
 *   node src/build.mjs            生成 index.html
 *   node src/build.mjs --check    只校验 index.html 是否与源文件逐字节一致（不写盘；不一致退出码 1）
 *   node src/build.mjs --print    把生成结果写到 stdout（供沙箱内「进程不可写盘」时由外部落盘）
 *
 * 注意：本沙箱下进程对工作区**只读**（fs.writeFileSync → EPERM），
 * 因此生成文件由 harness 工具落盘；--check 是那条漂移判据，
 * tests/test-embedded.js 里也会独立复算一次同样内容做断言。
 *
 * 实现陷阱（曾真实踩坑）：注入必须用 split/join，**不能**用 String.replace(占位符, core)。
 * core.js 里的正则 /^[A-Za-z_][A-Za-z0-9_]*$/ 含有 `$'`，而 replace 的替换串会把
 * `$'` 解释为「匹配位置之后的全部内容」，导致整份内容被反复展开成 2 倍垃圾。
 */
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const CORE_PATH = path.join(ROOT, 'src', 'core.js');
const TPL_PATH = path.join(ROOT, 'src', 'index.template.html');
const OUT_PATH = path.join(ROOT, 'index.html');
const MARKER = '/* __CORE_SOURCE__ */';

/**
 * 复算 index.html 应有的完整内容。
 * GENERATED 标记写在模板自身的第一行（不再由本脚本额外前置一行），
 * 这样"生成物带标记"这件事不依赖落盘方式，check 也就不需要两侧各剥一次头部。
 * 注入必须用 split/join，**不能**用 String.replace(占位符, core)：
 * core.js 里的正则 /^[A-Za-z_][A-Za-z0-9_]*$/ 含有 `$'`，而 replace 的替换串会把
 * `$'` 解释为「匹配位置之后的全部内容」，把整份内容反复展开成 2 倍垃圾。
 */
function render() {
  const core = fs.readFileSync(CORE_PATH, 'utf8');
  const tpl = fs.readFileSync(TPL_PATH, 'utf8');

  if (core.indexOf(MARKER) >= 0) throw new Error('core.js 自身不应包含占位标记 ' + MARKER);
  if (core.indexOf('</script') >= 0) throw new Error('core.js 含有 </script，内联进 HTML 会截断脚本块');
  if (tpl.indexOf(MARKER) < 0) throw new Error('模板缺少占位标记 ' + MARKER);
  if (tpl.split(MARKER).length !== 2) throw new Error('模板中的占位标记必须恰好出现 1 次');
  if (tpl.indexOf('GENERATED-FILE') < 0) throw new Error('模板缺少 GENERATED-FILE 标记（生成物溯源用）');

  return tpl.split(MARKER).join(core.replace(/\s+$/, ''));
}

const norm = (s) => s.replace(/\r\n/g, '\n');

function main() {
  const check = process.argv.indexOf('--check') >= 0;
  const print = process.argv.indexOf('--print') >= 0;
  const diag = process.argv.indexOf('--diag') >= 0;
  const expected = render();

  if (diag) {
    const core = fs.readFileSync(CORE_PATH, 'utf8');
    const tpl = fs.readFileSync(TPL_PATH, 'utf8');
    const bytes = (s) => Buffer.byteLength(s, 'utf8');
    const actual = fs.existsSync(OUT_PATH) ? fs.readFileSync(OUT_PATH, 'utf8') : '';
    process.stdout.write('[diag] core chars=' + core.length + ' bytes=' + bytes(core) + ' lines=' + core.split('\n').length + '\n');
    process.stdout.write('[diag] tpl  chars=' + tpl.length + ' bytes=' + bytes(tpl) + ' lines=' + tpl.split('\n').length + '\n');
    process.stdout.write('[diag] expected chars=' + expected.length + ' bytes=' + bytes(expected) + ' lines=' + expected.split('\n').length + '\n');
    process.stdout.write('[diag] actual   chars=' + actual.length + ' bytes=' + bytes(actual) + ' lines=' + actual.split('\n').length + '\n');
    process.stdout.write('[diag] core appears in expected ' + expected.split(core.replace(/\s+$/, '')).length + ' time(s)\n');
    process.stdout.write('[diag] after strip: expected ' + norm(expected).length + ' vs actual ' + norm(actual).length + '\n');
    process.stdout.write('[diag] marker left in expected? ' + (expected.indexOf(MARKER) >= 0) + '\n');
    process.stdout.write('[diag] expected HEAD: ' + JSON.stringify(expected.slice(0, 120)) + '\n');
    process.stdout.write('[diag] expected TAIL: ' + JSON.stringify(expected.slice(-120)) + '\n');
    const cnt = (hay, needle) => hay.split(needle).length - 1;
    process.stdout.write('[diag] raw tpl.replace length: ' + tpl.replace(MARKER, core.replace(/\s+$/, '')).length + '\n');
    process.stdout.write('[diag] raw HEADER+tpl.replace length: ' + (HEADER + tpl.replace(MARKER, core.replace(/\s+$/, ''))).length + '\n');
    process.stdout.write('[diag] HEADER length: ' + HEADER.length + '\n');
    process.stdout.write('[diag] count of "</html>" in expected: ' + cnt(expected, '</html>') + '\n');
    process.stdout.write('[diag] count of "<!DOCTYPE html>" in expected: ' + cnt(expected, '<!DOCTYPE html>') + '\n');
    process.exit(0);
  }

  if (print) {
    process.stdout.write(expected);
    process.exit(0);
  }

  if (check) {
    if (!fs.existsSync(OUT_PATH)) {
      process.stderr.write('[build] index.html 不存在，需先执行 node src/build.mjs\n');
      process.exit(1);
    }
    const actual = fs.readFileSync(OUT_PATH, 'utf8');
    if (norm(actual) !== norm(expected)) {
      process.stderr.write('[build] index.html 与源文件不一致（存在漂移）\n' +
        '        期望 ' + Buffer.byteLength(expected, 'utf8') + ' 字节，实际 ' + Buffer.byteLength(actual, 'utf8') + ' 字节\n' +
        '        请重新执行 node src/build.mjs 并落盘\n');
      process.exit(1);
    }
    process.stdout.write('[build] check 通过：index.html 与 src/core.js + src/index.template.html 逐字节一致\n');
    process.exit(0);
  }

  fs.writeFileSync(OUT_PATH, expected, 'utf8');
  process.stdout.write('[build] 已生成 ' + path.relative(ROOT, OUT_PATH) +
    '（' + Buffer.byteLength(expected, 'utf8') + ' 字节，其中内联 core.js ' +
    Buffer.byteLength(fs.readFileSync(CORE_PATH, 'utf8'), 'utf8') + ' 字节）\n');
  process.exit(0);
}

main();
