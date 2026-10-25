# ctdutil · 表结构登记与 DDL 生成工具

单文件、零依赖的表结构登记工具：人类界面为纯前端页面（双击即用），
按六步向导登记数据库表结构，自动生成建表 DDL 与结构总览 Excel。
支持 Oracle / GaussDB / MySQL / H2（文件模式），支持普通索引与唯一索引。
同一个引擎同时提供**人类界面**、**命令行（JSON in / JSON out）**与**浏览器内自动化接口**三个操作面。

- 版本：2.2.0
- 运行时：Node.js >= 18（浏览器端无需安装任何东西）
- 依赖：**零依赖**（无 `dependencies` / `devDependencies`，离线可用）
- 交付形态：`index.html` 单文件，双击即用

## 功能

- **六步向导**：选择数据库 → 基本信息 → 字段定义 → 主键设置 → 索引设置 → 生成 DDL。
- **四种目标库**：Oracle、GaussDB、MySQL、H2（文件模式）。类型映射与注释语法随库切换。
  字符型 `varchar2`/`varchar`、数值型 `number`/`numeric`/`decimal`、时间戳 `datetime`/`timestamp` 等差异由引擎统一处理。
- **字段与校验**：字段名大小写不敏感去重；按类型校验长度、精度、小数位数；标识符格式校验。
- **主键**：支持组合主键，也允许无主键；主键名固定为 `pk_小写表名`，随表名自动联动。
- **索引**：最多 10 个索引、每个索引最多 10 个字段；索引类型可选**普通索引 / 唯一索引**；
  索引名默认 `idx_小写表名_序号`，可手动修改；索引字段集合与主键字段集合相同时拦截。
- **DDL 输出**：英文全小写、中文注释原样输出、单引号自动转义（`'` → `''`）；
  注释语句按库分两族（`comment on ...` 与 MySQL 内联 `comment '...'`）。
- **Excel 导出**：页面右上角一键导出 Excel 2003 XML（`.xls`，UTF-8 BOM，Sheet 名取表名），
  含基本信息、字段定义、主键、索引，不含 DDL。
- **AI / 脚本接口**：`node src/cli.js` 读 JSON 载荷、写 JSON 结果，退出码可供流水线判定；
  浏览器内另有 `window.Core` 与 `window.ctdutil` 两个对象。
- **零依赖、离线可用**：jQuery 3.7.1 本地文件引入，无 CDN、无后端、无构建服务。

## 快速开始

### 1. 人类界面（手工登记）

双击 `index.html` 即可使用（兼容 `file://`，导出与复制都有降级路径）。也可用任意静态服务器打开，
例如下面这条零依赖命令（在本目录执行）：

```powershell
node -e "const h=require('http'),f=require('fs'),p=require('path');h.createServer((q,s)=>{const u=(q.url==='/'?'/index.html':q.url).split('?')[0];f.readFile(p.join('.',u),(e,d)=>{if(e){s.writeHead(404);s.end('not found');return}const m={'.html':'text/html','.js':'application/javascript'}[p.extname(u)]||'application/octet-stream';s.writeHead(200,{'Content-Type':m+'; charset=utf-8'});s.end(d)})}).listen(8080)"
```

浏览器打开 `http://127.0.0.1:8080`。按六步填完，最后一步得到 DDL 与结构总览，可一键复制、可导出 Excel。

### 2. 命令行（AI / 脚本）

```bash
# 生成：JSON 载荷从文件读入，结果 JSON 写 stdout
node src/cli.js --in mytable.json --pretty

# 从 stdin 读入（bash / Git Bash / WSL）
cat mytable.json | node src/cli.js

# 从 stdin 读入（Windows PowerShell：必须带 -Raw 与 utf8，否则中文按 ANSI 解码导致 JSON 解析失败）
Get-Content -Raw -Encoding utf8 mytable.json | node src/cli.js

# 先取输入契约（JSON Schema）
node src/cli.js --schema

# 校验失败时退出码 2，可供流水线判定
node src/cli.js --in mytable.json --strict

# 把生成的 DDL 保存到本地
node src/cli.js --in mytable.json --ddl-out out/emp.sql
```

