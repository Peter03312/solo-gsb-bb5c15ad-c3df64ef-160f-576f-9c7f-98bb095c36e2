# 字幕校订台 · 多人协作 SRT 校订 Web 应用

面向小型放映团队的浏览器字幕校订工具：上传 **UTF-8 编码的 SRT**，按时间轴逐段
校订起止时间与多行文字，多人同时修改时用**作品修订号（乐观锁）**防止互相覆盖，
随时导出重新编号的标准 SRT。

技术栈：Node.js（Express）+ SQLite（sql.js / WebAssembly）+ 原生浏览器界面，
无前端构建步骤。

---

## 功能一览

- **上传校验**：严格按行解析 UTF-8 SRT（支持 CRLF、BOM、逗号或点号毫秒分隔）。
  序号、时间轴格式、时间合法性（非负、结束晚于开始）、**同作品字幕段不得交叠**
  全部通过后才入库；任何一项失败都会返回**出错行号**，且**整份文件不入库**。
- **逐段校订**：按时间顺序展示全部字幕段，可修改开始/结束时间与多行文字，
  行内换行完整保留。
- **批量时间轴平移**：勾选同一作品的若干字幕段，输入有符号整数毫秒偏移量
  （如 `-500`、`1200`），先**预览**每段调整前后的时间、碰撞对象与负起点；
  确认时携带预览所依据的作品修订号，整批在同一事务内同量平移（文字与段标识
  不变）、修订号只增加一次并自动重排展示序号。
- **多人并发保护**：每次保存携带作品修订号。修订号过期时服务器**拒绝覆盖**，
  返回 `409`、最新修订号以及目标字幕段的最新内容；界面就地展示服务器版本，
  校订人人工对照合并后再保存。批量确认同样按修订号乐观锁：预览后作品被他人
  改动则拒绝写入并返回最新修订号，不能按过期预览落库。
- **候选修改待审区**：多人校订时，单段修改可以先作为**候选提案**提交到待审区
  （携带页面所见修订号与说明；号已过期或内容非法直接拒绝、不生成提案）。
  提案冻结原段时间与文字快照，**不改变正式段、作品修订号或 SRT 导出**。
  审阅人并列对照「原值 / 候选值 / 当前正式值」后逐条**采纳**或**驳回**：
  采纳在同一事务内确认目标段仍与快照一致、并重查非负时间/结束晚于开始/
  不与其他段交叠，成功后写入正式段、修订号 +1、重排序号；其他段的修改不阻止
  采纳，目标已变或会交叠时提案保留待审并返回当前段与冲突原因。驳回只结案，
  已结案提案不可再次处理。
- **时间约束**：结束必须晚于开始（时间不可为负），新时间段与同作品其他字幕段
  不得交叠（相邻段首尾相接允许）。批量平移时任一新起点为负、选中段彼此或与
  未选段交叠，都**整批拒绝**并指出原因与相关段；违例保存不推进修订号。
- **离线校订包**：校订人员可把作品字幕下载为离线校订包（JSON，含作品标识、
  包标识、稳定段 ID、可编辑起止时间与多行文字），服务端在发包时留存各段基线。
  离线改完回传后**先预览**：逐段对照基线/离线候选/当前正式值，标出改过与未改段、
  目标段发包后已变或缺失、以及整批应用后的负时间、无效区间与交叠。**确认时**
  服务器在同一事务内按最新正式段重新核对：只写入相对基线改过的段（未改段即使
  服务器后来变化也不覆盖），任一冲突或违例则**整包不写**并返回段 ID 与原因、
  包仍可重新预览；成功才一次性推进作品修订号、重排展示序号并把包标记为已使用
  （重复确认拒绝）。无效包、跨作品包、路径与包内标识不一致、字段非法都明确
  拒绝且不写入。
- **导出标准 SRT**：按开始时间重新从 1 连续编号，文字多行换行原样保留，
  输出带 UTF-8 BOM 的标准 SRT 文件。

