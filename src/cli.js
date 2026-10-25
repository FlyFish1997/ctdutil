#!/usr/bin/env node
/**
 * ctdutil 命令行（AI / 脚本操作面）
 * ------------------------------------------------------------------
 * 用法：
 *   node src/cli.js --in <file.json> [--out <file>] [--pretty] [--strict] [--no-draft] [--ddl-out <file>] [--allow-draft]
 *   node src/cli.js --schema                        # 打印输入 JSON Schema
 *   node src/cli.js --help
 *   type payload.json | node src/cli.js             # 从 stdin 读入
 *
 * 退出码口径（契约，见 docs/AI接口契约.md §4）：
 *   0  payload 是合法 JSON，且已产出结果对象（**校验不通过也是 0**，因为结果对象本身即答案）
 *   1  无法产出结果对象：输入文件读不到 / JSON 解析失败 / 用法错误 / --out 写不进去
 *   2  仅当 --strict 且业务校验未通过（优先于 3）
 *   3  结果对象已产出，但 --ddl-out 未落盘（草稿被拒 / ddl 为 null / 写盘失败）
 *
 * 结果对象固定写 stdout；诊断信息写 stderr；--out 时结果落文件、stdout 只给一行摘要。
 *
 * 可测性：本文件导出 run(argv, io)，I/O 全部走注入对象（默认接 process），
 * 于是测试可以在进程内断言「退出码 + stdout + stderr」，不依赖子进程管道
 * （本机沙箱拒绝以 stdio:'pipe' 派生进程，spawnSync 会 EPERM）。
 */
'use strict';

var fs = require('fs');
var path = require('path');
var Core = require(path.join(__dirname, 'core.js'));

var EXIT_OK = 0;
var EXIT_INPUT_ERROR = 1;
var EXIT_VALIDATION_FAILED = 2;
var EXIT_DDL_NOT_WRITTEN = 3;

var HELP = [
  'ctdutil CLI —— 表结构登记与 DDL 生成（JSON in / JSON out，零依赖）',
  '',
  '用法:',
  '  node src/cli.js --in <file.json> [--out <file>] [--pretty] [--strict] [--no-draft]',
  '                  [--ddl-out <file>] [--allow-draft]',
  '  node src/cli.js --schema',
  '  node src/cli.js --help',
  '  <stdin JSON> | node src/cli.js',
  '',
  '选项:',
  '  --in <file>     输入 JSON 文件；省略时从 stdin 读取',
  '  --out <file>    结果 JSON 写入文件（默认写 stdout）',
  '  --ddl-out <file> 把最后一步的 DDL 写入本地文件（内容 = 结果对象的 ddl 字段，UTF-8 无 BOM）',
  '  --allow-draft   校验未通过时也允许把草稿 DDL 写入 --ddl-out（默认拒绝）',
  '  --pretty        结果 JSON 缩进 2 空格输出',
  '  --schema        输出输入 JSON Schema 后退出',
  '  --strict        业务校验未通过时退出码 2（默认为 0）',
  '  --no-draft      校验未通过时不生成 DDL 草稿（结果中 ddl 为 null，此时 --ddl-out 不落盘）',
  '  --help          显示本帮助',
  '',
  '退出码: 0 = 已产出结果对象（含校验失败且未指定 --ddl-out）; 1 = 输入/用法错误;',
  '        2 = --strict 且校验未通过; 3 = 已产出结果对象但 --ddl-out 未落盘'
].join('\n');

function usageError(message) {
  var e = new Error(message);
  e.usage = true;
  return e;
}

function parseArgs(argv) {
  var opts = {
    in: null, out: null, pretty: false, schema: false, strict: false, noDraft: false,
    ddlOut: null, allowDraft: false, help: false
  };
  for (var i = 0; i < argv.length; i++) {
    var a = argv[i];
    if (a === '--help' || a === '-h') opts.help = true;
    else if (a === '--schema') opts.schema = true;
    else if (a === '--pretty') opts.pretty = true;
    else if (a === '--strict') opts.strict = true;
    else if (a === '--no-draft') opts.noDraft = true;
    else if (a === '--allow-draft') opts.allowDraft = true;
    else if (a === '--in' || a === '-i') { opts.in = argv[++i]; if (opts.in == null) throw usageError('--in 缺少参数值'); }
    else if (a === '--out' || a === '-o') { opts.out = argv[++i]; if (opts.out == null) throw usageError('--out 缺少参数值'); }
    else if (a === '--ddl-out') { opts.ddlOut = argv[++i]; if (opts.ddlOut == null) throw usageError('--ddl-out 缺少参数值'); }
    else if (a.indexOf('--') === 0) throw usageError('未知选项：' + a);
    else throw usageError('不接受的参数：' + a + '（JSON 请用 --in 或 stdin 传入）');
  }
  return opts;
}

/**
 * 处理 --ddl-out：把「最后一步得到的 DDL」落到本地文件。
 *
 * 落盘纪律：校验未通过时引擎仍会产出草稿 DDL（带 W_DRAFT 告警），但**默认不落盘**——
 * 磁盘上留下一个语法不完整的 .sql 极易被当成交付物；确需写出必须显式加 --allow-draft。
 *
 * @returns {{path: string, written: boolean, draft: boolean, reason: string|null}}
 *          reason: null | 'ddl-null'（--no-draft 抑制了草稿）| 'draft-refused' | 'write-failed'
 */
