'use strict';

/**
 * 批量时间轴平移推演（纯函数，不含存储与 HTTP）。
 *
 * 规则：
 * - 若干字幕段整体加上同一有符号整数毫秒偏移；文字与段 ID 不变；
 * - 任一新起点为负 -> 整批非法；
 * - 平移后的选中段彼此、以及与未选段不得交叠（半开区间 [start, end)，
 *   前一段结束 == 后一段开始的首尾相接允许）。
 */

const { formatMs } = require('./srt');

/** 负时间也按 HH:MM:SS,mmm 格式化，前面加负号（formatMs 本身会截断到 0） */
function formatSignedMs(ms) {
  if (ms >= 0) return formatMs(ms);
  return `-${formatMs(-ms)}`;
}

/** 半开区间相交判定：端点相等（首尾相接）不算交叠 */
function intervalsOverlap(a, b) {
  return a.start < b.end && b.start < a.end;
}

/**
 * 计算批量平移的完整预案。
 * @param {{id:number,idx:number,start_ms:number,end_ms:number,text:string}[]} allCues
 *        该作品当前全部字幕段
 * @param {number[]} selectedIds 去重后的选中段 ID（调用方保证均存在）
 * @param {number} offsetMs 有符号整数毫秒偏移
 * @returns {{
 *   entries: Array,   // 每段调整前后时间、碰撞对象
 *   issues: Array,    // 全部违例（负起点 / 交叠 / 越界）
 *   valid: boolean
 * }}
 */
function planShift(allCues, selectedIds, offsetMs) {
  const byId = new Map(allCues.map((c) => [c.id, c]));
  const selectedSet = new Set(selectedIds);

  const entries = selectedIds.map((id) => {
    const cue = byId.get(id);
    const newStart = cue.start_ms + offsetMs;
    const newEnd = cue.end_ms + offsetMs;
    return {
      id: cue.id,
      idx: cue.idx,
      start_ms: cue.start_ms,
      end_ms: cue.end_ms,
      start: formatMs(cue.start_ms),
      end: formatMs(cue.end_ms),
      new_start_ms: newStart,
      new_end_ms: newEnd,
      new_start: formatSignedMs(newStart),
      new_end: formatSignedMs(newEnd),
      negative_start: newStart < 0,
      out_of_range:
        !Number.isSafeInteger(newStart) || !Number.isSafeInteger(newEnd),
      collisions: [], // {id, idx, start, end, selected}
    };
  });
  const entryById = new Map(entries.map((e) => [e.id, e]));

  // 平移后的选中段 + 原地不动的未选段，统一做区间相交检查
  const intervals = [
    ...entries.map((e) => ({
      id: e.id,
      idx: e.idx,
      start: e.new_start_ms,
      end: e.new_end_ms,
      selected: true,
    })),
    ...allCues
      .filter((c) => !selectedSet.has(c.id))
      .map((c) => ({
        id: c.id,
        idx: c.idx,
        start: c.start_ms,
        end: c.end_ms,
        selected: false,
      })),
  ].sort((a, b) => a.start - b.start || a.end - b.end || a.id - b.id);

  for (let i = 0; i < intervals.length; i++) {
    for (let j = i + 1; j < intervals.length; j++) {
      // 起点已排序：j 的起点一旦达到 i 的终点，其后各段只会更晚，首尾相接允许
      if (intervals[j].start >= intervals[i].end) break;
      if (!intervalsOverlap(intervals[i], intervals[j])) continue;
      // 双方都是未选段的碰撞与本次操作无关，不报告
      if (!intervals[i].selected && !intervals[j].selected) continue;

      const describe = (x) => ({
        id: x.id,
        idx: x.idx,
        start: formatMs(x.start),
        end: formatMs(x.end),
        selected: x.selected,
      });
      if (intervals[i].selected) {
        entryById.get(intervals[i].id).collisions.push(describe(intervals[j]));
      }
      if (intervals[j].selected) {
        entryById.get(intervals[j].id).collisions.push(describe(intervals[i]));
      }
    }
  }

  const issues = [];

  for (const e of entries) {
    if (e.out_of_range) {
      issues.push({
        type: 'time_out_of_range',
        cue_ids: [e.id],
        cues: [{ id: e.id, idx: e.idx }],
        message: `展示序号 #${e.idx} 的字幕段偏移后时间超出可表示范围`,
      });
    } else if (e.negative_start) {
      issues.push({
        type: 'negative_start',
        cue_ids: [e.id],
        cues: [{ id: e.id, idx: e.idx }],
        message:
          `展示序号 #${e.idx}（段 ID ${e.id}）调整后起点为 ${e.new_start_ms} 毫秒，` +
          '时间不能为负',
      });
    }
  }

  for (const e of entries) {
    if (e.collisions.length === 0) continue;
    const related = e.collisions.map((c) => `#${c.idx}`).join('、');
    issues.push({
      type: 'overlap',
      cue_ids: [e.id, ...e.collisions.map((c) => c.id)],
      cues: [
        { id: e.id, idx: e.idx },
        ...e.collisions.map((c) => ({ id: c.id, idx: c.idx })),
      ],
      message:
        `展示序号 #${e.idx}（段 ID ${e.id}）调整为 ${e.new_start} --> ${e.new_end} 后，` +
        `与 ${e.collisions.length} 个字幕段交叠：${related}（首尾相接不算交叠）`,
    });
  }

  return { entries, issues, valid: issues.length === 0 };
}

module.exports = { planShift, formatSignedMs, intervalsOverlap };
