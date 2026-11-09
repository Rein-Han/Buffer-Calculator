/* toolkit-api.js — 宿主存在性/API 版本守卫与 SDK 错误规范化
 * 不含业务逻辑，不写 DOM：plugin-entry.js 用它决定是否进入业务，
 * toolkit-platform.js 用它把 SDK 拒绝值统一成带 code 的普通对象。
 */
(function (global) {
  'use strict';

  const REQUIRED_API = '1.1';
  const REQUIRED_METHODS = [
    'onActivate', 'onView', 'onEnvironmentChange', 'onDeactivate',
    'storage.get', 'storage.set',
    'files.saveText', 'clipboard.writeText', 'printing.print',
  ];

  function dig(object, dotted) {
    let current = object;
    for (const part of dotted.split('.')) {
      if (current == null) return undefined;
      current = current[part];
    }
    return current;
  }

  // SDK 拒绝值是普通可序列化对象 {name:'ToolkitError', code, message}，不是 Error 实例。
  // 规范化后只保留 name/code/message，不保留原始对象，便于安全显示与比较。
  function normalizeError(error, fallbackCode) {
    if (error && typeof error === 'object') {
      const code = typeof error.code === 'string' && error.code ? error.code : (fallbackCode || 'UNKNOWN_ERROR');
      const message = typeof error.message === 'string' && error.message ? error.message : code;
      return { name: 'ToolkitError', code, message };
    }
    if (typeof error === 'string' && error) return { name: 'ToolkitError', code: fallbackCode || 'UNKNOWN_ERROR', message: error };
    return { name: 'ToolkitError', code: fallbackCode || 'UNKNOWN_ERROR', message: fallbackCode || '未知错误' };
  }

  // 返回 {ok, reason}；reason 用于界面提示，不抛异常、不回落其他运行方式。
  function inspect(toolkit) {
    if (!toolkit || typeof toolkit !== 'object') {
      return { ok: false, reason: 'missing', message: '未检测到实验工具箱接口（window.toolkit）。' };
    }
    const apiVersion = typeof toolkit.apiVersion === 'string' ? toolkit.apiVersion : null;
    if (apiVersion !== REQUIRED_API) {
      return { ok: false, reason: 'api', message: `本插件需要实验 API ${REQUIRED_API}，当前工具箱提供的是 ${apiVersion || '未知版本'}。`, apiVersion };
    }
    const missing = REQUIRED_METHODS.filter(name => typeof dig(toolkit, name) !== 'function');
    if (missing.length) {
      return { ok: false, reason: 'methods', message: `工具箱接口缺少必要方法：${missing.join('、')}。`, apiVersion, missing };
    }
    return { ok: true, apiVersion };
  }

  const ToolkitApi = { REQUIRED_API, REQUIRED_METHODS, inspect, normalizeError };
  global.ToolkitApi = ToolkitApi;
  if (typeof module !== 'undefined' && module.exports) module.exports = ToolkitApi;
})(typeof window !== 'undefined' ? window : globalThis);
