'use strict';

/* 无第三方依赖的集成测试：内存 SQLite + 真实 HTTP 服务。
   运行：npm test
   退出码非 0 表示有失败用例。 */

process.env.DB_PATH = ':memory:';

const assert = require('assert');
const fs = require('fs');
const os = require('os');
const path = require('path');
const http = require('http');
const { parseSrt, serializeSrt, SrtError, parseTimeToMs, formatMs } = require('../src/srt');

let passed = 0;
function test(name, fn) {
  return Promise.resolve()
    .then(fn)
    .then(() => {
      passed++;
      console.log(`  ✓ ${name}`);
    })
    .catch((err) => {
      console.error(`  ✗ ${name}`);
      console.error(err);
      process.exitCode = 1;
    });
}

function expectSrtError(fn, expectedLine, partOfMessage) {
  try {
    fn();
    assert.fail('应当抛出 SrtError');
  } catch (e) {
    assert.ok(e instanceof SrtError, `应是 SrtError，实际 ${e.constructor.name}`);
    assert.strictEqual(e.line, expectedLine, `行号应为 ${expectedLine}，实际 ${e.line}`);
    if (partOfMessage) {
      assert.ok(
        e.message.includes(partOfMessage),
        `错误信息应包含“${partOfMessage}”，实际：${e.message}`
      );
    }
  }
}

/* ------------------------------------------------------------------ */
/* SRT 解析/序列化单元测试                                             */
/* ------------------------------------------------------------------ */

function runUnitTests() {
  test('正常文件：多行文字、CRLF、BOM 都能解析', () => {
    const raw =
      '\uFEFF1\r\n00:00:01,000 --> 00:00:02,500\r\n第一行\r\n第二行\r\n\r\n' +
      '2\r\n00:00:02,500 --> 00:00:03,000\r\n结尾相接可以\r\n';
    const cues = parseSrt(raw);
    assert.strictEqual(cues.length, 2);
    assert.strictEqual(cues[0].start_ms, 1000);
    assert.strictEqual(cues[0].end_ms, 2500);
    assert.strictEqual(cues[0].text, '第一行\n第二行');
    assert.strictEqual(cues[1].text, '结尾相接可以');
  });

  test('序号行格式错误，报出行号', () => {
    const raw = '1\n00:00:01,000 --> 00:00:02,000\n甲\n\n??\n00:00:03,000 --> 00:00:04,000\n乙\n';
    expectSrtError(() => parseSrt(raw), 5, '序号');
  });

  test('时间轴格式错误，报出时间轴所在行号', () => {
    const raw = '1\n00:00:01,000 -> 00:00:02,000\n甲\n';
    expectSrtError(() => parseSrt(raw), 2, '时间轴');
  });

  test('结束不晚于开始，报出行号', () => {
    const raw = '1\n00:00:05,000 --> 00:00:05,000\n甲\n';
    expectSrtError(() => parseSrt(raw), 2, '结束时间');
  });

  test('缺少字幕文字，报出行号', () => {
    const raw = '1\n00:00:01,000 --> 00:00:02,000\n\n2\n00:00:03,000 --> 00:00:04,000\n乙\n';
    expectSrtError(() => parseSrt(raw), 2, '文字');
  });

  test('整份文件内时间交叠，报出后一段序号所在行', () => {
    const raw =
      '1\n00:00:01,000 --> 00:00:03,000\n甲\n\n' +
      '2\n00:00:02,000 --> 00:00:04,000\n乙\n';
    expectSrtError(() => parseSrt(raw), 5, '交叠');
  });

  test('空文件报错', () => {
    expectSrtError(() => parseSrt('   \n\n'), 1, '没有任何字幕');
  });

  test('时间码换算与格式化', () => {
    assert.strictEqual(parseTimeToMs('01:02:03,456'), 3723456);
    assert.strictEqual(formatMs(3723456), '01:02:03,456');
    // 点号也接受
    assert.strictEqual(parseTimeToMs('00:00:00.500'), 500);
  });

  test('序列化按时间重新编号并保留多行换行', () => {
    const out = serializeSrt([
      { start_ms: 2000, end_ms: 3000, text: 'b 行1\nb 行2' },
      { start_ms: 1000, end_ms: 2000, text: 'a' },
    ]);
    const expected =
      '1\n00:00:01,000 --> 00:00:02,000\na\n\n' +
      '2\n00:00:02,000 --> 00:00:03,000\nb 行1\nb 行2\n';
    assert.strictEqual(out, expected);
  });
}

/* ------------------------------------------------------------------ */
/* HTTP 集成测试                                                       */
/* ------------------------------------------------------------------ */

const VALID_SRT =
  '1\r\n00:00:01,000 --> 00:00:02,000\r\n你好世界\r\n第二行\r\n\r\n' +
  '2\r\n00:00:02,000 --> 00:00:03,500\r\n第二段\r\n';

