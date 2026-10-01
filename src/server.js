'use strict';

/**
 * 多人字幕校订 HTTP 服务。
 *
 * 并发模型：每次编辑携带作品修订号（乐观锁）。
 * 过期提交 -> 409，并返回最新修订号与目标字幕段，供前端人工重试。
 */

const path = require('path');
const express = require('express');
const { openDb } = require('./db');
const {
  SrtError,
  parseSrt,
  parseTimeToMs,
  formatMs,
  serializeSrt,
} = require('./srt');
const { planShift } = require('./shift');

const PORT = parseInt(process.env.PORT || '3000', 10);
const DB_PATH = process.env.DB_PATH || path.join(__dirname, '..', 'data', 'subtitles.db');
const MAX_TEXT_LEN = 10000;
const MAX_TITLE_LEN = 200;
const MAX_NOTE_LEN = 1000;

// sql.js 需要先加载 wasm，所有请求处理都会 await 此 promise
const dbReady = openDb(DB_PATH).then((instance) => {
  db = instance;
  /** 按开始时间重排作品内全部字幕段的展示序号 */
  reindexCues = db.transaction((workId) => {
    const rows = db
      .prepare('SELECT id FROM cues WHERE work_id = ? ORDER BY start_ms, end_ms, id')
      .all(workId);
    const stmt = db.prepare('UPDATE cues SET idx = ? WHERE id = ?');
    rows.forEach((r, i) => stmt.run(i + 1, r.id));
  });
  return db;
});
let db;
let reindexCues;
const app = express();

app.use(async (req, res, next) => {
  try {
    await dbReady;
    next();
  } catch (err) {
    next(err);
  }
});
app.use(express.json({ limit: '6mb' }));
app.use(express.static(path.join(__dirname, '..', 'public')));

/* ------------------------------------------------------------------ */
/* 工具函数                                                            */
/* ------------------------------------------------------------------ */

class HttpError extends Error {
  constructor(status, code, message, extra = {}) {
    super(message);
    this.status = status;
    this.code = code;
    this.extra = extra;
  }
}

function cueRow(row) {
  return {
    id: row.id,
    idx: row.idx,
    start_ms: row.start_ms,
    end_ms: row.end_ms,
    start: formatMs(row.start_ms),
    end: formatMs(row.end_ms),
    text: row.text,
  };
}

function getWorkOr404(workId) {
  const work = db.prepare('SELECT * FROM works WHERE id = ?').get(workId);
  if (!work) throw new HttpError(404, 'not_found', '作品不存在');
  return work;
}

function normalizeText(text) {
  if (typeof text !== 'string') {
    throw new HttpError(400, 'invalid_text', '字幕文字必须是字符串');
  }
  const t = text.replace(/\r\n?/g, '\n').replace(/\n+$/, '');
  if (t.trim() === '') {
    throw new HttpError(400, 'invalid_text', '字幕文字不能为空');
  }
  if (t.length > MAX_TEXT_LEN) {
    throw new HttpError(400, 'invalid_text', `字幕文字过长（上限 ${MAX_TEXT_LEN} 字）`);
  }
  return t;
}

/**
 * 解析并校验单段保存/候选提案共用的载荷：多行文字 + 起止时间。
 * 返回 { text, startMs, endMs }；非法时抛出与单段保存一致的错误码。
 */
function parseCuePayload(body) {
  const text = normalizeText(body && body.text);

  const startMs = parseTimeToMs(String((body && body.start) ?? ''));
  const endMs = parseTimeToMs(String((body && body.end) ?? ''));
  if (startMs === null || endMs === null) {
    throw new HttpError(
      400,
      'invalid_time',
      '时间格式应为 HH:MM:SS,mmm（例如 00:01:23,500）'
    );
  }
  if (startMs < 0 || endMs < 0) {
    throw new HttpError(422, 'negative_time', '时间不能为负数');
  }
  if (endMs <= startMs) {
    throw new HttpError(422, 'invalid_range', '结束时间必须晚于开始时间');
  }
  return { text, startMs, endMs };
}

