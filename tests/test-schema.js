/**
 * 契约层测试：
 *   1) Core.jsonSchema() 能真正校验输入（含自证：故意改坏必须被它抓到）；
 *   2) 引擎可产出的全部错误码，都在 invalid-cases.json 里有对应用例
 *      —— 防止「新增校验规则却没人测」和「用例写错却仍然全绿」。
 */
'use strict';

var fs = require('fs');
var path = require('path');
var Core = require(path.join(__dirname, '..', 'src', 'core.js'));

var FIXTURES = path.join(__dirname, 'fixtures');
var DOCS = path.join(__dirname, '..', 'docs');

/** 引擎可能产出的全部错误码（新增规则时必须同步这里，否则本文件会变红） */
var KNOWN_ERROR_CODES = [
  'E_INPUT_SHAPE',
  'E_DB_INVALID', 'E_DB_REQUIRED',
  'E_TYPE_INVALID',
  'E_SCHEMA_REQUIRED', 'E_SCHEMA_INVALID',
  'E_TABLE_REQUIRED', 'E_TABLE_INVALID', 'E_TABLE_DESC_REQUIRED',
  'E_FIELD_EMPTY',
  'E_FIELD_NAME_REQUIRED', 'E_FIELD_NAME_INVALID', 'E_FIELD_NAME_DUP',
  'E_FIELD_DESC_REQUIRED',
  'E_FIELD_LENGTH_REQUIRED', 'E_FIELD_LENGTH_INVALID',
  'E_FIELD_PRECISION_REQUIRED', 'E_FIELD_PRECISION_INVALID',
  'E_FIELD_SCALE_REQUIRED', 'E_FIELD_SCALE_INVALID', 'E_FIELD_SCALE_GE_PRECISION',
  'E_PK_NAME_REQUIRED', 'E_PK_NAME_INVALID', 'E_PK_FIELD_UNKNOWN', 'E_PK_FIELD_DUP',
  'E_INDEX_COUNT_EXCEED',
  'E_INDEX_FIELDS_REQUIRED', 'E_INDEX_FIELDS_EXCEED',
  'E_INDEX_NAME_REQUIRED', 'E_INDEX_NAME_INVALID', 'E_INDEX_NAME_DUP',
  'E_INDEX_EQUALS_PK'
];

function typeList(t) { return Array.isArray(t) ? t : [t]; }
function firstCode(errors) { return errors.length ? errors[0].code : null; }

/**
 * 极简 JSON Schema 校验器（只支持本契约用到的关键字）。
 * 它同时是「被测对象」的判据与被判据——因此额外用一条"改坏必红"用例自证它不是空转。
 */
function validateAgainstSchema(schema, value, at) {
  var errs = [];
  at = at || '$';
  function add(msg) { errs.push(at + ' ' + msg); }

  if (schema.enum) {
    if (schema.enum.indexOf(value) < 0) add('不在枚举 ' + JSON.stringify(schema.enum) + ' 内（实际 ' + JSON.stringify(value) + '）');
    return errs;
  }

  if (schema.type) {
    var types = typeList(schema.type);
    var actual = value === null ? 'null' : Array.isArray(value) ? 'array' : typeof value;
    var match = false;
    types.forEach(function (t) {
      if (t === 'integer') { if (typeof value === 'number' && Number.isInteger(value)) match = true; }
      else if (t === 'number') { if (typeof value === 'number') match = true; }
      else if (t === actual) match = true;
    });
    if (!match) { add('类型期望 ' + types.join('|') + '，实际 ' + actual); return errs; }
    if (value === null) return errs;
  }

  if (typeof value === 'string') {
    if (schema.pattern && !new RegExp(schema.pattern).test(value)) add('不匹配 pattern ' + schema.pattern + '（实际 ' + JSON.stringify(value) + '）');
    if (typeof schema.minLength === 'number' && value.length < schema.minLength) add('长度小于 minLength ' + schema.minLength);
    if (typeof schema.maxLength === 'number' && value.length > schema.maxLength) add('长度大于 maxLength ' + schema.maxLength);
  }

  if (Array.isArray(value)) {
    if (typeof schema.minItems === 'number' && value.length < schema.minItems) add('元素数小于 minItems ' + schema.minItems + '（实际 ' + value.length + '）');
    if (typeof schema.maxItems === 'number' && value.length > schema.maxItems) add('元素数大于 maxItems ' + schema.maxItems + '（实际 ' + value.length + '）');
    if (schema.items) value.forEach(function (v, i) { errs = errs.concat(validateAgainstSchema(schema.items, v, at + '[' + i + ']')); });
  }

  if (value && typeof value === 'object' && !Array.isArray(value)) {
    (schema.required || []).forEach(function (k) {
      if (!Object.prototype.hasOwnProperty.call(value, k)) add('缺少必填字段 ' + k);
    });
    Object.keys(schema.properties || {}).forEach(function (k) {
      if (Object.prototype.hasOwnProperty.call(value, k)) {
        errs = errs.concat(validateAgainstSchema(schema.properties[k], value[k], at + '.' + k));
      }
    });
  }

  return errs;
}

