#!/usr/bin/env node
/**
 * ctdutil 测试总入口（零依赖）
 * ------------------------------------------------------------------
 *   node tests/run.js              跑全部测试
 *   node tests/run.js core cli     只跑指定模块（按文件名片段匹配）
 *
 * 自证机制（防空转，对应纪律「改坏必须变红」）：
 *   1) 每个测试文件必须至少贡献 1 条断言，且总数不得低于 MIN_ASSERTIONS；
 *   2) 任一文件加载/执行抛异常 → 记为失败并退出非 0；
 *   3) 任一断言失败 → 退出码 1；
 *   4) 汇总行打印「文件数 / 断言数 / 失败数」，解析类失败无法伪装成 0。
 */
'use strict';

var path = require('path');
var harness = require(path.join(__dirname, 'harness.js'));

var MIN_ASSERTIONS = 470;
var FILES = [
  'test-core.js',
  'test-excel.js',
  'test-schema.js',
  'test-embedded.js',
  'test-cli.js',
  'ui-wiring.js'
];

function main() {
  var filters = process.argv.slice(2).filter(function (a) { return a.indexOf('-') !== 0; });
  // 断言总数下限只在「完整跑」时生效：它的作用是抓出"文件被静默跳过/加载失败"，
  // 而按筛选跑子集是调用方的显式选择，不该被这条判据判失败（否则 `node tests/run.js core` 永远退出 1）。
  var isFullRun = filters.length === 0;
  var selected = FILES.filter(function (f) {
    if (!filters.length) return true;
    return filters.some(function (k) { return f.indexOf(k) >= 0; });
  });

  console.log('ctdutil 测试 | Node ' + process.version + ' | 选择 ' + (selected.length ? selected.join(', ') : '(无)'));
  console.log('');

  var summaries = [];
  selected.forEach(function (file) {
    var name = file.replace(/\.js$/, '');
    var s = harness.createSuite(name);
    console.log('== ' + name + ' ==');
    try {
      var mod = require(path.join(__dirname, file));
      if (typeof mod !== 'function') throw new Error('测试文件未导出 run(suite) 函数');
      mod(s);
    } catch (e) {
      s.group('加载/执行异常');
      s.ok(false, '测试文件执行抛出异常：' + (e && e.stack ? e.stack.split('\n')[0] : e));
      if (e && e.stack) console.log(e.stack);
    }
    var sum = s.summary();
    summaries.push(sum);
    console.log('');
  });

  var totalAssertions = summaries.reduce(function (a, x) { return a + x.total; }, 0);
  var totalFailed = summaries.reduce(function (a, x) { return a + x.failed; }, 0);

  console.log('========================================');
  console.log('文件 ' + summaries.length + ' 个 | 断言 ' + totalAssertions + ' 条 | 失败 ' + totalFailed + ' 条');
  summaries.forEach(function (x) {
    console.log('  ' + (x.failed ? 'FAIL' : 'ok  ') + '  ' + x.name + '  ' +
      (x.total - x.failed) + '/' + x.total);
  });

  var emptyFiles = summaries.filter(function (x) { return x.total === 0; });
  if (emptyFiles.length) {
    console.log('自证失败：以下测试文件一条断言都没跑：' + emptyFiles.map(function (x) { return x.name; }).join(', '));
  }
  var belowFloor = totalAssertions < MIN_ASSERTIONS;
  if (belowFloor) {
    if (isFullRun) console.log('自证失败：断言总数 ' + totalAssertions + ' 低于下限 ' + MIN_ASSERTIONS + '（可能有测试文件被跳过）');
    else console.log('（按筛选跑子集，跳过「断言总数下限 ' + MIN_ASSERTIONS + '」这条自证；完整自证请执行 node tests/run.js）');
  }
  var bad = totalFailed > 0 || emptyFiles.length > 0 || (isFullRun && belowFloor);
  console.log(bad ? '结果：失败' : '结果：全部通过');
  process.exit(bad ? 1 : 0);
}

main();
