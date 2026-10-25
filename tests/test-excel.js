/**
 * Excel（.xls / Excel 2003 SpreadsheetML）导出与 Sheet 命名规则
 */
'use strict';

var fs = require('fs');
var path = require('path');
var Core = require(path.join(__dirname, '..', 'src', 'core.js'));

var FIXTURES = path.join(__dirname, 'fixtures');
function loadFixture(name) { return JSON.parse(fs.readFileSync(path.join(FIXTURES, name), 'utf8')); }
function clone(o) { return JSON.parse(JSON.stringify(o)); }

module.exports = function run(s) {
  var payload = loadFixture('ok-oracle.json');
  var result = Core.generate(payload, { includeExcel: true });
  var xls = result.excel;
  var content = xls.content;

  s.group('Excel 基本契约');
  s.equal(result.ok, true, '载荷合法');
  s.equal(typeof xls, 'object', '返回 excel 对象');
  s.equal(xls.fileName, '表结构设计_scott_emp.xls', '文件名 = 表结构设计_{schema}_{table}.xls');
  s.equal(xls.mimeType, 'application/vnd.ms-excel;charset=utf-8', 'MIME 类型正确');
  s.equal(xls.bom, true, '标记为含 BOM');
  s.equal(content.charCodeAt(0), 0xFEFF, '内容首字符为 UTF-8 BOM（U+FEFF）');

  s.group('Excel 结构与样式');
  s.ok(content.indexOf('<?mso-application progid="Excel.Sheet"?>') >= 0, '含 mso-application 指令');
  s.ok(content.indexOf('urn:schemas-microsoft-com:office:spreadsheet') >= 0, '含 SpreadsheetML 命名空间');
  s.ok(content.indexOf('ss:Name="emp"') >= 0, 'Sheet 名称为表名 emp');
  s.ok(content.indexOf('ss:ID="sSection"') >= 0, '含分节样式');
  s.ok(content.indexOf('ss:ID="sHeader"') >= 0, '含表头样式');
  s.ok(content.indexOf('ss:Bold="1"') >= 0, '存在加粗样式');

  s.group('Excel 内容');
  s.ok(content.indexOf('表结构设计总览') >= 0, '含标题');
  s.ok(content.indexOf('一、基本信息') >= 0, '含「一、基本信息」');
  s.ok(content.indexOf('二、字段定义') >= 0, '含「二、字段定义」');
  s.ok(content.indexOf('三、主键') >= 0, '含「三、主键」');
  s.ok(content.indexOf('四、索引') >= 0, '含「四、索引」');
  s.ok(content.indexOf('Oracle') >= 0, '含目标数据库名 Oracle');
  s.ok(content.indexOf('员工信息表') >= 0, '含表描述');
  s.ok(content.indexOf('emp_no') >= 0, '含字段名');
  s.ok(content.indexOf('员工编号') >= 0, '含字段描述');
  s.ok(content.indexOf('>字符型<') >= 0, '含字段类型');
  s.ok(content.indexOf('ss:Type="Number">1<') >= 0, '序号列为数字类型');
  s.ok(content.indexOf('pk_emp') >= 0, '含主键名');
  s.ok(content.indexOf('emp_no、emp_name') >= 0, '主键字段以「、」连接（判定为集合，与顺序无关）');
  s.ok(content.indexOf('idx_emp_01') >= 0, '含索引名');

  s.group('Excel 不含 DDL');
  s.equal(content.toLowerCase().indexOf('create table'), -1, '不含 create table');
  s.equal(content.toLowerCase().indexOf('alter table'), -1, '不含 alter table');
  s.equal(content.toLowerCase().indexOf('create index'), -1, '不含 create index');
  s.equal(content.toLowerCase().indexOf('comment on'), -1, '不含 comment on');

  s.group('Excel 含数据类型列（本次新增）');
  s.equal((content.match(/<Column ss:Width=/g) || []).length, Core.XLS_COLS, '列宽定义条数 = 引擎声明的列数 ' + Core.XLS_COLS);
  s.ok(content.indexOf('>数据类型<') >= 0, '字段定义表头含「数据类型」');
  s.ok(content.indexOf('>varchar2(20)<') >= 0, '含 varchar2(20)（emp_no，Oracle 方言）');
  s.ok(content.indexOf('>varchar2(50)<') >= 0, '含 varchar2(50)（emp_name）');
  s.ok(content.indexOf('>number(10,2)<') >= 0, '含 number(10,2)（sal）');
  s.ok(content.indexOf('>integer<') >= 0, '含 integer（age）');
  s.ok(content.indexOf('>timestamp<') >= 0, '含 timestamp（created_at）');
  s.ok(content.indexOf('<Cell><Data ss:Type="String">字符型</Data></Cell><Cell><Data ss:Type="String">varchar2(20)</Data></Cell>') >= 0,
    '数据类型列紧跟「字段类型」列之后（列序固定，不是追加在行尾）');

  s.group('Excel 数据类型随目标库变化');
  var mysqlXls = Core.generate(loadFixture('ok-mysql.json'), { includeExcel: true }).excel.content;
  s.ok(mysqlXls.indexOf('>MySQL<') >= 0, 'MySQL 载荷的「目标数据库」为 MySQL');
  s.ok(mysqlXls.indexOf('>varchar(32)<') >= 0, 'MySQL 字段类型 → varchar(32)');
  s.ok(mysqlXls.indexOf('>decimal(18,4)<') >= 0, 'MySQL 数值型 → decimal(18,4)');
  s.ok(mysqlXls.indexOf('>datetime<') >= 0, 'MySQL 时间戳 → datetime');
  s.equal(mysqlXls.indexOf('varchar2'), -1, 'MySQL 的 Excel 不含 varchar2');
  var h2Xls = Core.generate(loadFixture('ok-h2.json'), { includeExcel: true }).excel.content;
  s.ok(h2Xls.indexOf('>H2<') >= 0, 'H2 载荷的「目标数据库」为 H2');
  s.ok(h2Xls.indexOf('>varchar(32)<') >= 0, 'H2 字段类型 → varchar(32)');
  s.ok(h2Xls.indexOf('>numeric(18,4)<') >= 0, 'H2 数值型 → numeric(18,4)');
  s.ok(h2Xls.indexOf('>int<') >= 0, 'H2 整型 → int');
  s.equal(h2Xls.indexOf('varchar2'), -1, 'H2 的 Excel 不含 varchar2');

  s.group('Excel XML 转义');
  var esc = clone(payload);
  esc.tableDesc = '描述含 <标签> & "引号" 与 \'单引号\'';
  var escContent = Core.generate(esc, { includeExcel: true }).excel.content;
  s.ok(escContent.indexOf('&lt;标签&gt;') >= 0, '< 与 > 被转义');
  s.ok(escContent.indexOf('&amp;') >= 0, '& 被转义');
  s.ok(escContent.indexOf('&quot;引号&quot;') >= 0, '双引号被转义');
  s.ok(escContent.indexOf('&apos;单引号&apos;') >= 0, '单引号被转义');
  s.equal(/描述含 <标签>/.test(escContent), false, '原始尖括号不再出现在文档中');

  s.group('Excel 索引类型列（普通/唯一）');
  s.ok(content.indexOf('>索引类型<') >= 0, '索引表头含「索引类型」');
  s.ok(content.indexOf('<Cell><Data ss:Type="String">idx_emp_02</Data></Cell><Cell><Data ss:Type="String">唯一索引</Data></Cell>') >= 0,
    '唯一索引行标注「唯一索引」');
  s.ok(content.indexOf('<Cell><Data ss:Type="String">idx_emp_01</Data></Cell><Cell><Data ss:Type="String">普通索引</Data></Cell>') >= 0,
    '普通索引行标注「普通索引」');
  s.equal((content.match(/>唯一索引</g) || []).length, 1, '唯一索引在 Excel 里只出现一次（不被误标）');
  s.equal((content.match(/>普通索引</g) || []).length, 1, '普通索引只出现一次');
  s.equal((content.match(/<Cell\/>/g) || []).length > 0, true, '索引行仍补齐到 8 列（含空单元格）');

  s.group('Sheet 名称规则');
  s.equal(Core.xlsSheetName('emp'), 'emp', '普通表名原样');
  s.equal(Core.xlsSheetName('A_B_C').length <= 31, true, '长度不超过 31（Excel 上限）');
  var longName = 't' + new Array(40).join('x');
  s.equal(Core.xlsSheetName(longName).length, 31, '超长表名截断到 31 字符');
  s.equal(Core.xlsSheetName('a:b'), 'a_b', ': 替换为 _');
  s.equal(Core.xlsSheetName('a*b'), 'a_b', '* 替换为 _');
  s.equal(Core.xlsSheetName('  emp  '), 'emp', '首尾空格被去除');

  s.group('无主键 / 无索引的表述');
  var minimalResult = Core.generate(loadFixture('ok-minimal.json'), { includeExcel: true });
  s.equal(minimalResult.ok, true, '最小 fixture 校验通过（否则后面断言无意义）');
  s.deepEqual(minimalResult.data.pk.fields, [], '最小 fixture 无主键字段');
  s.equal(minimalResult.data.indexes.length, 0, '最小 fixture 无索引');
  var minimal = minimalResult.excel.content;
  // 与既有实现（原 index.html exportExcelDoc）一致：无主键时输出 标签「主键」+ 值「无」
  s.ok(minimal.indexOf('<Data ss:Type="String">主键</Data></Cell><Cell ss:MergeAcross="6"><Data ss:Type="String">无</Data>') >= 0,
    '无主键时输出「主键 | 无」');
  s.ok(minimal.indexOf('<Data ss:Type="String">索引</Data></Cell><Cell ss:MergeAcross="6"><Data ss:Type="String">无</Data>') >= 0,
    '无索引时输出「索引 | 无」');
  s.equal(minimal.indexOf('pk_log1'), -1, '无主键时不出现主键名');

  s.group('Excel 可重复性');
  var again = Core.generate(payload, { includeExcel: true }).excel.content;
  s.equal(again, content, '同样输入两次导出字节完全一致（无时间戳）');
  s.equal(Core.xlsFileName('scott', 'emp'), '表结构设计_scott_emp.xls', 'xlsFileName 规则固定');

  return s;
};
