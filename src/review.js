'use strict';

/**
 * 离线校订包：文件格式、解析与应用预案（纯函数，不含存储与 HTTP）。
 *
 * 校订包是一份 JSON 文件，校订人员带走离线修改文字与起止时间，回传后服务器
 * 对照「发包时各段基线」决定哪些段真正改动：
 * - 只处理相对基线改过的段；未改段即使服务器后来变化也不覆盖；
 * - 改过的段若服务器上已偏离基线（目标已变/缺失），作为冲突报告；
 * - 整批候选还要重算负时间、结束晚于开始、彼此/与其他段交叠。
 */

const crypto = require('crypto');
const { formatMs } = require('./srt');

const PACKAGE_FORMAT = 'srt-review-package';
const PACKAGE_VERSION = 1;
const MAX_PACKAGE_ID_LEN = 64;
const MAX_TEXT_LEN = 10000;
const PACKAGE_ID_RE = /^[A-Za-z0-9_-]{4,64}$/;

class ReviewPackageError extends Error {
  /**
   * @param {string} message 中文错误说明
   * @param {object} extra   附加字段（cue_id / field / package_work_id 等）
   */
  constructor(message, extra = {}) {
    super(message);
    this.name = 'ReviewPackageError';
    this.code = 'invalid_package';
    Object.assign(this, extra);
  }
}

/** 生成稳定的包标识（对外可见，跨服务重启仍可识别） */
function newPackageId() {
  return 'rv_' + crypto.randomBytes(12).toString('base64url');
}

/**
 * 校订包专用时间解析：在标准 HH:MM:SS,mmm 前允许一个负号，
 * 这样离线文件里手滑写成负时间也能在预览/确认时作为「负时间」违例报告，
 * 而不是笼统的格式非法。
 * @returns {number|null} 毫秒（可为负）；无法解析返回 null
 */
function parseSignedTimeToMs(tc) {
  const m = /^([+-]?)(\d{1,2}):(\d{1,2}):(\d{1,2})[,.](\d{1,3})$/.exec(String(tc).trim());
  if (!m) return null;
  const ms = Number(m[5].padEnd(3, '0'));
  const v = (Number(m[2]) * 3600 + Number(m[3]) * 60 + Number(m[4])) * 1000 + ms;
  return m[1] === '-' ? -v : v;
}

function normalizePkgText(text) {
  const t = String(text).replace(/\r\n?/g, '\n').replace(/\n+$/, '');
  if (t.trim() === '') {
    throw new ReviewPackageError('字幕文字不能为空');
  }
  if (t.length > MAX_TEXT_LEN) {
    throw new ReviewPackageError(`字幕文字过长（上限 ${MAX_TEXT_LEN} 字）`);
  }
  return t;
}

function isPlainObject(v) {
  return v !== null && typeof v === 'object' && !Array.isArray(v);
}

/**
 * 解析校订包（接受对象或 JSON 字符串），只做结构与字段校验；
 * 「目标段是否已变」等需要服务器当前数据的检查在 planReview 中完成。
 *
 * @returns {{package_id:string, work_id:number, cues:Array<{cue_id:number,startMs:number,endMs:number,text:string,start:string,end:string}>}}
 * @throws {ReviewPackageError}
 */
