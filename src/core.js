/**
 * ctdutil 核心引擎（core）
 * ------------------------------------------------------------------
 * 设计约束（三条，任何修改都必须同时满足）：
 *   1. 零依赖：不 require 任何模块，不访问 DOM / window / jQuery / 网络。
 *   2. 可运行环境：Node（CommonJS）与浏览器（页面内通过 window.Core 暴露）双端同一份源码。
 *   3. 纯函数：同样输入必得同样输出；除 Core.generate 的 generatedAt 外无时间/随机因素。
 *
 * 本文件是唯一权威实现（single source of truth）：
 *   - index.html 的界面逻辑只做 DOM 读写，业务规则一律调用 window.Core；
 *   - 命令行 src/cli.js 只是本引擎的 JSON in/out 外壳；
 *   - index.html 由 src/build.mjs 从 src/index.template.html 注入本文件生成，tests 有漂移断言。
 *
 * 输入/输出契约见 docs/AI接口契约.md（由本文件的 Core.jsonSchema() 自动保持一致）。
 */
(function (root, factory) {
  'use strict';
  var api = factory();
  if (typeof module === 'object' && module && module.exports) module.exports = api;
  if (root) root.Core = api;
})(typeof globalThis !== 'undefined' ? globalThis : this, function () {
  'use strict';

  var VERSION = '2.2.0';
  var MAX_INDEX = 10;
  var MAX_INDEX_FIELDS = 10;
  var IDENT_RE = /^[A-Za-z_][A-Za-z0-9_]*$/;
  var FIELD_TYPES = ['字符型', '数值型', '整型', '日期型', '时间戳'];
  /**
   * 目标数据库。新增库时必须同时改三处（否则各套测试会变红）：
   *   1) 本数组 + DB_LABEL；
   *   2) typeSql 的类型映射；
   *   3) buildDdl 里是否需要独立方言（MySQL 注释/表注释语法与其它库不同）。
   * 顺序即界面卡片顺序，前两个保持历史顺序不动。
   */
  var DB_LIST = ['oracle', 'gauss', 'mysql', 'h2'];
  var DB_LABEL = { oracle: 'Oracle', gauss: 'GaussDB', mysql: 'MySQL', h2: 'H2' };
  /**
   * 注释语法分族（决定了 buildDdl 走哪条分支）：
   *   'comment-on' —— comment on table/column ... is '...'（oracle / gauss / h2）
   *   'inline'     —— 列上内联 comment '...'、表尾 ) comment = '...'（mysql）
   * MySQL 不存在 comment on 语句，故不能复用 comment-on 分支。
   */
  var DB_COMMENT_STYLE = { oracle: 'comment-on', gauss: 'comment-on', h2: 'comment-on', mysql: 'inline' };
  /**
   * 索引类型。'normal' / 'unique' 是稳定键（程序侧判定用），中文标签只用于展示；
   * 界面、Excel、文档三处共用这一份，避免各写一套文案。
   */
  var INDEX_TYPES = ['normal', 'unique'];
  var INDEX_TYPE_LABEL = { normal: '普通索引', unique: '唯一索引' };

  /* ============================ 工具 ============================ */

  function trim(s) { return String(s == null ? '' : s).trim(); }

  /** 任意值 → 字符串（供 JSON 输入宽容化：10 与 "10" 等价） */
  function toStr(v) {
    if (v == null) return '';
    if (typeof v === 'number') return isFinite(v) ? String(v) : '';
    if (typeof v === 'boolean') return v ? 'true' : 'false';
    return trim(v);
  }

  function escXml(s) {
    return String(s == null ? '' : s)
      .replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;')
      .replace(/"/g, '&quot;').replace(/'/g, '&apos;');
  }
  function escSql(s) { return String(s == null ? '' : s).replace(/'/g, "''"); }
  function pad2(n) { return n < 10 ? '0' + n : '' + n; }

  function isIdent(s) { return IDENT_RE.test(trim(s)); }
  function isValidDb(db) { return DB_LIST.indexOf(db) >= 0; }
  function isValidType(t) { return FIELD_TYPES.indexOf(t) >= 0; }
  function isInt(s) { return /^\d+$/.test(toStr(s)); }

  /** 索引类型判定的唯一实现：只有显式 unique === true 才算唯一索引 */
  function indexTypeOf(idx) { return (idx && idx.unique === true) ? 'unique' : 'normal'; }

  /* ======================= 命名规则（联动） ======================= */

  function pkName(table) { return 'pk_' + trim(table).toLowerCase(); }
  function indexBase(table) { return 'idx_' + trim(table).toLowerCase(); }
  function indexAutoName(table, i) { return indexBase(table) + '_' + pad2(i + 1); }

  /** 空字段行（与界面「新增字段」一致） */
  function emptyField() {
    return { name: '', desc: '', type: '字符型', length: '', precision: '', scale: '' };
  }

  /** 空白输入（与界面「重新填写」一致） */
  function emptyInput() {
    return {
      db: null, schema: '', table: '', tableDesc: '',
      fields: [emptyField()],
      pk: { name: '', fields: [] },
      indexes: []
    };
  }

  /* ======================= 输入规范化 ======================= */

  /**
   * 把任意（AI 生成的、手写的、界面收集的）输入整理成规范形状。
   * 同时做「形状级」校验，产出 input 类错误；不抛异常——解析失败也要有结构化回执。
   * @returns {{data: object, errors: Array}}
   */
  function normalizeInput(raw) {
    var errors = [];
    function bad(code, message, extra) {
      var e = { code: code, message: message };
      if (extra) for (var k in extra) if (Object.prototype.hasOwnProperty.call(extra, k)) e[k] = extra[k];
      errors.push(e);
    }

    var src = (raw && typeof raw === 'object' && !Array.isArray(raw)) ? raw : null;
    if (!src) {
      bad('E_INPUT_SHAPE', '输入必须是 JSON 对象（顶层不能是数组或标量）');
      return { data: emptyInput(), errors: errors };
    }

    var db = src.db == null ? null : trim(src.db).toLowerCase();
    if (db === '') db = null;
    if (db != null && !isValidDb(db)) {
      bad('E_DB_INVALID', '目标数据库只支持 ' + DB_LIST.join(' / ') + '，收到 "' + trim(src.db) + '"', { field: 'db' });
      db = null;
    }

    var data = {
      db: db,
      schema: toStr(src.schema),
      table: toStr(src.table),
      tableDesc: toStr(src.tableDesc),
      fields: [],
      pk: { name: '', fields: [] },
      indexes: []
    };

    var rawFields = src.fields;
    if (rawFields == null) rawFields = [];
    if (!Array.isArray(rawFields)) {
      bad('E_INPUT_SHAPE', 'fields 必须是数组', { field: 'fields' });
      rawFields = [];
    }
    rawFields.forEach(function (rf, i) {
      var f = rf && typeof rf === 'object' ? rf : {};
      if (!rf || typeof rf !== 'object' || Array.isArray(rf)) {
        bad('E_INPUT_SHAPE', 'fields[' + i + '] 必须是对象', { field: 'fields', index: i });
      }
      var type = toStr(f.type) || '字符型';
      if (!isValidType(type)) {
        bad('E_TYPE_INVALID', 'fields[' + i + '].type 取值必须是 ' + FIELD_TYPES.join(' / ') + '，收到 "' + toStr(f.type) + '"',
          { field: 'fields', index: i });
        type = '字符型';
      }
      data.fields.push({
        name: toStr(f.name),
        desc: toStr(f.desc),
        type: type,
        length: toStr(f.length),
        precision: toStr(f.precision),
        scale: toStr(f.scale)
      });
    });

    var rawPk = src.pk;
    if (rawPk != null && (typeof rawPk !== 'object' || Array.isArray(rawPk))) {
      bad('E_INPUT_SHAPE', 'pk 必须是对象 { name, fields }', { field: 'pk' });
      rawPk = null;
    }
    rawPk = rawPk || {};
    var rawPkFields = rawPk.fields;
    if (rawPkFields == null) rawPkFields = [];
    if (!Array.isArray(rawPkFields)) {
      bad('E_INPUT_SHAPE', 'pk.fields 必须是字符串数组', { field: 'pk' });
      rawPkFields = [];
    }
    var pkNameGiven = toStr(rawPk.name);
    data.pk.fields = rawPkFields.map(toStr).filter(function (x) { return x !== ''; });
    // 主键名与界面一致：固定为 pk_小写表名；未显式给出时自动派生
    data.pk.name = pkNameGiven || pkName(data.table);

    var rawIndexes = src.indexes;
    if (rawIndexes == null) rawIndexes = [];
    if (!Array.isArray(rawIndexes)) {
      bad('E_INPUT_SHAPE', 'indexes 必须是数组', { field: 'indexes' });
      rawIndexes = [];
    }
    rawIndexes.forEach(function (ri, i) {
      if (!ri || typeof ri !== 'object' || Array.isArray(ri)) {
        bad('E_INPUT_SHAPE', 'indexes[' + i + '] 必须是对象', { field: 'indexes', index: i });
        ri = {};
      }
      var rf = ri.fields == null ? [] : ri.fields;
      if (!Array.isArray(rf)) {
        bad('E_INPUT_SHAPE', 'indexes[' + i + '].fields 必须是字符串数组', { field: 'indexes', index: i });
        rf = [];
      }
      var nameAuto = ri.nameAuto === true || ri.nameAuto === undefined;
      var given = toStr(ri.name);
      if (given === '' && nameAuto) given = indexAutoName(data.table, i);
      // unique 与 nameAuto 同一套宽容化口径：只认真正的布尔 true，其余（缺省/false/"true"/1）一律视为普通索引
      data.indexes.push({
        name: given,
        nameAuto: nameAuto,
        unique: ri.unique === true,
        fields: rf.map(toStr).filter(function (x) { return x !== ''; })
      });
    });

    return { data: data, errors: errors };
  }

  /* ======================= 逐字段类型映射 ======================= */

  /**
   * 字段类型 → SQL 类型片段。仅使用传入字段的 length/precision/scale。
   *
   * 各库差异（写成表以免后来者凭印象改）：
   *   | 字段类型 | oracle          | gauss            | mysql           | h2              |
   *   | 字符型   | varchar2(n)     | varchar2(n)      | varchar(n)      | varchar(n)      |
   *   | 数值型   | number(p,s)     | numeric(p,s)     | decimal(p,s)    | numeric(p,s)    |
   *   | 整型     | integer         | integer          | int             | int             |
   *   | 日期型   | date            | date             | date            | date            |
   *   | 时间戳   | timestamp       | timestamp        | datetime        | timestamp       |
   *
   * 为什么 h2 用 varchar 而不是 varchar2：**实测** H2 2.5.250 常规/文件模式其实接受 varchar2
   * （它把 varchar2 当兼容别名，落地为 CHARACTER VARYING），但 H2 官方文档把这类写法标为
   * “compatibility-only non-standard syntax, don't use it unless you need it for compatibility”；
   * 面向 H2 常规/文件模式我们生成标准写法 varchar。（MySQL 没有 varchar2，这一点无争议。）
   * 为什么 mysql 时间戳用 datetime 而不是 timestamp：MySQL timestamp 范围仅 1970–2038，
   * 且受 explicit_defaults_for_timestamp 影响可能自动更新，不适合业务时间字段。
   *
   * @param {'oracle'|'gauss'|'mysql'|'h2'} db
   * @param {object} f { type, length, precision, scale }
   */
  function typeSql(db, f) {
    f = f || {};
    if (f.type === '字符型') {
      var ch = (db === 'mysql' || db === 'h2') ? 'varchar' : 'varchar2';
      return ch + '(' + toStr(f.length) + ')';
    }
    if (f.type === '数值型') {
      var num = db === 'oracle' ? 'number' : (db === 'mysql' ? 'decimal' : 'numeric');
      return num + '(' + toStr(f.precision) + ',' + toStr(f.scale) + ')';
    }
    if (f.type === '整型') return (db === 'mysql' || db === 'h2') ? 'int' : 'integer';
    if (f.type === '日期型') return 'date';
    if (f.type === '时间戳') return db === 'mysql' ? 'datetime' : 'timestamp';
    return '';
  }

  /* ======================= 业务校验 ======================= */

  var IDENT_HINT = '（仅允许字母、数字、下划线，且不能以数字开头）';

  /**
   * 业务校验。入参应是 normalizeInput 产出的 data。
   * 返回错误数组（有序，界面只显示第一条），错误项含稳定 code，供程序判别。
   */
  function validate(data) {
    var errors = [];
    function bad(code, message, extra) {
      var e = { code: code, message: message };
      if (extra) for (var k in extra) if (Object.prototype.hasOwnProperty.call(extra, k)) e[k] = extra[k];
      errors.push(e);
    }

    /* --- 第一步 --- */
    if (!data.db) bad('E_DB_REQUIRED', '请先选择目标数据库', { step: 1 });

    /* --- 第二步 --- */
    if (!trim(data.schema)) bad('E_SCHEMA_REQUIRED', 'Schema 名不能为空', { step: 2, field: 'schema' });
    else if (!isIdent(data.schema)) bad('E_SCHEMA_INVALID', 'Schema 名 "' + trim(data.schema) + '" 不合法' + IDENT_HINT, { step: 2, field: 'schema' });
    if (!trim(data.table)) bad('E_TABLE_REQUIRED', '表名不能为空', { step: 2, field: 'table' });
    else if (!isIdent(data.table)) bad('E_TABLE_INVALID', '表名 "' + trim(data.table) + '" 不合法' + IDENT_HINT, { step: 2, field: 'table' });
    if (!trim(data.tableDesc)) bad('E_TABLE_DESC_REQUIRED', '表描述不能为空', { step: 2, field: 'tableDesc' });

    /* --- 第三步 --- */
    if (!data.fields.length) bad('E_FIELD_EMPTY', '请至少新增一个字段', { step: 3 });
    var seen = {};
    data.fields.forEach(function (f, i) {
      var no = i + 1, at = { step: 3, field: 'fields', index: i };
      if (!f.name) { bad('E_FIELD_NAME_REQUIRED', '第 ' + no + ' 行：字段名不能为空', at); }
      else if (!isIdent(f.name)) { bad('E_FIELD_NAME_INVALID', '第 ' + no + ' 行：字段名 "' + f.name + '" 不合法' + IDENT_HINT, at); }
      else {
        var key = f.name.toLowerCase();
        if (seen[key]) bad('E_FIELD_NAME_DUP', '第 ' + no + ' 行：字段名 "' + f.name + '" 重复', at);
        seen[key] = true;
      }
      if (!f.desc) bad('E_FIELD_DESC_REQUIRED', '第 ' + no + ' 行：字段描述不能为空', at);
      if (f.type === '字符型') {
        if (!f.length) bad('E_FIELD_LENGTH_REQUIRED', '第 ' + no + ' 行：字符型字段必须输入长度', at);
        else if (!isInt(f.length) || +f.length < 1) bad('E_FIELD_LENGTH_INVALID', '第 ' + no + ' 行：字段长度必须为正整数', at);
      } else if (f.type === '数值型') {
        if (!f.precision) bad('E_FIELD_PRECISION_REQUIRED', '第 ' + no + ' 行：数值型字段必须输入精度', at);
        else if (!isInt(f.precision) || +f.precision < 1) bad('E_FIELD_PRECISION_INVALID', '第 ' + no + ' 行：精度必须为正整数', at);
        if (!f.scale) bad('E_FIELD_SCALE_REQUIRED', '第 ' + no + ' 行：数值型字段必须输入小数位数', at);
        else if (!isInt(f.scale) || +f.scale < 0) bad('E_FIELD_SCALE_INVALID', '第 ' + no + ' 行：小数位数必须为非负整数', at);
        else if (isInt(f.precision) && +f.scale >= +f.precision) bad('E_FIELD_SCALE_GE_PRECISION', '第 ' + no + ' 行：小数位数必须小于精度', at);
      }
    });

    /* --- 第四步：主键 --- */
    if (data.pk.fields.length) {
      if (!trim(data.pk.name)) bad('E_PK_NAME_REQUIRED', '已勾选主键字段，主键名称不能为空', { step: 4, field: 'pk.name' });
      else if (!isIdent(data.pk.name)) bad('E_PK_NAME_INVALID', '主键名称 "' + trim(data.pk.name) + '" 不合法' + IDENT_HINT, { step: 4, field: 'pk.name' });
      var nameSet = {};
      data.fields.forEach(function (f) { nameSet[f.name.toLowerCase()] = true; });
      var pkSeen = {};
      data.pk.fields.forEach(function (n) {
        var k = n.toLowerCase();
        if (!nameSet[k]) bad('E_PK_FIELD_UNKNOWN', '主键引用了不存在的字段 "' + n + '"', { step: 4, field: 'pk.fields' });
        else if (pkSeen[k]) bad('E_PK_FIELD_DUP', '主键字段 "' + n + '" 重复', { step: 4, field: 'pk.fields' });
        pkSeen[k] = true;
      });
    }

    /* --- 第五步：索引 --- */
    if (data.indexes.length > MAX_INDEX) {
      bad('E_INDEX_COUNT_EXCEED', '索引数量不能超过 ' + MAX_INDEX + ' 个', { step: 5, field: 'indexes' });
    }
    var pkSet = data.pk.fields.map(function (n) { return n.toLowerCase(); }).sort().join(',');
    var idxNames = {};
    data.indexes.forEach(function (idx, i) {
      var no = i + 1, at = { step: 5, field: 'indexes', index: i };
      if (!idx.fields.length) bad('E_INDEX_FIELDS_REQUIRED', '索引 ' + no + '：请至少选择一个字段（不需要该索引可删除）', at);
      if (idx.fields.length > MAX_INDEX_FIELDS) bad('E_INDEX_FIELDS_EXCEED', '索引 ' + no + '：字段数量不能超过 ' + MAX_INDEX_FIELDS + ' 个', at);
      if (!trim(idx.name)) bad('E_INDEX_NAME_REQUIRED', '索引 ' + no + '：索引名不能为空', at);
      else if (!isIdent(idx.name)) bad('E_INDEX_NAME_INVALID', '索引 ' + no + '：索引名 "' + trim(idx.name) + '" 不合法' + IDENT_HINT, at);
      else {
        var k = idx.name.toLowerCase();
        if (idxNames[k]) bad('E_INDEX_NAME_DUP', '索引 ' + no + '：索引名 "' + trim(idx.name) + '" 与其他索引重复', at);
        idxNames[k] = true;
      }
      if (pkSet) {
        var set = idx.fields.map(function (n) { return n.toLowerCase(); }).sort().join(',');
        if (set === pkSet) bad('E_INDEX_EQUALS_PK', '索引 ' + no + '：索引字段与主键完全相同，请调整（不允许主键和索引相同）', at);
      }
    });

    return errors;
  }

  /* ======================= DDL 生成 ======================= */

  /**
   * 生成 DDL（全部英文小写；注释中文原样；单引号转义）。
   * 不做校验——调用方必须先 validate；此处按给定数据尽力生成，便于 AI 预览草稿。
   *
   * 按 DB_COMMENT_STYLE 分两条分支：
   *   - 'comment-on'（oracle / gauss / h2）：建表 + 独立 comment on 语句；
   *   - 'inline'（mysql）：列上内联 comment，表注释写在 ) comment = '...'。
   * MySQL 没有 comment on 语句，因此不能共用前者的骨架。
   *
   * @param {object} data normalizeInput 产出的 data
   * @returns {string}
   */
  function buildDdl(data) {
    if (DB_COMMENT_STYLE[data && data.db] === 'inline') return buildDdlInline(data);
    return buildDdlCommentOn(data);
  }

  /** 建表骨架：字段定义行（缩进 4 空格）拼进 create table */
  function buildCreateTableHead(data, fieldLine) {
    var schema = trim(data.schema).toLowerCase();
    var table = trim(data.table).toLowerCase();
    var L = [];
    L.push('create table ' + schema + '.' + table + ' (');
    L.push((data.fields || []).map(fieldLine).join(',\n'));
    return L;
  }

  /** 主键约束 + 索引（两族语法完全一致，抽出来避免两份实现漂移）
   *
   * 索引类型只差一个关键字：普通索引 `create index`，唯一索引 `create unique index`。
   * oracle / gauss / mysql / h2 四库的这两种写法完全一致（H2 用真实 2.5.250 实测过），
   * 因此不需要像注释那样按方言分支。
   */
  function buildDdlTail(L, data) {
    var schema = trim(data.schema).toLowerCase();
    var table = trim(data.table).toLowerCase();
    if (data.pk && data.pk.fields && data.pk.fields.length) {
      L.push('');
      L.push('alter table ' + schema + '.' + table + ' add constraint ' + trim(data.pk.name).toLowerCase() +
        ' primary key (' + data.pk.fields.map(function (n) { return trim(n).toLowerCase(); }).join(', ') + ');');
    }
    (data.indexes || []).forEach(function (idx) {
      L.push('');
      L.push((idx.unique ? 'create unique index ' : 'create index ') + trim(idx.name).toLowerCase() +
        ' on ' + schema + '.' + table + ' (' +
        idx.fields.map(function (n) { return trim(n).toLowerCase(); }).join(', ') + ');');
    });
    return L;
  }

  /** oracle / gauss / h2：comment on table/column ... is '...'
   *
   * H2 专属差异（实测得出，别删）：H2 拒绝在可空列上 add primary key ——
   *   alter table ... add constraint pk_x primary key (c)  →  90023 Column "C" must not be nullable。
   * 因此 h2 的主键列必须在建表时就写 not null；oracle / gauss 会隐式把主键列置为 not null，
   * 保持原样不动（不动它们也就不会改动既有 golden 基准）。
   */
  function buildDdlCommentOn(data) {
    var schema = trim(data.schema).toLowerCase();
    var table = trim(data.table).toLowerCase();
    var fields = data.fields || [];
    var pkSet = {};
    ((data.pk && data.pk.fields) || []).forEach(function (n) { pkSet[trim(n).toLowerCase()] = true; });
    var L = buildCreateTableHead(data, function (f) {
      var name = trim(f.name).toLowerCase();
      var notNull = (data.db === 'h2' && pkSet[name]) ? ' not null' : '';
      return '    ' + name + ' ' + typeSql(data.db, f) + notNull;
    });
    L.push(');');
    L.push('');
    L.push("comment on table " + schema + '.' + table + " is '" + escSql(data.tableDesc) + "';");
    fields.forEach(function (f) {
      L.push("comment on column " + schema + '.' + table + '.' + trim(f.name).toLowerCase() + " is '" + escSql(f.desc) + "';");
    });
    return buildDdlTail(L, data).join('\n');
  }

  /** mysql：列内联 comment '...'，表注释写成 ) comment = '...' */
  function buildDdlInline(data) {
    var L = buildCreateTableHead(data, function (f) {
      return '    ' + trim(f.name).toLowerCase() + ' ' + typeSql(data.db, f) +
        " comment '" + escSql(f.desc) + "'";
    });
    L.push(") comment = '" + escSql(data.tableDesc) + "';");
    return buildDdlTail(L, data).join('\n');
  }

  /* ======================= Excel 导出（.xls / SpreadsheetML） ======================= */

  var XLS_MIME = 'application/vnd.ms-excel;charset=utf-8';
  /** 工作表列数：序号/字段名/字段描述/字段类型/数据类型/长度/精度/小数位数 */
  var XLS_COLS = 8;
  /** 整行合并用（跨 XLS_COLS 列）；kv 行的值跨 XLS_COLS-1 列 */
  var XLS_MERGE_ALL = XLS_COLS - 1;
  var XLS_MERGE_VALUE = XLS_COLS - 2;

  function xlsSheetName(table) {
    // Excel 工作表名上限 31 字符，且不得含 : \ / ? * [ ]
    return trim(table).replace(/[:\\\/\?\*\[\]]/g, '_').slice(0, 31);
  }

  function xlsFileName(schema, table) {
    return '表结构设计_' + trim(schema) + '_' + trim(table) + '.xls';
  }

  /**
   * 生成 Excel 2003 SpreadsheetML（引擎决定字节，供界面下载或 CLI 落盘）。
   * 不含 DDL 语句；**含每个字段映射到目标库后的数据类型**（如 varchar2(20) / decimal(10,2)）；
   * 内容不含时间戳（保证同样输入必得同样字节，可被断言）。
   * @returns {{fileName: string, mimeType: string, content: string, bom: boolean}}
   */
  function buildExcel(data) {
    var rows = [];
    function cell(t) { return '<Cell><Data ss:Type="String">' + escXml(t) + '</Data></Cell>'; }
    function numCell(n) { return '<Cell><Data ss:Type="Number">' + n + '</Data></Cell>'; }
    function emptyCells(n) { var s = ''; for (var i = 0; i < n; i++) s += '<Cell/>'; return s; }
    function sectionRow(t) {
      return '<Row><Cell ss:MergeAcross="' + XLS_MERGE_ALL + '" ss:StyleID="sSection"><Data ss:Type="String">' + escXml(t) + '</Data></Cell></Row>';
    }
    function kvRow(k, v) {
      return '<Row><Cell ss:StyleID="sLabel"><Data ss:Type="String">' + escXml(k) + '</Data></Cell>' +
        '<Cell ss:MergeAcross="' + XLS_MERGE_VALUE + '"><Data ss:Type="String">' + escXml(v) + '</Data></Cell></Row>';
    }
    function headerRow(cells) {
      var h = '<Row>';
      cells.forEach(function (t) { h += '<Cell ss:StyleID="sHeader"><Data ss:Type="String">' + escXml(t) + '</Data></Cell>'; });
      h += emptyCells(XLS_COLS - cells.length);
      return h + '</Row>';
    }

    rows.push('<Row><Cell ss:MergeAcross="' + XLS_MERGE_ALL + '" ss:StyleID="sTitle"><Data ss:Type="String">表结构设计总览</Data></Cell></Row>');
    rows.push('<Row/>');

    rows.push(sectionRow('一、基本信息'));
    rows.push(kvRow('目标数据库', DB_LABEL[data.db] || ''));
    rows.push(kvRow('Schema', data.schema));
    rows.push(kvRow('表名', data.table));
    rows.push(kvRow('表描述', data.tableDesc));
    rows.push('<Row/>');

    rows.push(sectionRow('二、字段定义'));
    rows.push(headerRow(['序号', '字段名', '字段描述', '字段类型', '数据类型', '长度', '精度', '小数位数']));
    data.fields.forEach(function (f, i) {
      rows.push('<Row>' + numCell(i + 1) + cell(f.name) + cell(f.desc) + cell(f.type) +
        cell(typeSql(data.db, f)) +
        cell(f.length || '-') + cell(f.precision || '-') + cell(f.scale || '-') + '</Row>');
    });
    rows.push('<Row/>');

    rows.push(sectionRow('三、主键'));
    if (data.pk.fields.length) {
      rows.push(kvRow('主键名', data.pk.name));
      rows.push(kvRow('主键字段', data.pk.fields.join('、')));
    } else {
      rows.push(kvRow('主键', '无'));
    }
    rows.push('<Row/>');

    rows.push(sectionRow('四、索引'));
    if (data.indexes.length) {
      rows.push(headerRow(['索引名', '索引类型', '索引字段（按勾选顺序）']));
      data.indexes.forEach(function (idx) {
        rows.push('<Row>' + cell(idx.name) + cell(INDEX_TYPE_LABEL[indexTypeOf(idx)]) +
          cell(idx.fields.join('、')) + emptyCells(XLS_COLS - 3) + '</Row>');
      });
    } else {
      rows.push(kvRow('索引', '无'));
    }

    var xml = '<?xml version="1.0" encoding="UTF-8"?>\n' +
      '<?mso-application progid="Excel.Sheet"?>\n' +
      '<Workbook xmlns="urn:schemas-microsoft-com:office:spreadsheet" ' +
      'xmlns:o="urn:schemas-microsoft-com:office:office" ' +
      'xmlns:x="urn:schemas-microsoft-com:office:excel" ' +
      'xmlns:ss="urn:schemas-microsoft-com:office:spreadsheet" ' +
      'xmlns:html="http://www.w3.org/TR/REC-html40">' +
      '<DocumentProperties xmlns="urn:schemas-microsoft-com:office:office">' +
      '<Author>表结构登记工具</Author>' +
      '</DocumentProperties>' +
      '<Styles>' +
      '<Style ss:ID="Default" ss:Name="Normal"><Alignment ss:Vertical="Center"/><Font ss:FontName="宋体" ss:Size="11"/></Style>' +
      '<Style ss:ID="sTitle"><Font ss:Bold="1" ss:Size="16"/><Alignment ss:Horizontal="Center"/></Style>' +
      '<Style ss:ID="sSection"><Font ss:Bold="1" ss:Size="12"/><Interior ss:Color="#DDE7F5" ss:Pattern="Solid"/></Style>' +
      '<Style ss:ID="sHeader"><Font ss:Bold="1"/><Interior ss:Color="#E8EEF7" ss:Pattern="Solid"/></Style>' +
      '<Style ss:ID="sLabel"><Font ss:Bold="1"/></Style>' +
      '</Styles>' +
      '<Worksheet ss:Name="' + escXml(xlsSheetName(data.table)) + '">' +
      '<Table>' +
      '<Column ss:Width="45"/><Column ss:Width="130"/><Column ss:Width="200"/><Column ss:Width="90"/><Column ss:Width="110"/><Column ss:Width="60"/><Column ss:Width="60"/><Column ss:Width="70"/>' +
      rows.join('') +
      '</Table>' +
      '</Worksheet>' +
      '</Workbook>';

    return { fileName: xlsFileName(data.schema, data.table), mimeType: XLS_MIME, content: '\ufeff' + xml, bom: true };
  }

  /* ======================= 统一入口 ======================= */

  /**
   * 一次调用完成：规范化 → 校验 → 生成 DDL（与 Excel 原文）。
   * @param {object} raw 宽松输入（字符串/数字皆可，见 docs/AI接口契约.md）
   * @param {{includeExcel?: boolean, includeDdl?: boolean}} [opts]
   * @returns {{ok: boolean, version: string, errors: Array, warnings: Array,
   *            data: object|null, ddl: string|null, excel: object|null, generatedAt: string|null}}
   */
  function generate(raw, opts) {
    opts = opts || {};
    var needDdl = opts.includeDdl !== false;
    var needExcel = opts.includeExcel === true;

    var norm = normalizeInput(raw);
    var errors = norm.errors.slice();
    var data = norm.data;

    // 形状没问题时再跑业务校验，避免形状错误刷屏
    if (!errors.length) errors = errors.concat(validate(data));

    var ok = errors.length === 0;
    var out = {
      ok: ok,
      version: VERSION,
      errors: errors,
      warnings: [],
      data: data,
      ddl: null,
      excel: null,
      generatedAt: null
    };
    if (ok) {
      out.generatedAt = new Date().toISOString();
      if (needDdl) out.ddl = buildDdl(data);
      if (needExcel) out.excel = buildExcel(data);
    } else {
      // 失败也给出草稿，便于 AI 迭代；但明确标记为草稿
      out.warnings.push({ code: 'W_DRAFT', message: '校验未通过，data/ddl 仅供定位问题参考，不可作为交付结果' });
      if (needDdl) out.ddl = buildDdl(data);
    }
    return out;
  }

  /* ======================= 可执行契约：JSON Schema ======================= */

  /**
   * 输入的 JSON Schema（2020-12）。契约三件套里的「可执行一致性检查」用它校验全部 fixtures。
   * 注意：这是**宽容化之后的**契约——字段类型等枚举与 normalizeInput 的实际收受范围一致。
   */
  function jsonSchema() {
    var strOrNum = { type: ['string', 'number'] };
    return {
      $schema: 'https://json-schema.org/draft/2020-12/schema',
      $id: 'https://ctdutil.local/schema/table-design-input.json',
      title: 'ctdutil 表结构登记输入',
      type: 'object',
      additionalProperties: true,
      required: ['db', 'schema', 'table', 'tableDesc', 'fields'],
      properties: {
        db: {
          enum: DB_LIST,
          description: '目标数据库，决定类型映射与注释语法：oracle → number(p,s)/varchar2，' +
            'gauss → numeric(p,s)/varchar2，mysql → decimal(p,s)/varchar + 内联 comment，h2 → numeric(p,s)/varchar'
        },
        schema: { type: 'string', pattern: '^[A-Za-z_][A-Za-z0-9_]*$' },
        table: { type: 'string', pattern: '^[A-Za-z_][A-Za-z0-9_]*$' },
        tableDesc: { type: 'string', minLength: 1, description: '表描述（生成 comment on table）' },
        fields: {
          type: 'array',
          minItems: 1,
          items: {
            type: 'object',
            required: ['name', 'desc', 'type'],
            additionalProperties: true,
            properties: {
              name: { type: 'string', pattern: '^[A-Za-z_][A-Za-z0-9_]*$' },
              desc: { type: 'string', minLength: 1 },
              type: { enum: FIELD_TYPES },
              length: strOrNum,
              precision: strOrNum,
              scale: strOrNum
            }
          }
        },
        pk: {
          type: 'object',
          additionalProperties: true,
          properties: {
            name: { type: 'string' },
            fields: { type: 'array', items: { type: 'string' } }
          }
        },
        indexes: {
          type: 'array',
          maxItems: MAX_INDEX,
          items: {
            type: 'object',
            additionalProperties: true,
            properties: {
              name: { type: 'string' },
              nameAuto: { type: 'boolean', description: '为 true 且未给 name 时按 idx_表名_序号 自动生成' },
              unique: { type: 'boolean', description: '为 true 时生成 create unique index（唯一索引）；缺省/false 为普通索引' },
              fields: { type: 'array', maxItems: MAX_INDEX_FIELDS, items: { type: 'string' } }
            }
          }
        }
      }
    };
  }

  /* ======================= 常量快照（只读用途） ======================= */

  var constants = {
    VERSION: VERSION,
    MAX_INDEX: MAX_INDEX,
    MAX_INDEX_FIELDS: MAX_INDEX_FIELDS,
    IDENT_RE: IDENT_RE,
    FIELD_TYPES: FIELD_TYPES,
    DB_LIST: DB_LIST,
    DB_LABEL: DB_LABEL,
    DB_COMMENT_STYLE: DB_COMMENT_STYLE,
    INDEX_TYPES: INDEX_TYPES,
    INDEX_TYPE_LABEL: INDEX_TYPE_LABEL,
    XLS_MIME: XLS_MIME,
    XLS_COLS: XLS_COLS
  };

  return {
    VERSION: VERSION,
    constants: constants,
    MAX_INDEX: MAX_INDEX,
    MAX_INDEX_FIELDS: MAX_INDEX_FIELDS,
    FIELD_TYPES: FIELD_TYPES,
    DB_LIST: DB_LIST,
    DB_LABEL: DB_LABEL,
    DB_COMMENT_STYLE: DB_COMMENT_STYLE,
    INDEX_TYPES: INDEX_TYPES,
    INDEX_TYPE_LABEL: INDEX_TYPE_LABEL,
    IDENT_RE: IDENT_RE,
    XLS_MIME: XLS_MIME,
    XLS_COLS: XLS_COLS,
    // 工具
    trim: trim, pad2: pad2, escXml: escXml, escSql: escSql, isIdent: isIdent, isValidDb: isValidDb,
    indexTypeOf: indexTypeOf,
    // 联动命名
    pkName: pkName, indexAutoName: indexAutoName, emptyField: emptyField, emptyInput: emptyInput,
    // 业务
    normalizeInput: normalizeInput, validate: validate, typeSql: typeSql,
    buildDdl: buildDdl, buildExcel: buildExcel, xlsSheetName: xlsSheetName, xlsFileName: xlsFileName,
    generate: generate, jsonSchema: jsonSchema
  };
});