## 一键启动（Docker Compose）

需要 Docker 20.10+ 与 Docker Compose v2。

```bash
docker compose up -d --build
```

该命令会：

1. 构建镜像并在镜像内 `npm install`（安装依赖）；
2. 首次启动时应用自动创建 SQLite 数据库与全部表（初始化存储）；
3. 以后台方式启动服务，并随 Docker 自动重启。

访问地址：

- 本机：<http://localhost:3000>
- 局域网：`http://<本机 IP>:3000`

停止 / 查看日志：

```bash
docker compose down        # 停止（数据保留在命名卷 srt-data 中）
docker compose logs -f     # 跟踪日志
```

## 配置

所有配置通过环境变量传入，修改后执行 `docker compose up -d` 生效。

| 变量 | 默认值 | 说明 |
| --- | --- | --- |
| `HOST_PORT` | `3000` | 宿主机映射端口。例如 `HOST_PORT=8080 docker compose up -d --build` 后访问 <http://localhost:8080> |
| `PORT` | `3000` | 容器内监听端口，一般无需修改（改动需同步调整 compose 端口映射右侧） |
| `DB_PATH` | `/data/subtitles.db` | 容器内数据库文件路径，位于持久化卷中 |

数据保存在 Docker 命名卷 `srt-data`（挂载于容器 `/data`）。
如希望直接映射到宿主机目录，可把 `docker-compose.yml` 中的

```yaml
volumes:
  - srt-data:/data
```

改为

```yaml
volumes:
  - ./data:/data
```

> 存储说明：SQLite 通过 sql.js（WebAssembly）运行，每次写事务提交后把数据库
> 原子快照写回磁盘（先写临时文件再 rename）。对放映团队这种几十至几千段字幕、
> 少量并发校订的场景完全够用；读取始终在内存中完成，速度很快。

## 不用 Docker 的本地运行

需要 Node.js 18+。

```bash
npm install
npm start
```

默认数据库写到项目下 `data/subtitles.db`，访问 <http://localhost:3000>。
可用环境变量覆盖：

```bash
PORT=8080 DB_PATH=/var/lib/srt/sub.db npm start
```

## 运行测试

测试使用内存数据库，不产生任何文件：

```bash
npm test
```

覆盖：SRT 解析各类非法输入与行号定位、多行文字、交叠检测、整份不入库、
乐观锁 409 冲突（含并发双写）、时间/交叠拒绝不推进修订号、批量平移预览
（负起点/交叠/首尾相接）、批量确认单事务重算与重排、过期预览 409、
候选提案提交（过期/非法不生成提案）、采纳（快照一致校验、交叠复查、
重排序号、目标已变/交叠冲突保留待审）、驳回结案与结案后不可再处理、
离线校订包（包格式校验、发包基线、逐段差异预览、未改段不覆盖、目标已变/
缺失冲突、负时间/无效区间/交叠整批拒绝、确认单事务核对、修订号推进与重排、
包标记已用与重复确认拒绝、无效包/跨作品包拒绝）、导出重新编号与换行保留、
重启持久化等 60 个用例。

## HTTP 接口摘要

