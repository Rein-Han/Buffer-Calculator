/* toolkit-platform.js — 唯一生产适配器 ToolkitPlatform
 * 把工具箱 SDK 的 storage / files.saveText / clipboard.writeText / printing.print
 * 收敛成 BufferStore 与 BufferApp 使用的固定接口。没有浏览器分支、没有下载或剪贴板兜底。
 */
(function (global) {
  'use strict';

  const ToolkitApi = global.ToolkitApi || (typeof require === 'function' ? require('./toolkit-api.js') : null);
  const BufferData = global.BufferData || (typeof require === 'function' ? require('./data-model.js') : null);
  const save = ToolkitApi.normalizeError;

  const SAVE_LIMIT_BYTES = 4 * 1024 * 1024;   // files.saveText 文本上限（UTF-8 字节）
  const COPY_LIMIT_BYTES = 1024 * 1024;       // clipboard.writeText 文本上限（UTF-8 字节）
  const FORMATS = ['json', 'txt', 'tsv'];
  const NAME_LIMIT = 180;
  // 宿主建议名规则：无路径分隔符、无保留字符、无首尾空格、结尾不是点。
  const BAD_NAME = /[\\/:*?"<>|\u0000-\u001f]/;

  function fail(code, message) { return Promise.reject({ name: 'ToolkitError', code, message }); }

  function create(toolkit) {
    const guard = ToolkitApi.inspect(toolkit);
    if (!guard.ok) throw Object.assign(new Error(guard.message), { code: 'UNSUPPORTED_API' });

    function readDB() {
      return Promise.resolve()
        .then(() => toolkit.storage.get(BufferData.STORAGE_KEY))
        .then(value => (value === undefined ? null : value))
        .catch(error => Promise.reject(save(error, 'STORAGE_READ_FAILED')));
    }

    // 宿主明确拒绝且未落盘的 code 必须原样保留，store 才能区分“明确未写入”与“无法确认”；
    // 其余桥接/内部错误统一成 HOST_ERROR，由 store 进入恢复核对流程。
    const DEFINITE_WRITE_CODES = ['PERMISSION_DENIED', 'PLUGIN_DISABLED', 'INVALID_INSTANCE', 'INVALID_ARGUMENT', 'UNSUPPORTED_API', 'QUOTA_EXCEEDED', 'CORRUPT_STORAGE'];
    function writeDB(db) {
      if (!db || typeof db !== 'object' || Array.isArray(db)) return fail('INVALID_ARGUMENT', '写入值必须是数据库对象');
      return Promise.resolve()
        .then(() => toolkit.storage.set(BufferData.STORAGE_KEY, db))
        .then(() => undefined)
        .catch(error => {
          const code = error && typeof error.code === 'string' && DEFINITE_WRITE_CODES.includes(error.code) ? error.code : 'HOST_ERROR';
          return Promise.reject(save(error, code));
        });
    }

    function saveText(options) {
      const opts = options || {};
      const text = opts.text;
      const format = opts.format;
      const suggestedName = opts.suggestedName;
      if (typeof text !== 'string') return fail('INVALID_ARGUMENT', '导出内容必须是字符串');
      if (!FORMATS.includes(format)) return fail('INVALID_ARGUMENT', `导出格式必须是 ${FORMATS.join(' / ')}`);
      if (typeof suggestedName !== 'string') return fail('INVALID_ARGUMENT', '文件名必须是字符串');
      if (suggestedName.length < 1 || suggestedName.length > NAME_LIMIT) return fail('INVALID_ARGUMENT', `文件名长度需为 1～${NAME_LIMIT} 个字符`);
      if (BAD_NAME.test(suggestedName) || suggestedName !== suggestedName.trim() || suggestedName.endsWith('.')) {
        return fail('INVALID_ARGUMENT', '文件名不能包含路径、保留字符、首尾空格或以点结尾');
      }
      const bytes = BufferData.textBytes(text);
      if (bytes > SAVE_LIMIT_BYTES) {
        return fail('TEXT_TOO_LARGE', `导出内容 ${bytes} 字节，超过单次 ${SAVE_LIMIT_BYTES} 字节上限；请分批导出。`);
      }
      return Promise.resolve()
        .then(() => toolkit.files.saveText({ suggestedName, format, text }))
        .then(result => {
          const status = result && result.status;
          if (status !== 'saved' && status !== 'cancelled') throw { name: 'ToolkitError', code: 'FILE_SAVE_FAILED', message: '保存返回了未知状态' };
          return { status };
        })
        .catch(error => Promise.reject(save(error, 'FILE_SAVE_FAILED')));
    }

    function copyText(text) {
      if (typeof text !== 'string' || !text) return fail('INVALID_ARGUMENT', '复制内容必须是非空字符串');
      const bytes = BufferData.textBytes(text);
      if (bytes > COPY_LIMIT_BYTES) {
        return fail('TEXT_TOO_LARGE', `复制内容 ${bytes} 字节，超过 ${COPY_LIMIT_BYTES} 字节上限。`);
      }
      // 成功返回 undefined，没有 status 字段可读。
      return Promise.resolve()
        .then(() => toolkit.clipboard.writeText(text))
        .then(() => undefined)
        .catch(error => Promise.reject(save(error, 'CLIPBOARD_WRITE_FAILED')));
    }

    function printView() {
      return Promise.resolve()
        .then(() => toolkit.printing.print())
        .then(result => {
          const status = result && result.status;
          if (status !== 'submitted' && status !== 'cancelled') throw { name: 'ToolkitError', code: 'PRINT_FAILED', message: '打印返回了未知状态' };
          return { status };
        })
        .catch(error => Promise.reject(save(error, 'PRINT_FAILED')));
    }

    return { apiVersion: guard.apiVersion, readDB, writeDB, saveText, copyText, printView };
  }

  const ToolkitPlatform = { create, SAVE_LIMIT_BYTES, COPY_LIMIT_BYTES };
  global.ToolkitPlatform = ToolkitPlatform;
  if (typeof module !== 'undefined' && module.exports) module.exports = ToolkitPlatform;
})(typeof window !== 'undefined' ? window : globalThis);
