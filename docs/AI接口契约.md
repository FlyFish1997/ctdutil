# ctdutil AI 接口契约

> 版本：v2.2.0（与 `src/core.js` 的 `Core.VERSION` 同步）
> 本文件是**契约**，不是说明文。契约 = 文档 + 共享类型（`Core.jsonSchema()`）+ 可执行一致性检查
> （`tests/test-schema.js`：Schema 必须能校验全部 fixtures，且**本文列出的错误码与引擎可产出的错误码必须双向齐平**）。

---

## 1. 一分钟上手

```bash
# 生成（从文件读入，结果 JSON 写 stdout）
node src/cli.js --in mytable.json --pretty

# 从 stdin 读入
cat mytable.json | node src/cli.js

# 让程序先拿到输入契约（JSON Schema）
node src/cli.js --schema

# 只要退出码可用于流水线判定（校验不过 = 退出码 2）
node src/cli.js --in mytable.json --strict

# AI 场景：把最后一步生成的 DDL 保存到本地文件
node src/cli.js --in mytable.json --ddl-out out/emp.sql
```

界面之外的三个操作面，业务规则**只有一份实现**（`src/core.js`）：

| 操作面 | 入口 | 适合谁 |
|---|---|---|
| 人类界面 | 双击 `index.html` | 手工登记 |
| 程序 / AI | `node src/cli.js`（JSON in / JSON out） | Agent、脚本、CI |
| 浏览器内自动化 | `window.Core`、`window.ctdutil` | 页面内调试、端到端脚本 |

---

## 2. 输入契约

输入是一个 JSON 对象。**宽容化规则**：所有计数类字段（`length` / `precision` / `scale`）既接受字符串也接受数字；
`db` 大小写不敏感；字符串首尾空格自动去除；`type` 缺省时按 `字符型` 处理。

**各目标库的映射与注释语法**（`h2` 指 H2 常规/文件模式）：

| db | 字符型 | 数值型 | 整型 | 日期型 | 时间戳 | 表/列注释 |
|---|---|---|---|---|---|---|
| `oracle` | `varchar2(n)` | `number(p,s)` | `integer` | `date` | `timestamp` | `comment on table/column ... is '...'` |
| `gauss` | `varchar2(n)` | `numeric(p,s)` | `integer` | `date` | `timestamp` | 同上 |
| `mysql` | `varchar(n)` | `decimal(p,s)` | `int` | `date` | `datetime` | 列上内联 `comment '...'`、表尾 `) comment = '...'` |
| `h2` | `varchar(n)` | `numeric(p,s)` | `int` | `date` | `timestamp` | `comment on table/column ... is '...'` |

> MySQL 没有 `comment on` 语句，故单独一条注释分支；`h2` 的主键列会在建表时写成 `... not null`
> （实测 H2 拒绝在可空列上 `add primary key`），其余库输出形态不变。
>
> **索引两种形态四库写法完全一致**（无需按库分支）：普通索引 `create index <名> on <schema>.<表> (...)`，
> 唯一索引 `create unique index <名> on <schema>.<表> (...)` —— 由 `indexes[].unique` 决定。

字段清单：

