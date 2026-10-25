/**
 * 界面接线测试（对**交付文件本身**做自证，不需要浏览器）
 * ------------------------------------------------------------------
 * 本机没有可用的无头浏览器，也没有连接的浏览器扩展，因此无法在这里点击真实页面。
 * 能做且值得做的三件事，都针对 index.html 本体：
 *   1) 两个 <script> 块必须语法正确 —— 别把"页面直接白屏"这种事故留到用户手里；
 *   2) 界面层里每一个 jQuery 选择器（#id / .class）都必须能在页面里找到对应元素 ——
 *      拼错一个 id 就是一条静默失效的交互（既不报错、也不生效）；
 *   3) 生成物不能残留占位符/调试痕迹，且 script 标签必须闭合、数量符合预期。
 * 这**不能**替代真实浏览器验收（事件链、Blob 下载、剪贴板降级仍需人工走查），
 * 但能在交付前拦住绝大多数"打不开/点了没反应"的低级故障。
 */
'use strict';

var fs = require('fs');
var path = require('path');

var ROOT = path.resolve(__dirname, '..');
var OUT_PATH = path.join(ROOT, 'index.html');

/** 取出所有内联 <script> 块（无 src 属性的） */
function inlineScripts(html) {
  var out = [];
  var re = /<script(?![^>]*\bsrc=)[^>]*>([\s\S]*?)<\/script>/gi;
  var m;
  while ((m = re.exec(html)) !== null) out.push(m[1]);
  return out;
}

/** 收集页面里真实存在的 id */
function collectIds(html) {
  var ids = {};
  var re = /\bid="([^"]+)"/g;
  var m;
  while ((m = re.exec(html)) !== null) ids[m[1]] = true;
  return ids;
}

/** 收集样式与标记里出现过的 class 名 */
function collectClasses(html) {
  var cls = {};
  var styleMatch = html.match(/<style>([\s\S]*?)<\/style>/i);
  var body = html;
  if (styleMatch) {
    var reStyle = /\.([A-Za-z_][\w-]*)/g;
    var ms;
    while ((ms = reStyle.exec(styleMatch[1])) !== null) cls[ms[1]] = true;
  }
  var reAttr = /class="([^"]*)"/g;
  var ma;
  while ((ma = reAttr.exec(body)) !== null) {
    ma[1].split(/\s+/).forEach(function (c) { if (c) cls[c] = true; });
  }
  return cls;
}

/** 抽出界面层里字面量型 jQuery 选择器，如 $('#step' + n) 这种拼接的会被跳过 */
function collectSelectors(source) {
  var found = [];
  var re = /\$\(\s*'([^'\\]*)'\s*\)/g;
  var m;
  while ((m = re.exec(source)) !== null) found.push(m[1]);
  // 复合选择器里用逗号并列的情况
  var expanded = [];
  found.forEach(function (sel) {
    sel.split(',').forEach(function (part) { expanded.push(part.trim()); });
  });
  return expanded;
}