最小可用载荷（只有一个字段，无主键、无索引）：

```json
{
  "db": "oracle",
  "schema": "scott",
  "table": "log1",
  "tableDesc": "日志表",
  "fields": [{ "name": "msg", "desc": "消息", "type": "字符型", "length": 2000 }]
}
```

更多载荷见 `tests/fixtures/ok-*.json`；完整契约（字段表、错误码、输出形状、退出码）见
[docs/AI接口契约.md](docs/AI接口契约.md)。

退出码口径：

| 退出码 | 含义 |
|---|---|
| `0` | 已产出结果对象（**校验失败也是 0**，结果对象本身就是答案） |
| `1` | 无法产出结果对象：文件读不到、stdin 为空、JSON 解析失败、用法错误、`--out` 写不进去 |
| `2` | 仅 `--strict` 且业务校验未通过（优先于 3） |
| `3` | 结果对象已产出，但 `--ddl-out` 未落盘（草稿被拒 / `--no-draft` / 写盘失败） |

### 3. 浏览器内自动化

页面内联了同一个引擎，暴露两个对象：

```js
window.Core.version                 // "2.2.0"
window.ctdutil.getData()            // 当前界面数据（深拷贝）
window.ctdutil.setData(payload)     // 灌入数据并回到第一步
window.ctdutil.generate(payload)    // 同 Core.generate
window.ctdutil.goToStep(5)          // 跳步（不触发校验）
window.ctdutil.validateAll()        // 当前数据的全部错误
```

## 生成结果示例

`node src/cli.js --in tests/fixtures/ok-oracle.json` 的 `ddl` 字段：

```sql
create table scott.emp (
    emp_no varchar2(20),
    emp_name varchar2(50),
    sal number(10,2),
    age integer,
    hire_date date,
    created_at timestamp
);

comment on table scott.emp is '员工信息表';
comment on column scott.emp.emp_no is '员工编号';
comment on column scott.emp.emp_name is '员工姓名''含单引号';
comment on column scott.emp.sal is '薪资';
comment on column scott.emp.age is '年龄';
comment on column scott.emp.hire_date is '入职日期';
comment on column scott.emp.created_at is '创建时间';

alter table scott.emp add constraint pk_emp primary key (emp_no, emp_name);

create index idx_emp_01 on scott.emp (emp_name, hire_date);

create unique index idx_emp_02 on scott.emp (sal);
```

MySQL 分支的注释改为内联写法（`comment '...'` 与 `) comment = '...'`），其余结构相同。
H2 分支给主键列显式写 `not null`（H2 拒绝在可空列上 `add primary key`）。

## 项目结构

```text
ctdutil/
├── index.html                # 交付物：单文件工具页面（由模板 + 引擎生成，勿手改）
├── jquery.min.js             # jQuery 3.7.1（本地引用，离线可用）
├── package.json              # 元数据与脚本入口；无任何依赖
├── README.md                 # 本文件
├── LICENSE                   # MIT 许可
├── 技术方案.md                # 架构、交互、校验规则、DDL 生成设计
├── 开发记录.md                # 按时间顺序的开发、测试与问题修复记录
├── src/
│   ├── core.js               # 唯一权威实现：纯函数引擎（Node + 浏览器同源）
│   ├── cli.js                # 命令行操作面：JSON in → JSON out + 退出码口径
│   ├── build.mjs             # 生成 index.html（内联 core.js）+ 漂移检查
│   └── index.template.html   # 界面模板（DOM 读写 + jQuery，业务规则一律调 Core）
├── tests/
│   ├── run.js                # 测试总入口（断言总数 / 空转自证）
│   ├── harness.js            # 极简断言器（零依赖）
│   ├── test-core.js          # 引擎：规范化、校验、类型映射、命名联动、幂等
│   ├── test-excel.js         # Excel 导出与 Sheet 命名规则
│   ├── test-schema.js        # 契约：JSON Schema 可校验、错误码双向齐平
│   ├── test-embedded.js      # 内联与漂移、HTML 截断守卫、历史缺陷静态守卫
│   ├── test-cli.js           # CLI 端到端（退出码 + 结果对象）
│   ├── ui-wiring.js          # 交付文件本体：脚本语法、选择器接线、控件在位、离线可用
│   ├── fixtures/             # ok-*.json（合法载荷）、invalid-cases.json（校验用例）
│   └── golden/               # ddl-*.sql（逐字符比对的 DDL 基准）
└── docs/
    └── AI接口契约.md          # 输入 / 输出 / 错误码 / 退出码契约
```

