'use strict';

/**
 * SQLite 存储层（sql.js / WebAssembly 后端）。
 *
 * 选用 sql.js 的原因：纯 wasm，无原生编译依赖，镜像构建和受限网络环境都友好。
 * 持久化：每次写事务提交后把整库快照写回 DB_PATH；读取直接走内存，速度足够
 * 小型放映团队使用。':memory:' 用于测试，不产生任何文件。
 *
 * 对外暴露与 better-sqlite3 类似的子集：
 *   db.prepare(sql).get/all/run(...)
 *   db.exec(sql)
 *   db.pragma(...)
 *   db.transaction(fn)  ->  fn（返回函数，支持 .immediate/.deferred 别名）
 *   db.init()           ->  Promise（加载 wasm、恢复磁盘快照并建表）
 */

const fs = require('fs');
const path = require('path');
const initSqlJs = require('sql.js');

const SCHEMA = `
PRAGMA foreign_keys = ON;

CREATE TABLE IF NOT EXISTS works (
  id          INTEGER PRIMARY KEY AUTOINCREMENT,
  title       TEXT NOT NULL,
  filename    TEXT NOT NULL,
  revision    INTEGER NOT NULL DEFAULT 1,
  created_at  TEXT NOT NULL DEFAULT (datetime('now')),
  updated_at  TEXT NOT NULL DEFAULT (datetime('now'))
);

CREATE TABLE IF NOT EXISTS cues (
  id        INTEGER PRIMARY KEY AUTOINCREMENT,
  work_id   INTEGER NOT NULL REFERENCES works(id) ON DELETE CASCADE,
  idx       INTEGER NOT NULL,
  start_ms  INTEGER NOT NULL,
  end_ms    INTEGER NOT NULL,
  text      TEXT NOT NULL
);

CREATE INDEX IF NOT EXISTS idx_cues_work ON cues(work_id, idx);

CREATE TABLE IF NOT EXISTS revisions_log (
  id          INTEGER PRIMARY KEY AUTOINCREMENT,
  work_id     INTEGER NOT NULL REFERENCES works(id) ON DELETE CASCADE,
  revision    INTEGER NOT NULL,
  editor      TEXT,
  action      TEXT NOT NULL,
  cue_id      INTEGER,
  created_at  TEXT NOT NULL DEFAULT (datetime('now'))
);

-- 候选修改待审区：提交时冻结原段快照（orig_*）与候选值（new_*），
-- 正式段、作品修订号在提交时都不变；采纳/驳回后 status 变为
-- accepted/rejected 并记录审阅者与结案时间，结案后不可再处理。
CREATE TABLE IF NOT EXISTS proposals (
  id            INTEGER PRIMARY KEY AUTOINCREMENT,
  work_id       INTEGER NOT NULL REFERENCES works(id) ON DELETE CASCADE,
  cue_id        INTEGER NOT NULL REFERENCES cues(id) ON DELETE CASCADE,
  status        TEXT NOT NULL DEFAULT 'pending',
  base_revision INTEGER NOT NULL,
  orig_start_ms INTEGER NOT NULL,
  orig_end_ms   INTEGER NOT NULL,
  orig_text     TEXT NOT NULL,
  new_start_ms  INTEGER NOT NULL,
  new_end_ms    INTEGER NOT NULL,
  new_text      TEXT NOT NULL,
  note          TEXT,
  editor        TEXT,
  reviewer      TEXT,
  created_at    TEXT NOT NULL DEFAULT (datetime('now')),
  resolved_at   TEXT
);

CREATE INDEX IF NOT EXISTS idx_proposals_work ON proposals(work_id, status);
`;

function bindParams(stmt, args) {
  if (args.length === 0) {
    return stmt;
  }
  // sql.js 只接受数组（位置参数 ?）或键名为 :name/$name/@name 的对象。
  // better-sqlite3 的位置参数风格统一转为数组；本应用不使用命名参数。
  let params;
  if (args.length === 1 && Array.isArray(args[0])) {
    params = args[0];
  } else {
    params = Array.from(args);
  }
  stmt.bind(params);
  return stmt;
}

/**
 * 把 sql.js 的列结果转成普通对象。sql.js 整数以 number 返回（本应用时间戳
 * 与自增主键都远在 2^53 以内，安全）。
 */
