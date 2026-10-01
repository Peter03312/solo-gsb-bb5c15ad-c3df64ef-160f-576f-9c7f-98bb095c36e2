'use strict';

/**
 * SRT 解析与序列化。
 *
 * 解析严格按行处理，任何格式/时间错误都抛出带行号的 SrtError，
 * 由调用方决定“整份文件不入库”。
 */

/** 单个时间码：HH:MM:SS,mmm（逗号或点分隔毫秒） */
const TC = '(\\d{1,2}):(\\d{1,2}):(\\d{1,2})[,.](\\d{1,3})';
const TIMECODE_RE = new RegExp(`^${TC}\\s*-->\\s*${TC}`);
const SINGLE_TC_RE = new RegExp(`^${TC}$`);

class SrtError extends Error {
  /**
   * @param {string} message 中文错误说明
   * @param {number} line    出错行号（1 起）
   */
  constructor(message, line) {
    super(message);
    this.name = 'SrtError';
    this.line = line;
  }
}

/**
 * 把 00:00:00,000 形式的时间码转成毫秒。
 * @returns {number|null} 无法解析时返回 null
 */
function parseTimecodeToMs(tc) {
  const m = TIMECODE_RE.exec(tc);
  if (!m) return null;
  const toMs = (h, mm, ss, frac) => {
    // 1 位 = 十分之一秒，2 位 = 百分之一秒，3 位 = 毫秒
    const ms = Number(frac.padEnd(3, '0'));
    return (Number(h) * 3600 + Number(mm) * 60 + Number(ss)) * 1000 + ms;
  };
  const start = toMs(m[1], m[2], m[3], m[4]);
  const end = toMs(m[5], m[6], m[7], m[8]);
  return [start, end];
}

function parseTimeToMs(tc) {
  const m = SINGLE_TC_RE.exec(String(tc).trim());
  if (!m) return null;
  const ms = Number(m[4].padEnd(3, '0'));
  return (Number(m[1]) * 3600 + Number(m[2]) * 60 + Number(m[3])) * 1000 + ms;
}

/**
 * 毫秒 -> HH:MM:SS,mmm（小时不截断到两位，允许超过 99 小时的素材）
 */
function formatMs(ms) {
  const safe = Math.max(0, Math.round(ms));
  const h = Math.floor(safe / 3600000);
  const mm = Math.floor((safe % 3600000) / 60000);
  const ss = Math.floor((safe % 60000) / 1000);
  const mmm = safe % 1000;
  const p = (n, w = 2) => String(n).padStart(w, '0');
  return `${p(h)}:${p(mm)}:${p(ss)},${p(mmm, 3)}`;
}

/**
 * 解析整份 UTF-8 SRT 文本。
 * @param {string} raw
 * @returns {{start_ms:number,end_ms:number,text:string,src_line:number}[]}
 * @throws {SrtError}
 */
function parseSrt(raw) {
  if (typeof raw !== 'string') {
    throw new SrtError('文件内容不是文本（请上传 UTF-8 编码的 .srt 文件）', 1);
  }
  // 去 BOM；统一换行
  const text = raw.replace(/^\uFEFF/, '').replace(/\r\n?/g, '\n');
  const lines = text.split('\n');

  const cues = [];
  let i = 0;

  const skipBlanks = () => {
    while (i < lines.length && lines[i].trim() === '') i++;
  };

  while (i < lines.length) {
    skipBlanks();
    if (i >= lines.length) break;

    // 第一行：序号
    const indexLine = lines[i];
    const indexNo = i + 1;
    if (!/^\d+$/.test(indexLine.trim())) {
      throw new SrtError(`应为数字序号，实际为“${indexLine.trim() || '空行'}”`, indexNo);
    }
    i++;

    // 第二行：时间轴
    if (i >= lines.length) {
      throw new SrtError(`第 ${indexLine.trim()} 条字幕缺少时间轴行`, indexNo);
    }
    const timeLine = i + 1;
    const m = TIMECODE_RE.exec(lines[i]);
    if (!m) {
      throw new SrtError(
        '时间轴格式应为 “HH:MM:SS,mmm --> HH:MM:SS,mmm”',
        timeLine
      );
    }
    const range = parseTimecodeToMs(lines[i]);
    const [startMs, endMs] = range;
    i++;

    // 后续行：字幕文字，直到空行或文件结束
    const textLines = [];
    while (i < lines.length && lines[i].trim() !== '') {
      textLines.push(lines[i]);
      i++;
    }

    // 去掉尾部空白行，保留正文内部换行
    while (textLines.length && textLines[textLines.length - 1].trim() === '') {
      textLines.pop();
    }
    if (textLines.length === 0) {
      throw new SrtError(`第 ${indexLine.trim()} 条字幕缺少文字内容`, timeLine);
    }

    if (endMs <= startMs) {
      throw new SrtError('结束时间必须晚于开始时间', timeLine);
    }
    if (startMs < 0 || endMs < 0) {
      throw new SrtError('时间不能为负数', timeLine);
    }

    cues.push({
      start_ms: startMs,
      end_ms: endMs,
      text: textLines.join('\n'),
      src_line: indexNo, // 该条字幕序号所在行，交叠报错时定位用
    });
  }

  if (cues.length === 0) {
    throw new SrtError('文件中没有任何字幕段', 1);
  }

  // 同一作品字幕段不得交叠：按开始时间排序后检查相邻区间
  const ordered = cues
    .map((c, idx) => ({ ...c, order: idx }))
    .sort((a, b) => a.start_ms - b.start_ms || a.end_ms - b.end_ms);

  for (let k = 1; k < ordered.length; k++) {
    const prev = ordered[k - 1];
    const cur = ordered[k];
    // 半开区间：前一段结束 == 后一段开始 不算交叠
    if (cur.start_ms < prev.end_ms) {
      throw new SrtError(
        `字幕时间交叠：第 ${k} 段附近（开始于 ${formatMs(cur.start_ms)}）` +
          `与上一段（结束于 ${formatMs(prev.end_ms)}）重叠`,
        cur.src_line
      );
    }
  }

  return cues;
}

/**
 * 序列化为标准 SRT：按开始时间重新编号，文字换行原样保留。
 * @param {{start_ms:number,end_ms:number,text:string}[]} cues
 * @returns {string}
 */
function serializeSrt(cues) {
  const sorted = [...cues].sort(
    (a, b) => a.start_ms - b.start_ms || a.end_ms - b.end_ms
  );
  return (
    sorted
      .map((c, idx) => {
        const text = String(c.text).replace(/\r\n?/g, '\n').replace(/\n+$/, '');
        return `${idx + 1}\n${formatMs(c.start_ms)} --> ${formatMs(c.end_ms)}\n${text}`;
      })
      .join('\n\n') + '\n'
  );
}

module.exports = {
  SrtError,
  TIMECODE_RE,
  parseTimeToMs,
  parseTimecodeToMs,
  formatMs,
  parseSrt,
  serializeSrt,
};
