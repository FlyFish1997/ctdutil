/**
 * 极简断言器（零依赖）
 * ------------------------------------------------------------------
 * 设计要点（对应「防空转自证」纪律）：
 *   - 断言失败必须让进程退出码非 0，且失败信息里带实际值/期望值；
 *   - 每个文件跑完打印「通过数/总数」，并由 tests/run.js 汇总；
 *   - 不吞异常：任何未捕获异常一律记为失败并退出非 0。
 */
'use strict';

function stringify(v) {
  if (typeof v === 'string') return v;
  try { return JSON.stringify(v); } catch (e) { return String(v); }
}

function diffLine(actual, expected, label) {
  var a = stringify(actual).split('\n');
  var b = stringify(expected).split('\n');
  for (var i = 0; i < Math.max(a.length, b.length); i++) {
    if (a[i] !== b[i]) {
      return '  ' + label + ' 首个差异在第 ' + (i + 1) + ' 行：\n' +
        '    实际: ' + JSON.stringify(a[i] === undefined ? '<缺行>' : a[i]) + '\n' +
        '    期望: ' + JSON.stringify(b[i] === undefined ? '<缺行>' : b[i]);
    }
  }
  return '';
}

function createSuite(name) {
  var results = [];
  var currentGroup = '(未分组)';

  function group(title) { currentGroup = title; }

  function record(ok, title, detail) {
    results.push({ group: currentGroup, title: title, ok: ok, detail: detail || '' });
    var line = (ok ? '  PASS  ' : '  FAIL  ') + title;
    if (!ok && detail) line += '\n' + detail;
    console.log(line);
    return ok;
  }

  function ok(value, title) {
    return record(!!value, title, value ? '' : '    期望真值，实际为 ' + stringify(value));
  }

  function equal(actual, expected, title) {
    if (actual === expected) return record(true, title);
    return record(false, title, diffLine(actual, expected, '') ||
      '    实际: ' + stringify(actual) + '\n    期望: ' + stringify(expected));
  }

  function deepEqual(actual, expected, title) {
    var a = JSON.stringify(actual);
    var b = JSON.stringify(expected);
    return a === b ? record(true, title)
      : record(false, title, '    实际: ' + a + '\n    期望: ' + b);
  }

  function throws(fn, title) {
    try { fn(); return record(false, title, '    期望抛出异常，但没有'); }
    catch (e) { return record(true, title); }
  }

  function summary() {
    var failed = results.filter(function (r) { return !r.ok; });
    console.log('---');
    console.log('[' + name + '] ' + (results.length - failed.length) + '/' + results.length + ' 通过');
    if (failed.length) {
      console.log('失败明细：');
      failed.forEach(function (f) { console.log('  · [' + f.group + '] ' + f.title); });
    }
    return { name: name, total: results.length, failed: failed.length, results: results };
  }

  return { group: group, ok: ok, equal: equal, deepEqual: deepEqual, throws: throws, summary: summary };
}

module.exports = { createSuite: createSuite, stringify: stringify };