/** 选填说明：去空白、限长；空串视为未填写 */
function normalizeNote(note) {
  if (note === undefined || note === null) return null;
  if (typeof note !== 'string') {
    throw new HttpError(400, 'invalid_note', '说明必须是字符串');
  }
  const t = note.replace(/\r\n?/g, '\n').trim();
  if (!t) return null;
  if (t.length > MAX_NOTE_LEN) {
    throw new HttpError(400, 'invalid_note', `说明过长（上限 ${MAX_NOTE_LEN} 字）`);
  }
  return t;
}

/** 选填署名（提交者/审阅者通用），与既有单段保存一致：限 80 字 */
function normalizeEditor(editor) {
  return typeof editor === 'string' && editor.trim() ? editor.trim().slice(0, 80) : null;
}

/**
 * 提案对外视图：原值（提交时快照）、候选值、当前正式值三者并列，
 * changed 标记当前正式值是否已偏离快照（审阅时的冲突预警）。
 */
function proposalRow(row, currentCue) {
  const current = currentCue ? cueRow(currentCue) : null;
  const changed =
    !currentCue ||
    currentCue.start_ms !== row.orig_start_ms ||
    currentCue.end_ms !== row.orig_end_ms ||
    currentCue.text !== row.orig_text;
  return {
    id: row.id,
    work_id: row.work_id,
    cue_id: row.cue_id,
    status: row.status,
    base_revision: row.base_revision,
    editor: row.editor,
    reviewer: row.reviewer,
    note: row.note,
    created_at: row.created_at,
    resolved_at: row.resolved_at,
    snapshot: {
      start_ms: row.orig_start_ms,
      end_ms: row.orig_end_ms,
      start: formatMs(row.orig_start_ms),
      end: formatMs(row.orig_end_ms),
      text: row.orig_text,
    },
    candidate: {
      start_ms: row.new_start_ms,
      end_ms: row.new_end_ms,
      start: formatMs(row.new_start_ms),
      end: formatMs(row.new_end_ms),
      text: row.new_text,
    },
    current,
    changed,
  };
}

/** 同一作品内与 [startMs, endMs) 交叠的其他字幕段（半开区间，首尾相接允许） */
function findOverlapCue(workId, excludeCueId, startMs, endMs) {
  return db
    .prepare(
      `SELECT id, idx, start_ms, end_ms FROM cues
        WHERE work_id = ? AND id != ? AND start_ms < ? AND end_ms > ?
        ORDER BY start_ms, id
        LIMIT 1`
    )
    .get(workId, excludeCueId, endMs, startMs);
}

/**
 * 解析并校验批量平移请求的公共部分：修订号、段选择、有符号整数毫秒偏移。
 * 返回 { revision, offsetMs, cueIds }；段是否存在/属于该作品由调用方在
 * 事务内结合最新数据检查。
 */
function parseShiftBody(body) {
  const b = body || {};

  if (!Number.isInteger(b.revision) || b.revision < 1) {
    throw new HttpError(400, 'invalid_revision', '缺少有效的作品修订号');
  }

  // 偏移量必须是整数毫秒：拒绝数字非整数、数字字符串非整数及其他类型
  const rawOffset = b.offset_ms;
  let offsetMs;
  if (typeof rawOffset === 'number') {
    offsetMs = rawOffset;
  } else if (typeof rawOffset === 'string' && /^\s*[+-]?\d+\s*$/.test(rawOffset)) {
    offsetMs = Number(rawOffset.trim());
  } else {
    throw new HttpError(400, 'invalid_offset', '偏移量必须是有符号整数毫秒（例如 -500 或 120）');
  }
  if (!Number.isInteger(offsetMs)) {
    throw new HttpError(400, 'invalid_offset', '偏移量必须是整数毫秒，不接受小数');
  }
  if (!Number.isSafeInteger(offsetMs)) {
    throw new HttpError(400, 'invalid_offset', '偏移量超出可表示范围');
  }

  if (!Array.isArray(b.cue_ids)) {
    throw new HttpError(400, 'invalid_selection', 'cue_ids 必须是字幕段 ID 数组');
  }
  if (b.cue_ids.length === 0) {
    throw new HttpError(400, 'empty_selection', '请至少选择一个字幕段');
  }
  const cueIds = [];
  for (const v of b.cue_ids) {
    if (!Number.isInteger(v) || v < 1) {
      throw new HttpError(400, 'invalid_selection', '字幕段 ID 必须是正整数');
    }
    if (cueIds.includes(v)) {
      throw new HttpError(400, 'duplicate_cue', `字幕段 ID ${v} 在选择中重复出现`);
    }
    cueIds.push(v);
  }

  return { revision: b.revision, offsetMs, cueIds };
}