function parseReviewPackage(input) {
  let obj = input;
  if (typeof input === 'string') {
    try {
      obj = JSON.parse(input);
    } catch (e) {
      throw new ReviewPackageError('校订包不是合法 JSON 文件', { field: 'json' });
    }
  }
  if (!isPlainObject(obj)) {
    throw new ReviewPackageError('校订包顶层必须是对象');
  }
  if (obj.format !== PACKAGE_FORMAT) {
    throw new ReviewPackageError(`不是校订包文件（format 应为 "${PACKAGE_FORMAT}"）`, {
      field: 'format',
    });
  }
  if (obj.version !== PACKAGE_VERSION) {
    throw new ReviewPackageError(`不支持的校订包版本（version 应为 ${PACKAGE_VERSION}）`, {
      field: 'version',
    });
  }
  if (!Number.isInteger(obj.work_id) || obj.work_id < 1) {
    throw new ReviewPackageError('缺少有效的作品标识 work_id', { field: 'work_id' });
  }
  if (typeof obj.package_id !== 'string' || !PACKAGE_ID_RE.test(obj.package_id)) {
    throw new ReviewPackageError('缺少有效的包标识 package_id', { field: 'package_id' });
  }
  if (!Array.isArray(obj.cues)) {
    throw new ReviewPackageError('cues 必须是字幕段数组', { field: 'cues' });
  }
  if (obj.cues.length === 0) {
    throw new ReviewPackageError('校订包不包含任何字幕段', { field: 'cues' });
  }

  const cues = [];
  const seen = new Set();
  obj.cues.forEach((raw, i) => {
    const at = `cues[${i}]`;
    if (!isPlainObject(raw)) {
      throw new ReviewPackageError(`${at} 必须是对象`);
    }
    if (!Number.isInteger(raw.cue_id) || raw.cue_id < 1) {
      throw new ReviewPackageError(`${at} 缺少有效的稳定段 ID cue_id`, { field: 'cue_id' });
    }
    if (seen.has(raw.cue_id)) {
      throw new ReviewPackageError(`段 ID ${raw.cue_id} 在校订包中重复出现`, {
        cue_id: raw.cue_id,
      });
    }
    seen.add(raw.cue_id);

    const startMs = parseSignedTimeToMs(raw.start);
    const endMs = parseSignedTimeToMs(raw.end);
    if (startMs === null || endMs === null) {
      throw new ReviewPackageError(
        `${at} 时间格式应为 HH:MM:SS,mmm（可为负，例如 00:01:23,500）`,
        { cue_id: raw.cue_id, field: 'start' }
      );
    }
    if (!Number.isSafeInteger(startMs) || !Number.isSafeInteger(endMs)) {
      throw new ReviewPackageError(`${at} 时间超出可表示范围`, { cue_id: raw.cue_id });
    }

    // 文字：接受 text（字符串，换行用 \n）或 text_lines（字符串数组，每行一个元素）
    let text;
    if (raw.text !== undefined) {
      if (typeof raw.text !== 'string') {
        throw new ReviewPackageError(`${at} text 必须是字符串`, { cue_id: raw.cue_id });
      }
      text = normalizePkgText(raw.text);
    } else if (Array.isArray(raw.text_lines)) {
      if (raw.text_lines.some((l) => typeof l !== 'string')) {
        throw new ReviewPackageError(`${at} text_lines 必须全部是字符串`, {
          cue_id: raw.cue_id,
        });
      }
      text = normalizePkgText(raw.text_lines.join('\n'));
    } else {
      throw new ReviewPackageError(`${at} 缺少字幕文字 text`, { cue_id: raw.cue_id });
    }

    cues.push({
      cue_id: raw.cue_id,
      startMs,
      endMs,
      text,
      start: startMs >= 0 ? formatMs(startMs) : `-${formatMs(-startMs)}`,
      end: endMs >= 0 ? formatMs(endMs) : `-${formatMs(-endMs)}`,
    });
  });

  return { package_id: obj.package_id, work_id: obj.work_id, cues };
}

/** 负时间也按 HH:MM:SS,mmm 表示，前面加负号 */
function tcView(ms) {
  return ms >= 0 ? formatMs(ms) : `-${formatMs(-ms)}`;
}

/** 半开区间相交判定：端点相等（首尾相接）不算交叠 */
function intervalsOverlap(a, b) {
  return a.start < b.end && b.start < a.end;
}

/**
 * 计算校订包应用预案（不写库）。
 *
 * @param {object} args
 * @param {{id:number,idx:number,start_ms:number,end_ms:number,text:string}[]} args.currentCues
 *        作品当前全部正式段
 * @param {{cue_id:number,start_ms:number,end_ms:number,text:string}[]} args.baselines
 *        发包时留存的各段基线
 * @param {object[]} args.pkgCues parseReviewPackage 返回的 cues
 * @returns {{
 *   entries: Array,     // 逐段差异（基线 / 候选 / 当前正式值、冲突与违例）
 *   conflicts: Array,   // 目标段缺失/已偏离基线（仅对改过的段）
 *   issues: Array,      // 负时间 / 无效区间 / 交叠（整批应用视角）
 *   valid: boolean,
 *   changed_count: number,
 *   unchanged_count: number,
 *   unchanged_drifted: number[]  // 未改但正式段已偏离基线的段 ID（仅供提示，不阻止）
 * }}
 */
