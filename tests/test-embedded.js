/**
 * 内联与漂移测试（部署形态的判据）
 * ------------------------------------------------------------------
 * 交付形态是「单文件 index.html，双击即用」。本文件守住三件事：
 *   1) index.html 确实内联了 src/core.js 的完整源码 → 界面与引擎同一份逻辑；
 *   2) index.html 与「模板 + 引擎」逐字节一致 → 改了源文件却忘记重建会被抓出来；
 *   3) 内联后的引擎在浏览器式环境（无 module/exports）下可正常导出 window.Core。
 * 另附 UI 层的静态守卫：不许再引入 $.trim / .show()/.hide()（历史上出过真实缺陷）。
 */
'use strict';

var fs = require('fs');
var path = require('path');
var Core = require(path.join(__dirname, '..', 'src', 'core.js'));

var ROOT = path.resolve(__dirname, '..');
var CORE_PATH = path.join(ROOT, 'src', 'core.js');
var TPL_PATH = path.join(ROOT, 'src', 'index.template.html');
var OUT_PATH = path.join(ROOT, 'index.html');
var MARKER = '/* __CORE_SOURCE__ */';

function norm(t) { return t.replace(/\r\n/g, '\n'); }
function loadFixture(name) { return JSON.parse(fs.readFileSync(path.join(__dirname, 'fixtures', name), 'utf8')); }

/** 复刻 src/build.mjs 的渲染逻辑（测试独立复算，不 require 构建脚本）。
 *  注释里点明真实踩过的坑，防止有人"顺手改回" replace 写法。 */
function renderInner() {
  var core = fs.readFileSync(CORE_PATH, 'utf8');
  var tpl = fs.readFileSync(TPL_PATH, 'utf8');
  // 必须 split/join：core.js 的正则 /^[A-Za-z_][A-Za-z0-9_]*$/ 含 `$'`，
  // 而 String.replace 的替换串会把 `$'` 当成「匹配之后的全部内容」，把内容展开成 2 倍垃圾。
  return tpl.split(MARKER).join(core.replace(/\s+$/, ''));
}

/** 在"浏览器式"环境里实例化内联引擎：
 *  必须把 globalThis / window 都换成本地空对象——引擎的 UMD 头优先绑定 globalThis，
 *  只遮蔽 module 是不够的（会写到 Node 的全局对象上，window.Core 仍是 undefined）。 */
function instantiateLikeBrowser(coreSource) {
  var win = {};
  var factory = new Function('globalThis', 'window', 'module', 'exports', 'document',
    coreSource + '\n;return (typeof globalThis !== "undefined" && globalThis.Core) || window.Core;');
  var exported = factory(win, win, undefined, undefined, undefined);
  return { win: win, Core: win.Core, returned: exported };
}