module.exports = function run(s) {
  var schema = Core.jsonSchema();

  s.group('Schema 形状');
  s.equal(schema.$schema, 'https://json-schema.org/draft/2020-12/schema', '声明 2020-12 草案');
  s.equal(schema.type, 'object', '顶层为对象');
  s.deepEqual(schema.required, ['db', 'schema', 'table', 'tableDesc', 'fields'], '必填字段列表固定');
  s.deepEqual(schema.properties.db.enum, Core.DB_LIST, 'db 枚举与引擎一致');
  s.deepEqual(schema.properties.fields.items.properties.type.enum, Core.FIELD_TYPES, '字段类型枚举与引擎一致');
  s.equal(schema.properties.indexes.items.properties.unique.type, 'boolean', 'indexes[].unique 在 Schema 里声明为 boolean');
  s.equal(schema.properties.indexes.maxItems, Core.MAX_INDEX, '索引上限与引擎一致');
  s.equal(schema.properties.indexes.items.properties.fields.maxItems, Core.MAX_INDEX_FIELDS, '单索引字段上限与引擎一致');
  s.equal(schema.properties.fields.minItems, 1, '至少 1 个字段');
  s.ok(JSON.stringify(schema).length > 0, 'Schema 可序列化（无循环引用）');

  s.group('Schema 校验器自证（改坏必红）');
  s.ok(validateAgainstSchema(schema, null).length > 0, '非对象输入被拒（证明校验器不是空转）');
  s.ok(validateAgainstSchema(schema, {}).length >= 5, '空对象缺必填被拒');
  s.ok(validateAgainstSchema(schema, { db: 'oracle', schema: 's', table: 't', tableDesc: 'd', fields: [{ name: 'a', desc: 'b', type: '字符型', length: 'x' }] }).length === 0, '合法输入通过');
  s.ok(validateAgainstSchema(schema.properties.fields, []).length > 0, '空字段数组被拒');
  s.ok(validateAgainstSchema(schema.properties.fields, [{ name: '1bad', desc: 'b', type: '整型' }]).length > 0, '非法标识符被拒');
  s.ok(validateAgainstSchema(schema.properties.fields, [{ name: 'a', desc: 'b', type: '整型' }]).length === 0, '合法字段通过');
  s.ok(validateAgainstSchema(schema.properties.fields, [{ name: 'a', desc: 'b', type: '字符串' }]).length > 0, '非法类型被拒');
  s.ok(validateAgainstSchema(schema.properties.fields, [{ name: 'a', desc: 'b', type: '字符型', length: 12 }]).length === 0, 'length 允许数字');
  s.ok(validateAgainstSchema(schema.properties.indexes, [{ name: 'i', unique: true, fields: ['a'] }]).length === 0, 'indexes[].unique 为布尔时通过');
  s.ok(validateAgainstSchema(schema.properties.indexes, [{ name: 'i', unique: 'yes', fields: ['a'] }]).length > 0, 'indexes[].unique 非布尔被 Schema 拒（证明该声明不是空转）');

  s.group('全部 fixtures 必须通过 Schema 与引擎双重校验');
  var files = fs.readdirSync(FIXTURES).filter(function (f) { return /^ok-.*\.json$/.test(f); });
  s.equal(files.length >= 3, true, '至少存在 3 个合法 fixture（实际 ' + files.length + '）');
  files.forEach(function (f) {
    var payload = JSON.parse(fs.readFileSync(path.join(FIXTURES, f), 'utf8'));
    s.deepEqual(validateAgainstSchema(schema, payload), [], f + ' 通过 JSON Schema');
    s.equal(Core.generate(payload).ok, true, f + ' 通过引擎校验');
  });

  s.group('错误码覆盖');
  var cases = JSON.parse(fs.readFileSync(path.join(FIXTURES, 'invalid-cases.json'), 'utf8'));
  var covered = {};
  cases.fail.forEach(function (c) { covered[c.expect] = (covered[c.expect] || 0) + 1; });

  var missing = KNOWN_ERROR_CODES.filter(function (code) { return !covered[code]; });
  s.deepEqual(missing, [], '已声明错误码都有用例覆盖');
  var unknown = Object.keys(covered).filter(function (code) { return KNOWN_ERROR_CODES.indexOf(code) < 0; });
  s.deepEqual(unknown, [], '用例里没有未声明的错误码');

  // raw 用例必须真的走 generate 全链，否则形状类错误码覆盖是假的
  var rawCases = cases.fail.filter(function (c) { return c.raw === true; });
  s.ok(rawCases.length >= 3, '存在形状类（raw）用例：' + rawCases.length + ' 条');
  rawCases.forEach(function (c) {
    s.equal(firstCode(Core.generate(c.data).errors), c.expect, 'raw 用例经 generate 得到 ' + c.expect);
  });

  s.group('错误码契约文档');
  var docPath = path.join(DOCS, 'AI接口契约.md');
  s.equal(fs.existsSync(docPath), true, 'docs/AI接口契约.md 存在');
  var doc = fs.readFileSync(docPath, 'utf8');
  var undocumented = KNOWN_ERROR_CODES.filter(function (code) { return doc.indexOf(code) < 0; });
  s.deepEqual(undocumented, [], '每个错误码都在契约文档中列出');
  var exercised = Object.keys(covered);
  var docOnly = exercised.filter(function (code) { return doc.indexOf(code) < 0; });
  s.deepEqual(docOnly, [], '用例中的错误码都在契约文档中列出');

  return s;
};
