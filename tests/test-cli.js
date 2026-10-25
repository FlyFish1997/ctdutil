/**
 * CLI 端到端测试（进程内）
 * ------------------------------------------------------------------
 * 本机沙箱拒绝以 stdio:'pipe' 派生进程（spawnSync 会 EPERM），
 * 因此 CLI 被设计成可注入 I/O 的 run(argv, io)，测试在进程内断言
 * 「退出码 + stdout payload + stderr 诊断」三件事。
 * 这里同时是对 **退出码口径** 的判据：0=已产出结果对象（含校验失败）、1=输入错误、2=--strict 且校验失败。
 */
'use strict';

var fs = require('fs');
var os = require('os');
var path = require('path');
var cli = require(path.join(__dirname, '..', 'src', 'cli.js'));
var Core = require(path.join(__dirname, '..', 'src', 'core.js'));

var ROOT = path.resolve(__dirname, '..');
var OK_FILE = path.join('tests', 'fixtures', 'ok-oracle.json');

/** 造一个假的 I/O，收集 stdout/stderr/退出码 */
function makeIo(stdinText) {
  var io = {
    stdoutText: '',
    stderrText: '',
    exitCode: null,
    stdout: function (s) { io.stdoutText += s; },
    stderr: function (s) { io.stderrText += s; },
    readStdin: function () { return stdinText == null ? '' : stdinText; },
    exit: function (code) { io.exitCode = code; }
  };
  return io;
}

function invoke(argv, stdinText) {
  var io = makeIo(stdinText);
  cli.run(argv, io);
  return io;
}

function parsePayload(io) {
  return JSON.parse(io.stdoutText);
}