/** 按 ID 列表取出作品内全部存在的字幕段；不存在或不属于该作品则 404 */
function loadCuesForShift(workId, cueIds) {
  const rows = db
    .prepare('SELECT * FROM cues WHERE work_id = ? ORDER BY idx, id')
    .all(workId);
  const byId = new Map(rows.map((r) => [r.id, r]));
  const missing = cueIds.filter((id) => !byId.has(id));
  if (missing.length > 0) {
    throw new HttpError(
      404,
      'cue_not_found',
      `以下字幕段不存在或不属于该作品：${missing.join('、')}`,
      { cue_ids: missing }
    );
  }
  return rows;
}

/* ------------------------------------------------------------------ */
/* 作品：列表 / 详情 / 删除                                            */
/* ------------------------------------------------------------------ */

app.get('/api/works', (req, res) => {
  const works = db
    .prepare(
      `SELECT w.id, w.title, w.filename, w.revision, w.created_at, w.updated_at,
              COUNT(c.id) AS cue_count
         FROM works w
         LEFT JOIN cues c ON c.work_id = w.id
        GROUP BY w.id
        ORDER BY w.updated_at DESC, w.id DESC`
    )
    .all();
  res.json({ works });
});

app.get('/api/works/:id', (req, res, next) => {
  try {
    const work = getWorkOr404(req.params.id);
    const cues = db
      .prepare('SELECT * FROM cues WHERE work_id = ? ORDER BY idx, id')
      .all(work.id)
      .map(cueRow);
    res.json({
      work: {
        id: work.id,
        title: work.title,
        filename: work.filename,
        revision: work.revision,
        created_at: work.created_at,
        updated_at: work.updated_at,
      },
      cues,
    });
  } catch (e) {
    next(e);
  }
});

app.delete('/api/works/:id', (req, res, next) => {
  try {
    const work = getWorkOr404(req.params.id);
    db.prepare('DELETE FROM works WHERE id = ?').run(work.id);
    res.json({ ok: true });
  } catch (e) {
    next(e);
  }
});

/* ------------------------------------------------------------------ */
/* 上传：严格校验，任何错误整份不入库                                  */
/* ------------------------------------------------------------------ */

app.post('/api/works', (req, res, next) => {
  try {
    const { title, filename, content } = req.body || {};

    if (typeof title !== 'string' || !title.trim()) {
      throw new HttpError(400, 'invalid_title', '作品标题不能为空');
    }
    if (title.trim().length > MAX_TITLE_LEN) {
      throw new HttpError(400, 'invalid_title', `标题过长（上限 ${MAX_TITLE_LEN} 字）`);
    }
    if (typeof filename !== 'string' || !filename.trim()) {
      throw new HttpError(400, 'invalid_filename', '缺少原始文件名');
    }
    if (typeof content !== 'string' || content.length === 0) {
      throw new HttpError(400, 'invalid_content', '缺少 SRT 文件内容');
    }
    if (content.includes('�')) {
      // 前端按 UTF-8 解码后仍出现替换符，基本可判定编码不对
      throw new SrtError('文件疑似不是 UTF-8 编码，请另存为 UTF-8 后重新上传', 1);
    }

    // 解析 + 时间合法性 + 交叠检查；抛错则下面的 catch 直接返回，绝不入库
    const parsed = parseSrt(content);

    const result = db.transaction(() => {
      const info = db
        .prepare('INSERT INTO works (title, filename) VALUES (?, ?)')
        .run(title.trim(), filename.trim());
      const workId = info.lastInsertRowid;

      const insertCue = db.prepare(
        'INSERT INTO cues (work_id, idx, start_ms, end_ms, text) VALUES (?, ?, ?, ?, ?)'
      );
      parsed
        .slice()
        .sort((a, b) => a.start_ms - b.start_ms || a.end_ms - b.end_ms)
        .forEach((c, i) => {
          insertCue.run(workId, i + 1, c.start_ms, c.end_ms, c.text);
        });

      db.prepare(
        'INSERT INTO revisions_log (work_id, revision, action) VALUES (?, 1, ?)'
      ).run(workId, 'import');

      return workId;
    })();

    res.status(201).json({ id: result, revision: 1, cue_count: parsed.length });
  } catch (e) {
    next(e);
  }
});

