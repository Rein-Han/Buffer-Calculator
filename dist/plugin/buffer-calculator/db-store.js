/* db-store.js — 数据事务层 BufferStore
 * 维护唯一已提交 DB 与串行写队列；只有确认写入成功才提交快照。
 * 不依赖 DOM；platform 由 toolkit-platform.js 提供，单元测试可注入受控替身。
 *
 * 两个独立的门禁（T-008 F-01/F-04 修复要点）：
 *  - generation：实例代次。dispose 后递增，任何 await 之后都必须重新核对，
 *    使旧回调不能提交快照、改状态或继续发请求。
 *  - writeEpoch：写入代次。仅在“结果不确定”的写入失败时递增；每个任务在入队时
 *    捕获当时的代次，执行前核对。这样已排队但尚未发送的事务会因不确定结果作废，
 *    而明确的校验/容量/宿主拒绝不会影响队列，后续合法操作仍可继续。
 */
(function (global) {
  'use strict';

  const BufferData = global.BufferData || (typeof require === 'function' ? require('./data-model.js') : null);

  // 写入失败分类：
  //  - VALIDATION / CAPACITY：本地明确未写入，保留最新已提交 DB，不阻断后续合法操作。
  //  - 宿主明确拒绝（权限、实例失效、参数、配额、存储损坏）：未写盘，保留 DB 与队列。
  //  - UNCERTAIN：桥接中断或宿主内部错误，无法确认是否落盘，必须先恢复到只读核对状态。
  const LOCAL_CODES = ['VALIDATION', 'CAPACITY'];
  const DENIED_CODES = [
    'PERMISSION_DENIED', 'PLUGIN_DISABLED', 'INVALID_INSTANCE', 'INVALID_ARGUMENT',
    'UNSUPPORTED_API', 'QUOTA_EXCEEDED', 'CORRUPT_STORAGE', 'STORAGE_UNREADABLE',
  ];

  function create({ platform }) {
    if (!platform) throw new Error('BufferStore 需要 platform');
    let state = 'loading';           // loading | ready | recovery | disposed
    let db = null;                   // 唯一已提交快照
    let initPromise = null;
    let recoveryInfo = { readSucceeded: false, raw: null, code: null, uncertain: false };
    let tail = Promise.resolve();    // 串行队列尾：以捕获后的 Promise 继续，不会永久断链
    let pending = 0;
    let generation = 1;              // 实例代次：dispose 后递增，旧回调据此作废
    let writeEpoch = 0;              // 写入代次：不确定结果后递增，作废尚未发送的排队事务

    const closedError = () => Object.assign(new Error('实例已关闭'), { code: 'INVALID_INSTANCE', instanceClosed: true });
    const voidedError = () => Object.assign(
      new Error('上一次保存结果无法确认，本次修改未发送。请先重新读取实际存储再重试。'),
      { code: 'WRITE_VOIDED', voided: true },
    );

    function setRecovery(info) {
      const next = Object.assign({ readSucceeded: false, raw: null, code: null, uncertain: false }, info || {});
      state = 'recovery';
      recoveryInfo = next;
    }
    function settle(promise) {
      const next = promise.then(() => undefined, () => undefined);
      tail = next;
      return next;
    }
    // 执行任务前的门禁：实例未销毁，且没有因不确定写入而作废本次任务。
    function gateAlive(gen) {
      if (state === 'disposed' || gen !== generation) throw closedError();
    }
    function gateAtRun(gen, epoch) {
      gateAlive(gen);
      if (epoch !== writeEpoch) throw voidedError();
    }
    // 读取/重读是“核对实际存储”的操作：进入时作废尚未发送的写事务，并释放队列。
    // 因此读取本身不受 epoch 限制，只受实例代次限制。
    function beginRecovery(reason) {
      writeEpoch++;
      state = 'loading';
      recoveryInfo = { readSucceeded: false, raw: null, code: reason || null, uncertain: false };
    }
    // 队列可能在上一次 await 之后才轮到本任务：真正发请求之前必须再核对一次，
    // 否则“结果不确定”的写入会让已经排队的任务把旧快照写回去（T-008 F-01）。
    function gateBeforeWrite(gen, epoch) {
      gateAtRun(gen, epoch);
      if (state !== 'ready' && state !== 'recovery') throw voidedError();
    }
    function tracked(gen, epoch, run) {
      pending++;
      const p = tail.then(() => {
        gateAtRun(gen, epoch);
        return run();
      });
      settle(p);
      return p.finally(() => { pending--; });
    }

    function applyChange(change) {
      const draft = BufferData.clone(db);
      if (typeof change === 'function') {
        const result = change(draft);
        if (result && typeof result.then === 'function') {
          throw Object.assign(new Error('mutate 的 change 必须是同步函数'), { code: 'VALIDATION' });
        }
        // 支持两种写法：就地修改草稿（返回 undefined），或返回一个新的完整库对象。
        // 后者必须真正替换草稿，否则整库替换类操作（导入/恢复默认）会静默丢失改动。
        if (result !== undefined) {
          if (!result || typeof result !== 'object' || Array.isArray(result)) {
            throw Object.assign(new Error('mutate 的 change 返回值必须是数据库对象或 undefined'), { code: 'VALIDATION' });
          }
          return result;
        }
      } else if (change && typeof change === 'object') {
        Object.assign(draft, BufferData.clone(change));
      } else {
        throw Object.assign(new Error('mutate 需要函数或对象'), { code: 'VALIDATION' });
      }
      return draft;
    }

    function validateNext(candidate) {
      const check = BufferData.validate(candidate);
      if (check.errors.length) {
        throw Object.assign(new Error('数据校验失败：' + check.errors[0]), { code: 'VALIDATION', errors: check.errors });
      }
      const capacity = BufferData.checkCapacity(candidate);
      if (!capacity.ok) {
        throw Object.assign(
          new Error(`数据容量超出工具箱上限：当前 ${capacity.length} 字符，上限 ${capacity.limit} 字符。请先导出备份并清理实测记录或自定义条目。`),
          { code: 'CAPACITY', length: capacity.length, limit: capacity.limit },
        );
      }
      return check.warnings;
    }

    async function commit({ kind, candidate, gen, epoch }) {
      const warnings = validateNext(candidate);
      gateBeforeWrite(gen, epoch);
      try {
        await platform.writeDB(candidate);
      } catch (error) {
        if (state === 'disposed' || gen !== generation) throw closedError();
        const code = (error && error.code) || 'HOST_ERROR';
        if (LOCAL_CODES.includes(code)) throw error;   // 本地校验/容量：明确未写入
        if (DENIED_CODES.includes(code)) throw error;  // 宿主明确拒绝：未写盘，保留状态与队列
        // 结果不确定：暂停写入，作废尚未发送的排队事务，并要求显式重读核对。
        writeEpoch++;
        setRecovery({ readSucceeded: true, raw: db, code, uncertain: true });
        throw Object.assign(
          new Error('保存结果无法确认，已暂停写入以避免覆盖：' + ((error && error.message) || code)),
          { code, cause: error, uncertain: true },
        );
      }
      // 已确认写入，但若期间实例已销毁，则不得把状态改回 ready 或提交快照。
      if (state === 'disposed' || gen !== generation) throw closedError();
      db = candidate;                                   // 只有确认写入才替换快照
      state = 'ready';                                  // 恢复状态下的成功写入（replace/重读后）回到 ready
      return warnings;
    }

    function requireReady(action) {
      if (state === 'disposed') throw closedError();
      if (state !== 'ready') throw Object.assign(new Error(`${action} 需要数据已就绪，当前状态：${state}`), { code: 'NOT_READY' });
    }

    /* ---------- 初始化 ---------- */
    async function load(isRetry, gen) {
      let raw;
      try {
        raw = await platform.readDB();
      } catch (error) {
        if (state === 'disposed' || gen !== generation) throw closedError();
        setRecovery({ readSucceeded: false, raw: null, code: (error && error.code) || 'HOST_ERROR' });
        throw Object.assign(new Error('读取插件存储失败：' + ((error && error.message) || '未知错误')), { code: recoveryInfo.code, cause: error });
      }
      if (state === 'disposed' || gen !== generation) throw closedError();
      if (raw == null) {
        // 存储中没有本键：建立默认库，等写入成功后进入 ready。
        // 必须走与 prepare 相同的迁移流程，否则新建库会缺少 renameRev 等迁移标记，
        // 下一次读取就会重新应用一次性迁移（T-008 复现：默认条目改名被反复覆盖）。
        const fresh = BufferData.prepare(null).db;
        validateNext(fresh);
        gateAlive(gen);
        try {
          await platform.writeDB(fresh);
        } catch (error) {
          if (state === 'disposed' || gen !== generation) throw closedError();
          const code = (error && error.code) || 'HOST_ERROR';
          setRecovery({ readSucceeded: true, raw: null, code, uncertain: !DENIED_CODES.includes(code) && !LOCAL_CODES.includes(code) });
          throw Object.assign(new Error('建立默认库失败：' + ((error && error.message) || '未知错误')), { code, cause: error });
        }
        if (state === 'disposed' || gen !== generation) throw closedError();
        db = fresh;
        state = 'ready';
        return { status: 'created', retry: !!isRetry };
      }
      let prepared;
      try {
        prepared = BufferData.prepare(raw);
      } catch (error) {
        // 能读出 JSON 值但业务结构非法：保留原值供原样导出，不经过迁移或字段裁剪。
        setRecovery({ readSucceeded: true, raw, code: (error && error.code) || 'CORRUPT_STORAGE' });
        throw Object.assign(new Error((error && error.message) || '数据格式不正确'), { code: (error && error.code) || 'CORRUPT_STORAGE', cause: error, errors: error && error.errors });
      }
      if (prepared.changed) {
        // 迁移必须确认落盘后才进入可编辑的 ready，否则用户会在未保存的库上继续编辑。
        validateNext(prepared.db);
        gateAlive(gen);
        try {
          await platform.writeDB(prepared.db);
        } catch (error) {
          if (state === 'disposed' || gen !== generation) throw closedError();
          const code = (error && error.code) || 'HOST_ERROR';
          setRecovery({ readSucceeded: true, raw, code, uncertain: !DENIED_CODES.includes(code) && !LOCAL_CODES.includes(code) });
          throw Object.assign(new Error('默认迁移写入失败：' + ((error && error.message) || code)), { code, cause: error });
        }
      }
      if (state === 'disposed' || gen !== generation) throw closedError();
      db = prepared.db;
      state = 'ready';
      return { status: prepared.changed ? 'migrated' : 'loaded', warnings: prepared.warnings, retry: !!isRetry };
    }

    const store = {
      get state() { return state; },
      get pending() { return pending; },
      get generation() { return generation; },

      init() {
        if (state === 'disposed') return Promise.reject(closedError());
        if (state === 'ready') return Promise.resolve({ status: 'ready' });
        if (initPromise) return initPromise;   // pending 时复用同一 Promise；失败后下一次显式调用才新建读取尝试
        const isRetry = state === 'recovery';
        const gen = generation;
        beginRecovery(isRetry ? recoveryInfo.code : null);
        const attempt = tracked(gen, writeEpoch, () => load(isRetry, gen));
        // 无论成功失败都释放一次性令牌：写入不确定性导致的恢复状态必须能重新读取核对。
        attempt.then(() => { initPromise = null; }, () => { initPromise = null; });
        initPromise = attempt;
        return attempt;
      },

      snapshot() {
        requireReady('读取数据');
        return BufferData.clone(db);
      },

      recovery() {
        return {
          readSucceeded: !!recoveryInfo.readSucceeded,
          raw: recoveryInfo.readSucceeded && recoveryInfo.raw != null ? BufferData.clone(recoveryInfo.raw) : null,
          code: recoveryInfo.code || null,
          uncertain: !!recoveryInfo.uncertain,
        };
      },

      mutate(change) {
        requireReady('修改数据');
        const gen = generation, epoch = writeEpoch;
        return tracked(gen, epoch, async () => {
          const candidate = applyChange(change);
          return { warnings: await commit({ kind: 'mutate', candidate, gen, epoch }) };
        });
      },

      replace(candidate) {
        if (state === 'recovery') {
          if (!recoveryInfo.readSucceeded) {
            return Promise.reject(Object.assign(new Error('存储文件本身不可读取，无法在此覆盖；请先用宿主管理途径恢复。'), { code: 'STORAGE_UNREADABLE' }));
          }
        } else {
          requireReady('替换数据');
        }
        const gen = generation, epoch = writeEpoch;
        const next = BufferData.clone(candidate);
        return tracked(gen, epoch, async () => {
          return { warnings: await commit({ kind: 'replace', candidate: next, gen, epoch }) };
        });
      },

      // 队列排空后回调；写入排队期间调用 whenIdle 会等到该写入结束。
      // 任务被作废或实例销毁时同样会结算，因此不会永久挂起。
      whenIdle() {
        if (state === 'disposed') return Promise.resolve();
        return tail.then(() => undefined);
      },

      dispose() {
        if (state === 'disposed') return;
        state = 'disposed';
        generation++;                  // 递增代次：所有在途/排队的旧回调据此作废
        writeEpoch++;                  // 尚未发送的排队事务一律不再发送
        db = null;
        initPromise = null;
        recoveryInfo = { readSucceeded: false, raw: null, code: null, uncertain: false };
      },
    };
    return store;
  }

  const BufferStore = { create };
  global.BufferStore = BufferStore;
  if (typeof module !== 'undefined' && module.exports) module.exports = BufferStore;
})(typeof window !== 'undefined' ? window : globalThis);