| 方法 | 路径 | 说明 |
| --- | --- | --- |
| `GET` | `/api/works` | 作品列表（含段数、修订号） |
| `POST` | `/api/works` | 上传 SRT：`{title, filename, content}`；失败返回 `422 {error:"invalid_srt", line, message}`，不入库 |
| `GET` | `/api/works/:id` | 作品详情与按时间排序的字幕段 |
| `PUT` | `/api/works/:id/cues/:cueId` | 保存单段：`{revision, start, end, text, editor?}`；修订号过期返回 `409 {latest_revision, cue}`，时间/交叠非法返回 `422` |
| `POST` | `/api/works/:id/cues/:cueId/proposals` | 提交候选修改到待审区：`{revision, start, end, text, note?, editor?}`；过期 `409`、非法 `400/422`，均不生成提案 |
| `GET` | `/api/works/:id/proposals` | 待审区列表（`?status=pending/accepted/rejected/all`），每条含原值快照、候选值、当前正式值 |
| `POST` | `/api/works/:id/proposals/:pid/accept` | 采纳候选：`{editor?}`；成功写入正式段、修订号 +1、重排序号；冲突 `409 {reason, cue}` 保留待审，已结案 `409 proposal_closed` |
| `POST` | `/api/works/:id/proposals/:pid/reject` | 驳回候选：`{editor?}`；只结案，不动正式段与修订号；已结案 `409 proposal_closed` |
| `POST` | `/api/works/:id/cues/shift/preview` | 批量平移预览（不写库），见下 |
| `POST` | `/api/works/:id/cues/shift` | 确认批量平移：同事务重算应用、修订号 +1、重排展示序号；过期 `409 {latest_revision}`，非法 `422 {issues, cues}` |
| `POST` | `/api/works/:id/review-packages` | 生成离线校订包：留存各段基线，返回包元数据与可保存的 JSON 文件内容；不推进修订号 |
| `GET` | `/api/works/:id/review-packages?status=issued\|used\|all` | 本作品发包记录（含已用/未用状态、基线修订号、段数） |
| `GET` | `/api/works/:id/review-packages/:uid/file` | 下载校订包文件（`<标题>.review.json`）；跨作品访问 `400 cross_work_package` |
| `POST` | `/api/works/:id/review-packages/preview` | 导入预览：`{content}`，逐段差异 + 冲突 + 整批违例，不写库 |
| `POST` | `/api/works/:id/review-packages/:uid/apply` | 确认应用：单事务按最新正式段核对；成功推进修订号/重排/标记已用，冲突 `409 review_conflict`，重复确认 `409 package_used` |
| `GET` | `/api/works/:id/export` | 下载按时间重新编号的标准 SRT |
| `DELETE` | `/api/works/:id` | 删除作品及其全部字幕段 |

## 批量时间轴平移 API

两个接口的请求体相同：

```json
{
  "revision": 4,
  "cue_ids": [12, 15, 18],
  "offset_ms": -500,
  "editor": "阿校对"
}
```

- `revision`（必填）：作品修订号正整数。
- `cue_ids`（必填）：非空、无重复的字幕段 ID 数组；段不存在或不属于该作品
  返回 `404 cue_not_found` 并附 `cue_ids`；空数组 `400 empty_selection`；
  重复 `400 duplicate_cue`。
- `offset_ms`（必填）：有符号**整数**毫秒偏移。数字或整数字符串均可
  （`-500`、`"1200"`、`0`）；小数（`1.5`）、非数字均返回 `400 invalid_offset`。
- `editor`（仅确认接口，选填）：校订人署名，随修订记录保存。

### 1) 预览 `POST /api/works/:id/cues/shift/preview`

只推演不写库，返回预览所依据的修订号 `expected_revision`、每段调整前后的
时间（毫秒与 `HH:MM:SS,mmm`）、碰撞对象列表，以及全部违例：

```bash
curl -X POST http://localhost:3000/api/works/1/cues/shift/preview \
  -H 'Content-Type: application/json' \
  -d '{"revision":1,"cue_ids":[2],"offset_ms":2500}'
```

假设作品当前为 #1 1s–2s、#2 3s–4s、#3 5s–7s、#4 9s–10s，#2 平移 2500ms 后
变为 5.5s–6.5s，与原地的 #3 交叠，返回：