/* ------------------------------------------------------------------ */
/* 编辑单条字幕：乐观锁 + 时间合法性 + 交叠检查                        */
/* ------------------------------------------------------------------ */

app.put('/api/works/:id/cues/:cueId', (req, res, next) => {
  try {
    const workId = Number(req.params.id);
    const cueId = Number(req.params.cueId);
    const { revision, editor } = req.body || {};

    const work = getWorkOr404(workId);

    if (!Number.isInteger(revision) || revision < 1) {
      throw new HttpError(400, 'invalid_revision', '缺少有效的作品修订号');
    }

    const { text, startMs, endMs } = parseCuePayload(req.body);

    const outcome = db
      .transaction((wId, cId, expectedRevision) => {
        const w = db.prepare('SELECT revision FROM works WHERE id = ?').get(wId);
        if (!w) throw new HttpError(404, 'not_found', '作品不存在');

        const cue = db.prepare('SELECT * FROM cues WHERE id = ? AND work_id = ?').get(cId, wId);
        if (!cue) throw new HttpError(404, 'cue_not_found', '目标字幕段不存在或不属于该作品');

        // 修订号过期：拒绝覆盖，返回最新修订号和目标字幕段
        if (w.revision !== expectedRevision) {
          const latest = db.prepare('SELECT * FROM cues WHERE id = ?').get(cId);
          return { conflict: true, revision: w.revision, cue: latest };
        }

        // 同一作品其他字幕段不得交叠（半开区间，首尾相接允许）
        if (findOverlapCue(wId, cId, startMs, endMs)) {
          throw new HttpError(422, 'overlap', '该时间段与同一作品的其他字幕段交叠');
        }

        db.prepare(
          'UPDATE cues SET start_ms = ?, end_ms = ?, text = ? WHERE id = ?'
        ).run(startMs, endMs, text, cId);

        const nextRevision = w.revision + 1;
        db.prepare("UPDATE works SET revision = ?, updated_at = datetime('now') WHERE id = ?")
          .run(nextRevision, wId);

        db.prepare(
          'INSERT INTO revisions_log (work_id, revision, editor, action, cue_id) VALUES (?, ?, ?, ?, ?)'
        ).run(wId, nextRevision, normalizeEditor(editor), 'edit', cId);

        reindexCues(wId);
        const updated = db.prepare('SELECT * FROM cues WHERE id = ?').get(cId);
        return { conflict: false, revision: nextRevision, cue: updated };
      })
      .immediate(workId, cueId, revision);

    if (outcome.conflict) {
      throw new HttpError(409, 'revision_stale', '修订号已过期：该作品已被其他人修改', {
        latest_revision: outcome.revision,
        cue: cueRow(outcome.cue),
      });
    }

    res.json({ revision: outcome.revision, cue: cueRow(outcome.cue) });
  } catch (e) {
    next(e);
  }
});

/* ------------------------------------------------------------------ */
/* 候选修改待审区：提交（冻结快照，不动正式段与修订号）                */
/* ------------------------------------------------------------------ */