| 字段 | 类型 | 必填 | 说明 |
|---|---|---|---|
| `db` | `"oracle"` \| `"gauss"` \| `"mysql"` \| `"h2"` | 是 | 决定类型映射与注释语法，见上表 |
| `schema` | string | 是 | 标识符：`^[A-Za-z_][A-Za-z0-9_]*$`；MySQL 中它即 database 名 |
| `table` | string | 是 | 同上；DDL 中统一转小写 |
| `tableDesc` | string | 是 | 生成表注释（MySQL 为表尾 `) comment = '...'`）；单引号自动转义为 `''` |
| `fields` | array | 是 | 至少 1 项 |
| `fields[].name` | string | 是 | 标识符；**同一表内大小写不敏感去重** |
| `fields[].desc` | string | 是 | 生成 `comment on column`（MySQL 则为列内联 `comment '...'`） |
| `fields[].type` | `"字符型"` \| `"数值型"` \| `"整型"` \| `"日期型"` \| `"时间戳"` | 是 | 缺省 `字符型` |
| `fields[].length` | string \| number | 字符型必填 | 正整数 |
| `fields[].precision` | string \| number | 数值型必填 | 正整数 |
| `fields[].scale` | string \| number | 数值型必填 | 非负整数，且 **必须小于 `precision`** |
| `pk` | object | 否 | `{ name, fields[] }`；`fields` 为空 = 无主键（合法） |
| `pk.name` | string | 有主键字段时必填 | 通常留空由引擎派生 `pk_` + 小写表名 |
| `pk.fields` | string[] | 否 | 必须是已定义字段名；不得重复 |
| `indexes` | array | 否 | 最多 **10** 个；空数组合法 |
| `indexes[].name` | string | 是（可由引擎派生） | 标识符；**索引之间**不得重名（大小写不敏感） |
| `indexes[].nameAuto` | boolean | 否 | 默认 `true`：未给 `name` 时派生 `idx_` + 小写表名 + `_序号`（序号从 `01` 起） |
| `indexes[].unique` | boolean | 否 | 默认 `false`（普通索引）。为 `true` 时生成 `create unique index`；**只认布尔 `true`**，`"true"`/`1` 按普通索引处理（与 `nameAuto` 同一宽容化口径） |
| `indexes[].fields` | string[] | 是 | 至少 1 个、最多 **10** 个；**顺序即索引列顺序**；其集合不得与主键字段集合完全相同 |

**最小可用载荷**（只有一个字段，无主键、无索引）：

```json
{
  "db": "oracle",
  "schema": "scott",
  "table": "log1",
  "tableDesc": "日志表",
  "fields": [{ "name": "msg", "desc": "消息", "type": "字符型", "length": 2000 }]
}
```

机器可读版本：`node src/cli.js --schema`（JSON Schema 2020-12）。

---

## 3. 输出契约

结果对象固定为如下形状（成功与失败**同形状**，便于程序无分支取值）：

```json
{
  "ok": true,
  "version": "2.2.0",
  "errors": [],
  "warnings": [],
  "data": { "db": "oracle", "schema": "scott", "table": "emp", "tableDesc": "员工信息表",
            "fields": [], "pk": { "name": "pk_emp", "fields": [] }, "indexes": [] },
  "ddl": "create table scott.emp (\n ...",
  "excel": { "fileName": "表结构设计_scott_emp.xls",
             "mimeType": "application/vnd.ms-excel;charset=utf-8",
             "content": "\ufeff<?xml ...", "bom": true },
  "generatedAt": "2026-09-15T17:26:07.185Z",
  "input": { "source": "D:\\...\\mytable.json" },
  "ddlOut": { "path": "D:\\...\\out\\emp.sql", "written": true, "draft": false, "reason": null }
}
```

| 字段 | 说明 |
|---|---|
| `ok` | 是否通过全部校验 |
| `errors` | 错误数组，**一次全报、按步骤排序**；每项 `{ code, message }`，部分带 `step` / `field` / `index` 定位 |
| `warnings` | 校验失败时含 `W_DRAFT`，提醒 `data`/`ddl` 只是草稿、不可作为交付结果 |
| `data` | 规范化后的数据（数值字段一律字符串；主键名已派生）。失败时仍返回，仅供定位 |
| `ddl` | 生成的 DDL 字符串；`--no-draft` 且校验失败时为 `null` |
| `excel` | 仅当 `includeExcel` 为真时返回：文件名、MIME、含 BOM 的完整 XML 文本（字段定义含「数据类型」列，如 `varchar2(20)`/`decimal(10,2)`） |
| `generatedAt` | 成功时为 ISO 时间；**失败时为 `null`**（避免把草稿误当交付物） |
| `input.source` | CLI 追加：输入来源绝对路径或 `<stdin>` |
| `ddlOut` | **仅当 CLI 给出 `--ddl-out` 时追加**：`{ path, written, draft, reason }`；`reason ∈ null / "draft-refused" / "ddl-null" / "write-failed"`。不指定该选项时本字段不出现（保持历史 payload 形状） |

