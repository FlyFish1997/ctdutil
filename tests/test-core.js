/**
 * 核心层测试：规范化 / 校验规则 / 类型映射 / 命名联动 / 统一入口
 * 全部为纯函数断言，不需要 DOM、网络、外部依赖。
 */
'use strict';

var fs = require('fs');
var path = require('path');
var Core = require(path.join(__dirname, '..', 'src', 'core.js'));

var FIXTURES = path.join(__dirname, 'fixtures');
var GOLDEN = path.join(__dirname, 'golden');

function loadFixture(name) { return JSON.parse(fs.readFileSync(path.join(FIXTURES, name), 'utf8')); }
function loadGolden(name) { return fs.readFileSync(path.join(GOLDEN, name), 'utf8').replace(/\r\n/g, '\n').replace(/\n$/, ''); }
function clone(o) { return JSON.parse(JSON.stringify(o)); }
function codes(errors) { return errors.map(function (e) { return e.code; }); }
function firstCode(errors) { return errors.length ? errors[0].code : null; }

var OK_FIXTURES = [
  { file: 'ok-oracle.json', golden: 'ddl-ok-oracle.sql' },
  { file: 'ok-gauss-auto.json', golden: 'ddl-ok-gauss-auto.sql' },
  { file: 'ok-mysql.json', golden: 'ddl-ok-mysql.sql' },
  { file: 'ok-h2.json', golden: 'ddl-ok-h2.sql' },
  { file: 'ok-minimal.json', golden: 'ddl-ok-minimal.sql' }
];