## 开发

环境：Node.js >= 18（本机实测 v24.19.0）。**不需要 `npm install`**，项目零依赖。

```bash
node tests/run.js             # 全部测试（6 个文件 / 520 条断言）
node tests/run.js core cli    # 只跑指定模块
node src/build.mjs            # 重新生成 index.html
node src/build.mjs --check    # 只检查生成物是否与源文件一致（漂移检查）
```

`package.json` 里的脚本是等价入口：`npm test` / `npm run build` / `npm run check`。
`npm run cli` 只是 `node src/cli.js` 的别名，参数要自己追加（如 `npm run cli -- --in mytable.json`）。
无可用 npm 环境时直接跑 `node` 命令即可。

当前基线（2026-10-25 在本仓库实测）：`node tests/run.js` → 6 文件 / 520 条断言 / 0 失败；
`node src/build.mjs --check` → `index.html` 与「模板 + `src/core.js`」逐字节一致。

### 改代码流程

1. 业务规则改 `src/core.js`；界面改 `src/index.template.html`。
2. 跑 `node src/build.mjs` 重新生成 `index.html`。
3. 跑 `node tests/run.js`，必须全绿。

`index.html` 是**生成物**：直接手改会让漂移断言变红。这不是误报，请改源文件后重建。

### 设计要点

- **业务规则只有一份实现**：`src/core.js`。界面只做 DOM 读写，CLI 只做 I/O，两边都调它。
- **零依赖**：测试用 Node 内置能力 + 自写断言器（`tests/harness.js`），离线与受限环境都能跑。
- **契约可执行**：错误码、JSON Schema、退出码、golden DDL 都有自动化断言钉死；
  改了引擎不同步文档或用例，测试会变红。
- **历史缺陷有守卫**：页面不再出现 `$.trim`、`.show()`、`.hide()`（这三者都曾造成真实缺陷），由静态断言守住。

## 文档

| 文档 | 内容 |
|---|---|
| [技术方案.md](技术方案.md) | 架构总览、页面交互、数据模型、校验规则、DDL 生成、测试策略 |
| [docs/AI接口契约.md](docs/AI接口契约.md) | 输入契约、输出契约、错误码表、退出码口径、浏览器内入口 |
| [开发记录.md](开发记录.md) | 按时间顺序的需求变更、缺陷根因与修复、验证证据、遗留事项 |

## 已知边界

- **真实 MySQL 引擎执行未验证**：本机无 mysqld / docker。现有证据是 MySQL 方言解析器接受整份脚本，
  加上 MySQL 8.0 手册的依据。建议在有 MySQL 的环境里执行一次生成的 DDL。
- **真实浏览器交互未自动化**：本机无可用无头浏览器。DOM 事件链、Blob 下载、剪贴板降级由静态守卫
  （选择器接线、控件在位、脚本语法、HTML 截断守卫）加人工走查兜底。
- **数据仅存内存**：界面数据刷新即失；需要持久化时由调用方使用 JSON 载荷自行存取。
- **索引空值语义未建模**：不涉及「NULL 也算唯一」这类策略。

## 许可

本项目采用 [MIT 许可](LICENSE)。

Copyright (c) 2026 ctdutil contributors