function rowsToObjects(result) {
  if (!result || result.length === 0) return [];
  const { columns, values } = result[0];
  return values.map((row) => {
    const obj = {};
    columns.forEach((col, i) => {
      obj[col] = row[i];
    });
    return obj;
  });
}

async function openDb(dbPath) {
  const SQL = await initSqlJs({
    // 显式定位包内自带的 wasm，避免在 CWD 之外找不到
    locateFile: (file) => path.join(__dirname, '..', 'node_modules', 'sql.js', 'dist', file),
  });

  const isMemory = dbPath === ':memory:';
  let buffer;
  if (!isMemory) {
    fs.mkdirSync(path.dirname(dbPath), { recursive: true });
    if (fs.existsSync(dbPath)) {
      buffer = fs.readFileSync(dbPath);
    }
  }
  const db = new SQL.Database(buffer);
  db.run(SCHEMA);

  let dirty = false;
  let savepointDepth = 0;

  const flush = () => {
    if (isMemory || !dirty) return;
    // 快照导出前释放全部预编译语句：sql.js 的 export() 会使既有语句句柄失效，
    // 导出完成后缓存清空，下次 prepare 时按需重建
    for (const stmt of stmtCache.values()) {
      try {
        stmt.free();
      } catch (_) {
        /* 已释放则忽略 */
      }
    }
    stmtCache.clear();

    const tmp = `${dbPath}.tmp`;
    fs.writeFileSync(tmp, Buffer.from(db.export()));
    fs.renameSync(tmp, dbPath);
    dirty = false;
  };

  const stmtCache = new Map();

  /** 同一 SQL 复用预编译语句（better-sqlite3 语义）；每次执行后 reset 以便重用 */
  const getStmt = (sql) => {
    let stmt = stmtCache.get(sql);
    if (!stmt) {
      stmt = db.prepare(sql);
      stmtCache.set(sql, stmt);
    }
    stmt.reset();
    return stmt;
  };

  const prepare = (sql) => {
    return {
      get(...args) {
        const stmt = getStmt(sql);
        bindParams(stmt, args);
        const row = stmt.step() ? stmt.getAsObject() : undefined;
        stmt.reset();
        return row;
      },
      all(...args) {
        const stmt = getStmt(sql);
        bindParams(stmt, args);
        const out = [];
        while (stmt.step()) out.push(stmt.getAsObject());
        stmt.reset();
        return out;
      },
      run(...args) {
        const stmt = getStmt(sql);
        bindParams(stmt, args);
        stmt.step();
        stmt.reset();
        const changes = db.getRowsModified();
        dirty = true;
        // 事务内：提交时统一落盘；事务外的单条写语句立即落盘
        if (savepointDepth === 0) flush();
        return { changes, lastInsertRowid: db.exec('SELECT last_insert_rowid() AS id')[0].values[0][0] };
      },
    };
  };

  /**
   * 事务包装：异常时回滚（嵌套时使用 SAVEPOINT），成功后提交并落盘。
   * .immediate/.deferred 只是语义别名，wasm 单连接下行为相同。
   */
  const makeTransaction = (fn) => {
    const wrapped = (...args) => {
      const name = `sp_${savepointDepth}`;
      if (savepointDepth === 0) {
        db.run('BEGIN IMMEDIATE');
      } else {
        db.run(`SAVEPOINT ${name}`);
      }
      savepointDepth++;
      try {
        const ret = fn(...args);
        savepointDepth--;
        if (savepointDepth === 0) {
          db.run('COMMIT');
          flush();
        } else {
          db.run(`RELEASE SAVEPOINT ${name}`);
        }
        return ret;
      } catch (err) {
        savepointDepth--;
        if (savepointDepth === 0) {
          db.run('ROLLBACK');
        } else {
          db.run(`ROLLBACK TO SAVEPOINT ${name}`);
          db.run(`RELEASE SAVEPOINT ${name}`);
        }
        throw err;
      }
    };
    wrapped.immediate = wrapped;
    wrapped.deferred = wrapped;
    return wrapped;
  };

  return {
    prepare,
    exec: (sql) => {
      db.exec(sql);
    },
    pragma: (str) => {
      // 仅需兼容本应用用到的 pragma（journal_mode / foreign_keys），wasm 后端为空操作
      return [];
    },
    transaction: makeTransaction,
    flush,
    close: () => db.close(),
  };
}

module.exports = { openDb };