app.post('/api/works/:id/cues/:cueId/proposals', (req, res, next) => {
  try {
    const workId = Number(req.params.id);
    const cueId = Number(req.params.cueId);
    const body = req.body || {};
    const { revision } = body;

    getWorkOr404(workId);

    if (!Number.isInteger(revision) || revision < 1) {
      throw new HttpError(400, 'invalid_revision', '缺少有效的作品修订号');
    }

    // 内容非法（文字/时间/交叠）直接拒绝，不生成提案
    const { text, startMs, endMs } = parseCuePayload(body);
    const note = normalizeNote(body.note);
    const editor = normalizeEditor(body.editor);

    const outcome = db
      .transaction((wId, cId, expectedRevision) => {
        const w = db.prepare('SELECT revision FROM works WHERE id = ?').get(wId);
        if (!w) throw new HttpError(404, 'not_found', '作品不存在');

        const cue = db.prepare('SELECT * FROM cues WHERE id = ? AND work_id = ?').get(cId, wId);
        if (!cue) throw new HttpError(404, 'cue_not_found', '目标字幕段不存在或不属于该作品');

        // 页面所见修订号已过期：拒绝，不生成提案
        if (w.revision !== expectedRevision) {
          return { conflict: true, revision: w.revision, cue };
        }

        // 候选时间段与同作品其他字幕段不得交叠（半开区间，首尾相接允许）
        if (findOverlapCue(wId, cId, startMs, endMs)) {
          throw new HttpError(422, 'overlap', '候选时间段与同一作品的其他字幕段交叠');
        }

        // 只写提案：冻结原段快照与候选值；正式段、作品修订号、SRT 导出均不变
        const info = db
          .prepare(
            `INSERT INTO proposals
               (work_id, cue_id, base_revision,
                orig_start_ms, orig_end_ms, orig_text,
                new_start_ms, new_end_ms, new_text,
                note, editor)
             VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`
          )
          .run(
            wId, cId, expectedRevision,
            cue.start_ms, cue.end_ms, cue.text,
            startMs, endMs, text,
            note, editor
          );
        const proposal = db.prepare('SELECT * FROM proposals WHERE id = ?').get(info.lastInsertRowid);
        return { conflict: false, proposal, cue };
      })
      .immediate(workId, cueId, revision);

    if (outcome.conflict) {
      throw new HttpError(409, 'revision_stale', '修订号已过期：该作品已被其他人修改，候选未提交', {
        latest_revision: outcome.revision,
        cue: cueRow(outcome.cue),
      });
    }

    res.status(201).json({ proposal: proposalRow(outcome.proposal, outcome.cue) });
  } catch (e) {
    next(e);
  }
});

/* ------------------------------------------------------------------ */
/* 候选修改待审区：列表（原值 / 候选值 / 当前正式值并列）              */
/* ------------------------------------------------------------------ */

app.get('/api/works/:id/proposals', (req, res, next) => {
  try {
    const work = getWorkOr404(req.params.id);
    const status = req.query.status;

    let rows;
    if (status === undefined || status === 'all') {
      rows = db.prepare('SELECT * FROM proposals WHERE work_id = ? ORDER BY id').all(work.id);
    } else if (status === 'pending' || status === 'accepted' || status === 'rejected') {
      rows = db
        .prepare('SELECT * FROM proposals WHERE work_id = ? AND status = ? ORDER BY id')
        .all(work.id, status);
    } else {
      throw new HttpError(400, 'invalid_status', 'status 只能是 pending / accepted / rejected / all');
    }

    const cueStmt = db.prepare('SELECT * FROM cues WHERE id = ?');
    res.json({
      revision: work.revision,
      proposals: rows.map((p) => proposalRow(p, cueStmt.get(p.cue_id))),
    });
  } catch (e) {
    next(e);
  }
});

/* ------------------------------------------------------------------ */
/* 候选修改待审区：采纳（单事务校验快照一致 + 重查合法性后落正式段）   */
/* ------------------------------------------------------------------ */