function planReview({ currentCues, baselines, pkgCues }) {
  const currentById = new Map(currentCues.map((c) => [c.id, c]));
  const baselineById = new Map(baselines.map((b) => [b.cue_id, b]));

  const entries = [];
  const conflicts = [];
  const unchangedDrifted = [];

  for (const c of pkgCues) {
    const base = baselineById.get(c.cue_id);
    const cur = currentById.get(c.cue_id);
    const entry = {
      cue_id: c.cue_id,
      idx: cur ? cur.idx : null,
      changed: false,
      baseline: base
        ? { start_ms: base.start_ms, end_ms: base.end_ms, start: tcView(base.start_ms), end: tcView(base.end_ms), text: base.text }
        : null,
      candidate: { start_ms: c.startMs, end_ms: c.endMs, start: c.start, end: c.end, text: c.text },
      current: cur
        ? { id: cur.id, idx: cur.idx, start_ms: cur.start_ms, end_ms: cur.end_ms, start: tcView(cur.start_ms), end: tcView(cur.end_ms), text: cur.text }
        : null,
      conflict: null,
      issues: [],
      collisions: [],
    };

    if (!base) {
      // 包中段 ID 在本包基线中无记录：不属于本次发包（损坏/伪造的包）
      entry.conflict = {
        reason: 'baseline_missing',
        message: '该段不在发包基线中，无法判断相对基线的改动',
      };
      conflicts.push({ cue_id: c.cue_id, reason: 'baseline_missing', message: entry.conflict.message, current: null });
      entries.push(entry);
      continue;
    }

    const changed =
      c.startMs !== base.start_ms || c.endMs !== base.end_ms || c.text !== base.text;
    entry.changed = changed;

    if (!changed) {
      // 未改段即使服务器后来变化也不覆盖；只在响应里提示其已漂移
      if (
        !cur ||
        cur.start_ms !== base.start_ms ||
        cur.end_ms !== base.end_ms ||
        cur.text !== base.text
      ) {
        unchangedDrifted.push(c.cue_id);
      }
      entries.push(entry);
      continue;
    }

    if (!cur) {
      entry.conflict = { reason: 'target_missing', message: '目标字幕段已不存在' };
      conflicts.push({ cue_id: c.cue_id, reason: 'target_missing', message: entry.conflict.message, current: null });
      entries.push(entry);
      continue;
    }

    // 改过的段：正式段必须仍与发包基线一致，否则不覆盖
    if (
      cur.start_ms !== base.start_ms ||
      cur.end_ms !== base.end_ms ||
      cur.text !== base.text
    ) {
      entry.conflict = {
        reason: 'target_changed',
        message: '目标字幕段在发包后已被修改，与基线不一致；本段不会被覆盖',
      };
      conflicts.push({ cue_id: c.cue_id, reason: 'target_changed', message: entry.conflict.message, current: entry.current });
      entries.push(entry);
      continue;
    }

    // 候选自身时间合法性
    if (c.startMs < 0 || c.endMs < 0) {
      entry.issues.push('negative_time');
    }
    if (c.startMs >= 0 && c.endMs >= 0 && c.endMs <= c.startMs) {
      entry.issues.push('invalid_range');
    }

    entries.push(entry);
  }

  // 整批应用后的时间轴：改过且自身合法的段取候选区间，其余段保持当前正式区间
  const effective = new Map();
  for (const cur of currentCues) {
    effective.set(cur.id, { id: cur.id, idx: cur.idx, start: cur.start_ms, end: cur.end_ms });
  }
  for (const e of entries) {
    if (!e.changed || e.conflict) continue;
    if (e.issues.length === 0) {
      effective.set(e.cue_id, {
        id: e.cue_id,
        idx: e.idx,
        start: e.candidate.start_ms,
        end: e.candidate.end_ms,
      });
    }
  }

  const issues = [];
  const issueByCue = new Map();
  const addIssue = (issue) => {
    issues.push(issue);
    for (const id of issue.cue_ids) {
      if (!issueByCue.has(id)) issueByCue.set(id, []);
      issueByCue.get(id).push(issue.type);
    }
  };

  // 先报各段自身的负时间/无效区间
  for (const e of entries) {
    if (!e.changed || e.conflict) continue;
    if (e.issues.includes('negative_time')) {
      addIssue({
        type: 'negative_time',
        cue_ids: [e.cue_id],
        cues: [{ id: e.cue_id, idx: e.idx }],
        message:
          `段 ID ${e.cue_id}（展示序号 #${e.idx}）候选起点/终点为负：` +
          `${e.candidate.start} --> ${e.candidate.end}，时间不能为负`,
      });
    } else if (e.issues.includes('invalid_range')) {
      addIssue({
        type: 'invalid_range',
        cue_ids: [e.cue_id],
        cues: [{ id: e.cue_id, idx: e.idx }],
        message:
          `段 ID ${e.cue_id}（展示序号 #${e.idx}）候选区间无效：` +
          `${e.candidate.start} --> ${e.candidate.end}，结束必须晚于开始`,
      });
    }
  }

  // 交叠：只对改过且自身时间合法的候选段检查与整条时间轴的关系
  for (const e of entries) {
    if (!e.changed || e.conflict || e.issues.length > 0) continue;
    const mine = effective.get(e.cue_id);
    const hits = [];
    for (const [id, other] of effective) {
      if (id === e.cue_id) continue;
      if (intervalsOverlap(mine, other)) {
        hits.push({
          id: other.id,
          idx: currentById.get(other.id) ? currentById.get(other.id).idx : null,
          start: tcView(other.start),
          end: tcView(other.end),
        });
      }
    }
    if (hits.length > 0) {
      e.collisions = hits;
      const related = hits.map((h) => (h.idx ? `#${h.idx}` : `段 ID ${h.id}`)).join('、');
      addIssue({
        type: 'overlap',
        cue_ids: [e.cue_id, ...hits.map((h) => h.id)],
        cues: [{ id: e.cue_id, idx: e.idx }, ...hits.map((h) => ({ id: h.id, idx: h.idx }))],
        message:
          `段 ID ${e.cue_id}（展示序号 #${e.idx}）候选为 ${e.candidate.start} --> ${e.candidate.end}，` +
          `与 ${hits.length} 个字幕段交叠：${related}（首尾相接不算交叠）`,
      });
    }
  }

  for (const e of entries) {
    if (issueByCue.has(e.cue_id)) e.issues = issueByCue.get(e.cue_id);
  }

  const changedCount = entries.filter((e) => e.changed).length;
  return {
    entries,
    conflicts,
    issues,
    valid: conflicts.length === 0 && issues.length === 0,
    changed_count: changedCount,
    unchanged_count: entries.length - changedCount,
    unchanged_drifted: unchangedDrifted,
  };
}

/**
 * 序列化为可离线编辑的校订包文件（UTF-8 JSON，缩进 2 空格）。
 * @param {{package_id:string, work_id:number, base_revision:number, created_at?:string,
 *          cues:Array<{cue_id:number,start_ms:number,end_ms:number,text:string}>}} pkg
 */
function serializeReviewPackage(pkg) {
  const file = {
    format: PACKAGE_FORMAT,
    version: PACKAGE_VERSION,
    work_id: pkg.work_id,
    package_id: pkg.package_id,
    base_revision: pkg.base_revision,
    created_at: pkg.created_at || null,
    cues: pkg.cues.map((c) => ({
      cue_id: c.cue_id,
      start: formatMs(c.start_ms),
      end: formatMs(c.end_ms),
      text: c.text,
    })),
  };
  return JSON.stringify(file, null, 2) + '\n';
}

module.exports = {
  PACKAGE_FORMAT,
  PACKAGE_VERSION,
  MAX_PACKAGE_ID_LEN,
  ReviewPackageError,
  newPackageId,
  parseSignedTimeToMs,
  parseReviewPackage,
  planReview,
  serializeReviewPackage,
  tcView,
};
