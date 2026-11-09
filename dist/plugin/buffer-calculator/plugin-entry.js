/* plugin-entry.js — 唯一启动入口
 * 顶层同步完成宿主检查与四类生命周期回调注册；注册前不 await、不读库。
 * 业务模块不自行启动：BufferApp.create 只在这里被调用一次。
 */
(function (global) {
  'use strict';

  const doc = global.document;
  const toolkit = global.toolkit;
  const guard = ToolkitApi.inspect(toolkit);

  function showGate(reason, detail) {
    if (!doc) return;
    const business = doc.getElementById('businessRoot');
    const gate = doc.getElementById('gateRoot');
    const msg = doc.getElementById('gateMessage');
    const det = doc.getElementById('gateDetail');
    if (business) business.hidden = true;
    if (gate) gate.hidden = false;
    if (msg) {
      msg.textContent = reason === 'missing' || reason === 'api' || reason === 'methods'
        ? '请在支持 API 1.1 的实验工具箱中安装并打开本插件。'
        : '本插件无法在当前环境运行。';
    }
    if (det && detail) {
      det.innerHTML = '';
      const line = doc.createElement('div');
      line.textContent = detail;
      det.appendChild(line);
    }
    // 独立打开 index.html 只会看到这条拒绝路径：不建库、不读写存储、不启动计算。
  }

  if (!guard.ok) {
    showGate(guard.reason, guard.message);
    return;
  }

  const runtime = { env: null, theme: 'light', app: null, store: null, platform: null, disposed: false, activateStarted: false, starting: null, unsubscribes: [] };

  function unregisterAll() {
    for (const off of runtime.unsubscribes.splice(0)) {
      try { if (typeof off === 'function') off(); } catch (error) { /* 宿主已清理 */ }
    }
  }

  // 激活流程：同一实例只跑一次；视图重载（页面重新加载）后必须能重新建立，
  // 否则页面会永久停在 loading。
  async function activate(env) {
    runtime.env = env || runtime.env || {};
    runtime.theme = runtime.env.theme === 'dark' ? 'dark' : 'light';
    runtime.disposed = false;
    const root = doc.getElementById('app');
    try {
      runtime.platform = ToolkitPlatform.create(toolkit);
    } catch (error) {
      showGate('unsupported', error && error.message);
      return { status: 'unsupported' };
    }
    runtime.store = BufferStore.create({ platform: runtime.platform });
    runtime.app = BufferApp.create({ store: runtime.store, platform: runtime.platform });
    runtime.app.attach(root);
    runtime.app.setTheme(runtime.theme);
    // init 内部捕获可恢复错误并显示恢复界面，因此这里不会因数据问题抛出。
    return runtime.app.init(runtime.env);
  }

  function startActivate(env) {
    if (runtime.starting) return runtime.starting;
    if (runtime.app) return Promise.resolve({ status: 'already-active' });
    runtime.starting = activate(env).finally(() => { runtime.starting = null; });
    return runtime.starting;
  }

  // 顶层同步注册，保存每个回调的取消订阅函数。
  runtime.unsubscribes.push(
    toolkit.onActivate(async env => {
      runtime.activateStarted = true;
      doc.title = '缓冲液计算器 · onActivate';
      await startActivate(env);
      doc.title = '缓冲液计算器 · activated:' + runtime.app.state;
    }),
    toolkit.onView(async id => {
      // 等待已有 init 完成后按当前状态展示；保留内部标签、输入与已算结果。
      doc.title = '缓冲液计算器 · onView:' + id;
      if (!runtime.app) await startActivate(runtime.env || {});
      if (!runtime.app || runtime.disposed) return;
      try { await runtime.app.init(runtime.env || {}); } catch (error) { /* init 已内部处理 */ }
      if (runtime.disposed) return;
      runtime.app.showView(id);
      doc.title = '缓冲液计算器 · view:' + id + ':' + runtime.app.state;
    }),
    toolkit.onEnvironmentChange(env => {
      // 始终以最新 env.theme 为准；初始化期间收到变化也保存，init 结束后不会被旧主题覆盖。
      const next = env && env.theme === 'dark' ? 'dark' : 'light';
      runtime.theme = next;
      runtime.env = Object.assign({}, runtime.env, env || {});
      if (runtime.app) runtime.app.setTheme(next);
    }),
    toolkit.onDeactivate(() => {
      runtime.disposed = true;
      unregisterAll();
      // 只做同步清理，不调用 SDK、不 flush 保存队列；已发出的请求无法撤回。
      if (runtime.app) runtime.app.dispose();
      runtime.app = null;
      if (runtime.store) runtime.store.dispose();
      runtime.store = null;
      runtime.platform = null;
    }),
  );
})(typeof window !== 'undefined' ? window : globalThis);