app.post('/api/works/:id/proposals/:pid/accept', (req, res, next) => {
  try {
    const workId = Number(req.params.id);
    const pid = Number(req.params.pid);
    const reviewer = normalizeEditor(req.body && req.body.editor);
    getWorkOr404(workId);

    const outcome = db
      .transaction((wId, pId) => {
        const p = db.prepare('SELECT * FROM proposals WHERE id = ? AND work_id = ?').get(pId, wId);
        if (!p) throw new HttpError(404, 'proposal_not_found', '提案不存在或不属于该作品');
        if (p.status !== 'pending') {
          return { closed: true, status: p.status };
        }

        const w = db.prepare('SELECT revision FROM works WHERE id = ?').get(wId);
        const cue = db.prepare('SELECT * FROM cues WHERE id = ? AND work_id = ?').get(p.cue_id, wId);
        if (!cue) {
          return { conflict: true, reason: 'target_missing', cue: null, proposal: p };
        }

        // 目标段的时间与文字必须仍与提交时快照一致；其他段的修改不阻止采纳
        if (
          cue.start_ms !== p.orig_start_ms ||
          cue.end_ms !== p.orig_end_ms ||
          cue.text !== p.orig_text
        ) {
          return { conflict: true, reason: 'target_changed', cue, proposal: p };
        }

        // 重新检查候选合法性：非负时间、结束晚于开始（提交时已校验，此处防御复查）
        if (p.new_start_ms < 0 || p.new_end_ms < 0 || p.new_end_ms <= p.new_start_ms) {
          return { conflict: true, reason: 'invalid_candidate', cue, proposal: p };
        }

        // 重新检查候选时间段当前不与其他字幕段交叠
        const overlap = findOverlapCue(wId, p.cue_id, p.new_start_ms, p.new_end_ms);
        if (overlap) {
          return { conflict: true, reason: 'overlap', cue, overlapWith: overlap, proposal: p };
        }

        db.prepare('UPDATE cues SET start_ms = ?, end_ms = ?, text = ? WHERE id = ?')
          .run(p.new_start_ms, p.new_end_ms, p.new_text, p.cue_id);

        const nextRevision = w.revision + 1;
        db.prepare("UPDATE works SET revision = ?, updated_at = datetime('now') WHERE id = ?")
          .run(nextRevision, wId);

        db.prepare(
          'INSERT INTO revisions_log (work_id, revision, editor, action, cue_id) VALUES (?, ?, ?, ?, ?)'
        ).run(wId, nextRevision, reviewer, `accept proposal #${p.id}`, p.cue_id);

        reindexCues(wId);

        db.prepare(
          "UPDATE proposals SET status = 'accepted', reviewer = ?, resolved_at = datetime('now') WHERE id = ?"
        ).run(reviewer, p.id);

        const updated = db.prepare('SELECT * FROM cues WHERE id = ?').get(p.cue_id);
        const proposal = db.prepare('SELECT * FROM proposals WHERE id = ?').get(p.id);
        const cues = db
          .prepare('SELECT * FROM cues WHERE work_id = ? ORDER BY idx, id')
          .all(wId)
          .map(cueRow);
        return { closed: false, conflict: false, revision: nextRevision, cue: updated, proposal, cues };
      })
      .immediate(workId, pid);

    if (outcome.closed) {
      throw new HttpError(409, 'proposal_closed', '提案已结案，不能再次处理', {
        status: outcome.status,
      });
    }
    if (outcome.conflict) {
      const reasons = {
        target_missing: '目标字幕段已不存在',
        target_changed: '目标字幕段在提案提交后已被修改，与快照不一致',
        invalid_candidate: '候选内容未通过合法性复查（时间非法）',
        overlap: '候选时间段当前会与同一作品的其他字幕段交叠',
      };
      const extra = {
        reason: outcome.reason,
        cue: outcome.cue ? cueRow(outcome.cue) : null,
        proposal: proposalRow(outcome.proposal, outcome.cue),
      };
      if (outcome.overlapWith) {
        extra.overlap_with = {
          id: outcome.overlapWith.id,
          idx: outcome.overlapWith.idx,
          start: formatMs(outcome.overlapWith.start_ms),
          end: formatMs(outcome.overlapWith.end_ms),
        };
      }
      // 提案保留待审，不写入任何内容
      throw new HttpError(
        409,
        'proposal_conflict',
        `${reasons[outcome.reason]}；提案保留在待审区，未写入`,
        extra
      );
    }

    res.json({
      revision: outcome.revision,
      cue: cueRow(outcome.cue),
      cues: outcome.cues,
      proposal: proposalRow(outcome.proposal, outcome.cue),
    });
  } catch (e) {
    next(e);
  }
});