```json
{
  "revision": 1,
  "expected_revision": 1,
  "stale": false,
  "offset_ms": 2500,
  "cue_ids": [2],
  "valid": false,
  "issues": [
    {
      "type": "overlap",
      "cue_ids": [2, 3],
      "cues": [{"id": 2, "idx": 2}, {"id": 3, "idx": 3}],
      "message": "展示序号 #2（段 ID 2）调整为 00:00:05,500 --> 00:00:06,500 后，与 1 个字幕段交叠：#3（首尾相接不算交叠）"
    }
  ],
  "cues": [
    {
      "id": 2, "idx": 2,
      "start": "00:00:03,000", "end": "00:00:04,000",
      "new_start": "00:00:05,500", "new_end": "00:00:06,500",
      "start_ms": 3000, "end_ms": 4000,
      "new_start_ms": 5500, "new_end_ms": 6500,
      "negative_start": false, "out_of_range": false,
      "collisions": [
        {"id": 3, "idx": 3, "start": "00:00:05,000", "end": "00:00:07,000", "selected": false}
      ]
    }
  ]
}
```

若 #2 只平移 1000ms（变为 4s–5s，新终点正好等于 #3 起点 5s，首尾相接），则
`valid: true`、`issues` 与 `collisions` 均为空数组。

`issues[].type` 为 `negative_start`（新起点为负）、`overlap`（交叠）或
`time_out_of_range`（超出可表示范围）。`valid: true` 时 `issues` 为空数组，
`cues[].collisions` 也为空。

### 2) 确认 `POST /api/works/:id/cues/shift`

必须携带**预览返回的 `expected_revision`**。服务器在同一事务内：校验修订号 →
重算全部时间（负起点/交叠则回滚）→ 更新选中段 → 修订号 +1 → 重排全部展示
序号。文字与段 ID 不变。

```bash
curl -X POST http://localhost:3000/api/works/1/cues/shift \
  -H 'Content-Type: application/json' \
  -d '{"revision":1,"cue_ids":[2,3],"offset_ms":-500,"editor":"阿校对"}'
```

成功返回新修订号与按新时间重排的全部字幕段：

```json
{ "revision": 2, "offset_ms": -500, "shifted_count": 2, "cues": [ /* 全部段，idx 已重排 */ ] }
```

- 作品在预览后被他人改动：`409 {"error":"revision_stale","latest_revision":N}`，
  本次不写入；请重新 `GET` 作品、重新预览后携带 N 确认。
- 会产生负起点或交叠：`422 {"error":"shift_rejected","issues":[...],"cues":[...]}`，
  整批回滚、修订号不变。

随后 `GET /api/works/:id/export` 导出的 SRT 自动按新时间排序、从 1 连续编号。

## 候选修改待审区 API

多人校订时，单段修改可以不直接落正式段，而是先提交为**候选提案**进入待审区，
由审阅人逐条采纳或驳回。提案状态机：`pending` →（采纳）`accepted` /
（驳回）`rejected`；结案后不可再次处理。

### 1) 提交候选 `POST /api/works/:id/cues/:cueId/proposals`

```bash
curl -X POST http://localhost:3000/api/works/1/cues/12/proposals \
  -H 'Content-Type: application/json' \
  -d '{"revision":4,"start":"00:00:04,500","end":"00:00:04,700",
       "text":"甲改\n第二行","note":"标点与断行建议","editor":"小提交"}'
```

- `revision`（必填）：**页面所见作品修订号**。与服务器当前不一致时返回
  `409 {"error":"revision_stale","latest_revision":N,"cue":{...}}`，不生成提案。
- `start` / `end` / `text`：候选起止时间与多行文字，校验规则与单段保存相同
  （格式 `400 invalid_time`、结束不晚于开始 `422 invalid_range`、空文字
  `400 invalid_text`、与其他段交叠 `422 overlap`），任何一项非法都拒绝且
  不生成提案。
- `note`（选填，≤1000 字）：给审阅人的说明；`editor`（选填，≤80 字）：提交者署名。

成功返回 `201`，提案冻结**原段时间与文字快照**（`snapshot`）与候选值
（`candidate`），正式段、作品修订号、SRT 导出均不受影响：