async function main() {
  console.log('SRT 解析单元测试：');
  runUnitTests();

  // 集成测试使用临时文件库（而非 :memory:），以覆盖快照落盘、
  // export() 后预编译语句失效重建、重启持久化等路径。
  const tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'srt-collab-test-'));
  process.env.DB_PATH = path.join(tmpDir, 'test.db');

  const { app, ready } = require('../src/server');
  await ready;
  const server = http.createServer(app);
  await new Promise((resolve) => server.listen(0, '127.0.0.1', resolve));
  const base = `http://127.0.0.1:${server.address().port}`;

  const call = async (method, url, body) => {
    const res = await fetch(base + url, {
      method,
      headers: body !== undefined ? { 'Content-Type': 'application/json' } : {},
      body: body !== undefined ? JSON.stringify(body) : undefined,
    });
    const json = await res.json().catch(() => null);
    return { status: res.status, json };
  };

  console.log('\nHTTP 接口测试：');

  await test('非法 SRT 上传返回 422 与行号，且整份不入库', async () => {
    const bad = '1\n00:00:01,000 --> 00:00:02,000\n甲\n\n2\n00:00:02,000 --> 00:00:01,000\n乙\n';
    const r = await call('POST', '/api/works', { title: '坏文件', filename: 'bad.srt', content: bad });
    assert.strictEqual(r.status, 422);
    assert.strictEqual(r.json.error, 'invalid_srt');
    assert.strictEqual(r.json.line, 6);

    const list = await call('GET', '/api/works');
    assert.strictEqual(list.json.works.length, 0, '坏文件不应产生任何作品');
  });

  await test('合法 SRT 上传成功，修订号为 1', async () => {
    const r = await call('POST', '/api/works', { title: '测试片', filename: 'sample.srt', content: VALID_SRT });
    assert.strictEqual(r.status, 201, JSON.stringify(r.json));
    assert.strictEqual(r.json.revision, 1);
    assert.strictEqual(r.json.cue_count, 2);
  });

  let cueId;
  let cue2Id;
  await test('作品详情按时间顺序返回字幕段', async () => {
    const r = await call('GET', '/api/works/1');
    assert.strictEqual(r.status, 200);
    assert.strictEqual(r.json.cues.length, 2);
    assert.strictEqual(r.json.cues[0].text, '你好世界\n第二行');
    assert.strictEqual(r.json.cues[0].idx, 1);
    cueId = r.json.cues[0].id;
    cue2Id = r.json.cues[1].id;
  });

  await test('携带正确修订号编辑：多行文字与时间可改，修订号变 2', async () => {
    // cue2 为 02.000–03.500，这里与它首尾相接，不构成交叠
    const r = await call('PUT', `/api/works/1/cues/${cueId}`, {
      revision: 1,
      start: '00:00:01,200',
      end: '00:00:02,000',
      text: '改后第一行\n改后第二行\n第三行',
      editor: '阿校对',
    });
    assert.strictEqual(r.status, 200, JSON.stringify(r.json));
    assert.strictEqual(r.json.revision, 2);
    assert.strictEqual(r.json.cue.start_ms, 1200);
    assert.strictEqual(r.json.cue.end_ms, 2000);
    assert.strictEqual(r.json.cue.text, '改后第一行\n改后第二行\n第三行');
  });

  await test('用过期修订号 1 再次编辑：409，返回最新修订号与目标字幕段', async () => {
    const r = await call('PUT', `/api/works/1/cues/${cueId}`, {
      revision: 1,
      start: '00:00:01,300',
      end: '00:00:02,000',
      text: '过期修改',
    });
    assert.strictEqual(r.status, 409);
    assert.strictEqual(r.json.error, 'revision_stale');
    assert.strictEqual(r.json.latest_revision, 2);
    assert.strictEqual(r.json.cue.id, cueId);
    // 目标字幕段是服务器上的最新版本
    assert.strictEqual(r.json.cue.text, '改后第一行\n改后第二行\n第三行');
    assert.strictEqual(r.json.cue.start, '00:00:01,200');
  });

  await test('时间结束早于开始：422 拒绝，修订号与内容不变', async () => {
    const r = await call('PUT', `/api/works/1/cues/${cueId}`, {
      revision: 2,
      start: '00:00:05,000',
      end: '00:00:01,000',
      text: '改后第一行\n改后第二行\n第三行',
    });
    assert.strictEqual(r.status, 422);
    assert.strictEqual(r.json.error, 'invalid_range');

    const detail = await call('GET', '/api/works/1');
    assert.strictEqual(detail.json.work.revision, 2, '失败的编辑不应推进修订号');
    assert.strictEqual(detail.json.cues[0].start, '00:00:01,200');
  });

  await test('非法时间格式：400 拒绝', async () => {
    const r = await call('PUT', `/api/works/1/cues/${cueId}`, {
      revision: 2,
      start: '1秒',
      end: '00:00:02,000',
      text: 'x',
    });
    assert.strictEqual(r.status, 400);
    assert.strictEqual(r.json.error, 'invalid_time');
  });

  await test('与其他字幕段交叠：422 拒绝', async () => {
    // cue2 当前 02.000–03.500；把 cue1 改成 01.500–02.200 会与之交叠
    const r = await call('PUT', `/api/works/1/cues/${cueId}`, {
      revision: 2,
      start: '00:00:01,500',
      end: '00:00:02,200',
      text: '改后第一行\n改后第二行\n第三行',
    });
    assert.strictEqual(r.status, 422);
    assert.strictEqual(r.json.error, 'overlap');

    const detail = await call('GET', '/api/works/1');
    assert.strictEqual(detail.json.work.revision, 2);
    assert.strictEqual(detail.json.cues[0].start, '00:00:01,200');
  });

  await test('首尾相接（前一段结束==后一段开始）不算交叠，允许保存', async () => {
    // cue1 改为 00:00:01,200 -> 00:00:02,000，正好接上 cue2 的开始
    const r = await call('PUT', `/api/works/1/cues/${cueId}`, {
      revision: 2,
      start: '00:00:01,200',
      end: '00:00:02,000',
      text: '改后第一行\n改后第二行\n第三行',
    });
    assert.strictEqual(r.status, 200, JSON.stringify(r.json));
    assert.strictEqual(r.json.revision, 3);
  });

  await test('空文字被拒绝', async () => {
    const r = await call('PUT', `/api/works/1/cues/${cue2Id}`, {
      revision: 3,
      start: '00:00:02,000',
      end: '00:00:03,500',
      text: '   \n  ',
    });
    assert.strictEqual(r.status, 400);
    assert.strictEqual(r.json.error, 'invalid_text');
  });

  await test('并发两处相同修订号提交：恰好一个成功、另一个 409', async () => {
    const [a, b] = await Promise.all([
      call('PUT', `/api/works/1/cues/${cueId}`, {
        revision: 3,
        start: '00:00:01,200',
        end: '00:00:02,000',
        text: '并发编辑',
      }),
      call('PUT', `/api/works/1/cues/${cue2Id}`, {
        revision: 3,
        start: '00:00:02,000',
        end: '00:00:03,500',
        text: '第二处并发',
      }),
    ]);
    const ok = [a, b].filter((r) => r.status === 200);
    const conflicts = [a, b].filter((r) => r.status === 409);
    assert.strictEqual(ok.length, 1, `应有一个成功，实际 ${ok.length}：${JSON.stringify([a.json, b.json])}`);
    assert.strictEqual(conflicts.length, 1, '应有一个 409 冲突');
    assert.strictEqual(conflicts[0].json.latest_revision, 4);
  });

  await test('导出标准 SRT：按时间重新编号，换行保留，带 UTF-8 BOM', async () => {
    const res = await fetch(base + '/api/works/1/export');
    assert.strictEqual(res.status, 200);
    assert.ok(res.headers.get('content-type').includes('x-subrip'));
    const buf = Buffer.from(await res.arrayBuffer());
    assert.ok(buf[0] === 0xef && buf[1] === 0xbb && buf[2] === 0xbf, '应以 BOM 开头');
    const body = buf.toString('utf8').replace(/^\uFEFF/, '');
    const lines = body.replace(/\r\n?/g, '\n').split('\n');
    // 编号从 1 连续递增
    assert.strictEqual(lines[0], '1');
    assert.ok(lines.some((l) => l === '2'));
    // 多行文字换行仍在（并发测试中恰好一处保存成功）
    assert.ok(
      body.includes('改后第一行\n改后第二行\n第三行') ||
        body.includes('并发编辑') ||
        body.includes('第二处并发'),
      '导出内容应包含多行文字换行'
    );
  });

  /* ---------------- 批量时间轴平移 ---------------- */

  // 新作品，各段时长/间隙不同，便于区分“交叠”与“首尾相接”：
  // #1 1000-2000  #2 3000-4000  #3 5000-7000  #4 9000-10000
  const SHIFT_SRT =
    '1\n00:00:01,000 --> 00:00:02,000\n甲\n\n' +
    '2\n00:00:03,000 --> 00:00:04,000\n乙\n\n' +
    '3\n00:00:05,000 --> 00:00:07,000\n丙\n\n' +
    '4\n00:00:09,000 --> 00:00:10,000\n丁\n';
  let shiftWorkId;
  let sIds = {};
  const byIdx = (cues, i) => cues.find((c) => c.idx === i);

  await test('批量：上传测试作品（4 段，带间隙）', async () => {
    const r = await call('POST', '/api/works', { title: '批量片', filename: 'shift.srt', content: SHIFT_SRT });
    assert.strictEqual(r.status, 201, JSON.stringify(r.json));
    assert.strictEqual(r.json.revision, 1);
    shiftWorkId = r.json.id;
    const d = await call('GET', `/api/works/${shiftWorkId}`);
    [1, 2, 3, 4].forEach((i) => {
      sIds[i] = byIdx(d.json.cues, i).id;
    });
  });

  await test('批量预览：合法后移 1000ms，返回调整前后时间，无碰撞，valid=true', async () => {
    const r = await call('POST', `/api/works/${shiftWorkId}/cues/shift/preview`, {
      revision: 1,
      cue_ids: [sIds[2]],
      offset_ms: 1000,
    });
    assert.strictEqual(r.status, 200, JSON.stringify(r.json));
    assert.strictEqual(r.json.valid, true);
    assert.strictEqual(r.json.expected_revision, 1);
    assert.deepStrictEqual(r.json.issues, []);
    const c = r.json.cues[0];
    assert.strictEqual(c.start, '00:00:03,000');
    assert.strictEqual(c.new_start, '00:00:04,000');
    assert.strictEqual(c.new_end, '00:00:05,000');
    assert.deepStrictEqual(c.collisions, []);
  });

  await test('批量预览：前移导致负起点，valid=false 并指出该段', async () => {
    const r = await call('POST', `/api/works/${shiftWorkId}/cues/shift/preview`, {
      revision: 1,
      cue_ids: [sIds[1]],
      offset_ms: -1500,
    });
    assert.strictEqual(r.status, 200, JSON.stringify(r.json));
    assert.strictEqual(r.json.valid, false);
    assert.strictEqual(r.json.issues[0].type, 'negative_start');
    assert.deepStrictEqual(r.json.issues[0].cue_ids, [sIds[1]]);
    assert.strictEqual(r.json.cues[0].new_start_ms, -500);
  });

  await test('批量预览：后移撞上下一段，碰撞对象含未选段 #3', async () => {
    const r = await call('POST', `/api/works/${shiftWorkId}/cues/shift/preview`, {
      revision: 1,
      cue_ids: [sIds[2]],
      offset_ms: 1500, // 3000-4000 -> 4500-5500，与 #3 的 5000-7000 交叠
    });
    assert.strictEqual(r.json.valid, false);
    const issue = r.json.issues.find((x) => x.type === 'overlap');
    assert.ok(issue, '应有交叠问题');
    assert.ok(issue.cue_ids.includes(sIds[2]) && issue.cue_ids.includes(sIds[3]));
    const entry = r.json.cues[0];
    assert.strictEqual(entry.collisions.length, 1);
    assert.strictEqual(entry.collisions[0].id, sIds[3]);
    assert.strictEqual(entry.collisions[0].selected, false);
  });

  await test('批量预览：首尾相接（新起点 == 邻段结束）允许，valid=true', async () => {
    // #4 9000-10000 前移 2000ms -> 7000-8000，新起点 7000 正好等于 #3 结束
    const r = await call('POST', `/api/works/${shiftWorkId}/cues/shift/preview`, {
      revision: 1,
      cue_ids: [sIds[4]],
      offset_ms: -2000,
    });
    assert.strictEqual(r.status, 200, JSON.stringify(r.json));
    assert.strictEqual(r.json.valid, true);
    assert.deepStrictEqual(r.json.cues[0].collisions, []);
  });

  await test('批量确认：多段同量平移 + 重排序号，单事务修订号只 +1', async () => {
    // #3 5000-7000 -> 6000-8000（接 #4 起点 9000，不撞）
    // #1 1000-2000 -> 2000-3000（接 #2 起点 3000）；#1 与 #3 交换展示顺序
    const r = await call('POST', `/api/works/${shiftWorkId}/cues/shift`, {
      revision: 1,
      cue_ids: [sIds[1], sIds[3]],
      offset_ms: 1000,
      editor: '排片同学',
    });
    assert.strictEqual(r.status, 200, JSON.stringify(r.json));
    assert.strictEqual(r.json.revision, 2, '整批只应增加一次修订号');
    assert.strictEqual(r.json.shifted_count, 2);

    // 返回的是按新时间重排的全部段
    const starts = r.json.cues.map((c) => c.start);
    assert.deepStrictEqual(starts, [
      '00:00:02,000', // 原 #1 甲
      '00:00:03,000', // #2 乙未选
      '00:00:06,000', // 原 #3 丙
      '00:00:09,000', // #4 丁未选
    ]);
    r.json.cues.forEach((c, i) => assert.strictEqual(c.idx, i + 1, '展示序号应从 1 连续重排'));

    // 文字与段标识不变：原 #1（id 不变）仍是“甲”，原 #3 仍是“丙”
    const c1 = r.json.cues.find((c) => c.id === sIds[1]);
    const c3 = r.json.cues.find((c) => c.id === sIds[3]);
    assert.strictEqual(c1.text, '甲');
    assert.strictEqual(c3.text, '丙');
    assert.strictEqual(c1.start_ms, 2000);
    assert.strictEqual(c1.end_ms, 3000);
    assert.strictEqual(c3.start_ms, 6000);
    assert.strictEqual(c3.end_ms, 8000);
  });

  await test('批量确认后导出 SRT 按新时间排序编号', async () => {
    const res = await fetch(base + `/api/works/${shiftWorkId}/export`);
    const body = (await res.text()).replace(/^﻿/, '');
    assert.ok(body.startsWith('1\n00:00:02,000'), body.slice(0, 60));
    assert.ok(body.includes('2\n00:00:03,000 --> 00:00:04,000\n乙'));
    assert.ok(/3\n00:00:06,000 --> 00:00:08,000\n丙/.test(body), '原 #3（丙）按新时间排到第 3 条');
    assert.ok(/4\n00:00:09,000 --> 00:00:10,000\n丁/.test(body));
  });

  await test('批量确认：会交叠的批次 422 整批拒绝，修订号与全部时间不变', async () => {
    // rev2 时间线：甲 2000-3000、乙 3000-4000、丙 6000-8000、丁 9000-10000
    // 乙 +1500 -> 4500-5500，落在乙、丙之间的间隙（4000-6000），合法 -> rev3
    const fit = await call('POST', `/api/works/${shiftWorkId}/cues/shift`, {
      revision: 2,
      cue_ids: [sIds[2]],
      offset_ms: 1500,
    });
    assert.strictEqual(fit.status, 200, JSON.stringify(fit.json));
    assert.strictEqual(fit.json.revision, 3);

    // rev3：乙已在 4500-5500；乙再 +2500 -> 7000-8000，与丙 6000-8000 交叠
    const bad = await call('POST', `/api/works/${shiftWorkId}/cues/shift`, {
      revision: 3,
      cue_ids: [sIds[2]],
      offset_ms: 2500,
    });
    assert.strictEqual(bad.status, 422);
    assert.strictEqual(bad.json.error, 'shift_rejected');
    assert.ok(bad.json.issues.some((x) => x.type === 'overlap'));
    assert.ok(bad.json.issues[0].cues.some((c) => c.id === sIds[2]));

    const d = await call('GET', `/api/works/${shiftWorkId}`);
    assert.strictEqual(d.json.work.revision, 3, '被拒绝的批量调整不应推进修订号');
    const yi = byIdx(d.json.cues, 2);
    assert.strictEqual(yi.start, '00:00:04,500'); // 前一次合法平移的结果保留
  });

  await test('批量确认：负起点 422 拒绝', async () => {
    const r = await call('POST', `/api/works/${shiftWorkId}/cues/shift`, {
      revision: 3,
      cue_ids: [sIds[1]], // 甲当前 2000-3000
      offset_ms: -3000,
    });
    assert.strictEqual(r.status, 422);
    assert.strictEqual(r.json.issues[0].type, 'negative_start');
    const d = await call('GET', `/api/works/${shiftWorkId}`);
    assert.strictEqual(d.json.work.revision, 3);
  });

  await test('批量确认：预览后作品被单段编辑改动 -> 409 返回最新修订号，不写入', async () => {
    // rev3 时间线：甲 2000-3000、乙 4500-5500、丙 6000-8000、丁 9000-10000
    const before = await call('GET', `/api/works/${shiftWorkId}`);
    const yi = byIdx(before.json.cues, 2);
    assert.strictEqual(yi.start, '00:00:04,500');

    const preview = await call('POST', `/api/works/${shiftWorkId}/cues/shift/preview`, {
      revision: 3,
      cue_ids: [sIds[4]], // 丁 9000-10000
      offset_ms: -500,
    });
    assert.strictEqual(preview.status, 200);
    assert.strictEqual(preview.json.valid, true);

    // 他人改动同一作品：修订号推进到 4
    const other = await call('PUT', `/api/works/${shiftWorkId}/cues/${sIds[1]}`, {
      revision: 3,
      start: '00:00:02,000',
      end: '00:00:02,500',
      text: '甲被别人改短',
      editor: '别人',
    });
    assert.strictEqual(other.status, 200, JSON.stringify(other.json));

    // 仍按旧预览的修订号 3 确认 -> 409
    const confirm = await call('POST', `/api/works/${shiftWorkId}/cues/shift`, {
      revision: 3,
      cue_ids: [sIds[4]],
      offset_ms: -500,
    });
    assert.strictEqual(confirm.status, 409);
    assert.strictEqual(confirm.json.error, 'revision_stale');
    assert.strictEqual(confirm.json.latest_revision, 4);

    const after = await call('GET', `/api/works/${shiftWorkId}`);
    assert.strictEqual(after.json.work.revision, 4);
    const ding = after.json.cues.find((c) => c.id === sIds[4]);
    assert.strictEqual(ding.start, '00:00:09,000', '丁不应被过期预览写入');
  });

  await test('批量：空选择、重复段、不存在段、非整数偏移均报错', async () => {
    const base_ = `/api/works/${shiftWorkId}/cues/shift`;
    const empty = await call('POST', `${base_}/preview`, { revision: 4, cue_ids: [], offset_ms: 100 });
    assert.strictEqual(empty.status, 400);
    assert.strictEqual(empty.json.error, 'empty_selection');

    const dup = await call('POST', `${base_}/preview`, { revision: 4, cue_ids: [sIds[1], sIds[1]], offset_ms: 100 });
    assert.strictEqual(dup.status, 400);
    assert.strictEqual(dup.json.error, 'duplicate_cue');

    const notFound = await call('POST', `${base_}/preview`, { revision: 4, cue_ids: [999999], offset_ms: 100 });
    assert.strictEqual(notFound.status, 404);
    assert.strictEqual(notFound.json.error, 'cue_not_found');

    for (const bad of [1.5, '1.5', 'abc', null, {}, true]) {
      const r = await call('POST', `${base_}/preview`, { revision: 4, cue_ids: [sIds[1]], offset_ms: bad });
      assert.strictEqual(r.status, 400, `偏移量 ${JSON.stringify(bad)} 应被拒绝`);
      assert.strictEqual(r.json.error, 'invalid_offset');
    }
  });

  await test('批量：整数字符串偏移与 0 偏移接受；不选非数组报错', async () => {
    const base_ = `/api/works/${shiftWorkId}/cues/shift`;
    const str = await call('POST', `${base_}/preview`, { revision: 4, cue_ids: [sIds[2]], offset_ms: '-500' });
    assert.strictEqual(str.status, 200, JSON.stringify(str.json));
    assert.strictEqual(str.json.offset_ms, -500);

    const zero = await call('POST', `${base_}/preview`, { revision: 4, cue_ids: [sIds[2]], offset_ms: 0 });
    assert.strictEqual(zero.status, 200);
    assert.strictEqual(zero.json.valid, true);

    const noArr = await call('POST', `${base_}/preview`, { revision: 4, cue_ids: sIds[2], offset_ms: 0 });
    assert.strictEqual(noArr.status, 400);
    assert.strictEqual(noArr.json.error, 'invalid_selection');
  });

  /* ---------------- 候选修改待审区 ---------------- */

  // 新作品：#1 1000-2000 甲  #2 3000-4000 乙  #3 5000-6000 丙
  const PROPOSAL_SRT =
    '1\n00:00:01,000 --> 00:00:02,000\n甲\n\n' +
    '2\n00:00:03,000 --> 00:00:04,000\n乙\n\n' +
    '3\n00:00:05,000 --> 00:00:06,000\n丙\n';
  let propWorkId;
  let pIds = {};
  const listProposals = async (q) => {
    const r = await call('GET', `/api/works/${propWorkId}/proposals${q || ''}`);
    assert.strictEqual(r.status, 200, JSON.stringify(r.json));
    return r.json.proposals;
  };

  await test('待审区：上传测试作品（3 段）', async () => {
    const r = await call('POST', '/api/works', { title: '提案片', filename: 'prop.srt', content: PROPOSAL_SRT });
    assert.strictEqual(r.status, 201, JSON.stringify(r.json));
    propWorkId = r.json.id;
    const d = await call('GET', `/api/works/${propWorkId}`);
    [1, 2, 3].forEach((i) => {
      pIds[i] = byIdx(d.json.cues, i).id;
    });
  });

  let p1;
  await test('提交候选：201 入待审区，快照/候选/当前三段并列，正式段与修订号不变', async () => {
    const r = await call('POST', `/api/works/${propWorkId}/cues/${pIds[1]}/proposals`, {
      revision: 1,
      start: '00:00:04,500',
      end: '00:00:04,700',
      text: '甲改\n第二行',
      note: '标点与断行建议',
      editor: '小提交',
    });
    assert.strictEqual(r.status, 201, JSON.stringify(r.json));
    p1 = r.json.proposal;
    assert.strictEqual(p1.status, 'pending');
    assert.strictEqual(p1.base_revision, 1);
    assert.strictEqual(p1.editor, '小提交');
    assert.strictEqual(p1.note, '标点与断行建议');
    // 快照 = 提交时原段
    assert.strictEqual(p1.snapshot.start, '00:00:01,000');
    assert.strictEqual(p1.snapshot.end, '00:00:02,000');
    assert.strictEqual(p1.snapshot.text, '甲');
    // 候选值
    assert.strictEqual(p1.candidate.start, '00:00:04,500');
    assert.strictEqual(p1.candidate.text, '甲改\n第二行');
    // 当前正式值仍等于快照
    assert.strictEqual(p1.current.text, '甲');
    assert.strictEqual(p1.changed, false);

    const d = await call('GET', `/api/works/${propWorkId}`);
    assert.strictEqual(d.json.work.revision, 1, '提交候选不应推进修订号');
    assert.strictEqual(d.json.cues[0].text, '甲', '正式段不应被候选改动');

    const exp = await fetch(`${base}/api/works/${propWorkId}/export`);
    const body = await exp.text();
    assert.ok(!body.includes('甲改'), 'SRT 导出不应包含未采纳的候选文字');
  });

  await test('提交候选：修订号过期 409，不生成提案', async () => {
    const r = await call('POST', `/api/works/${propWorkId}/cues/${pIds[1]}/proposals`, {
      revision: 2, // 当前仍是 1
      start: '00:00:01,000',
      end: '00:00:02,000',
      text: '过期候选',
    });
    assert.strictEqual(r.status, 409);
    assert.strictEqual(r.json.error, 'revision_stale');
    assert.strictEqual(r.json.latest_revision, 1);
    assert.strictEqual(r.json.cue.id, pIds[1]);
    assert.strictEqual((await listProposals()).length, 1, '过期提交不应生成提案');
  });

  await test('提交候选：非法内容（时间格式/区间/空文字/交叠）拒绝且不生成提案', async () => {
    const badTime = await call('POST', `/api/works/${propWorkId}/cues/${pIds[1]}/proposals`, {
      revision: 1, start: '1秒', end: '00:00:02,000', text: 'x',
    });
    assert.strictEqual(badTime.status, 400);
    assert.strictEqual(badTime.json.error, 'invalid_time');

    const badRange = await call('POST', `/api/works/${propWorkId}/cues/${pIds[1]}/proposals`, {
      revision: 1, start: '00:00:02,000', end: '00:00:01,000', text: 'x',
    });
    assert.strictEqual(badRange.status, 422);
    assert.strictEqual(badRange.json.error, 'invalid_range');

    const emptyText = await call('POST', `/api/works/${propWorkId}/cues/${pIds[1]}/proposals`, {
      revision: 1, start: '00:00:01,000', end: '00:00:02,000', text: '  \n ',
    });
    assert.strictEqual(emptyText.status, 400);
    assert.strictEqual(emptyText.json.error, 'invalid_text');

    // 候选 2500-3500 与 #2（3000-4000）交叠
    const overlap = await call('POST', `/api/works/${propWorkId}/cues/${pIds[1]}/proposals`, {
      revision: 1, start: '00:00:02,500', end: '00:00:03,500', text: '撞上乙',
    });
    assert.strictEqual(overlap.status, 422);
    assert.strictEqual(overlap.json.error, 'overlap');

    const notFound = await call('POST', `/api/works/${propWorkId}/cues/999999/proposals`, {
      revision: 1, start: '00:00:01,000', end: '00:00:02,000', text: 'x',
    });
    assert.strictEqual(notFound.status, 404);
    assert.strictEqual(notFound.json.error, 'cue_not_found');

    assert.strictEqual((await listProposals()).length, 1, '非法提交不应生成提案');
  });

  await test('采纳：其他段被修改不阻止；成功后正式段更新、修订号 +1、序号重排', async () => {
    // 他人先改了另一段 #2：修订号 1 -> 2
    const other = await call('PUT', `/api/works/${propWorkId}/cues/${pIds[2]}`, {
      revision: 1, start: '00:00:03,000', end: '00:00:04,000', text: '乙 v2', editor: '别人',
    });
    assert.strictEqual(other.status, 200, JSON.stringify(other.json));
    assert.strictEqual(other.json.revision, 2);

    // 候选 #1 基于修订 1 提交，目标段未动 -> 可采纳
    const r = await call('POST', `/api/works/${propWorkId}/proposals/${p1.id}/accept`, { editor: '审阅甲' });
    assert.strictEqual(r.status, 200, JSON.stringify(r.json));
    assert.strictEqual(r.json.revision, 3, '采纳只推进一次修订号');
    assert.strictEqual(r.json.proposal.status, 'accepted');
    assert.strictEqual(r.json.proposal.reviewer, '审阅甲');
    assert.strictEqual(r.json.cue.text, '甲改\n第二行');
    assert.strictEqual(r.json.cue.start_ms, 4500);

    // 甲移到 4500-4700 后顺序变为 乙、甲、丙，序号从 1 连续重排
    const order = r.json.cues.map((c) => c.id);
    assert.deepStrictEqual(order, [pIds[2], pIds[1], pIds[3]]);
    r.json.cues.forEach((c, i) => assert.strictEqual(c.idx, i + 1));

    const exp = await fetch(`${base}/api/works/${propWorkId}/export`);
    const body = await exp.text();
    assert.ok(body.includes('甲改'), '采纳后导出应包含候选文字');
    assert.ok(body.includes('00:00:04,500 --> 00:00:04,700'));
  });

  await test('已结案提案不可再次处理：采纳/驳回均 409', async () => {
    const again = await call('POST', `/api/works/${propWorkId}/proposals/${p1.id}/accept`, {});
    assert.strictEqual(again.status, 409);
    assert.strictEqual(again.json.error, 'proposal_closed');
    assert.strictEqual(again.json.status, 'accepted');

    const rej = await call('POST', `/api/works/${propWorkId}/proposals/${p1.id}/reject`, {});
    assert.strictEqual(rej.status, 409);
    assert.strictEqual(rej.json.error, 'proposal_closed');
  });

  let p2;
  await test('采纳冲突：目标段已被他人改动 -> 409 返回当前段，提案保留待审', async () => {
    // 基于 rev3 提交 #2 的候选（快照：乙 v2，3000-4000）
    const sub = await call('POST', `/api/works/${propWorkId}/cues/${pIds[2]}/proposals`, {
      revision: 3, start: '00:00:03,200', end: '00:00:04,200', text: '乙 v3', editor: '小提交',
    });
    assert.strictEqual(sub.status, 201, JSON.stringify(sub.json));
    p2 = sub.json.proposal;

    // 他人直接改了 #2：rev 3 -> 4，目标段偏离快照
    const edit = await call('PUT', `/api/works/${propWorkId}/cues/${pIds[2]}`, {
      revision: 3, start: '00:00:03,000', end: '00:00:04,000', text: '乙 v2.5', editor: '别人',
    });
    assert.strictEqual(edit.status, 200, JSON.stringify(edit.json));

    const acc = await call('POST', `/api/works/${propWorkId}/proposals/${p2.id}/accept`, {});
    assert.strictEqual(acc.status, 409);
    assert.strictEqual(acc.json.error, 'proposal_conflict');
    assert.strictEqual(acc.json.reason, 'target_changed');
    assert.strictEqual(acc.json.cue.text, '乙 v2.5', '应返回目标段当前内容');
    assert.strictEqual(acc.json.proposal.status, 'pending', '提案应保留待审');

    const d = await call('GET', `/api/works/${propWorkId}`);
    assert.strictEqual(d.json.work.revision, 4, '冲突采纳不应推进修订号');
    assert.strictEqual(byIdx(d.json.cues, 1).text, '乙 v2.5', '正式段不应被写入');

    // 列表中该提案标记为已偏离快照
    const all = await listProposals();
    const row = all.find((x) => x.id === p2.id);
    assert.strictEqual(row.status, 'pending');
    assert.strictEqual(row.changed, true);
    assert.strictEqual(row.current.text, '乙 v2.5');
  });

  let p3;
  await test('采纳冲突：候选时间段与他人新位置交叠 -> 409 指出交叠对象，不写入', async () => {
    // #3 丙 5000-6000，候选移到 6500-7500（当前合法）
    const sub = await call('POST', `/api/works/${propWorkId}/cues/${pIds[3]}/proposals`, {
      revision: 4, start: '00:00:06,500', end: '00:00:07,500', text: '丙移后',
    });
    assert.strictEqual(sub.status, 201, JSON.stringify(sub.json));
    p3 = sub.json.proposal;

    // 他人把 #2 乙改到 7000-8000：rev 4 -> 5，恰好挡住候选区间
    const edit = await call('PUT', `/api/works/${propWorkId}/cues/${pIds[2]}`, {
      revision: 4, start: '00:00:07,000', end: '00:00:08,000', text: '乙挡住',
    });
    assert.strictEqual(edit.status, 200, JSON.stringify(edit.json));

    const acc = await call('POST', `/api/works/${propWorkId}/proposals/${p3.id}/accept`, {});
    assert.strictEqual(acc.status, 409);
    assert.strictEqual(acc.json.error, 'proposal_conflict');
    assert.strictEqual(acc.json.reason, 'overlap');
    assert.strictEqual(acc.json.overlap_with.id, pIds[2]);
    assert.strictEqual(acc.json.proposal.status, 'pending');

    const d = await call('GET', `/api/works/${propWorkId}`);
    assert.strictEqual(d.json.work.revision, 5, '交叠冲突不应推进修订号');
    const bing = d.json.cues.find((c) => c.id === pIds[3]);
    assert.strictEqual(bing.start, '00:00:05,000', '正式段不应被写入');
    assert.strictEqual(bing.text, '丙');
  });

  await test('驳回：只结案，正式段与修订号不变；结案后不可再处理', async () => {
    const r = await call('POST', `/api/works/${propWorkId}/proposals/${p3.id}/reject`, { editor: '审阅乙' });
    assert.strictEqual(r.status, 200, JSON.stringify(r.json));
    assert.strictEqual(r.json.proposal.status, 'rejected');
    assert.strictEqual(r.json.proposal.reviewer, '审阅乙');
    assert.ok(r.json.proposal.resolved_at, '应记录结案时间');

    const d = await call('GET', `/api/works/${propWorkId}`);
    assert.strictEqual(d.json.work.revision, 5, '驳回不应推进修订号');
    const bing = d.json.cues.find((c) => c.id === pIds[3]);
    assert.strictEqual(bing.text, '丙', '驳回不应改动正式段');

    const again = await call('POST', `/api/works/${propWorkId}/proposals/${p3.id}/reject`, {});
    assert.strictEqual(again.status, 409);
    assert.strictEqual(again.json.error, 'proposal_closed');

    const acc = await call('POST', `/api/works/${propWorkId}/proposals/${p3.id}/accept`, {});
    assert.strictEqual(acc.status, 409);
    assert.strictEqual(acc.json.error, 'proposal_closed');
  });

  await test('待审区列表：状态过滤与非法状态 400；不存在的提案 404', async () => {
    // 清理：把仍待审的 p2 驳回
    const rej = await call('POST', `/api/works/${propWorkId}/proposals/${p2.id}/reject`, {});
    assert.strictEqual(rej.status, 200, JSON.stringify(rej.json));

    const pending = await listProposals('?status=pending');
    assert.strictEqual(pending.length, 0);
    const accepted = await listProposals('?status=accepted');
    assert.deepStrictEqual(accepted.map((x) => x.id), [p1.id]);
    const rejected = await listProposals('?status=rejected');
    assert.deepStrictEqual(rejected.map((x) => x.id).sort(), [p2.id, p3.id].sort());
    const all = await listProposals('?status=all');
    assert.strictEqual(all.length, 3);

    const bad = await call('GET', `/api/works/${propWorkId}/proposals?status=nope`);
    assert.strictEqual(bad.status, 400);
    assert.strictEqual(bad.json.error, 'invalid_status');

    const missing = await call('POST', `/api/works/${propWorkId}/proposals/999999/accept`, {});
    assert.strictEqual(missing.status, 404);
    assert.strictEqual(missing.json.error, 'proposal_not_found');

    const noWork = await call('GET', '/api/works/999999/proposals');
    assert.strictEqual(noWork.status, 404);
  });

  /* ---------------- 离线校订包 ---------------- */

  const {
    parseReviewPackage,
    planReview,
    serializeReviewPackage,
    newPackageId,
  } = require('../src/review');

  test('校订包：parseReviewPackage 拒绝非 JSON/格式/版本/字段非法', () => {
    const expectInvalid = (input, field) => {
      let threw = false;
      try {
        parseReviewPackage(input);
      } catch (e) {
        threw = true;
        assert.ok(e.name === 'ReviewPackageError');
        if (field) assert.strictEqual(e.field, field, `field 应为 ${field}，实际 ${e.field}`);
      }
      assert.ok(threw, '应拒绝非法校订包');
    };
    expectInvalid('{bad');
    expectInvalid({ format: 'other', version: 1, work_id: 1, package_id: 'rv_abcd1234', cues: [{}] }, 'format');
    expectInvalid({ format: 'srt-review-package', version: 9, work_id: 1, package_id: 'rv_abcd1234', cues: [] }, 'version');
    expectInvalid({ format: 'srt-review-package', version: 1, work_id: 0, package_id: 'rv_abcd1234', cues: [] }, 'work_id');
    expectInvalid({ format: 'srt-review-package', version: 1, work_id: 1, package_id: 'bad id', cues: [] }, 'package_id');
    expectInvalid({ format: 'srt-review-package', version: 1, work_id: 1, package_id: 'rv_abcd1234', cues: [] });
    expectInvalid({ format: 'srt-review-package', version: 1, work_id: 1, package_id: 'rv_abcd1234',
      cues: [{ cue_id: 'x', start: '00:00:01,000', end: '00:00:02,000', text: 'a' }] });
    expectInvalid({ format: 'srt-review-package', version: 1, work_id: 1, package_id: 'rv_abcd1234',
      cues: [{ cue_id: 1, start: 'bad', end: '00:00:02,000', text: 'a' }] });
    expectInvalid({ format: 'srt-review-package', version: 1, work_id: 1, package_id: 'rv_abcd1234',
      cues: [{ cue_id: 1, start: '00:00:01,000', end: '00:00:02,000', text: '  ' }] });
    // 重复段 ID
    expectInvalid({ format: 'srt-review-package', version: 1, work_id: 1, package_id: 'rv_abcd1234',
      cues: [
        { cue_id: 1, start: '00:00:01,000', end: '00:00:02,000', text: 'a' },
        { cue_id: 1, start: '00:00:03,000', end: '00:00:04,000', text: 'b' },
      ] });
  });

  test('校订包：合法包解析，支持负时间与 text_lines', () => {
    const parsed = parseReviewPackage({
      format: 'srt-review-package', version: 1, work_id: 7, package_id: 'rv_abcd1234',
      cues: [
        { cue_id: 1, start: '-00:00:00,500', end: '00:00:01,000', text_lines: ['第一行', '第二行'] },
      ],
    });
    assert.strictEqual(parsed.work_id, 7);
    assert.strictEqual(parsed.cues[0].startMs, -500);
    assert.strictEqual(parsed.cues[0].text, '第一行\n第二行');
  });

  test('校订包 planReview：未改段不覆盖（即使正式段已漂移）、改过段冲突/违例分类', () => {
    // 基线：#1 1-2 甲 #2 3-4 乙 #3 5-6 丙
    const baselines = [
      { cue_id: 1, start_ms: 1000, end_ms: 2000, text: '甲' },
      { cue_id: 2, start_ms: 3000, end_ms: 4000, text: '乙' },
      { cue_id: 3, start_ms: 5000, end_ms: 6000, text: '丙' },
    ];
    // 正式段：#2 已被在线改成 3-3.5 乙二；#3 已被删除（缺失）
    const currentCues = [
      { id: 1, idx: 1, start_ms: 1000, end_ms: 2000, text: '甲' },
      { id: 2, idx: 2, start_ms: 3000, end_ms: 3500, text: '乙二' },
    ];
    const parsed = parseReviewPackage({
      format: 'srt-review-package', version: 1, work_id: 1, package_id: 'rv_abcd1234',
      cues: [
        { cue_id: 1, start: '00:00:01,000', end: '00:00:02,000', text: '甲改' },        // 改过，干净
        { cue_id: 2, start: '00:00:03,000', end: '00:00:04,000', text: '乙' },          // 未改但正式段已漂移
        { cue_id: 3, start: '00:00:05,000', end: '00:00:06,000', text: '丙改' },        // 改过但段缺失
        { cue_id: 9, start: '00:00:01,000', end: '00:00:02,000', text: '外来' },        // 不在基线
      ],
    });
    const plan = planReview({ currentCues, baselines, pkgCues: parsed.cues });
    assert.strictEqual(plan.changed_count, 2);
    assert.strictEqual(plan.unchanged_count, 2);
    assert.deepStrictEqual(plan.unchanged_drifted, [2]);
    const reasons = new Map(plan.conflicts.map((c) => [c.cue_id, c.reason]));
    assert.strictEqual(reasons.get(3), 'target_missing');
    assert.strictEqual(reasons.get(9), 'baseline_missing');
    assert.strictEqual(plan.valid, false);
  });

  test('校订包 planReview：负时间/无效区间/交叠（含整批候选彼此交叠）', () => {
    const baselines = [
      { cue_id: 1, start_ms: 1000, end_ms: 2000, text: '甲' },
      { cue_id: 2, start_ms: 3000, end_ms: 4000, text: '乙' },
      { cue_id: 3, start_ms: 5000, end_ms: 6000, text: '丙' },
    ];
    const currentCues = baselines.map((b, i) => ({ id: b.cue_id, idx: i + 1, ...b }));
    const mk = (cues) => planReview({
      currentCues,
      baselines,
      pkgCues: parseReviewPackage({
        format: 'srt-review-package', version: 1, work_id: 1, package_id: 'rv_abcd1234', cues,
      }).cues,
    });
    // 负起点
    let plan = mk([
      { cue_id: 1, start: '-00:00:00,200', end: '00:00:00,500', text: '甲' },
      { cue_id: 2, start: '00:00:03,000', end: '00:00:04,000', text: '乙' },
      { cue_id: 3, start: '00:00:05,000', end: '00:00:06,000', text: '丙' },
    ]);
    assert.strictEqual(plan.issues.some((i) => i.type === 'negative_time'), true);
    assert.strictEqual(plan.valid, false);
    // 无效区间
    plan = mk([
      { cue_id: 1, start: '00:00:05,000', end: '00:00:01,000', text: '甲' },
      { cue_id: 2, start: '00:00:03,000', end: '00:00:04,000', text: '乙' },
      { cue_id: 3, start: '00:00:05,000', end: '00:00:06,000', text: '丙' },
    ]);
    assert.strictEqual(plan.issues.some((i) => i.type === 'invalid_range'), true);
    // 与未改正式段交叠
    plan = mk([
      { cue_id: 1, start: '00:00:03,500', end: '00:00:04,500', text: '甲' },
      { cue_id: 2, start: '00:00:03,000', end: '00:00:04,000', text: '乙' },
      { cue_id: 3, start: '00:00:05,000', end: '00:00:06,000', text: '丙' },
    ]);
    assert.strictEqual(plan.issues.some((i) => i.type === 'overlap'), true);
    // 两个改过的候选彼此交叠
    plan = mk([
      { cue_id: 1, start: '00:00:07,000', end: '00:00:08,000', text: '甲' },
      { cue_id: 2, start: '00:00:07,500', end: '00:00:09,000', text: '乙' },
      { cue_id: 3, start: '00:00:05,000', end: '00:00:06,000', text: '丙' },
    ]);
    assert.ok(plan.issues.some((i) => i.type === 'overlap'));
    assert.strictEqual(plan.valid, false);
    // 首尾相接允许，全部合法
    plan = mk([
      { cue_id: 1, start: '00:00:02,000', end: '00:00:03,000', text: '甲' },
      { cue_id: 2, start: '00:00:03,000', end: '00:00:04,000', text: '乙' },
      { cue_id: 3, start: '00:00:05,000', end: '00:00:06,000', text: '丙' },
    ]);
    assert.deepStrictEqual(plan.issues, []);
    assert.strictEqual(plan.valid, true);
  });

  test('校订包：serializeReviewPackage 往返稳定，package_id 合法', () => {
    const uid = newPackageId();
    assert.match(uid, /^rv_[A-Za-z0-9_-]{4,}$/);
    const file = serializeReviewPackage({
      package_id: uid, work_id: 1, base_revision: 1,
      cues: [{ cue_id: 1, start_ms: 1000, end_ms: 2000, text: '甲\n第二行' }],
    });
    const parsed = parseReviewPackage(file);
    assert.strictEqual(parsed.package_id, uid);
    assert.strictEqual(parsed.cues[0].text, '甲\n第二行');
  });

  // 新作品跑 HTTP 全流程：#1 1-2 甲 #2 3-4 乙 #3 5-6 丙
  const REVIEW_SRT =
    '1\n00:00:01,000 --> 00:00:02,000\n甲\n\n' +
    '2\n00:00:03,000 --> 00:00:04,000\n乙\n\n' +
    '3\n00:00:05,000 --> 00:00:06,000\n丙\n';
  let reviewWorkId;
  let rvIds = {};
  let pkg1Content;
  let pkg1Uid;

  const patchPkg = (content, cueId, patch) => {
    const p = JSON.parse(content);
    const c = p.cues.find((x) => x.cue_id === cueId);
    Object.assign(c, patch);
    return JSON.stringify(p);
  };

  await test('校订包 HTTP：上传作品并发包，包含作品/包标识、段 ID 与多行文字，基线入库', async () => {
    const up = await call('POST', '/api/works', { title: '离线片', filename: 'rv.srt', content: REVIEW_SRT });
    assert.strictEqual(up.status, 201, JSON.stringify(up.json));
    reviewWorkId = up.json.id;
    const d = await call('GET', `/api/works/${reviewWorkId}`);
    [1, 2, 3].forEach((i) => { rvIds[i] = byIdx(d.json.cues, i).id; });

    const r = await call('POST', `/api/works/${reviewWorkId}/review-packages`, { editor: '校对甲' });
    assert.strictEqual(r.status, 201, JSON.stringify(r.json));
    assert.strictEqual(r.json.package.status, 'issued');
    assert.strictEqual(r.json.package.base_revision, 1);
    assert.strictEqual(r.json.package.cue_count, 3);
    pkg1Uid = r.json.package.package_id;
    pkg1Content = r.json.content;
    const file = JSON.parse(r.json.content);
    assert.strictEqual(file.format, 'srt-review-package');
    assert.strictEqual(file.work_id, reviewWorkId);
    assert.strictEqual(file.package_id, pkg1Uid);
    assert.deepStrictEqual(file.cues.map((c) => c.cue_id).sort(), [rvIds[1], rvIds[2], rvIds[3]].sort());
    // 发包不推进修订号
    const d2 = await call('GET', `/api/works/${reviewWorkId}`);
    assert.strictEqual(d2.json.work.revision, 1);
  });

  await test('校订包 HTTP：文件下载与发包记录列表', async () => {
    const res = await fetch(`${base}/api/works/${reviewWorkId}/review-packages/${pkg1Uid}/file`);
    assert.strictEqual(res.status, 200);
    assert.ok(res.headers.get('content-disposition').includes('.review.json'));
    const file = JSON.parse(await res.text());
    assert.strictEqual(file.package_id, pkg1Uid);

    const list = await call('GET', `/api/works/${reviewWorkId}/review-packages?status=all`);
    assert.strictEqual(list.status, 200);
    assert.strictEqual(list.json.packages.length, 1);
    assert.strictEqual(list.json.packages[0].package_id, pkg1Uid);
  });

  await test('校订包 HTTP：预览逐段差异，改 1 段、其余未改', async () => {
    const content = patchPkg(pkg1Content, rvIds[1], { text: '甲离线\n第二行' });
    const r = await call('POST', `/api/works/${reviewWorkId}/review-packages/preview`, { content });
    assert.strictEqual(r.status, 200, JSON.stringify(r.json));
    assert.strictEqual(r.json.valid, true);
    assert.strictEqual(r.json.changed_count, 1);
    assert.strictEqual(r.json.unchanged_count, 2);
    assert.deepStrictEqual(r.json.conflicts, []);
    assert.deepStrictEqual(r.json.issues, []);
    const e1 = r.json.cues.find((c) => c.cue_id === rvIds[1]);
    assert.strictEqual(e1.changed, true);
    assert.strictEqual(e1.candidate.text, '甲离线\n第二行');
    assert.strictEqual(e1.baseline.text, '甲');
  });

  await test('校订包 HTTP：确认应用成功——只写改过的段、修订号 +1、序号重排、包标记已用', async () => {
    // #1 移到 07-08 以触发序号重排，#2/#3 未改
    let content = patchPkg(pkg1Content, rvIds[1], {
      start: '00:00:07,000', end: '00:00:08,000', text: '甲离线',
    });
    // 同时确认多行文字也能写入
    content = patchPkg(content, rvIds[3], { text: '丙改\n第二行' });
    const r = await call('POST', `/api/works/${reviewWorkId}/review-packages/${pkg1Uid}/apply`, {
      content, editor: '校对甲',
    });
    assert.strictEqual(r.status, 200, JSON.stringify(r.json));
    assert.strictEqual(r.json.revision, 2);
    assert.strictEqual(r.json.applied_count, 2);
    // 重排：乙(3-4)、丙(5-6)、甲(7-8)
    assert.deepStrictEqual(r.json.cues.map((c) => c.id), [rvIds[2], rvIds[3], rvIds[1]]);
    r.json.cues.forEach((c, i) => assert.strictEqual(c.idx, i + 1));
    const jia = r.json.cues.find((c) => c.id === rvIds[1]);
    assert.strictEqual(jia.text, '甲离线');
    const bing = r.json.cues.find((c) => c.id === rvIds[3]);
    assert.strictEqual(bing.text, '丙改\n第二行');

    const p = await call('GET', `/api/works/${reviewWorkId}/review-packages?status=all`);
    assert.strictEqual(p.json.packages.find((x) => x.package_id === pkg1Uid).status, 'used');

    const exp = await fetch(`${base}/api/works/${reviewWorkId}/export`);
    const body = await exp.text();
    assert.ok(body.includes('00:00:07,000 --> 00:00:08,000\n甲离线'));
    assert.ok(/1\n00:00:03,000 --> 00:00:04,000\n乙/.test(body), '导出按新正式内容从 1 编号');
  });

  await test('校订包 HTTP：重复确认被拒绝（409 package_used）', async () => {
    const r = await call('POST', `/api/works/${reviewWorkId}/review-packages/${pkg1Uid}/apply`, {
      content: pkg1Content,
    });
    assert.strictEqual(r.status, 409);
    assert.strictEqual(r.json.error, 'package_used');
    // 已用包的预览也标出 used
    const pv = await call('POST', `/api/works/${reviewWorkId}/review-packages/preview`, {
      content: pkg1Content,
    });
    assert.strictEqual(pv.status, 200);
    assert.strictEqual(pv.json.used, true);
    assert.strictEqual(pv.json.valid, false);
  });

  await test('校订包 HTTP：新包针对已漂移作品——未改段保持正式值，改过且干净的段照常写入', async () => {
    // 当前 rev2：乙 3-4、丙 5-6（丙改/第二行）、甲 7-8
    const issue = await call('POST', `/api/works/${reviewWorkId}/review-packages`, {});
    assert.strictEqual(issue.status, 201);
    const uid2 = issue.json.package.package_id;
    const base2 = issue.json.content;
    // 离线只改乙；丙、甲未改
    const content = patchPkg(base2, rvIds[2], { text: '乙离线' });
    const pv = await call('POST', `/api/works/${reviewWorkId}/review-packages/preview`, { content });
    assert.strictEqual(pv.json.valid, true);
    assert.deepStrictEqual(pv.json.unchanged_drifted, []);
    assert.strictEqual(pv.json.changed_count, 1);

    // 他人在确认前先改了「甲」（未改段）：修订号推进，但不应影响本包应用
    const other = await call('PUT', `/api/works/${reviewWorkId}/cues/${rvIds[1]}`, {
      revision: 2, start: '00:00:07,000', end: '00:00:08,500', text: '甲在线改',
    });
    assert.strictEqual(other.status, 200, JSON.stringify(other.json));

    const pv2 = await call('POST', `/api/works/${reviewWorkId}/review-packages/preview`, { content });
    assert.strictEqual(pv2.json.valid, true, JSON.stringify(pv2.json.issues));
    assert.deepStrictEqual(pv2.json.unchanged_drifted, [rvIds[1]]);

    const r = await call('POST', `/api/works/${reviewWorkId}/review-packages/${uid2}/apply`, { content });
    assert.strictEqual(r.status, 200, JSON.stringify(r.json));
    assert.strictEqual(r.json.revision, 4);
    const yi = r.json.cues.find((c) => c.id === rvIds[2]);
    assert.strictEqual(yi.text, '乙离线');
    const jia = r.json.cues.find((c) => c.id === rvIds[1]);
    assert.strictEqual(jia.text, '甲在线改', '未改段不应被离线包覆盖');
  });

  await test('校订包 HTTP：改过的目标段已在线变化 -> 整包不写，返回段 ID 与原因，包仍可预览', async () => {
    const issue = await call('POST', `/api/works/${reviewWorkId}/review-packages`, {});
    const uid3 = issue.json.package.package_id;
    // rev4 时间线：乙 3-4 乙离线、丙 5-6 丙改/第二行、甲 7-8.5 甲在线改
    const content = patchPkg(issue.json.content, rvIds[2], { text: '乙离线再改' });

    // 他人抢先改了乙
    const other = await call('PUT', `/api/works/${reviewWorkId}/cues/${rvIds[2]}`, {
      revision: 4, start: '00:00:03,000', end: '00:00:04,000', text: '乙在线抢先',
    });
    assert.strictEqual(other.status, 200);

    const pv = await call('POST', `/api/works/${reviewWorkId}/review-packages/preview`, { content });
    assert.strictEqual(pv.json.valid, false);
    assert.strictEqual(pv.json.conflicts[0].cue_id, rvIds[2]);
    assert.strictEqual(pv.json.conflicts[0].reason, 'target_changed');

    const ap = await call('POST', `/api/works/${reviewWorkId}/review-packages/${uid3}/apply`, { content });
    assert.strictEqual(ap.status, 409);
    assert.strictEqual(ap.json.error, 'review_conflict');
    assert.strictEqual(ap.json.conflicts[0].cue_id, rvIds[2]);
    assert.strictEqual(ap.json.conflicts[0].reason, 'target_changed');

    const d = await call('GET', `/api/works/${reviewWorkId}`);
    assert.strictEqual(d.json.work.revision, 5, '冲突整包不写，修订号不推进');
    assert.strictEqual(byIdx(d.json.cues, 1).text, '乙在线抢先');

    // 包仍是 issued，可重新预览
    const list = await call('GET', `/api/works/${reviewWorkId}/review-packages?status=all`);
    assert.strictEqual(list.json.packages.find((x) => x.package_id === uid3).status, 'issued');
    const rePv = await call('POST', `/api/works/${reviewWorkId}/review-packages/preview`, { content });
    assert.strictEqual(rePv.status, 200);
  });

  await test('校订包 HTTP：整批违例（负时间/无效区间/交叠）422 预览、确认 409 整包不写', async () => {
    const issue = await call('POST', `/api/works/${reviewWorkId}/review-packages`, {});
    const uid4 = issue.json.package.package_id;
    // rev5：乙 3-4、丙 5-6、甲 7-8.5
    const neg = patchPkg(issue.json.content, rvIds[2], { start: '-00:00:00,100', end: '00:00:00,500' });
    const pvNeg = await call('POST', `/api/works/${reviewWorkId}/review-packages/preview`, { content: neg });
    assert.strictEqual(pvNeg.json.valid, false);
    assert.strictEqual(pvNeg.json.issues[0].type, 'negative_time');

    const ov = patchPkg(issue.json.content, rvIds[1], {
      start: '00:00:05,500', end: '00:00:06,500', text: '甲移到丙上',
    });
    const pvOv = await call('POST', `/api/works/${reviewWorkId}/review-packages/preview`, { content: ov });
    assert.ok(pvOv.json.issues.some((i) => i.type === 'overlap'));
    assert.ok(pvOv.json.issues[0].cue_ids.includes(rvIds[3]));

    const ap = await call('POST', `/api/works/${reviewWorkId}/review-packages/${uid4}/apply`, { content: ov });
    assert.strictEqual(ap.status, 409);
    assert.strictEqual(ap.json.error, 'review_conflict');
    const d = await call('GET', `/api/works/${reviewWorkId}`);
    assert.strictEqual(d.json.work.revision, 5);
  });

  await test('校订包 HTTP：无效包/跨作品包/字段非法明确拒绝且不写入', async () => {
    // 非 JSON 文本
    const badJson = await call('POST', `/api/works/${reviewWorkId}/review-packages/preview`, {
      content: '{不是合法json',
    });
    assert.strictEqual(badJson.status, 400, JSON.stringify(badJson.json));
    assert.strictEqual(badJson.json.error, 'invalid_package', JSON.stringify(badJson.json));

    // format 错误
    const badFmt = await call('POST', `/api/works/${reviewWorkId}/review-packages/preview`, {
      content: JSON.stringify({ format: 'nope', version: 1, work_id: reviewWorkId, package_id: pkg1Uid, cues: [] }),
    });
    assert.strictEqual(badFmt.status, 400);
    assert.strictEqual(badFmt.json.error, 'invalid_package');

    // 时间字段非法
    const badField = await call('POST', `/api/works/${reviewWorkId}/review-packages/preview`, {
      content: JSON.stringify({
        format: 'srt-review-package', version: 1, work_id: reviewWorkId,
        package_id: 'rv_abcd1234', cues: [{ cue_id: 1, start: '一秒', end: '00:00:02,000', text: 'a' }],
      }),
    });
    assert.strictEqual(badField.status, 400);
    assert.strictEqual(badField.json.error, 'invalid_package');

    // 未知包标识
    const unknown = await call('POST', `/api/works/${reviewWorkId}/review-packages/preview`, {
      content: JSON.stringify({
        format: 'srt-review-package', version: 1, work_id: reviewWorkId,
        package_id: 'rv_notfound00', cues: [{ cue_id: 1, start: '00:00:01,000', end: '00:00:02,000', text: 'a' }],
      }),
    });
    assert.strictEqual(unknown.status, 404);
    assert.strictEqual(unknown.json.error, 'package_not_found');

    // 跨作品：构造属于另一作品的包，发到当前作品
    const otherUp = await call('POST', '/api/works', {
      title: '别的片', filename: 'o.srt',
      content: '1\n00:00:01,000 --> 00:00:02,000\nX\n',
    });
    const otherIssue = await call('POST', `/api/works/${otherUp.json.id}/review-packages`, {});
    const cross = await call('POST', `/api/works/${reviewWorkId}/review-packages/preview`, {
      content: otherIssue.json.content,
    });
    assert.strictEqual(cross.status, 400);
    assert.strictEqual(cross.json.error, 'cross_work_package');
    assert.strictEqual(cross.json.package_work_id, otherUp.json.id);

    // 跨作品确认（路径 uid 属于别的作品）
    const crossApply = await call(
      'POST',
      `/api/works/${reviewWorkId}/review-packages/${otherIssue.json.package.package_id}/apply`,
      { content: otherIssue.json.content }
    );
    assert.strictEqual(crossApply.status, 400);
    assert.strictEqual(crossApply.json.error, 'cross_work_package');

    // 路径 uid 与文件内 package_id 不一致
    const ownIssue = await call('POST', `/api/works/${reviewWorkId}/review-packages`, {});
    const tampered = (() => {
      const p = JSON.parse(ownIssue.json.content);
      p.package_id = 'rv_tampered000';
      return JSON.stringify(p);
    })();
    const mismatch = await call(
      'POST',
      `/api/works/${reviewWorkId}/review-packages/${ownIssue.json.package.package_id}/apply`,
      { content: tampered }
    );
    assert.strictEqual(mismatch.status, 400);
    assert.strictEqual(mismatch.json.error, 'package_mismatch');

    // 非法请求不推进修订号
    const d = await call('GET', `/api/works/${reviewWorkId}`);
    assert.strictEqual(d.json.work.revision, 5);
  });

  await test('校订包 HTTP：无任何改动确认返回 422 no_changes', async () => {
    const issue = await call('POST', `/api/works/${reviewWorkId}/review-packages`, {});
    const r = await call(
      'POST',
      `/api/works/${reviewWorkId}/review-packages/${issue.json.package.package_id}/apply`,
      { content: issue.json.content }
    );
    assert.strictEqual(r.status, 422);
    assert.strictEqual(r.json.error, 'no_changes');
  });

  await test('持久化：用 openDb 重新打开文件，数据与修订号都在', async () => {
    const { openDb } = require('../src/db');
    const db2 = await openDb(process.env.DB_PATH);
    const w = db2.prepare('SELECT title, revision FROM works WHERE id = ?').get(1);
    assert.ok(w, '重开后应能读到作品');
    assert.ok(w.revision >= 4, `修订号应为并发后的 >=4，实际 ${w.revision}`);
    const n = db2.prepare('SELECT COUNT(*) AS n FROM cues WHERE work_id = ?').get(1);
    assert.strictEqual(n.n, 2);
  });

  await test('删除作品后列表与详情都消失', async () => {
    const r = await call('DELETE', '/api/works/1');
    assert.strictEqual(r.status, 200);
    const detail = await call('GET', '/api/works/1');
    assert.strictEqual(detail.status, 404);
  });

  await new Promise((resolve) => server.close(resolve));

  if (process.exitCode) {
    console.log(`\n有失败用例；通过 ${passed} 个。`);
  } else {
    console.log(`\n全部 ${passed} 个用例通过。`);
  }
}

main().catch((err) => {
  console.error(err);
  process.exit(1);
});