/* ------------------------------------------------------------------ */
/* 候选修改待审区：驳回（只结案，不动正式段与修订号）                  */
/* ------------------------------------------------------------------ */

app.post('/api/works/:id/proposals/:pid/reject', (req, res, next) => {
  try {
    const workId = Number(req.params.id);
    const pid = Number(req.params.pid);
    const reviewer = normalizeEditor(req.body && req.body.editor);
    getWorkOr404(workId);

    const outcome = db
      .transaction((wId, pId) => {
        const p = db.prepare('SELECT * FROM proposals WHERE id = ? AND work_id = ?').get(pId, wId);
        if (!p) throw new HttpError(404, 'proposal_not_found', '提案不存在或不属于该作品');
        if (p.status !== 'pending') {
          return { closed: true, status: p.status };
        }
        db.prepare(
          "UPDATE proposals SET status = 'rejected', reviewer = ?, resolved_at = datetime('now') WHERE id = ?"
        ).run(reviewer, p.id);
        const proposal = db.prepare('SELECT * FROM proposals WHERE id = ?').get(p.id);
        return { closed: false, proposal };
      })
      .immediate(workId, pid);

    if (outcome.closed) {
      throw new HttpError(409, 'proposal_closed', '提案已结案，不能再次处理', {
        status: outcome.status,
      });
    }

    const cue = db.prepare('SELECT * FROM cues WHERE id = ?').get(outcome.proposal.cue_id);
    res.json({ proposal: proposalRow(outcome.proposal, cue) });
  } catch (e) {
    next(e);
  }
});

/* ------------------------------------------------------------------ */
/* 批量平移：预览（基于当前修订号推演，不写库）                        */
/* ------------------------------------------------------------------ */

app.post('/api/works/:id/cues/shift/preview', (req, res, next) => {
  try {
    const workId = Number(req.params.id);
    const { revision, offsetMs, cueIds } = parseShiftBody(req.body);
    const work = getWorkOr404(workId);

    const allCues = loadCuesForShift(work.id, cueIds);
    const plan = planShift(allCues, cueIds, offsetMs);

    res.json({
      revision: work.revision, // 预览所依据的作品修订号，确认时必须原样带回
      expected_revision: work.revision,
      stale: work.revision !== revision,
      offset_ms: offsetMs,
      cue_ids: cueIds,
      valid: plan.valid,
      issues: plan.issues,
      cues: plan.entries,
    });
  } catch (e) {
    next(e);
  }
});

/* ------------------------------------------------------------------ */
/* 批量平移：确认（乐观锁 + 单事务重算应用，修订号只增加一次）         */
/* ------------------------------------------------------------------ */

