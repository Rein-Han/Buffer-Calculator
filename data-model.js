/* data-model.js — 纯数据层 BufferData
 * 无 DOM、无 SDK、无 localStorage：结构检查、深拷贝、canon 比较、既有默认迁移与完整校验。
 * 同时支持浏览器（globalThis.BufferData）与 CommonJS（node 单元测试 require）。
 */
(function (global) {
  'use strict';

  const DefaultDB = global.DefaultDB || (typeof require === 'function' ? require('./db.js') : null);
  const STORAGE_KEY = 'bufferCalcDB_v1';
  // 宿主 toolkit.storage.set 的上限口径：整个 storage.json 容器 JSON.stringify 后的字符数。
  // 本插件只持有一个键，因此完整容器即 { bufferCalcDB_v1: db }。
  const STORAGE_LIMIT_CHARS = 1024 * 1024;
  const DANGEROUS_KEYS = ['__proto__', 'constructor', 'prototype'];

  /* ---------- 基础工具 ---------- */
  function isPlain(v) {
    if (v === null || typeof v !== 'object' || Array.isArray(v)) return false;
    const p = Object.getPrototypeOf(v);
    return p === Object.prototype || p === null;
  }
  function clone(v) {
    if (Array.isArray(v)) return v.map(clone);
    if (v && typeof v === 'object') {
      const o = {};
      for (const k of Object.keys(v)) o[k] = clone(v[k]);
      return o;
    }
    return v;
  }
  function canon(o) { // 键排序的稳定序列化，用于迁移与变更比对
    if (Array.isArray(o)) return '[' + o.map(canon).join(',') + ']';
    if (o && typeof o === 'object') return '{' + Object.keys(o).sort().map(k => JSON.stringify(k) + ':' + canon(o[k])).join(',') + '}';
    return JSON.stringify(o) === undefined ? 'undefined' : JSON.stringify(o);
  }
  function isFiniteNum(v) { return typeof v === 'number' && Number.isFinite(v); }
  function isBool(v) { return typeof v === 'boolean'; }
  function isStr(v) { return typeof v === 'string'; }
  // 非负整数：缺省按既有迁移口径。旧数据里 rev 允许缺失；出现时必须为非负整数。
  function isRev(v) { return Number.isInteger(v) && v >= 0; }
  function defaultDB() { return { stocks: clone(DefaultDB.stocks), systems: clone(DefaultDB.systems) }; }

  /* ---------- 结构检查（硬错误） ---------- */
  // 递归确认整棵数据是 JSON 安全值：拒绝危险键、非有限数、函数/undefined/符号/循环引用。
  function scanJSON(value, path, errors, seen, depth) {
    if (errors.length >= 50) return;
    if (depth > 40) { errors.push(`${path}: 嵌套层级过深`); return; }
    const t = typeof value;
    if (value === null) return;
    if (t === 'number') { if (!Number.isFinite(value)) errors.push(`${path}: 数字必须有限`); return; }
    if (t === 'string' || t === 'boolean') return;
    if (t === 'undefined') { errors.push(`${path}: 不允许 undefined`); return; }
    if (t !== 'object') { errors.push(`${path}: 不允许 ${t} 类型的值`); return; }
    if (seen.has(value)) { errors.push(`${path}: 存在循环引用`); return; }
    seen.add(value);
    if (Array.isArray(value)) {
      value.forEach((v, i) => scanJSON(v, `${path}[${i}]`, errors, seen, depth + 1));
    } else {
      for (const k of Object.keys(value)) {
        if (DANGEROUS_KEYS.includes(k)) { errors.push(`${path}.${k}: 危险键不允许保存`); continue; }
        scanJSON(value[k], `${path}.${k}`, errors, seen, depth + 1);
      }
    }
    seen.delete(value);
  }

  function checkStock(s, i, errors, warn) {
    const at = `stocks[${i}]`;
    if (!isStr(s.id) || !s.id) { errors.push(`${at}.id: 必须为非空字符串`); }
    if (s.name != null && !isStr(s.name)) errors.push(`${at}.name: 必须为字符串`);
    if (s.type != null && !isStr(s.type)) errors.push(`${at}.type: 必须为字符串`);
    for (const k of ['concM', 'pct', 'refpH', 'pka', 'lambda']) {
      if (s[k] != null && !isFiniteNum(s[k])) errors.push(`${at}.${k}: 出现时必须为有限数字或 null`);
    }
    for (const k of ['na', 'cl']) {
      if (s[k] != null && !isFiniteNum(s[k])) errors.push(`${at}.${k}: 出现时必须为有限数字`);
    }
    if (s.rev != null && !isRev(s.rev)) errors.push(`${at}.rev: 必须为非负整数`);
    if (s.enabled != null && !isBool(s.enabled)) errors.push(`${at}.enabled: 必须为布尔`);
    if (s.noTitrant != null && !isBool(s.noTitrant)) errors.push(`${at}.noTitrant: 必须为布尔`);
    if (s.concM == null && s.pct == null && s.premix == null) warn.push(`${at}: 既无浓度也无质量分数（${s.id}）`);
    if (s.premix != null) {
      const pm = s.premix;
      if (!isPlain(pm)) { errors.push(`${at}.premix: 必须为对象`); return; }
      if (!isStr(pm.sysId) || !pm.sysId) errors.push(`${at}.premix.sysId: 必须为非空字符串`);
      if (!isFiniteNum(pm.concM)) errors.push(`${at}.premix.concM: 必须为有限数字`);
      if (!isFiniteNum(pm.dbar)) errors.push(`${at}.premix.dbar: 必须为有限数字`);
      if (!Array.isArray(pm.saltIons)) errors.push(`${at}.premix.saltIons: 必须为数组`);
      else pm.saltIons.forEach((ion, j) => {
        const iat = `${at}.premix.saltIons[${j}]`;
        if (!isPlain(ion)) { errors.push(`${iat}: 必须为对象`); return; }
        if (!isFiniteNum(ion.z)) errors.push(`${iat}.z: 必须为有限数字`);
        if (!isFiniteNum(ion.concM)) errors.push(`${iat}.concM: 必须为有限数字`);
        if (ion.lambda != null && !isFiniteNum(ion.lambda)) errors.push(`${iat}.lambda: 出现时必须为有限数字`);
      });
    }
  }

  function checkSystem(s, i, errors, warn) {
    const at = `systems[${i}]`;
    if (!isStr(s.id) || !s.id) errors.push(`${at}.id: 必须为非空字符串`);
    if (s.name != null && !isStr(s.name)) errors.push(`${at}.name: 必须为字符串`);
    if (s.enabled != null && !isBool(s.enabled)) errors.push(`${at}.enabled: 必须为布尔`);
    for (const k of ['range', 'range2']) {
      if (s[k] == null) continue;
      if (!Array.isArray(s[k]) || s[k].length !== 2 || !s[k].every(isFiniteNum)) errors.push(`${at}.${k}: 必须为两个有限数字的数组`);
    }
    if (s.premix === true) {
      // 预混体系只通过 stockId 指向预混母液，不要求 steps；不能用普通体系 schema 误拒绝。
      if (!isStr(s.stockId) || !s.stockId) errors.push(`${at}.stockId: 预混体系必须提供非空 stockId`);
      if (s.stocks != null && !Array.isArray(s.stocks)) errors.push(`${at}.stocks: 出现时必须为数组`);
      return;
    }
    if (!Array.isArray(s.steps) || !s.steps.length) { errors.push(`${at}.steps: 必须为非空数组`); return; }
    if (!Array.isArray(s.stocks)) errors.push(`${at}.stocks: 必须为数组`);
    else s.stocks.forEach((x, j) => {
      const iat = `${at}.stocks[${j}]`;
      if (!isPlain(x)) { errors.push(`${iat}: 必须为对象`); return; }
      if (!isStr(x.stockId) || !x.stockId) errors.push(`${iat}.stockId: 必须为非空字符串`);
      if (!isFiniteNum(x.dStock)) errors.push(`${iat}.dStock: 必须为有限数字`);
    });
    s.steps.forEach((st, j) => {
      const iat = `${at}.steps[${j}]`;
      if (!isPlain(st)) { errors.push(`${iat}: 必须为对象`); return; }
      if (!isFiniteNum(st.pKa)) errors.push(`${iat}.pKa: 必须为有限数字`);
      if (!Number.isInteger(st.zA)) errors.push(`${iat}.zA: 必须为整数`);
      if (!Number.isInteger(st.zB)) errors.push(`${iat}.zB: 必须为整数`);
      if (Number.isInteger(st.zA) && Number.isInteger(st.zB) && st.zB !== st.zA - 1) errors.push(`${iat}: zB 必须等于 zA−1`);
      else if (j > 0 && Number.isInteger(st.zA) && Number.isInteger(s.steps[j - 1].zA) && st.zA !== s.steps[j - 1].zB) {
        errors.push(`${iat}: 与上一级电荷不连续`);
      }
    });
    const charges = new Set();
    for (const st of s.steps) { if (Number.isInteger(st.zA)) charges.add(st.zA); if (Number.isInteger(st.zB)) charges.add(st.zB); }
    if (Array.isArray(s.stocks) && !s.stocks.some(x => isPlain(x) && charges.has(x.dStock))) {
      // 仅为可用性提示：任一母液的 d 值都落在该体系电荷区间之外时配方可能无解。
      warn.push(`体系「${s.name || s.id}」的母液 d 值都不在电荷区间内，可能无法配制`);
    }
  }

  function checkCalibrationRow(x, i, errors) {
    const at = `calibration[${i}]`;
    if (!isPlain(x)) { errors.push(`${at}: 必须为对象`); return; }
    if (!isStr(x.id) || !x.id) errors.push(`${at}.id: 必须为非空字符串`);
    if (!isStr(x.key) || !x.key) errors.push(`${at}.key: 必须为非空字符串`);
    if (!isFiniteNum(x.targetPH) || x.targetPH < 0 || x.targetPH > 14) errors.push(`${at}.targetPH: 必须为 0～14 的有限数字`);
    if (!isFiniteNum(x.measuredPH) || x.measuredPH < 0 || x.measuredPH > 14) errors.push(`${at}.measuredPH: 必须为 0～14 的有限数字`);
    if (x.tempC != null && !isFiniteNum(x.tempC)) errors.push(`${at}.tempC: 出现时必须为有限数字或 null`);
    for (const k of ['label', 'at', 'model', 'text']) {
      if (x[k] != null && !isStr(x[k])) errors.push(`${at}.${k}: 出现时必须为字符串`);
    }
  }

  function checkDeletedDefaults(dd, errors) {
    if (!isPlain(dd)) { errors.push('deletedDefaults: 必须为对象'); return; }
    for (const kind of ['stocks', 'systems']) {
      const v = dd[kind];
      if (v == null) continue;
      if (!Array.isArray(v) || !v.every(isStr)) errors.push(`deletedDefaults.${kind}: 必须为非空字符串数组`);
    }
  }

  function uniqueIds(list, at, errors) {
    const seen = new Set();
    list.forEach((x, i) => {
      if (!isPlain(x) || !isStr(x.id) || !x.id) return;
      if (seen.has(x.id)) errors.push(`${at}[${i}].id: 与前面的 ID 重复（${x.id}）`);
      seen.add(x.id);
    });
  }

  // 结构检查：只判断能否安全地读写，不做化学语义判断。
  function validate(raw) {
    const errors = [], warnings = [];
    if (!isPlain(raw)) return { errors: ['顶层必须为对象'], warnings };
    for (const k of Object.keys(raw)) {
      if (DANGEROUS_KEYS.includes(k)) errors.push(`顶层 ${k}: 危险键不允许保存`);
    }
    if (!Array.isArray(raw.stocks)) errors.push('stocks: 必须为数组');
    if (!Array.isArray(raw.systems)) errors.push('systems: 必须为数组');
    if (raw.calibration != null && !Array.isArray(raw.calibration)) errors.push('calibration: 出现时必须为数组');
    if (raw.renameRev != null && !isRev(raw.renameRev)) errors.push('renameRev: 必须为非负整数');
    if (raw.deletedDefaults != null) checkDeletedDefaults(raw.deletedDefaults, errors);
    scanJSON(raw, 'db', errors, new Set(), 0);
    if (errors.length) return { errors, warnings };
    uniqueIds(raw.stocks, 'stocks', errors);
    uniqueIds(raw.systems, 'systems', errors);
    if (Array.isArray(raw.calibration)) {
      uniqueIds(raw.calibration, 'calibration', errors);
      raw.calibration.forEach((x, i) => checkCalibrationRow(x, i, errors));
    }
    raw.stocks.forEach((s, i) => { if (isPlain(s)) checkStock(s, i, errors, warnings); else errors.push(`stocks[${i}]: 必须为对象`); });
    raw.systems.forEach((s, i) => { if (isPlain(s)) checkSystem(s, i, errors, warnings); else errors.push(`systems[${i}]: 必须为对象`); });
    return { errors, warnings };
  }

  function validateOnly(db) { return validate(db); }

  /* ---------- 默认迁移（顺序沿用原 localStorage 版本） ---------- */
  // 只在初始化、导入与明确恢复默认时执行；不在每次编辑事务后重复跑，避免覆盖刚编辑的字段。
  function migrate(d) {
    let changed = false;
    const deletedStocks = new Set((d.deletedDefaults && d.deletedDefaults.stocks) || []);
    const deletedSystems = new Set((d.deletedDefaults && d.deletedDefaults.systems) || []);
    for (const s of DefaultDB.stocks) {
      if (deletedStocks.has(s.id)) continue;
      const i = d.stocks.findIndex(x => x.id === s.id);
      if (i < 0) { d.stocks.push(clone(s)); changed = true; }
      else if ((s.rev || 0) > (d.stocks[i].rev || 0)) {
        if (s.id === 'pbs10x' && s.rev === 4) {
          // 旧版 PBS 默认盐组成：内容仍是旧默认说明用户未自定义，可以升级；否则保留用户组成。
          const old = clone(s); old.rev = 3; old.premix.saltIons[0].concM = 1.549;
          if (canon(d.stocks[i]) !== canon(old)) continue;
        }
        d.stocks[i] = clone(s); changed = true;
      }
    }
    for (const s of DefaultDB.systems) {
      if (deletedSystems.has(s.id)) continue;
      const i = d.systems.findIndex(x => x.id === s.id);
      if (i < 0) { d.systems.push(clone(s)); changed = true; }
      else if ((s.rev || 0) > (d.systems[i].rev || 0)) { d.systems[i] = clone(s); changed = true; }
    }
    // 完整 His（三级 pKa）：仅当内容仍与旧两级默认完全一致时升级
    const oldHis = { id: 'histidine', name: 'His', enabled: true, range: [5, 7], steps: [{ pKa: 6, zA: 1, zB: 0 }], stocks: [{ stockId: 'his_hcl', dStock: 0 }, { stockId: 'his', dStock: 1 }] };
    const hi = d.systems.findIndex(s => s.id === 'histidine');
    if (hi >= 0 && canon(d.systems[hi]) === canon(oldHis)) {
      d.systems[hi] = clone(DefaultDB.systems.find(s => s.id === 'histidine'));
      changed = true;
    }
    // 已废弃的默认体系：用户从未修改过才自动移除
    for (const ob of (DefaultDB.obsoleteSystems || [])) {
      const i = d.systems.findIndex(x => x.id === ob.id);
      if (i >= 0 && canon(d.systems[i]) === canon(ob.match)) { d.systems.splice(i, 1); changed = true; }
    }
    // 显示名英文化：一次性执行。无论是否命中改名，都必须把 renameRev 记到数据里，
    // 否则每次读取都会重新应用改名，把用户对默认条目名称的修改覆盖掉（T-008 复现）。
    if ((d.renameRev || 0) < (DefaultDB.renameRev || 0)) {
      const map = DefaultDB.renameMap || {};
      for (const id of Object.keys(map.stocks || {})) {
        const s = d.stocks.find(x => x.id === id);
        if (s) { s.name = map.stocks[id]; changed = true; }
      }
      for (const id of Object.keys(map.systems || {})) {
        const s = d.systems.find(x => x.id === id);
        if (s) { s.name = map.systems[id]; changed = true; }
      }
    }
    if ((d.renameRev || 0) !== (DefaultDB.renameRev || 0)) {
      d.renameRev = DefaultDB.renameRev;
      changed = true;
    }
    return changed;
  }

  /* ---------- 缺失引用（只用警告，不作为整库硬错误） ---------- */
  // 旧的删除操作可能留下空 stocks、premix.stockId 或 premix.sysId 失配。
  // 保留数据与删除标记：不静默补回被删除的默认条目，也不级联删除体系或历史记录。
  function referenceWarnings(db) {
    const warnings = [];
    const stockIds = new Set(db.stocks.map(s => s.id));
    const sysIds = new Set(db.systems.map(s => s.id));
    const usedStock = new Set();
    for (const s of db.systems) {
      if (s.premix === true) {
        if (!stockIds.has(s.stockId)) warnings.push(`体系「${s.name || s.id}」引用的预混母液 ${s.stockId} 不存在`);
        else usedStock.add(s.stockId);
        continue;
      }
      if (!Array.isArray(s.stocks) || !s.stocks.length) { warnings.push(`体系「${s.name || s.id}」没有可用母液配方`); continue; }
      for (const x of s.stocks) {
        if (!stockIds.has(x.stockId)) warnings.push(`体系「${s.name || s.id}」引用的母液 ${x.stockId} 不存在`);
        else usedStock.add(x.stockId);
      }
    }
    for (const st of db.stocks) {
      if (st.premix && !sysIds.has(st.premix.sysId)) warnings.push(`预混母液「${st.name || st.id}」引用的缓冲体系 ${st.premix.sysId} 不存在`);
    }
    const orphans = db.stocks.filter(s => !usedStock.has(s.id) && !s.premix);
    if (orphans.length > 3) warnings.push(`${orphans.length} 个母液未被任何缓冲体系引用（可在管理页删除或补配方）`);
    return warnings;
  }

  /* ---------- 对外接口 ---------- */
  // prepare(raw) → {db, changed, warnings}
  // raw 为对象或 null，返回独立副本；原对象不被改动。先结构检查、后迁移、再语义检查。
  function prepare(raw) {
    const source = raw == null ? null : clone(raw);
    const base = source == null ? defaultDB() : source;
    if (source != null) {
      const pre = validate(source);
      if (pre.errors.length) {
        const err = new Error('数据格式不正确：' + pre.errors[0]);
        err.code = 'CORRUPT_STORAGE';
        err.errors = pre.errors;
        throw err;
      }
    }
    const changedByMigration = migrate(base);
    const post = validate(base);
    if (post.errors.length) {
      const err = new Error('迁移后数据校验失败：' + post.errors[0]);
      err.code = 'CORRUPT_STORAGE';
      err.errors = post.errors;
      throw err;
    }
    const changed = changedByMigration || (source != null && canon(source) !== canon(base));
    return { db: base, changed, warnings: post.warnings.concat(referenceWarnings(base)) };
  }

  // 容量预检：宿主限制是完整 storage.json 的字符串长度（不是 UTF-8 字节）。
  function checkCapacity(db) {
    const container = JSON.stringify({ [STORAGE_KEY]: db });
    const entry = JSON.stringify([STORAGE_KEY, db]);
    const length = Math.max(container.length, entry.length);
    return { ok: length <= STORAGE_LIMIT_CHARS, length, limit: STORAGE_LIMIT_CHARS };
  }

  function textBytes(text) {
    if (typeof TextEncoder !== 'undefined') return new TextEncoder().encode(text).length;
    return Buffer.byteLength(text, 'utf8');
  }

  const BufferData = {
    STORAGE_KEY, STORAGE_LIMIT_CHARS,
    clone, canon, defaultDB, validate, validateOnly, prepare, migrate,
    referenceWarnings, checkCapacity, textBytes,
  };
  global.BufferData = BufferData;
  if (typeof module !== 'undefined' && module.exports) module.exports = BufferData;
})(typeof window !== 'undefined' ? window : globalThis);