module.exports = function run(s) {
  s.group('交付文件存在性');
  s.equal(fs.existsSync(OUT_PATH), true, 'index.html 存在');
  s.equal(fs.existsSync(CORE_PATH), true, 'src/core.js 存在');
  s.equal(fs.existsSync(TPL_PATH), true, 'src/index.template.html 存在');
  s.equal(fs.existsSync(path.join(ROOT, 'jquery.min.js')), true, 'jquery.min.js 仍在（界面依赖，离线可用）');

  var html = fs.readFileSync(OUT_PATH, 'utf8');
  var coreSource = fs.readFileSync(CORE_PATH, 'utf8').replace(/\s+$/, '');
  var inner = renderInner();

  s.group('内联完整性');
  s.equal(html.indexOf(MARKER), -1, '占位标记已被替换（无残留）');
  s.ok(html.indexOf(coreSource) >= 0, 'index.html 内联了 core.js 的完整源码');
  s.equal(html.split(coreSource).length - 1, 1, 'core.js 源码在文件中只出现一次');

  s.group('生成漂移（改了源文件必须重建）');
  s.equal(norm(html), norm(inner), 'index.html 与「模板 + core.js」渲染结果逐字节一致');
  // 这条是上面那个 $' 展开坑的哨兵：一旦有人把注入方式改回 String.replace，行数会翻倍
  s.equal(html.split('</html>').length - 1, 1, '文档只有一个 </html>（防止注入被展开成 2 倍）');
  s.equal(html.split('<!DOCTYPE html>').length - 1, 1, '文档只有一个 <!DOCTYPE html>');
  s.ok(html.split('\n').length < 2000, '文档行数在合理范围（实际 ' + html.split('\n').length + ' 行）');
  // 真实踩过的坑：内联脚本里出现字面量 '<script>'，HTML 解析器会提前结束脚本块，
  // 页面从那里被截断、整页失效（引擎只剩一半）。标签总数必须恰好 3（1 外链 + 2 内联）。
  s.equal((html.match(/<script[\s>]/gi) || []).length, 3, '恰好 3 个 script 标签（1 外链 + 2 内联）');
  s.equal((html.match(/<\/script>/gi) || []).length, 3, 'script 标签全部闭合');

  s.group('HTML 结构');
  s.ok(html.indexOf('<!DOCTYPE html>') >= 0, '含 DOCTYPE');
  s.ok(html.indexOf('GENERATED-FILE') >= 0, '含「生成文件」标记（模板头部注释）');
  s.ok(html.indexOf('id="step6"') >= 0, '含第六步容器');
  s.ok(html.indexOf('id="fieldBody"') >= 0, '含字段表 tbody');
  s.ok(html.indexOf('id="modalMask"') >= 0, '含索引字段弹窗');
  s.ok(html.indexOf('id="btnExportExcel"') >= 0, '含导出按钮');
  s.ok(html.indexOf('window.ctdutil') >= 0, '暴露自动化入口 window.ctdutil');
  s.ok(html.indexOf('root.Core = api') >= 0, '引擎导出挂载点存在');

  s.group('历史缺陷守卫（不得回退）');
  s.equal(html.indexOf('$.trim'), -1, '不出现 $.trim（jQuery 3.5 废弃 / 4.0 移除）');
  s.equal(/\.show\(\)/.test(html), false, '不出现 .show()（会被 [hidden]{display:none!important} 覆盖）');
  s.equal(/\.hide\(\)/.test(html), false, '不出现 .hide()');
  s.ok(html.indexOf("removeAttr('hidden')") >= 0, '显隐统一走 hidden 属性（removeAttr）');
  s.ok(html.indexOf("attr('hidden', 'hidden')") >= 0, '显隐统一走 hidden 属性（attr）');

  s.group('内联引擎可独立运行（浏览器式环境）');
  var env = instantiateLikeBrowser(coreSource);
  s.equal(typeof env.win.Core, 'object', 'window.Core 被正确挂载（module 为 undefined 时）');
  s.equal(env.returned === env.win.Core, true, '工厂返回值与 window.Core 为同一对象');
  s.equal(env.win.Core.VERSION, Core.VERSION, '内联版本号与源文件一致');

  var payload = loadFixture('ok-oracle.json');
  var a = env.win.Core.generate(payload, { includeExcel: true });
  var b = Core.generate(payload, { includeExcel: true });
  s.equal(a.ddl, b.ddl, '内联引擎产出的 DDL 与 require 的引擎完全一致');
  s.equal(a.excel.content, b.excel.content, '内联引擎产出的 Excel 与 require 的引擎完全一致');

  var inlineBad = env.win.Core.generate({ db: 'postgres', fields: [] });
  s.equal(inlineBad.ok, false, '内联引擎同样能拦下非法输入');
  s.equal(inlineBad.errors[0].code, 'E_DB_INVALID', '内联引擎错误码与源文件一致');

  // 新增的两个目标库必须在内联副本里同样生效（否则浏览器端会出现「AI 能生成、页面不能」的分裂）
  ['mysql', 'h2'].forEach(function (db) {
    var payloadDb = loadFixture(db === 'mysql' ? 'ok-mysql.json' : 'ok-h2.json');
    var inlineOut = env.win.Core.generate(payloadDb, { includeExcel: true });
    var nodeOut = Core.generate(payloadDb, { includeExcel: true });
    s.equal(inlineOut.ok, true, '内联引擎支持 ' + db);
    s.equal(inlineOut.ddl, nodeOut.ddl, '内联引擎的 ' + db + ' DDL 与 require 的引擎一致');
    s.equal(inlineOut.excel.content, nodeOut.excel.content, '内联引擎的 ' + db + ' Excel 与 require 的引擎一致');
  });

  s.group('模板守卫');
  var tpl = fs.readFileSync(TPL_PATH, 'utf8');
  s.equal(tpl.split(MARKER).length, 2, '模板中占位标记恰好 1 处');
  s.ok(tpl.indexOf('window.ctdutil') >= 0, '自动化入口写在模板里（不会因重建丢失）');
  s.equal(tpl.indexOf('stepFieldCode'), -1, '模板中不残留死代码 stepFieldCode');

  return s;
};