```json
{
  "proposal": {
    "id": 1, "cue_id": 12, "status": "pending", "base_revision": 4,
    "editor": "小提交", "note": "标点与断行建议",
    "snapshot":  {"start": "00:00:01,000", "end": "00:00:02,000", "text": "甲", "start_ms": 1000, "end_ms": 2000},
    "candidate": {"start": "00:00:04,500", "end": "00:00:04,700", "text": "甲改\n第二行", "start_ms": 4500, "end_ms": 4700},
    "current":   {"id": 12, "idx": 1, "start": "00:00:01,000", "end": "00:00:02,000", "text": "甲"},
    "changed": false
  }
}
```

### 2) 待审区列表 `GET /api/works/:id/proposals?status=pending`

`status` 可取 `pending` / `accepted` / `rejected` / `all`（缺省为 `all`，
其他值 `400 invalid_status`）。每条提案并列返回 `snapshot`（原值）、
`candidate`（候选值）、`current`（当前正式值），`changed: true` 表示当前
正式值已偏离提交时快照（此时采纳会被拒绝）。响应同时附作品当前 `revision`。

### 3) 采纳 `POST /api/works/:id/proposals/:pid/accept`

```bash
curl -X POST http://localhost:3000/api/works/1/proposals/1/accept \
  -H 'Content-Type: application/json' -d '{"editor":"审阅甲"}'
```

服务器在**同一事务**内：确认目标段的时间与文字仍与快照一致（**其他段的修改
不阻止采纳**，因此无需携带修订号）→ 重新检查候选非负时间、结束晚于开始、
不与其他段交叠 → 写入正式段 → 修订号 +1 → 重排全部展示序号 → 提案结案。
成功返回 `200 {revision, cue, cues, proposal}`（`cues` 为重排后的全部段）。

冲突时提案**保留待审、不写入任何内容**，返回 `409` 与当前段及原因：

```json
{
  "error": "proposal_conflict",
  "reason": "target_changed",
  "message": "目标字幕段在提案提交后已被修改，与快照不一致；提案保留在待审区，未写入",
  "cue": {"id": 12, "idx": 1, "start": "00:00:01,000", "end": "00:00:02,000", "text": "甲（已被他人修改）"},
  "proposal": {"id": 1, "status": "pending", "changed": true}
}
```

`reason` 取值：`target_changed`（目标段已偏离快照）、`overlap`（候选时间段
当前会与其他段交叠，另附 `overlap_with` 交叠对象）、`target_missing`
（目标段已不存在）。提案已结案时返回 `409 {"error":"proposal_closed","status":"accepted|rejected"}`。

### 4) 驳回 `POST /api/works/:id/proposals/:pid/reject`

```bash
curl -X POST http://localhost:3000/api/works/1/proposals/2/reject \
  -H 'Content-Type: application/json' -d '{"editor":"审阅甲"}'
```

只把提案结案为 `rejected`（记录审阅者与结案时间），正式段与作品修订号不变。
已结案提案再次采纳/驳回均返回 `409 proposal_closed`。

## 离线校订包 API

校订人员需要带走字幕离线修改、再把改动回传同一作品时使用校订包。包是一份
UTF-8 JSON 文件（浏览器下载为 `<标题>.review.json`），顶层固定为：

```json
{
  "format": "srt-review-package",
  "version": 1,
  "work_id": 3,
  "package_id": "rv_P0Ab3Q_8NKb_urdG",
  "base_revision": 1,
  "created_at": "2026-10-01 11:07:18",
  "cues": [
    { "cue_id": 7, "start": "00:00:01,000", "end": "00:00:02,000", "text": "甲\n第二行" }
  ]
}
```

- `work_id` 是**作品标识**，`package_id` 是**包标识**（一个包全生命周期不变），
  `cue_id` 是**稳定段 ID**（展示序号重排也不变）。
- 离线只编辑每段的 `start`、`end`（`HH:MM:SS,mmm`，负时间也可填，会在预览/确认
  时作为违例报告）与 `text`（多行用 `\n` 换行；也支持把文字写成
  `text_lines: ["第一行", "第二行"]`）。**不要改动三个标识字段。**