module.exports = function run(s) {
  /* ============ 1. 合法 fixtures：DDL 必须与 golden 文件逐字符一致 ============ */
  s.group('golden DDL');
  OK_FIXTURES.forEach(function (item) {
    var payload = loadFixture(item.file);
    var result = Core.generate(payload, { includeExcel: false });
    s.equal(result.ok, true, item.file + ' 校验通过');
    s.equal(result.errors.length, 0, item.file + ' 无错误项');
    s.deepEqual(result.errors, [], item.file + ' errors 为空数组');
    s.equal(result.ddl, loadGolden(item.golden), item.file + ' → ' + item.golden + ' 逐字符一致');
  });

  /* ============ 2. 类型映射 ============ */
  s.group('类型映射 typeSql');
  s.equal(Core.typeSql('oracle', { type: '字符型', length: '20' }), 'varchar2(20)', 'oracle 字符型 → varchar2(20)');
  s.equal(Core.typeSql('gauss', { type: '字符型', length: '20' }), 'varchar2(20)', 'gauss 字符型 → varchar2(20)');
  s.equal(Core.typeSql('mysql', { type: '字符型', length: '20' }), 'varchar(20)', 'mysql 字符型 → varchar(20)（MySQL 无 varchar2）');
  s.equal(Core.typeSql('h2', { type: '字符型', length: '20' }), 'varchar(20)', 'h2 字符型 → varchar(20)（H2 常规模式无 varchar2）');
  s.equal(Core.typeSql('oracle', { type: '数值型', precision: '10', scale: '2' }), 'number(10,2)', 'oracle 数值型 → number(10,2)');
  s.equal(Core.typeSql('gauss', { type: '数值型', precision: '10', scale: '2' }), 'numeric(10,2)', 'gauss 数值型 → numeric(10,2)');
  s.equal(Core.typeSql('mysql', { type: '数值型', precision: '10', scale: '2' }), 'decimal(10,2)', 'mysql 数值型 → decimal(10,2)');
  s.equal(Core.typeSql('h2', { type: '数值型', precision: '10', scale: '2' }), 'numeric(10,2)', 'h2 数值型 → numeric(10,2)');
  s.equal(Core.typeSql('oracle', { type: '整型' }), 'integer', 'oracle 整型 → integer');
  s.equal(Core.typeSql('gauss', { type: '整型' }), 'integer', 'gauss 整型 → integer');
  s.equal(Core.typeSql('mysql', { type: '整型' }), 'int', 'mysql 整型 → int');
  s.equal(Core.typeSql('h2', { type: '整型' }), 'int', 'h2 整型 → int');
  s.equal(Core.typeSql('oracle', { type: '日期型' }), 'date', '日期型 → date');
  s.equal(Core.typeSql('mysql', { type: '日期型' }), 'date', 'mysql 日期型 → date');
  s.equal(Core.typeSql('oracle', { type: '时间戳' }), 'timestamp', 'oracle 时间戳 → timestamp');
  s.equal(Core.typeSql('gauss', { type: '时间戳' }), 'timestamp', 'gauss 时间戳 → timestamp');
  s.equal(Core.typeSql('h2', { type: '时间戳' }), 'timestamp', 'h2 时间戳 → timestamp');
  s.equal(Core.typeSql('mysql', { type: '时间戳' }), 'datetime', 'mysql 时间戳 → datetime（timestamp 有 2038 上限与自动更新语义）');
  s.equal(Core.typeSql('oracle', { type: '未知型' }), '', '未知类型 → 空串（不抛异常）');
  s.equal(Core.typeSql('oracle', undefined), '', '字段为空 → 空串（不抛异常）');

  /* ============ 2b. 注释语法分族（新增库时最容易漏的一条） ============ */
  s.group('注释语法分族');
  Core.DB_LIST.forEach(function (db) {
    s.ok(Core.DB_COMMENT_STYLE[db] === 'comment-on' || Core.DB_COMMENT_STYLE[db] === 'inline',
      db + ' 有明确的注释语法分族（' + Core.DB_COMMENT_STYLE[db] + '）');
  });
  s.equal(Core.DB_COMMENT_STYLE.mysql, 'inline', 'mysql 走内联注释（MySQL 无 comment on 语句）');
  ['oracle', 'gauss', 'h2'].forEach(function (db) {
    s.equal(Core.DB_COMMENT_STYLE[db], 'comment-on', db + ' 走 comment on 分支');
  });
  var mysqlDdl = Core.generate(loadFixture('ok-mysql.json')).ddl;
  s.equal(mysqlDdl.indexOf('comment on'), -1, 'mysql DDL 不含 comment on（该语法在 MySQL 不存在）');
  s.equal(mysqlDdl.indexOf("comment '订单号'") >= 0, true, 'mysql DDL 列注释为内联 comment');
  s.equal(mysqlDdl.indexOf(") comment = '订单主表''含单引号';") >= 0, true, 'mysql 表注释写在 ) comment = 且单引号已转义');
  var h2Ddl = Core.generate(loadFixture('ok-h2.json')).ddl;
  s.equal(h2Ddl.indexOf('comment on table public.t_order') >= 0, true, 'h2 DDL 用 comment on table');
  s.equal(h2Ddl.indexOf('varchar2'), -1, 'h2 DDL 不含 varchar2（常规/文件模式用标准 varchar）');

  /* 实测（H2 2.5.250）: H2 拒绝在可空列上 add primary key —— 90023 Column "ORDER_ID" must not be nullable。
     这条断言把这个实测结论锁进套件，防止有人"顺手"把 not null 去掉。 */
  s.group('H2 主键列显式 not null（实测约束）');
  s.ok(h2Ddl.indexOf('    order_id varchar(32) not null,') >= 0, 'H2 主键列声明为 not null');
  s.equal((h2Ddl.match(/ not null/g) || []).length, 1, 'H2 只有主键列带 not null（共 1 处）');
  s.ok(h2Ddl.indexOf('alter table public.t_order add constraint pk_t_order primary key (order_id);') >= 0,
    'H2 主键约束仍以 alter table 形式给出（与其它库同形）');
  s.equal(Core.generate(loadFixture('ok-oracle.json')).ddl.indexOf(' not null'), -1, 'oracle 输出不受影响（不引入 not null）');
  s.equal(Core.generate(loadFixture('ok-gauss-auto.json')).ddl.indexOf(' not null'), -1, 'gauss 输出不受影响');
  s.equal(Core.generate(loadFixture('ok-mysql.json')).ddl.indexOf(' not null'), -1, 'mysql 输出不受影响（MySQL 隐式把主键列置为 NOT NULL）');
  var h2NoPk = clone(loadFixture('ok-h2.json'));
  h2NoPk.pk = { name: '', fields: [] };
  s.equal(Core.generate(h2NoPk).ddl.indexOf(' not null'), -1, 'H2 无主键时不产生 not null');

  /* ============ 2c. 索引类型：普通索引 / 唯一索引 ============ */
  s.group('索引类型：普通 vs 唯一');
  s.deepEqual(Core.INDEX_TYPES, ['normal', 'unique'], '索引类型枚举固定');
  s.equal(Core.INDEX_TYPE_LABEL.normal, '普通索引', '普通索引展示名');
  s.equal(Core.INDEX_TYPE_LABEL.unique, '唯一索引', '唯一索引展示名');
  s.equal(Core.indexTypeOf({ unique: true }), 'unique', 'indexTypeOf: unique=true → unique');
  s.equal(Core.indexTypeOf({ unique: false }), 'normal', 'indexTypeOf: unique=false → normal');
  s.equal(Core.indexTypeOf({}), 'normal', 'indexTypeOf: 缺省 → normal');
  s.equal(Core.indexTypeOf({ unique: 'true' }), 'normal', 'indexTypeOf: 字符串 "true" 不算唯一（与 nameAuto 同一宽容化口径）');
  s.equal(Core.indexTypeOf(null), 'normal', 'indexTypeOf: 空值不抛异常');

  var oracleUnique = Core.generate(loadFixture('ok-oracle.json')).ddl;
  s.ok(oracleUnique.indexOf('create index idx_emp_01 on scott.emp (emp_name, hire_date);') >= 0,
    '未标 unique 的索引仍是普通 create index');
  s.ok(oracleUnique.indexOf('create unique index idx_emp_02 on scott.emp (sal);') >= 0,
    'unique:true 的索引生成 create unique index');
  s.equal((oracleUnique.match(/create unique index/g) || []).length, 1, '唯一索引只生成 1 条（普通索引没被误升级）');
  s.equal(oracleUnique.indexOf('create unique index idx_emp_01'), -1, '普通索引不会被写成唯一索引');

  s.group('唯一索引：四库矩阵（关键字写法四库一致）');
  Core.DB_LIST.forEach(function (db) {
    var pu = clone(loadFixture('ok-oracle.json'));
    pu.db = db;
    var ru = Core.generate(pu);
    s.equal(ru.ok, true, db + '：带唯一索引的载荷校验通过');
    s.ok(ru.ddl.indexOf('create unique index idx_emp_02') >= 0, db + ' 生成 create unique index');
    s.ok(ru.ddl.indexOf('create index idx_emp_01') >= 0, db + ' 普通索引仍是 create index');
  });

  s.group('unique 的宽容化与校验（不得因新特性放松既有校验）');
  var nUnique = Core.normalizeInput({
    db: 'oracle', schema: 's', table: 't', tableDesc: 'd',
    fields: [{ name: 'a', desc: '列1', type: '整型' }],
    indexes: [{ fields: ['a'], unique: true }, { fields: ['a'], unique: 'false' }, { fields: ['a'] }]
  });
  s.equal(nUnique.errors.length, 0, '带 unique 的索引输入形状合法');
  s.equal(nUnique.data.indexes[0].unique, true, 'unique:true 被保留');
  s.equal(nUnique.data.indexes[1].unique, false, 'unique:"false"（字符串）按普通索引处理');
  s.equal(nUnique.data.indexes[2].unique, false, '未给 unique 时默认普通索引');

  var uPk = clone(loadFixture('ok-oracle.json'));
  uPk.indexes = [{ name: 'idx_x', unique: true, fields: ['emp_no', 'emp_name'] }];
  s.equal(firstCode(Core.validate(Core.normalizeInput(uPk).data)), 'E_INDEX_EQUALS_PK',
    '唯一索引字段与主键完全相同仍被拦截（没被新特性放行）');

  var uEmpty = clone(loadFixture('ok-oracle.json'));
  uEmpty.indexes = [{ name: 'idx_x', unique: true, fields: [] }];
  s.equal(firstCode(Core.validate(Core.normalizeInput(uEmpty).data)), 'E_INDEX_FIELDS_REQUIRED',
    '唯一索引同样要求至少 1 个字段');

  /* ============ 3. 命名联动规则 ============ */
  s.group('命名联动');
  s.equal(Core.pkName('EMP'), 'pk_emp', '主键名 = pk_ + 小写表名');
  s.equal(Core.pkName('  T_Order  '), 'pk_t_order', '主键名去除首尾空格');
  s.equal(Core.indexAutoName('EMP', 0), 'idx_emp_01', '索引序号从 01 起');
  s.equal(Core.indexAutoName('EMP', 9), 'idx_emp_10', '索引第 10 个 = _10');
  s.deepEqual(Core.emptyInput().fields, [Core.emptyField()], 'emptyInput 含 1 个空字段行');
  s.equal(Core.emptyInput().db, null, 'emptyInput 未选库');

  /* ============ 4. 输入规范化宽容度 ============ */
  s.group('输入规范化');
  var n1 = Core.normalizeInput({ db: 'Oracle', schema: ' s ', table: 'emp', tableDesc: 'd', fields: [{ name: 'a', desc: 'b', type: '字符型', length: 20 }] });
  s.equal(n1.errors.length, 0, '大小写/空格/数字长度均被接受');
  s.equal(n1.data.db, 'oracle', 'db 归一为小写');
  s.equal(n1.data.schema, 's', 'schema 去首尾空格');
  s.equal(n1.data.fields[0].length, '20', '数字长度归一为字符串');
  s.equal(n1.data.pk.name, 'pk_emp', '未给主键名时自动派生 pk_emp');
  s.equal(n1.data.fields[0].type, '字符型', '类型原样保留');

  var n2 = Core.normalizeInput({ db: 'oracle', schema: 's', table: 'emp', tableDesc: 'd', fields: [{ name: 'a', desc: 'b', length: 5 }] });
  s.equal(n2.data.fields[0].type, '字符型', '缺省 type 时默认字符型');

  var n3 = Core.normalizeInput({
    db: 'oracle', schema: 's', table: 'T_ORD', tableDesc: 'd', fields: [{ name: 'a', desc: 'b' }],
    indexes: [{ fields: [] }, { name: 'my_idx', nameAuto: false, fields: ['a'] }]
  });
  s.equal(n3.data.indexes[0].name, 'idx_t_ord_01', 'nameAuto（默认）按 01 生成索引名');
  s.equal(n3.data.indexes[1].name, 'my_idx', 'nameAuto=false 保留给定名');

  s.equal(firstCode(Core.normalizeInput([1, 2, 3]).errors), 'E_INPUT_SHAPE', '顶层非对象 → E_INPUT_SHAPE');
  s.equal(firstCode(Core.normalizeInput({ db: 'oracle', schema: 's', table: 't', tableDesc: 'd', fields: ['x'] }).errors), 'E_INPUT_SHAPE', 'fields 元素非对象 → E_INPUT_SHAPE');
  s.equal(firstCode(Core.normalizeInput({ db: 'postgres', schema: 's', table: 't', tableDesc: 'd', fields: [] }).errors), 'E_DB_INVALID', '不支持的库 → E_DB_INVALID');
  s.equal(firstCode(Core.normalizeInput({ db: 'MySQL', schema: 's', table: 't', tableDesc: 'd', fields: [] }).errors), null, 'mysql 大小写不敏感被接受（新增库的宽容化）');
  s.equal(Core.normalizeInput({ db: 'H2', schema: 's', table: 't', tableDesc: 'd', fields: [] }).data.db, 'h2', 'h2 大小写不敏感归一为小写');
  s.equal(firstCode(Core.normalizeInput({ db: 'oracle', schema: 's', table: 't', tableDesc: 'd', fields: [{ name: 'a', desc: 'b', type: '字符串' }] }).errors), 'E_TYPE_INVALID', '不支持的类型 → E_TYPE_INVALID');

  /* ============ 5. 校验规则逐条（含反向用例，防止校验被放松） ============ */
  s.group('校验规则');
  var cases = JSON.parse(fs.readFileSync(path.join(FIXTURES, 'invalid-cases.json'), 'utf8'));

  cases.ok.forEach(function (c, i) {
    s.equal(Core.validate(c.data).length, 0, '合法用例[' + i + '] ' + c.title);
  });
  cases.fail.forEach(function (c) {
    // raw 用例走 generate 全链（覆盖 normalizeInput 阶段才产生的形状类错误码），
    // 其余用例直喂 validate，确保断言的是"业务校验"本身而非规范化后遗症。
    var got = c.raw
      ? firstCode(Core.generate(c.data, { includeDdl: false }).errors)
      : firstCode(Core.validate(c.data));
    s.equal(got, c.expect, c.title);
  });

  /* ============ 6. 否证性检查（对应「修复不得放松校验」） ============ */
  s.group('否证性检查');
  var okPayload = loadFixture('ok-oracle.json');
  s.equal(Core.validate(Core.normalizeInput(okPayload).data).length, 0, '基准载荷本身合法（避免假通过）');

  var fuzz = clone(okPayload);
  fuzz.fields[0].name = '1bad';
  s.ok(Core.validate(Core.normalizeInput(fuzz).data).length > 0, '非法字段名仍被拦截（未放松）');

  var pkEq = clone(okPayload);
  pkEq.indexes = [{ name: 'idx_emp_01', fields: ['emp_no', 'emp_name'] }];
  s.equal(firstCode(Core.validate(Core.normalizeInput(pkEq).data)), 'E_INDEX_EQUALS_PK', '索引与主键完全相同仍被拦截');

  var tooMany = clone(okPayload);
  tooMany.fields = [];
  for (var i = 0; i < 10; i++) tooMany.fields.push({ name: 'c' + i, desc: '列' + i, type: '整型' });
  tooMany.pk = { name: 'pk_emp', fields: ['c0'] };
  tooMany.indexes = [];
  for (var j = 0; j < 11; j++) tooMany.indexes.push({ name: 'idx_' + j, fields: ['c' + ((j + 1) % 10)] });
  s.ok(codes(Core.validate(Core.normalizeInput(tooMany).data)).indexOf('E_INDEX_COUNT_EXCEED') >= 0, '索引超过 10 个仍被拦截');

  var idxFields = clone(okPayload);
  idxFields.pk = { name: '', fields: [] };
  idxFields.indexes = [{ name: 'idx_emp_01', fields: ['a1', 'a2', 'a3', 'a4', 'a5', 'a6', 'a7', 'a8', 'a9', 'a10', 'a11'] }];
  s.ok(codes(Core.validate(Core.normalizeInput(idxFields).data)).indexOf('E_INDEX_FIELDS_EXCEED') >= 0, '单个索引超过 10 字段仍被拦截');

  var unknownPk = clone(okPayload);
  unknownPk.pk = { name: 'pk_emp', fields: ['nope'] };
  s.ok(codes(Core.validate(Core.normalizeInput(unknownPk).data)).indexOf('E_PK_FIELD_UNKNOWN') >= 0, '主键引用不存在的字段仍被拦截');

  /* ============ 7. 错误对象形状稳定（AI 侧要按 code 分支） ============ */
  s.group('契约稳定性');
  var shapeErrs = Core.validate(Core.normalizeInput({ db: 'oracle', schema: '1x', table: 'emp', tableDesc: 'd', fields: [] }).data);
  s.ok(shapeErrs.length >= 2, '多个错误一次全报（不是只报第一条）');
  shapeErrs.forEach(function (e, i) {
    s.equal(typeof e.code, 'string', 'errors[' + i + '].code 是字符串');
    s.equal(typeof e.message, 'string', 'errors[' + i + '].message 是字符串');
  });
  s.equal(firstCode(shapeErrs), 'E_SCHEMA_INVALID', '错误顺序按步骤：先 Schema 再字段');

  /* ============ 8. 统一入口 generate ============ */
  s.group('统一入口 generate');
  var gen = Core.generate(okPayload);
  s.equal(gen.ok, true, '合法载荷 ok=true');
  s.equal(gen.ddl !== null, true, '默认返回 ddl');
  s.equal(gen.excel, null, '默认不返回 excel（省成本）');
  s.equal(typeof gen.generatedAt, 'string', '成功时带 generatedAt 时间戳');
  s.equal(gen.version, Core.VERSION, '返回引擎版本');

  var genBad = Core.generate({ db: 'oracle' });
  s.equal(genBad.ok, false, '残缺载荷 ok=false');
  s.ok(genBad.errors.length > 0, '残缺载荷给出错误项');
  s.equal(genBad.generatedAt, null, '失败时不带 generatedAt（避免被误当作交付物）');
  s.equal(genBad.warnings.length, 1, '失败时给出 1 条草稿告警');
  s.equal(genBad.warnings[0].code, 'W_DRAFT', '告警码为 W_DRAFT');

  s.equal(Core.generate({ db: 'oracle' }, { includeDdl: false }).ddl, null, 'includeDdl=false 时不产草稿');
  s.equal(Core.generate(okPayload, { includeExcel: true }).excel !== null, true, 'includeExcel=true 时返回 excel');

  /* ============ 9. 幂等与无副作用 ============ */
  s.group('幂等 / 无副作用');
  var snapshot = JSON.stringify(okPayload);
  var r1 = Core.generate(okPayload, { includeExcel: true });
  var r2 = Core.generate(okPayload, { includeExcel: true });
  s.equal(JSON.stringify(okPayload), snapshot, 'generate 不修改入参');
  s.equal(r1.ddl, r2.ddl, '两次调用 DDL 一致');
  s.equal(r1.excel.content, r2.excel.content, '两次调用 Excel 字节一致（无时间戳/随机因素）');
  s.deepEqual(r1.data, r2.data, '两次调用规范化数据一致');

  /* ============ 10. 常量快照 ============ */
  s.group('常量快照');
  s.equal(Core.MAX_INDEX, 10, 'MAX_INDEX=10');
  s.equal(Core.MAX_INDEX_FIELDS, 10, 'MAX_INDEX_FIELDS=10');
  s.equal(Core.FIELD_TYPES.length, 5, '字段类型 5 种');
  s.deepEqual(Core.FIELD_TYPES, ['字符型', '数值型', '整型', '日期型', '时间戳'], '字段类型枚举固定');
  s.deepEqual(Core.DB_LIST, ['oracle', 'gauss', 'mysql', 'h2'], '数据库枚举固定（前两个保持历史顺序）');
  s.equal(Core.DB_LABEL.mysql, 'MySQL', 'mysql 展示名');
  s.equal(Core.DB_LABEL.h2, 'H2', 'h2 展示名');
  s.equal(Core.DB_LIST.length, Object.keys(Core.DB_LABEL).length, 'DB_LIST 与 DB_LABEL 数量一致');
  s.equal(Core.DB_LIST.length, Object.keys(Core.DB_COMMENT_STYLE).length, 'DB_LIST 与 DB_COMMENT_STYLE 数量一致');
  s.equal(Core.XLS_COLS, 8, 'Excel 列数 8（含数据类型列）');
  s.equal(Core.IDENT_RE.source, '^[A-Za-z_][A-Za-z0-9_]*$', '标识符正则固定');
  s.equal(Core.XLS_MIME, 'application/vnd.ms-excel;charset=utf-8', 'Excel MIME 固定');

  return s;
};