app.post('/api/works/:id/cues/shift', (req, res, next) => {
  try {
    const workId = Number(req.params.id);
    const { revision, offsetMs, cueIds } = parseShiftBody(req.body);
    const { editor } = req.body || {};
    getWorkOr404(workId);

    const outcome = db
      .transaction((wId, ids, expectedRevision, offset) => {
        const w = db.prepare('SELECT revision FROM works WHERE id = ?').get(wId);
        if (!w) throw new HttpError(404, 'not_found', '作品不存在');

        // 预览依据的修订号与当前不一致：作品已被他人改动，拒绝按过期预览写入
        if (w.revision !== expectedRevision) {
          return { conflict: true, revision: w.revision };
        }

        const allRows = db
          .prepare('SELECT * FROM cues WHERE work_id = ? ORDER BY idx, id')
          .all(wId);
        const byId = new Map(allRows.map((r) => [r.id, r]));
        const missing = ids.filter((id) => !byId.has(id));
        if (missing.length > 0) {
          throw new HttpError(
            404,
            'cue_not_found',
            `以下字幕段不存在或不属于该作品：${missing.join('、')}`,
            { cue_ids: missing }
          );
        }

        const plan = planShift(allRows, ids, offset);
        if (!plan.valid) {
          throw new HttpError(
            422,
            'shift_rejected',
            '批量平移会产生负起点或时间交叠，已整批拒绝',
            { issues: plan.issues, cues: plan.entries }
          );
        }

        const update = db.prepare(
          'UPDATE cues SET start_ms = ?, end_ms = ? WHERE id = ?'
        );
        for (const e of plan.entries) {
          update.run(e.new_start_ms, e.new_end_ms, e.id);
        }

        const nextRevision = w.revision + 1;
        db.prepare("UPDATE works SET revision = ?, updated_at = datetime('now') WHERE id = ?")
          .run(nextRevision, wId);

        db.prepare(
          'INSERT INTO revisions_log (work_id, revision, editor, action) VALUES (?, ?, ?, ?)'
        ).run(
          wId,
          nextRevision,
          normalizeEditor(editor),
          `shift x${ids.length} ${offset >= 0 ? '+' : ''}${offset}ms`
        );

        // 重算并应用全部时间后，在同一事务内重排展示序号
        reindexCues(wId);

        const cues = db
          .prepare('SELECT * FROM cues WHERE work_id = ? ORDER BY idx, id')
          .all(wId)
          .map(cueRow);
        return { conflict: false, revision: nextRevision, cues };
      })
      .immediate(workId, cueIds, revision, offsetMs);

    if (outcome.conflict) {
      throw new HttpError(409, 'revision_stale', '修订号已过期：该作品已被其他人修改，请基于最新版本重新预览后再确认', {
        latest_revision: outcome.revision,
      });
    }

    res.json({
      revision: outcome.revision,
      offset_ms: offsetMs,
      shifted_count: cueIds.length,
      cues: outcome.cues,
    });
  } catch (e) {
    next(e);
  }
});

/* ------------------------------------------------------------------ */
/* 导出标准 SRT：按时间重新编号，保留文字换行                          */
/* ------------------------------------------------------------------ */

app.get('/api/works/:id/export', (req, res, next) => {
  try {
    const work = getWorkOr404(req.params.id);
    const cues = db
      .prepare('SELECT start_ms, end_ms, text FROM cues WHERE work_id = ? ORDER BY start_ms, end_ms, id')
      .all(work.id);

    const body = '\uFEFF' + serializeSrt(cues);
    const safeName =
      work.title
        .trim()
        .replace(/[\\/:*?"<>|\x00-\x1f]/g, '_')
        .replace(/\s+/g, ' ')
        .slice(0, 120) || 'subtitles';

    res.setHeader('Content-Type', 'application/x-subrip; charset=utf-8');
    res.setHeader(
      'Content-Disposition',
      `attachment; filename*=UTF-8''${encodeURIComponent(safeName)}.srt`
    );
    res.send(body);
  } catch (e) {
    next(e);
  }
});

/* ------------------------------------------------------------------ */
/* 错误处理                                                            */
/* ------------------------------------------------------------------ */

// eslint-disable-next-line no-unused-vars
app.use((err, req, res, next) => {
  if (err instanceof SrtError) {
    return res.status(422).json({
      error: 'invalid_srt',
      message: err.message,
      line: err.line,
    });
  }
  if (err instanceof HttpError) {
    return res.status(err.status).json({
      error: err.code,
      message: err.message,
      ...err.extra,
    });
  }
  if (err.type === 'entity.too.large') {
    return res.status(413).json({ error: 'too_large', message: '上传文件过大（上限 6MB）' });
  }
  if (err.type === 'entity.parse.failed') {
    return res.status(400).json({ error: 'bad_json', message: '请求体不是合法 JSON' });
  }
  console.error(err);
  res.status(500).json({ error: 'internal', message: '服务器内部错误' });
});

if (require.main === module) {
  dbReady
    .then(() => {
      app.listen(PORT, () => {
        console.log(`字幕校订服务已启动: http://0.0.0.0:${PORT}`);
        console.log(`数据库: ${DB_PATH}`);
      });
    })
    .catch((err) => {
      console.error('存储初始化失败：', err);
      process.exit(1);
    });
}

module.exports = { app, get db() { return db; }, ready: dbReady };