function writeDdlFile(opts, result, errOut) {
  var abs = path.resolve(opts.ddlOut);
  var info = { path: abs, written: false, draft: !result.ok, reason: null };

  if (result.ddl == null) {
    info.reason = 'ddl-null';
    errOut('[ctdutil] DDL 未落盘：校验未通过且已用 --no-draft 抑制草稿，无内容可写 → ' + abs + '\n');
    return info;
  }
  if (info.draft && !opts.allowDraft) {
    info.reason = 'draft-refused';
    errOut('[ctdutil] 拒绝把草稿 DDL 写入文件（校验未通过）：' + abs + '\n' +
      '         草稿可能语法不完整、被误当交付物；确需写出请加 --allow-draft\n');
    return info;
  }
  try {
    fs.writeFileSync(abs, result.ddl, 'utf8');
  } catch (e) {
    info.reason = 'write-failed';
    errOut('[ctdutil] DDL 写盘失败：' + abs + ' —— ' + (e && e.message ? e.message : e) + '\n');
    return info;
  }
  info.written = true;
  if (info.draft) errOut('[ctdutil] 已写出草稿 DDL（校验未通过 + --allow-draft，勿当交付物）：' + abs + '\n');
  return info;
}

function readInput(opts, io) {
  if (opts.in) {
    var abs = path.resolve(opts.in);
    if (!fs.existsSync(abs)) throw usageError('输入文件不存在：' + abs);
    try { return { text: fs.readFileSync(abs, 'utf8'), source: abs }; }
    catch (e) { throw usageError('输入文件读取失败：' + abs + ' —— ' + (e && e.message ? e.message : e)); }
  }
  var text;
  try { text = io.readStdin(); }
  catch (e) {
    if (e && e.code === 'EAGAIN') throw usageError('stdin 暂无数据（本平台管道需异步读取）；请改用 --in <file.json>');
    throw usageError('读取 stdin 失败：' + (e && e.message ? e.message : e));
  }
  if (text == null) text = '';
  return { text: text, source: '<stdin>' };
}

/** 默认 stdin 读取：同步读 fd 0（管道场景可能 EAGAIN，由调用方转成用法错误） */
function readStdinSync() {
  var buf = Buffer.alloc(65536);
  var chunks = [];
  while (true) {
    var n = fs.readSync(0, buf, 0, buf.length, null);
    if (!n) break;
    chunks.push(Buffer.from(buf.slice(0, n)));
  }
  return Buffer.concat(chunks).toString('utf8');
}

/**
 * CLI 主流程（可注入 I/O）
 * @param {string[]} argv 不含 node/脚本路径的参数
 * @param {{stdout:function,stderr:function,readStdin:function,exit:function}} io
 */
function run(argv, io) {
  function out(s) { io.stdout(s); }
  function errOut(s) { io.stderr(s); }
  function stop(code) { io.exit(code); return code; }

  var opts;
  try { opts = parseArgs(argv); }
  catch (e) { errOut('[ctdutil] ' + e.message + '\n\n' + HELP + '\n'); return stop(EXIT_INPUT_ERROR); }

  if (opts.help) { out(HELP + '\n'); return stop(EXIT_OK); }

  if (opts.schema) { out(JSON.stringify(Core.jsonSchema(), null, 2) + '\n'); return stop(EXIT_OK); }

  var input;
  try { input = readInput(opts, io); }
  catch (e) { errOut('[ctdutil] ' + e.message + '\n'); return stop(EXIT_INPUT_ERROR); }

  if (!input.text || !input.text.trim()) { errOut('[ctdutil] 输入为空（' + input.source + '）\n'); return stop(EXIT_INPUT_ERROR); }

  var payload;
  try { payload = JSON.parse(input.text); }
  catch (e) { errOut('[ctdutil] JSON 解析失败（' + input.source + '）：' + (e && e.message ? e.message : e) + '\n'); return stop(EXIT_INPUT_ERROR); }

  var result = Core.generate(payload, { includeExcel: true, includeDdl: true });
  if (opts.noDraft && !result.ok) result.ddl = null;
  result.input = { source: input.source };

  // --ddl-out：AI / 脚本场景下把最后一步的 DDL 保存到本地（结果对象里回执落盘情况）
  var ddlOut = opts.ddlOut ? writeDdlFile(opts, result, errOut) : null;
  if (ddlOut) result.ddlOut = ddlOut;

  var text = JSON.stringify(result, null, opts.pretty ? 2 : 0);

  if (opts.out) {
    var outAbs = path.resolve(opts.out);
    try { fs.writeFileSync(outAbs, text, 'utf8'); }
    catch (e) { errOut('[ctdutil] 结果写盘失败：' + outAbs + ' —— ' + (e && e.message ? e.message : e) + '\n'); return stop(EXIT_INPUT_ERROR); }
    out('ok=' + result.ok + ' errors=' + result.errors.length + ' out=' + outAbs + '\n');
  } else {
    out(text + '\n');
  }

  if (!result.ok) {
    var first = result.errors[0];
    errOut('[ctdutil] 校验未通过（' + result.errors.length + ' 项）：' +
      (first ? first.code + ' ' + first.message : '') + '\n');
    if (opts.strict) return stop(EXIT_VALIDATION_FAILED);
  }
  if (ddlOut && !ddlOut.written) return stop(EXIT_DDL_NOT_WRITTEN);
  return stop(EXIT_OK);
}

/** 生产入口：接真实 process */
function main() {
  run(process.argv.slice(2), {
    stdout: function (s) { process.stdout.write(s); },
    stderr: function (s) { process.stderr.write(s); },
    readStdin: readStdinSync,
    exit: function (code) { process.exit(code); }
  });
}

module.exports = {
  run: run,
  EXIT_OK: EXIT_OK,
  EXIT_INPUT_ERROR: EXIT_INPUT_ERROR,
  EXIT_VALIDATION_FAILED: EXIT_VALIDATION_FAILED,
  EXIT_DDL_NOT_WRITTEN: EXIT_DDL_NOT_WRITTEN,
  HELP: HELP
};

if (require.main === module) main();