module.exports = function run(s) {
  var html = fs.readFileSync(OUT_PATH, 'utf8');
  var scripts = inlineScripts(html);

  s.group('内联脚本');
  s.equal(scripts.length, 2, '恰好 2 个内联 script 块（引擎 + 界面层），实际 ' + scripts.length);
  // 真标签匹配：'<script' 后面必须跟空白或 '>'，否则会命中文案里的字符串。
  const tagOpens = (html.match(/<script[\s>]/gi) || []).length;
  s.equal(tagOpens, 3, '共 3 个 script 标签（含外链 jquery.min.js），实际 ' + tagOpens);
  s.equal((html.match(/<\/script>/gi) || []).length, 3, 'script 标签全部闭合');

  // 真实踩过的坑：引擎文档注释里写了字面量 '<script>'，HTML 解析器会把它当成
  // 脚本块结束标记，页面从那里被截断、整页失效。这里断言两个内联块里都不含该字面量。
  scripts.forEach(function (code, i) {
    s.equal(code.indexOf('<script') < 0, true, '第 ' + (i + 1) + ' 个内联块不含字面量 <script（否则页面会被截断）');
    s.equal(code.indexOf('</script') < 0, true, '第 ' + (i + 1) + ' 个内联块不含字面量 </script');
  });
  s.equal(scripts[0].indexOf('function jsonSchema()') >= 0, true, '第 1 块是引擎');
  s.equal(scripts[1].indexOf('window.ctdutil') >= 0, true, '第 2 块是界面层');

  s.group('脚本语法（交付文件本体）');
  scripts.forEach(function (code, i) {
    var err = null;
    try {
      // 只做语法解析，不执行：真实浏览器同样会先整块解析再执行
      new Function(code);
    } catch (e) {
      err = e;
    }
    s.equal(err === null, true, '第 ' + (i + 1) + ' 个 script 块语法正确' + (err ? '（' + err.message + '）' : ''));
  });
  // 哨兵：保证上面的语法检查不是"怎么都过"
  var brokenCaught = false;
  try { new Function('function ( { broken'); } catch (e) { brokenCaught = true; }
  s.equal(brokenCaught, true, '语法检查器能抓到坏代码（自证非空转）');

  s.group('生成物洁净度');
  s.equal(html.indexOf('__CORE_SOURCE__'), -1, '无占位标记残留');
  s.equal(html.indexOf('__CTDUTIL_ENGINE_PLACEHOLDER__'), -1, '无引擎占位符残留');
  s.equal(html.indexOf('GENERATED-FILE'), html.lastIndexOf('GENERATED-FILE'), '生成标记只出现 1 次（描述文本除外）');
  s.equal(html.indexOf('stepFieldCode'), -1, '无死代码残留');
  s.equal(html.indexOf('console.log('), -1, '交付文件中无调试日志');
  s.equal(html.indexOf('debugger'), -1, '交付文件中无 debugger 语句');

  s.group('界面接线（选择器 ↔ 元素）');
  var ids = collectIds(html);
  var classes = collectClasses(html);
  var selectors = collectSelectors(scripts[1]);

  s.ok(selectors.length >= 20, '界面层抽到足够多的选择器（实际 ' + selectors.length + ' 条）');
  s.ok(Object.keys(ids).length >= 18, '页面有足够多的 id（实际 ' + Object.keys(ids).length + ' 个）');

  var missingIds = [];
  var missingClasses = [];
  selectors.forEach(function (sel) {
    var idRe = /#([A-Za-z_][\w-]*)/g;
    var m;
    while ((m = idRe.exec(sel)) !== null) {
      if (!ids[m[1]] && missingIds.indexOf(m[1]) < 0) missingIds.push(m[1]);
    }
    var clRe = /\.([A-Za-z_][\w-]*)/g;
    while ((m = clRe.exec(sel)) !== null) {
      if (!classes[m[1]] && missingClasses.indexOf(m[1]) < 0) missingClasses.push(m[1]);
    }
  });
  s.deepEqual(missingIds, [], '所有 #id 选择器都能在页面中找到元素');
  s.deepEqual(missingClasses, [], '所有 .class 选择器都能在页面中命中（样式或标记）');

  s.group('关键控件在位（六步流程的必需件）');
  [
    'errMsg', 'step1', 'step2', 'step3', 'step4', 'step5', 'step6',
    'fieldTable', 'fieldBody', 'btnAddField', 'pkList', 'inpPkName',
    'idxList', 'btnAddIndex', 'idxLimitTip', 'pkHint',
    'inpSchema', 'inpTable', 'inpDesc', 'steps', 'summary', 'ddlText', 'ddlDbName',
    'btnPrev', 'btnNext', 'btnCopy', 'btnReset', 'btnExportExcel'
  ].forEach(function (id) {
    s.equal(ids[id] === true, true, '页面存在 #' + id);
  });

  s.group('目标库卡片（4 个库都要能在界面上选到）');
  s.equal((html.match(/class="db-card"/g) || []).length, 4, '页面有 4 张数据库卡片（oracle/gauss/mysql/h2）');
  ['oracle', 'gauss', 'mysql', 'h2'].forEach(function (db) {
    s.equal(html.indexOf('data-db="' + db + '"') >= 0, true, '存在 data-db="' + db + '" 卡片');
    s.equal(html.indexOf('name="db" value="' + db + '"') >= 0, true, '存在 value="' + db + '" 单选框');
  });

  s.group('索引类型控件（普通 / 唯一索引）');
  s.ok(scripts[1].indexOf("'.idx-type'") >= 0, '界面层绑定了 .idx-type（索引类型下拉）的 change 事件');
  s.ok(scripts[1].indexOf('Core.indexTypeOf') >= 0, '索引类型判定调用引擎（界面不自己判 unique）');
  s.ok(scripts[1].indexOf('Core.INDEX_TYPES') >= 0, '类型选项取自引擎枚举 Core.INDEX_TYPES');
  s.ok(scripts[1].indexOf('Core.INDEX_TYPE_LABEL') >= 0, '类型文案取自引擎 Core.INDEX_TYPE_LABEL');
  s.ok(scripts[1].indexOf('idx-type') >= 0 && scripts[1].indexOf('<select class="inp idx-type"') >= 0, '索引卡片里渲染出类型下拉');
  s.ok(scripts[1].indexOf('unique: false') >= 0, '新增索引默认普通索引（unique:false）');
  s.ok(html.indexOf('唯一索引') >= 0, '交付页面出现「唯一索引」文案');
  s.ok(html.indexOf('create unique index') >= 0, '交付页面内联的引擎含 create unique index 分支');

  s.group('界面层引用的引擎 API 必须真实存在（防"点了没反应/整步渲染炸掉"）');
  // 动态渲染的控件（如索引类型下拉）不在静态 DOM 里，选择器检查抓不到它；
  // 这里改成检查「界面层写到的每个 Core.xxx 都由引擎真实导出」——缺一个就会在运行期抛错。
  var coreNames = {};
  var reCore = /Core\.([A-Za-z_$][\w$]*)/g;
  var mc;
  while ((mc = reCore.exec(scripts[1])) !== null) coreNames[mc[1]] = true;
  var coreObj = require(path.join(ROOT, 'src', 'core.js'));
  var missingApi = Object.keys(coreNames).filter(function (n) { return coreObj[n] === undefined; });
  s.deepEqual(missingApi, [], '界面层用到的 Core.* 全部由引擎导出');
  s.ok(Object.keys(coreNames).length >= 8, '确实抽到一批 Core.* 引用（自证这条检查不是空转，实际 ' + Object.keys(coreNames).length + ' 个）');
  s.equal(coreObj.definitelyNotAnApi === undefined, true, '判据本身有效：不存在的 API 会被判为 undefined');

  s.group('离线可用性');
  s.equal(/<script[^>]+src="https?:/i.test(html), false, '没有外部 CDN 脚本（离线可用）');
  s.equal(/<link[^>]+href="https?:/i.test(html), false, '没有外部样式表引用');
  s.equal(html.indexOf('src="jquery.min.js"') >= 0, true, '本地引用 jquery.min.js');
  var jqPath = path.join(ROOT, 'jquery.min.js');
  s.equal(fs.existsSync(jqPath), true, 'jquery.min.js 文件存在');
  var jq = fs.readFileSync(jqPath, 'utf8');
  s.ok(jq.length > 50000, 'jquery.min.js 内容完整（' + jq.length + ' 字符）');
  s.equal(jq.indexOf('jQuery v3') >= 0, true, 'jquery.min.js 为 jQuery 3.x（与文档一致）');

  return s;
};