**程序侧判定纪律**：以 `ok` / `errors[].code` 判定，**不要解析 `message` 文本**（文案可能微调，code 稳定）。

### 错误码表

| code | 触发条件 |
|---|---|
| `E_INPUT_SHAPE` | 顶层不是对象、`fields`/`indexes` 不是数组、数组元素不是对象 |
| `E_DB_INVALID` | `db` 不是 `oracle`/`gauss`/`mysql`/`h2` |
| `E_DB_REQUIRED` | 未选择数据库 |
| `E_TYPE_INVALID` | `type` 不在五种类型内 |
| `E_SCHEMA_REQUIRED` | Schema 为空 |
| `E_SCHEMA_INVALID` | Schema 不是合法标识符 |
| `E_TABLE_REQUIRED` | 表名为空 |
| `E_TABLE_INVALID` | 表名不是合法标识符 |
| `E_TABLE_DESC_REQUIRED` | 表描述为空 |
| `E_FIELD_EMPTY` | 一个字段都没有 |
| `E_FIELD_NAME_REQUIRED` | 字段名为空 |
| `E_FIELD_NAME_INVALID` | 字段名不是合法标识符 |
| `E_FIELD_NAME_DUP` | 字段名重复（大小写不敏感） |
| `E_FIELD_DESC_REQUIRED` | 字段描述为空 |
| `E_FIELD_LENGTH_REQUIRED` | 字符型未填长度 |
| `E_FIELD_LENGTH_INVALID` | 长度不是正整数 |
| `E_FIELD_PRECISION_REQUIRED` | 数值型未填精度 |
| `E_FIELD_PRECISION_INVALID` | 精度不是正整数 |
| `E_FIELD_SCALE_REQUIRED` | 数值型未填小数位数 |
| `E_FIELD_SCALE_INVALID` | 小数位数不是非负整数 |
| `E_FIELD_SCALE_GE_PRECISION` | 小数位数 ≥ 精度 |
| `E_PK_NAME_REQUIRED` | 勾选了主键字段但主键名为空 |
| `E_PK_NAME_INVALID` | 主键名不是合法标识符 |
| `E_PK_FIELD_UNKNOWN` | 主键引用了不存在的字段 |
| `E_PK_FIELD_DUP` | 主键字段重复 |
| `E_INDEX_COUNT_EXCEED` | 索引数超过 10 |
| `E_INDEX_FIELDS_REQUIRED` | 索引未选择字段 |
| `E_INDEX_FIELDS_EXCEED` | 单个索引字段数超过 10 |
| `E_INDEX_NAME_REQUIRED` | 索引名为空 |
| `E_INDEX_NAME_INVALID` | 索引名不是合法标识符 |
| `E_INDEX_NAME_DUP` | 索引名与其他索引重复 |
| `E_INDEX_EQUALS_PK` | 索引字段集合与主键字段集合完全相同（与顺序无关） |

---

## 4. 退出码口径（CLI）

| 退出码 | 含义 |
|---|---|
| `0` | 已产出结果对象。**校验失败也是 0**——结果对象本身就是答案（AI 可直接读 `errors` 继续迭代）；指定 `--ddl-out` 时 DDL 也已落盘 |
| `1` | 无法产出结果对象：输入文件读不到、stdin 为空、JSON 解析失败、参数用法错误、`--out` 写不进去 |
| `2` | 仅在显式 `--strict` 且业务校验未通过时（供 CI/流水线把校验失败当硬失败）。**优先于 3** |
| `3` | 结果对象已产出，但 `--ddl-out` 未落盘：草稿被拒（未加 `--allow-draft`）、`--no-draft` 使 `ddl` 为 `null`、或写盘失败。**结果对象仍完整写 stdout**，AI 可读 `errors` 继续迭代 |

复现命令：