module.exports = function run(s) {
  s.group('退出码常量');
  s.equal(cli.EXIT_OK, 0, 'EXIT_OK=0');
  s.equal(cli.EXIT_INPUT_ERROR, 1, 'EXIT_INPUT_ERROR=1');
  s.equal(cli.EXIT_VALIDATION_FAILED, 2, 'EXIT_VALIDATION_FAILED=2');
  s.equal(cli.EXIT_DDL_NOT_WRITTEN, 3, 'EXIT_DDL_NOT_WRITTEN=3（结果对象已产出但 --ddl-out 未落盘）');

  s.group('合法输入');
  var okIo = invoke(['--in', OK_FILE]);
  s.equal(okIo.exitCode, 0, '合法输入退出码 0');
  var ok = parsePayload(okIo);
  s.equal(ok.ok, true, 'payload.ok=true');
  s.deepEqual(ok.errors, [], 'payload.errors 为空');
  s.equal(typeof ok.ddl, 'string', 'payload.ddl 为字符串');
  s.ok(ok.ddl.indexOf('create table scott.emp') >= 0, 'ddl 含建表语句');
  s.equal(typeof ok.version, 'string', 'payload.version 存在');
  s.equal(typeof ok.generatedAt, 'string', 'payload.generatedAt 存在');
  s.equal(ok.excel.fileName, '表结构设计_scott_emp.xls', 'payload.excel.fileName 正确');
  s.equal(typeof ok.excel.content, 'string', 'payload.excel.content 存在');
  s.equal(ok.input.source, path.resolve(OK_FILE), 'payload.input.source 为输入文件绝对路径');
  s.equal(okIo.stderrText, '', '成功时 stderr 为空');
  s.ok(ok.ddl.indexOf('create unique index idx_emp_02') >= 0, 'CLI 透传 unique 标记：DDL 含 create unique index');
  s.equal(ok.data.indexes[1].unique, true, 'payload.data.indexes[1].unique 被保留');
  s.equal(ok.data.indexes[0].unique, false, '未标 unique 的索引在 payload 里是 false（不是缺字段）');

  s.group('--pretty');
  var prettyIo = invoke(['--in', OK_FILE, '--pretty']);
  s.ok(prettyIo.stdoutText.indexOf('\n  "ok"') >= 0, '--pretty 输出带 2 空格缩进');
  s.equal(prettyIo.exitCode, 0, '--pretty 退出码 0');
  s.equal(parsePayload(prettyIo).ddl, ok.ddl, '--pretty 不改变内容');

  s.group('stdin 输入');
  var stdinIo = invoke([], fs.readFileSync(path.join(ROOT, OK_FILE), 'utf8'));
  s.equal(stdinIo.exitCode, 0, 'stdin 输入退出码 0');
  s.equal(parsePayload(stdinIo).ok, true, 'stdin 输入校验通过');
  s.equal(parsePayload(stdinIo).input.source, '<stdin>', 'input.source 标记为 <stdin>');

  s.group('输入错误（退出码 1，且必须是合法 JSON 之外的失败）');
  var malformed = invoke([], '{ this is not json');
  s.equal(malformed.exitCode, 1, 'JSON 解析失败退出码 1');
  s.equal(malformed.stdoutText, '', '解析失败时不产出 payload');
  s.ok(malformed.stderrText.indexOf('JSON 解析失败') >= 0, 'stderr 提示 JSON 解析失败');

  var missing = invoke(['--in', 'tests/fixtures/definitely-missing.json']);
  s.equal(missing.exitCode, 1, '文件不存在退出码 1');
  s.ok(missing.stderrText.indexOf('不存在') >= 0, 'stderr 提示文件不存在');

  var empty = invoke([], '   ');
  s.equal(empty.exitCode, 1, '空输入退出码 1');
  s.ok(empty.stderrText.indexOf('输入为空') >= 0, 'stderr 提示输入为空');

  var unknownOpt = invoke(['--nope']);
  s.equal(unknownOpt.exitCode, 1, '未知选项退出码 1');
  s.ok(unknownOpt.stderrText.indexOf('未知选项') >= 0, 'stderr 提示未知选项');

  var positional = invoke([OK_FILE]);
  s.equal(positional.exitCode, 1, '位置参数退出码 1（JSON 必须走 --in 或 stdin）');
  s.ok(positional.stderrText.indexOf('不接受的参数') >= 0, 'stderr 提示不接受的参数');

  var missingValue = invoke(['--in']);
  s.equal(missingValue.exitCode, 1, '--in 缺参数值退出码 1');

  var emptyStdin = invoke([], '');
  s.equal(emptyStdin.exitCode, 1, '无 --in 且 stdin 为空退出码 1');

  s.group('业务校验失败（默认退出码 0，--strict 退出码 2）');
  var badPayload = JSON.stringify({ db: 'oracle', schema: 'scott', table: 'emp', tableDesc: '表', fields: [] });
  var soft = invoke([], badPayload);
  s.equal(soft.exitCode, 0, '默认情况下校验失败仍退出 0（结果对象即答案）');
  var softPayload = parsePayload(soft);
  s.equal(softPayload.ok, false, 'payload.ok=false');
  s.equal(softPayload.errors.length > 0, true, 'payload.errors 非空');
  s.equal(softPayload.errors[0].code, 'E_FIELD_EMPTY', '给出首个错误码 E_FIELD_EMPTY');
  s.equal(softPayload.generatedAt, null, '失败时 generatedAt 为 null');
  s.ok(soft.stderrText.indexOf('E_FIELD_EMPTY') >= 0, 'stderr 也给出首个错误码（便于日志定位）');

  var strict = invoke(['--strict'], badPayload);
  s.equal(strict.exitCode, 2, '--strict 下校验失败退出码 2');
  s.equal(parsePayload(strict).ok, false, '--strict 仍产出 payload');

  var strictOk = invoke(['--strict', '--in', OK_FILE]);
  s.equal(strictOk.exitCode, 0, '--strict 下合法输入仍为 0');

  s.group('--no-draft');
  var noDraft = invoke(['--no-draft'], badPayload);
  s.equal(parsePayload(noDraft).ddl, null, '--no-draft 时失败不产草稿');
  var withDraft = invoke([], badPayload);
  s.equal(typeof parsePayload(withDraft).ddl, 'string', '默认失败时产草稿（便于定位）');
  s.equal(parsePayload(withDraft).warnings.length, 1, '草稿带 W_DRAFT 告警');

  s.group('--schema / --help');
  var schemaIo = invoke(['--schema']);
  s.equal(schemaIo.exitCode, 0, '--schema 退出码 0');
  var schemaOut = JSON.parse(schemaIo.stdoutText);
  s.equal(schemaOut.$schema, 'https://json-schema.org/draft/2020-12/schema', '输出 2020-12 草案标识');
  s.deepEqual(schemaOut.required, ['db', 'schema', 'table', 'tableDesc', 'fields'], '输出必填字段列表');
  s.equal(schemaOut.properties.fields.items.properties.type.enum.length, 5, '输出字段类型枚举（5 项）');

  var helpIo = invoke(['--help']);
  s.equal(helpIo.exitCode, 0, '--help 退出码 0');
  s.ok(helpIo.stdoutText.indexOf('退出码') >= 0, '帮助里写明退出码口径');
  s.ok(helpIo.stdoutText.indexOf('--strict') >= 0, '帮助里列出 --strict');
  s.ok(helpIo.stdoutText.indexOf('--ddl-out') >= 0, '帮助里列出 --ddl-out');
  s.ok(helpIo.stdoutText.indexOf('--allow-draft') >= 0, '帮助里列出 --allow-draft');
  var helpShort = invoke(['-h']);
  s.equal(helpShort.exitCode, 0, '-h 等价于 --help');

  /* ============ --ddl-out：AI 场景把最后一步的 DDL 保存到本地 ============ */
  s.group('--ddl-out（DDL 落盘）');
  var tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'ctdutil-cli-'));
  try {
    var ddlPath = path.join(tmpDir, 'emp.sql');
    var writeIo = invoke(['--in', OK_FILE, '--ddl-out', ddlPath]);
    s.equal(writeIo.exitCode, 0, '合法载荷 + --ddl-out 退出码 0');
    s.equal(fs.existsSync(ddlPath), true, 'DDL 文件已生成');
    var writePayload = parsePayload(writeIo);
    var onDisk = fs.readFileSync(ddlPath, 'utf8');
    s.equal(onDisk, writePayload.ddl, '文件内容与 payload.ddl 逐字节一致（不加 BOM、不加尾换行）');
    s.ok(onDisk.indexOf('create table scott.emp') >= 0, '文件含建表语句');
    s.equal(writePayload.ddlOut.written, true, 'payload.ddlOut.written=true（落盘回执）');
    s.equal(writePayload.ddlOut.draft, false, '成功结果不是草稿');
    s.equal(writePayload.ddlOut.path, path.resolve(ddlPath), '回执给出绝对路径');
    s.equal(writePayload.ddlOut.reason, null, '成功时 reason 为 null');
    s.equal(writeIo.stderrText, '', '落盘成功时不产生 stderr 噪音');
    s.equal('ddlOut' in parsePayload(invoke(['--in', OK_FILE])), false, '未指定 --ddl-out 时 payload 形状不变（无 ddlOut 字段）');

    var draftPath = path.join(tmpDir, 'draft.sql');
    var refused = invoke(['--ddl-out', draftPath], badPayload);
    s.equal(refused.exitCode, cli.EXIT_DDL_NOT_WRITTEN, '草稿默认拒绝落盘 → 退出码 3');
    s.equal(fs.existsSync(draftPath), false, '拒绝时磁盘上不留 .sql（这正是拒写的目的）');
    s.equal(parsePayload(refused).ok, false, '拒绝落盘时仍产出结果对象（AI 可读 errors 继续迭代）');
    s.equal(parsePayload(refused).ddlOut.reason, 'draft-refused', '回执 reason=draft-refused');
    s.ok(refused.stderrText.indexOf('--allow-draft') >= 0, 'stderr 告知如何显式写出草稿');

    var allowed = invoke(['--ddl-out', draftPath, '--allow-draft'], badPayload);
    s.equal(allowed.exitCode, 0, '加 --allow-draft 后退出码 0');
    s.equal(fs.existsSync(draftPath), true, '--allow-draft 时草稿确实写出');
    var allowedPayload = parsePayload(allowed);
    s.equal(fs.readFileSync(draftPath, 'utf8'), allowedPayload.ddl, '草稿文件内容与 payload.ddl 一致');
    s.equal(allowedPayload.ddlOut.draft, true, '回执标记 draft=true');
    s.ok(allowed.stderrText.indexOf('草稿') >= 0, 'stderr 明确标注这是草稿');

    var noDraftPath = path.join(tmpDir, 'nodraft.sql');
    var ndOut = invoke(['--ddl-out', noDraftPath, '--no-draft'], badPayload);
    s.equal(ndOut.exitCode, cli.EXIT_DDL_NOT_WRITTEN, '--no-draft 下 ddl 为 null → 退出码 3');
    s.equal(parsePayload(ndOut).ddl, null, 'payload.ddl 为 null');
    s.equal(parsePayload(ndOut).ddlOut.reason, 'ddl-null', '回执 reason=ddl-null');
    s.equal(fs.existsSync(noDraftPath), false, '无内容时不创建空文件');

    var strictPath = path.join(tmpDir, 'strict.sql');
    var strictDdl = invoke(['--strict', '--ddl-out', strictPath], badPayload);
    s.equal(strictDdl.exitCode, cli.EXIT_VALIDATION_FAILED, '--strict 优先于落盘拒绝（退出码 2）');
    s.equal(fs.existsSync(strictPath), false, '--strict 下草稿同样没落盘');

    var badDirPath = path.join(tmpDir, 'no-such-dir', 'x.sql');
    var failedWrite = invoke(['--in', OK_FILE, '--ddl-out', badDirPath]);
    s.equal(failedWrite.exitCode, cli.EXIT_DDL_NOT_WRITTEN, '路径写不进去 → 退出码 3（结果对象仍已产出）');
    s.equal(parsePayload(failedWrite).ddlOut.reason, 'write-failed', '回执 reason=write-failed');
    s.ok(failedWrite.stderrText.indexOf('写盘失败') >= 0, 'stderr 提示写盘失败');

    s.equal(invoke(['--in', OK_FILE, '--ddl-out']).exitCode, cli.EXIT_INPUT_ERROR, '--ddl-out 缺参数值 → 退出码 1');

    s.group('--ddl-out 覆盖 MySQL / H2');
    ['ok-mysql.json', 'ok-h2.json'].forEach(function (fx) {
      var out = path.join(tmpDir, fx + '.sql');
      var io = invoke(['--in', path.join('tests', 'fixtures', fx), '--ddl-out', out]);
      s.equal(io.exitCode, 0, fx + ' 落盘退出码 0');
      s.equal(fs.readFileSync(out, 'utf8'), parsePayload(io).ddl, fx + ' 文件内容与 payload.ddl 一致');
      s.ok(fs.readFileSync(out, 'utf8').indexOf('create table') >= 0, fx + ' 文件含 create table');
    });
  } finally {
    try { fs.rmSync(tmpDir, { recursive: true, force: true }); } catch (e) { /* 清理失败不掩盖测试结论 */ }
  }
  s.equal(fs.existsSync(tmpDir), false, '测试临时目录已清理（不留产物）');

  s.group('与引擎一致性');
  var viaCli = parsePayload(invoke(['--in', OK_FILE]));
  var viaCore = Core.generate(JSON.parse(fs.readFileSync(path.join(ROOT, OK_FILE), 'utf8')), { includeExcel: true });
  s.equal(viaCli.ddl, viaCore.ddl, 'CLI 的 ddl 与直接调引擎一致');
  s.equal(viaCli.excel.content, viaCore.excel.content, 'CLI 的 excel 与直接调引擎一致');
  s.equal(viaCli.version, viaCore.version, 'CLI 报告的版本与引擎一致');

  return s;
};