- 服务端发包时把当时每段时间与文字作为**基线**留存。导入时只处理相对基线
  改过的段；未改段即使服务器后来被在线编辑、平移或采纳候选改过，也**不覆盖**。

### 1) 发包 `POST /api/works/:id/review-packages`

```bash
curl -X POST http://localhost:3000/api/works/3/review-packages \
  -H 'Content-Type: application/json' \
  -d '{"editor":"校对甲"}'
```

返回 `201`：`package` 为包元数据（`package_id`、`base_revision`、`cue_count`、
`status:"issued"`），`content` 是可直接存盘的校订包 JSON 文本。发包**不改变**
正式段与修订号。浏览器点「下载校订包」即调此接口并把 `content` 存为文件。

也可用 `GET /api/works/:id/review-packages/:uid/file` 直接下载同一文件
（Content-Disposition 附件），用 `GET /api/works/:id/review-packages?status=all`
查看发包记录。

### 2) 预览 `POST /api/works/:id/review-packages/preview`

离线改好后回传文件内容（JSON 字符串放 `content`；也可直接把包对象作为请求体）：

```bash
curl -X POST http://localhost:3000/api/works/3/review-packages/preview \
  -H 'Content-Type: application/json' \
  --data-binary @<(jq -Rs '{content: .}' 演示片.review.json)
```

返回（不写库）：

```json
{
  "package": { "package_id": "rv_…", "base_revision": 1, "current_revision": 2,
               "drifted_from_baseline": true, "status": "issued" },
  "revision": 2,
  "valid": false,
  "used": false,
  "no_changes": false,
  "changed_count": 2,
  "unchanged_count": 1,
  "unchanged_drifted": [8],
  "conflicts": [
    { "cue_id": 9, "reason": "target_missing",
      "message": "目标字幕段已不存在", "current": null }
  ],
  "issues": [
    { "type": "overlap", "cue_ids": [7, 8],
      "message": "段 ID 7（展示序号 #1）候选为 ……，与 1 个字幕段交叠：#2（首尾相接不算交叠）" }
  ],
  "cues": [
    { "cue_id": 7, "idx": 1, "changed": true,
      "baseline":  { "start": "00:00:01,000", "end": "00:00:02,000", "text": "甲" },
      "candidate": { "start": "00:00:01,000", "end": "00:00:01,800", "text": "甲离线" },
      "current":   { "id": 7, "idx": 1, "start": "00:00:01,000", "end": "00:00:02,000", "text": "甲" },
      "conflict": null, "issues": ["overlap"], "collisions": [ { "id": 8, "idx": 2 } ] }
  ]
}
```

- `conflicts[].reason`：`target_changed`（改过的目标段正式值已偏离基线）、
  `target_missing`（目标段已删除）、`baseline_missing`（包中段不在本包基线中）。
- `issues[].type`：`negative_time`（候选起点/终点为负）、`invalid_range`
  （结束不晚于开始）、`overlap`（整批应用后与其他段交叠，含两个改动段彼此交叠；
  首尾相接不算）。
- `unchanged_drifted`：未改但正式值已偏离基线的段 ID，仅提示，应用时保持服务器现状。
- `valid` 为 true 必须满足：无冲突、无违例、包未使用且至少有一段改过。

### 3) 确认 `POST /api/works/:id/review-packages/:uid/apply`

```bash
curl -X POST http://localhost:3000/api/works/3/review-packages/rv_P0Ab3Q_8NKb_urdG/apply \
  -H 'Content-Type: application/json' \
  --data-binary @<(jq -Rs '{content: ., editor: "校对甲"}' 演示片.review.json)
```

服务器在**同一事务**内：按最新正式段重新加载并核对每个改过的段仍与基线一致 →
重算负时间/无效区间/交叠 → 只更新改过且通过的段 → 作品修订号 **+1** →
重排全部展示序号 → 把包标记为 `used`。成功返回
`{revision, applied_count, cues, package}`。