```bash
node src/cli.js --in tests/fixtures/ok-oracle.json          # → 0
node src/cli.js --in tests/fixtures/invalid-cases.json      # 合法 JSON，但对象不是载荷 → 仍产出 payload
printf '{ bad json' | node src/cli.js                        # → 1
printf '{"db":"oracle","schema":"s","table":"t","tableDesc":"d","fields":[]}' | node src/cli.js --strict   # → 2

# --ddl-out：成功 → 0，且 payload.ddlOut.written=true
node src/cli.js --in tests/fixtures/ok-mysql.json --ddl-out out/order.sql
# 校验未通过 + 未加 --allow-draft → 3，且不创建文件
printf '{"db":"h2","schema":"public","table":"t","tableDesc":"d","fields":[]}' | node src/cli.js --ddl-out out/t.sql; echo $?
# 同上 + --allow-draft → 0，写出草稿并在 stderr 标注
printf '{"db":"h2","schema":"public","table":"t","tableDesc":"d","fields":[]}' | node src/cli.js --ddl-out out/t.sql --allow-draft; echo $?
```

### 4.1 `--ddl-out`：AI 场景把最后一步的 DDL 保存到本地

| 选项 | 说明 |
|---|---|
| `--ddl-out <file>` | 把 `result.ddl` 写入本地文件。**文件内容与 `payload.ddl` 逐字节一致**（UTF-8、无 BOM、不追加额外换行） |
| `--allow-draft` | 校验未通过时也允许写出草稿 DDL。**默认拒绝**——磁盘上留下语法不完整的 `.sql` 极易被误当交付物 |

纪律与回执：

- 落盘结果写在 `payload.ddlOut = { path, written, draft, reason }`，`reason` 取值
  `null`（成功）/ `"draft-refused"` / `"ddl-null"` / `"write-failed"`；
- 不指定 `--ddl-out` 时结果对象**完全不变**（不新增字段），历史调用方不受影响；
- 草稿被拒时**不创建空文件**；`--ddl-out` 不自动建目录，目录不存在会以退出码 3 报 `write-failed`。

---

## 5. 浏览器内入口

`index.html` 内联同一份引擎并暴露两个对象：

- `window.Core`：纯引擎，等同于 `require('src/core.js')`，含 `generate/validate/normalizeInput/buildDdl/buildExcel/jsonSchema`；
- `window.ctdutil`：薄封装，供端到端脚本读写界面状态：

```js
window.ctdutil.version                 // "2.2.0"
window.ctdutil.getData()               // 当前界面数据（深拷贝）
window.ctdutil.setData(payload)        // 灌入数据并回到第一步
window.ctdutil.generate(payload, opts) // 同 Core.generate（payload 省略则用当前界面数据）
window.ctdutil.goToStep(5)             // 跳步（不触发校验）
window.ctdutil.validateAll()           // 当前数据的全部错误
```

界面上第一步提供 **4 张目标库卡片**（Oracle / GaussDB / MySQL / H2（文件模式）），与 `Core.DB_LIST` 一一对应；
`window.ctdutil.setData({ db: 'mysql', ... })` 同样能把对应卡片选中。

---

## 6. 一致性检查（可执行的部分）

```bash
node tests/run.js          # 全部自测；另有静态守卫：index.html 必须与 src/core.js 逐字节同步
node src/build.mjs --check # 只跑「生成漂移」检查
```

本契约中六处会被自动检查：

1. `node src/cli.js --schema` 的枚举/上限必须与引擎常量一致（`tests/test-schema.js`）；
2. 上表每个错误码都必须在 `tests/fixtures/invalid-cases.json` 有对应用例，且用例中的码也必须在上表内；
3. `index.html` 必须内联 `src/core.js` 且逐字节一致，否则测试变红；
4. `DB_LIST` / `DB_LABEL` / `DB_COMMENT_STYLE` 三者必须齐平，且每个库都要有明确的注释语法分族（`tests/test-core.js`）；
5. CLI 退出码 0/1/2/3 与「草稿默认不落盘、`--allow-draft` 才落盘」由 `tests/test-cli.js` 端到端钉死；
6. `indexes[].unique` 的 DDL 分支（`create index` / `create unique index`）由 `tests/test-core.js` 的
   「四库矩阵」与 `tests/golden/ddl-ok-*.sql` 双向钉死，Schema 侧断言其为 boolean。