- 有冲突或违例：`409 {"error":"review_conflict","conflicts":[...],"issues":[...],
  "cues":[...],"revision":N}`，**整包不写**、包仍是 `issued`，修正离线文件后可
  重新预览/确认。
- 包已使用再次确认：`409 {"error":"package_used","status":"used"}`。
- 没有任何相对基线改过的段：`422 {"error":"no_changes"}`。
- 预览后到确认前作品被他人改动：未改段照常保持服务器现状；改过的段只要仍与
  基线一致就可应用（不依赖作品修订号），已偏离基线的改过段则在确认时被拦下。

### 4) 无效包 / 跨作品包 / 字段非法

以下情况一律 `400 invalid_package`（附 `field`/`cue_id`）或 `404 package_not_found`，
**不写入任何内容**：请求体不是合法 JSON、`format`/`version` 不符、`work_id`/
`package_id` 非法、`cues` 缺失/为空、段 ID 非法或重复、时间无法解析、文字为空
或超长；包文件属于其他作品返回 `400 cross_work_package`（附
`package_work_id`）；路径包标识与文件内不一致返回 `400 package_mismatch`。

## 目录结构

```
.
├── Dockerfile
├── docker-compose.yml
├── package.json
├── README.md
├── src/
│   ├── server.js      # Express 路由：上传/编辑/待审区/批量平移/离线校订包/导出、乐观锁与交叠校验
│   ├── shift.js       # 批量平移推演（负起点/交叠检测，碰撞对象）
│   ├── review.js      # 离线校订包：文件格式、解析校验、基线差异与整批应用预案（纯函数）
│   ├── db.js          # SQLite 存储（sql.js wasm，快照持久化，建表初始化）
│   └── srt.js         # SRT 严格解析（带行号报错）与标准序列化
├── public/            # 浏览器界面（原生 HTML/CSS/JS）
│   ├── index.html
│   ├── styles.css
│   └── app.js
└── test/test.js       # 单元 + HTTP 集成测试
```

## 使用流程建议

1. 一位同学上传片方字幕，其他人在作品列表中打开同一作品；
2. 各人在「校订人署名」填自己的名字（随修改记录保存）；
3. 改一段点一段的「保存」。若期间别人先保存过，该段会出现黄色冲突提示，
   其中附有服务器最新内容；对照合并后再次保存即可；
4. 不确定的修改点「提候选」：填入说明后进入**待审区**，正式段不受影响。
   审阅人点开「待审区」并列对照原值、候选值与当前正式值，逐条「采纳」
   （校验通过后写入正式段、修订号 +1）或「驳回」（只结案）。若目标段已被
   他人改动或候选会与其他段交叠，采纳会被拒绝并提示原因，提案保留待审；
5. 需要整体挪动时间轴时，勾选若干字幕段（或「全选」），在工具条输入有符号
   整数毫秒偏移量并点「预览调整」：面板逐段列出调整前后时间与碰撞对象；
   绿色表示可应用，红色会逐条指出负起点/交叠及相关段。点「确认应用」整批
   同量平移，修订号只增加一次、展示序号自动重排；若预览后作品被他人改动，
   会收到 409 提示，重新载入并重新预览即可；
6. 需要把字幕带走离线修改时，点右上角「下载校订包」得到 `<标题>.review.json`
   （服务端同时留存发包基线）。离线用任意文本编辑器改每段的 `start`/`end`/`text`，
   不要动 `work_id`/`package_id`/`cue_id`。回来后在「导入离线校订包」面板选择
   文件并「预览差异」：逐段对照基线、离线候选与当前正式值，目标段已变/缺失、
   负时间、无效区间、交叠都会标出；未改段即使服务器有新改动也不会被覆盖。
   点「确认应用整包」：服务器在同一事务内按最新正式段重新核对，任一冲突都
   整包不写（包保留，可改好再预览），成功才推进修订号、重排序号并把包标记为
   已使用（同一包不能重复确认，需要再次离线校订请重新发包）；
7. 校订完成后点右上角「导出标准 SRT」，文件可直接用于放映软件。
