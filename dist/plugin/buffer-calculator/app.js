/* app.js — 界面逻辑（BufferApp 工厂）
 * 依赖 engine.js 的 Engine、db.js 的 DefaultDB、data-model.js 的 BufferData、
 * db-store.js 的 BufferStore 与宿主平台适配器。
 *
 * 本模块不在加载时读库或绑定事件：唯一入口是 BufferApp.create({store, platform})，
 * 由 plugin-entry.js 在宿主 onActivate 中调用 init(env)。
 * 所有写入走 store 事务（草稿 → 校验 → 确认写入 → 才刷新界面）；没有 localStorage、
 * 下载、浏览器剪贴板或 window.print 兜底。
 */
(function (global) {
  'use strict';

  const TABS = ['t1', 't2', 't3', 't4'];
  const ADDITIVE_DEFS = [
    { key: 'nacl',      label: 'NaCl',         unit: 'mM',    kind: 'salt',     stockId: 'nacl',      def: 150 },
    { key: 'arghcl',    label: 'Arg-HCl',      unit: 'mM',    kind: 'protSalt', stockId: 'arg_hcl',   def: 0 },
    { key: 'arg',       label: 'Arg',          unit: 'mM',    kind: 'protBase', stockId: 'arg',       def: 0, note: '默认不参与，特殊需求时启用' },
    { key: 'gdnhcl',    label: 'GdnHCl 盐酸胍', unit: 'mM',   kind: 'salt',     stockId: 'gdnhcl',    def: 0 },
    { key: 'imidazole', label: '咪唑',          unit: 'mM',    kind: 'protBase', stockId: 'imidazole', def: 0 },
    { key: 'suc',       label: '蔗糖',          unit: '% w/v', kind: 'neutral',  stockId: 'suc',       def: 0 },
  ];
  const TYPE_NAMES = { acid: '酸式', base: '碱式', salt: '盐', neutral: '非离子', titrant: '中和试剂', premix: '预混液' };
  // 无 pKa 字段的酸性母液必须映射到它所属的缓冲体系；否则会退化成 systemFromStock 的
  // 单步碱式假设（默认 pKa 9.04），把加酸算成加碱。
  const ACID_TITRANT_SYSTEM = { hac: 'acetate', ca: 'citrate', h3po4: 'pb', nah2po4: 'pb' };
  const ACID_TITRANT_ORDER = ['hac', 'ca', 'h3po4', 'nah2po4'];
  const VOL_MIN = 0.5, VOL_MAX = 10000;
  const MAX_IMPORT_BYTES = 4 * 1024 * 1024;   // 只限制读取；不代表该大小一定能存入宿主

  function create(options) {
    const store = options.store;
    const platform = options.platform;
    if (!store || !platform) throw new Error('BufferApp 需要 store 与 platform');

    /* ---------- 运行状态 ---------- */
    let root = null;
    let DB = null;                       // 当前已提交快照的界面副本
    let alive = true;
    let disposed = false;
    let initPromise = null;
    let activeTab = 't1';
    let theme = 'light';
    let modal = null;                    // {resolve, onKey, previousFocus, ...}
    let busyDepth = 0;
    const tokens = { recipe: 0, neut: 0, import: 0 };
    const lastCopy = { A: '', B: '' };
    const lastName = { A: '', B: '' };

    /* ---------- DOM 小工具（全部限定在 root 内） ---------- */
    const $ = sel => root.querySelector(sel);
    const $$ = sel => Array.from(root.querySelectorAll(sel));
    // 弹层内部的控件：显式限定在 #overlay 内，避免与页面上的同名 ID 混淆
    const $m = sel => $('#overlay').querySelector(sel);
    const on = (node, type, handler, opts) => {
      if (!node) return () => {};
      const wrapped = event => {
        if (!alive) return;
        try {
          const result = handler(event);
          if (result && typeof result.catch === 'function') result.catch(error => reportAsyncError(error));
        } catch (error) {
          reportAsyncError(error);
        }
      };
      node.addEventListener(type, wrapped, opts);
      return () => node.removeEventListener(type, wrapped, opts);
    };
    const uid = () => 'x' + Math.random().toString(36).slice(2, 9);
    const esc = s => String(s == null ? '' : s).replace(/[&<>"]/g, c => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;' }[c]));
    const num = sel => { const el = $(sel); const v = el ? parseFloat(el.value) : NaN; return Number.isNaN(v) ? null : v; };

    function fmtVol(volL) {
      if (volL == null) return '—';
      const mL = volL * 1000;
      if (mL >= 1000) return (mL / 1000).toFixed(2) + ' L';
      if (mL >= 1) return mL.toFixed(2) + ' mL';
      return (mL * 1000).toFixed(1) + ' µL';
    }
    // 配方定容水始终使用 mL，避免大体积时换算为 L 后丢失两位小数之外的有效体积信息。
    function fmtWaterVol(volL) { return volL == null ? '—' : (volL * 1000).toFixed(2) + ' mL'; }
    function errText(error) {
      if (!error) return '未知错误';
      if (typeof error === 'string') return error;
      return error.message || error.code || '未知错误';
    }

    /* ---------- 状态提示与弹层 ---------- */
    function ensureStatusBar() {
      let bar = $('#appStatus');
      if (!bar) {
        bar = document.createElement('div');
        bar.id = 'appStatus';
        bar.className = 'app-status noprint';
        bar.setAttribute('role', 'status');
        bar.setAttribute('aria-live', 'polite');
        bar.hidden = true;
        root.insertBefore(bar, root.firstChild);
      }
      return bar;
    }
    function notify(message, kind) {
      const bar = ensureStatusBar();
      bar.textContent = message;
      bar.hidden = false;
      bar.dataset.kind = kind || 'info';
    }
    function clearNotify() {
      const bar = $('#appStatus');
      if (bar) { bar.hidden = true; bar.textContent = ''; }
    }
    function reportAsyncError(error) {
      notify(errText(error), 'error');
    }
    function describeError(error) {
      const code = error && error.code;
      const map = {
        CAPABILITY_BUSY: '工具箱正忙（保存与打印在宿主内互斥），请完成另一个操作后重试。',
        UNSUPPORTED_API: '工具箱接口版本不满足，无法完成该操作。',
        PERMISSION_DENIED: '未获得该能力授权，请在插件管理中确认权限。',
        INVALID_ARGUMENT: '参数或文件名不合法，内容已保留。',
        TEXT_TOO_LARGE: '内容超过单次上限，已保留完整内容，请分批导出。',
        FILE_SAVE_FAILED: '保存失败，内容已保留，可重试。',
        CLIPBOARD_WRITE_FAILED: '写入剪贴板失败，可重试。',
        PRINT_FAILED: '打印失败，未自动重印。',
        VIEW_NOT_VISIBLE: '当前视图不在前台，无法打印。',
        INVALID_INSTANCE: '插件实例已失效，请重新打开。',
        PLUGIN_DISABLED: '插件已停用，请重新启用后打开。',
        QUOTA_EXCEEDED: '插件存储已满（上限 1MB），请先导出备份并清理实测记录或自定义条目。',
        CORRUPT_STORAGE: '插件存储损坏，数据未改动。',
      };
      const base = map[code] || errText(error);
      return code && map[code] ? `${base}（${code}）` : base;
    }

    function trapFocus(event) {
      if (!modal || event.key !== 'Tab') return;
      const focusables = modal.box.querySelectorAll('button, input, select, textarea, [href]');
      if (!focusables.length) return;
      const first = focusables[0], last = focusables[focusables.length - 1];
      if (event.shiftKey && root.ownerDocument.activeElement === first) { event.preventDefault(); last.focus(); }
      else if (!event.shiftKey && root.ownerDocument.activeElement === last) { event.preventDefault(); first.focus(); }
    }

    // 页内弹层：返回 Promise；Esc/取消关闭且不提交，销毁时以取消结束。
    // 处理器直接绑定到本次弹层的实例对象上，用实例锁保证只会结束一次——
    // 不依赖全局 modal 变量，避免旧监听器在弹层关闭后误操作新弹层。
    // openModal(options.confirmId/cancelId) 允许表单沿用既有控件 ID（#f_save/#g_save 等），
    // 保持原页面结构可预测，也便于回归脚本按同一选择器操作。
    function openModal({ title, body, confirmText, cancelText, danger, description, onMount, confirmValue, confirmId, cancelId, submit, submitBusyText }) {
      if (modal) modal.finalize(null);
      const previousFocus = root.ownerDocument.activeElement;
      const overlay = $('#overlay');
      const box = $('#modalBox');
      box.innerHTML = '';
      const heading = root.ownerDocument.createElement('h3');
      heading.className = 'modal-title';
      heading.id = 'modalTitle';
      heading.textContent = title;
      box.appendChild(heading);
      if (description) {
        const p = root.ownerDocument.createElement('div');
        p.className = 'muted';
        p.textContent = description;
        box.appendChild(p);
      }
      const slot = root.ownerDocument.createElement('div');
      slot.className = 'modal-slot';
      box.appendChild(slot);
      const footer = root.ownerDocument.createElement('div');
      footer.className = 'row modal-footer';
      const confirmBtn = root.ownerDocument.createElement('button');
      confirmBtn.className = danger ? 'primary danger-solid' : 'primary';
      confirmBtn.id = confirmId || 'modalConfirm';
      confirmBtn.textContent = confirmText || '确认';
      const cancelBtn = root.ownerDocument.createElement('button');
      cancelBtn.className = 'ghost';
      cancelBtn.id = cancelId || 'modalCancel';
      cancelBtn.textContent = cancelText || '取消';
      footer.appendChild(confirmBtn);
      footer.appendChild(cancelBtn);
      box.appendChild(footer);
      box.setAttribute('role', 'dialog');
      box.setAttribute('aria-modal', 'true');
      box.setAttribute('aria-labelledby', 'modalTitle');
      overlay.classList.add('show');

      return new Promise(resolve => {
        const current = {
          id: 'm' + Date.now().toString(36),
          box, overlay, previousFocus, onKey: null, settled: false, confirmId, cancelId,
          resolve,
          finalize(value) {
            if (this.settled) return;
            this.settled = true;
            if (this.onKey) root.ownerDocument.removeEventListener('keydown', this.onKey, true);
            this.overlay.classList.remove('show');
            this.box.innerHTML = '';
            this.box.removeAttribute('role');
            this.box.removeAttribute('aria-modal');
            if (modal === this) modal = null;
            if (this.previousFocus && this.previousFocus.focus) {
              try { this.previousFocus.focus(); } catch (error) { /* 目标已移除 */ }
            }
            this.resolve(value == null ? null : value);
          },
        };
        modal = current;
        const keyHandler = event => {
          if (event.key === 'Escape') { event.preventDefault(); current.finalize(null); return; }
          trapFocus(event);
        };
        current.onKey = keyHandler;
        root.ownerDocument.addEventListener('keydown', keyHandler, true);
        // 输入型弹层没有额外内容时隐藏空槽，避免多余边距
        if (typeof body === 'string') slot.innerHTML = body; else if (body) slot.appendChild(body);
        else slot.hidden = true;
        if (typeof onMount === 'function') onMount(slot, { confirmButton: confirmBtn, cancelButton: cancelBtn, modal: current });
        if (typeof submit === 'function') {
          // 异步表单：确认按钮只触发提交，弹层是否关闭完全由提交结果决定。
          // 校验失败或写入失败时保留弹层与草稿；提交期间禁止重复提交。
          let submitting = false;
          on(confirmBtn, 'click', async () => {
            if (submitting) return;
            submitting = true;
            setSubmitBusy(current, true, submitBusyText);
            try {
              await submit();
            } catch (error) {
              reportAsyncError(error);
            } finally {
              submitting = false;
              setSubmitBusy(current, false, submitBusyText);
            }
          });
        } else {
          on(confirmBtn, 'click', () => current.finalize(confirmValue === undefined ? true : confirmValue));
        }
        on(cancelBtn, 'click', () => current.finalize(null));
        on(overlay, 'click', event => { if (event.target === overlay) current.finalize(null); });
        // 默认焦点为取消，破坏性操作不会被回车误确认
        cancelBtn.focus();
      });
    }
    // 提交期间禁用确认/取消按钮并显示忙碌文案；弹层已结束时不再改动其 DOM
    function setSubmitBusy(current, busy, busyText) {
      if (!current || current.settled) return;
      const confirmBtn = current.box.querySelector('#' + (current.confirmId || 'modalConfirm'));
      const cancelBtn = current.box.querySelector('#' + (current.cancelId || 'modalCancel'));
      if (confirmBtn) {
        if (busy) {
          if (confirmBtn.dataset.idleText == null) confirmBtn.dataset.idleText = confirmBtn.textContent;
          confirmBtn.disabled = true;
          if (busyText) confirmBtn.textContent = busyText;
        } else {
          confirmBtn.disabled = false;
          if (confirmBtn.dataset.idleText != null) confirmBtn.textContent = confirmBtn.dataset.idleText;
        }
      }
      if (cancelBtn) cancelBtn.disabled = busy;
    }
    function closeModal(value) {
      if (!modal) return;
      modal.finalize(value);
    }
    function askConfirm(title, description, confirmText) {
      return openModal({ title, description, confirmText: confirmText || '确认', danger: true });
    }
    function askText(title, bodyHtml, confirmText, onMount, ids, submit, busyText) {
      return openModal({
        title, body: bodyHtml, confirmText, cancelText: '取消', onMount, submit,
        confirmId: ids && ids.confirm, cancelId: ids && ids.cancel, submitBusyText: busyText,
      });
    }

    /* ---------- 写入通道 ---------- */
    // change 在已提交快照的独立草稿上同步执行；只有确认写入成功才刷新界面。
    // 失败时保留草稿内容、旧 DB 与弹层（由调用方决定），并显示明确错误。
    // 写入结果不确定时 store 会进入 recovery，这里必须同步切换界面，否则用户会在
    // 业务页上继续操作并只拿到 NOT_READY（T-008 F-03）。
    async function commit(change) {
      if (!alive) return null;
      beginBusy();
      try {
        const result = await store.mutate(change);
        if (!alive) return null;
        DB = store.snapshot();
        return result;
      } catch (error) {
        if (!alive) return null;
        if (store.state === 'recovery') enterRecovery(error, { uncertain: !!(error && error.uncertain) });
        throw error;
      } finally {
        endBusy();
      }
    }
    function beginBusy() {
      busyDepth++;
      setWriteBusy(true);
    }
    function endBusy() {
      busyDepth = Math.max(0, busyDepth - 1);
      setWriteBusy(busyDepth > 0);
    }
    function setWriteBusy(busy) {
      $$('[data-write-action]').forEach(node => { node.disabled = busy; });
      $$('#modalBox [data-write-action]').forEach(node => { node.disabled = busy; });
      const printBtn = $('#btnPrint');
      if (printBtn) printBtn.disabled = busy || outputBusy;
      root.dataset.writing = busy ? 'true' : 'false';
    }
    let outputBusy = false;
    function setOutputBusy(busy) {
      outputBusy = busy;
      const printBtn = $('#btnPrint');
      if (printBtn) printBtn.disabled = busy || busyDepth > 0;
      $$('[data-output-action]').forEach(node => { node.disabled = busy; });
    }

    /* ---------- 数据读取辅助（只读，不隐式创建数组） ---------- */
    const stockById = id => DB.stocks.find(s => s.id === id);
    const systemById = id => DB.systems.find(s => s.id === id);
    function calibAll() { return Array.isArray(DB.calibration) ? DB.calibration : []; }
    function calibrationFor(key) { return calibAll().filter(x => x.key === key); }
    function hydrate(sysDef) {
      const s = BufferData.clone(sysDef);
      s.stocks = (s.stocks || []).map(x => {
        const st = stockById(x.stockId);
        return st ? Object.assign({}, st, { dStock: x.dStock }) : null;
      }).filter(Boolean);
      return s;
    }
    function systemFromStock(st) {
      if (st.id === 'arg' || st.id === 'arg_hcl') return Object.assign({}, DefaultDB.argSystem, { id: 'ad_' + st.id, steps: DefaultDB.argSystem.steps.map((s, i) => Object.assign({}, s, { pKa: i === 1 ? (st.pka != null ? st.pka : s.pKa) : s.pKa })) });
      return { id: 'ad_' + st.id, name: st.name, steps: [{ pKa: st.pka != null ? st.pka : 9.04, zA: 1, zB: 0 }] };
    }

    /* ---------- 中和试剂的酸/碱方向 ---------- */
    function isAcidTitrantStock(st) {
      return ACID_TITRANT_SYSTEM[st.id] != null || (st.pka != null && st.pka < 7);
    }
    function acidTitrantSystemOf(st) {
      const sysId = ACID_TITRANT_SYSTEM[st.id];
      if (sysId) {
        const def = systemById(sysId);
        if (def) return hydrate(def);
      }
      for (const def of DB.systems) {
        const one = (def.stocks || []).find(x => x.stockId === st.id && x.dStock === 0);
        if (one && def.steps) return hydrate(def);
      }
      return systemFromStock(st);
    }
    function neutralizationTitrantFor(st) {
      const asAcid = isAcidTitrantStock(st);
      return { system: asAcid ? acidTitrantSystemOf(st) : systemFromStock(st), concM: st.concM, reagentPH: st.refpH, name: st.name };
    }
    function neutralizationTitrantOptions() {
      const acids = DB.stocks.filter(isAcidTitrantStock).sort((a, b) => {
        const ia = ACID_TITRANT_ORDER.indexOf(a.id), ib = ACID_TITRANT_ORDER.indexOf(b.id);
        return (ia < 0 ? 99 : ia) - (ib < 0 ? 99 : ib);
      });
      const bases = DB.stocks.filter(s => s.pka != null && !s.noTitrant && !isAcidTitrantStock(s));
      const opt = s => `<option value="${esc(s.id)}">${esc(s.name)}（${esc(s.concM)} M，pKa ${esc(s.pka)}）</option>`;
      return (acids.length ? `<optgroup label="酸性试剂（用于降低 pH）">${acids.map(opt).join('')}</optgroup>` : '')
        + (bases.length ? `<optgroup label="碱性试剂（用于升高 pH）">${bases.map(opt).join('')}</optgroup>` : '');
    }

    /* ---------- 实测 pH 记录键与文本 ---------- */
    function calibKey(buffers, premixes, additives, pH) {
      const parts = [];
      for (const b of buffers) parts.push(`s:${b.system.id}@${(b.concM * 1000).toFixed(4)}mM`);
      for (const px of premixes) parts.push(`p:${px.stock.id}@${px.fold}x`);
      for (const ad of additives) {
        if (ad.kind === 'premix') continue;
        const c = ad.kind === 'neutral' ? `${ad.volL.toFixed(8)}L` : `${(ad.concM * 1000).toFixed(4)}mM`;
        parts.push(`a:${ad.stock.id}/${ad.kind}@${c}`);
      }
      parts.sort();
      return `${parts.join('|')}#pH${Number(pH).toFixed(2)}`;
    }
    function calibrationTSV(rows, withText) {
      const head = ['记录时间', '目标pH', '实测pH', '偏差(实测-目标)', '温度C', '卡片名称', '模型'];
      return rows.map((x, i) => {
        const body = [x.at, x.targetPH, x.measuredPH, (x.measuredPH - x.targetPH).toFixed(3), x.tempC == null ? '' : x.tempC, x.label, x.model].join('\t');
        return (i === 0 ? head.join('\t') + '\n' : '') + body + (withText ? '\n' + x.text : '');
      }).join('\n');
    }
    const stamp = (withTime) => {
      const now = new Date();
      const d = now.toISOString().slice(0, 10);
      return withTime ? `${d}-${now.toTimeString().slice(0, 5).replace(':', '')}` : d;
    };
    const nowText = () => {
      const now = new Date();
      const pad = n => String(n).padStart(2, '0');
      return `${now.getFullYear()}-${pad(now.getMonth() + 1)}-${pad(now.getDate())} ${pad(now.getHours())}:${pad(now.getMinutes())}`;
    };

    /* ---------- 选择器渲染（配制页与中和页 A/B 共用） ---------- */
    function renderSysPicker(box, prefix) {
      box.innerHTML = '';
      DB.systems.filter(s => s.enabled).forEach(s => {
        const isPm = !!s.premix;
        const meta = isPm
          ? '预混母液（PB + NaCl + KCl），按倍数使用'
          : (s.steps || []).map(x => 'pKa ' + x.pKa).join(' / ') + (s.range ? ` · 建议 ${s.range[0]}–${s.range[1]}` : '');
        const unit = isPm ? '×' : 'mM';
        const div = document.createElement('div');
        div.className = 'sysrow';
        div.innerHTML = `<label><input type="checkbox" class="${prefix}SysChk" data-id="${esc(s.id)}"> <b>${esc(s.name)}</b></label>
          <span class="nm muted">${esc(meta)}</span>
          <input type="number" class="${prefix}SysConc" data-id="${esc(s.id)}" min="0" step="${isPm ? '0.1' : '1'}" placeholder="浓度" disabled>
          <span class="muted">${unit}</span>`;
        box.appendChild(div);
      });
      box.querySelectorAll(`.${prefix}SysChk`).forEach(chk => on(chk, 'change', () => {
        const def = systemById(chk.dataset.id);
        const inp = box.querySelector(`.${prefix}SysConc[data-id="${cssEscape(chk.dataset.id)}"]`);
        if (!inp) return;
        inp.disabled = !chk.checked;
        if (chk.checked && !inp.value) inp.value = def && def.premix ? 1 : 20;
      }));
    }
    function cssEscape(value) { return String(value).replace(/["\\]/g, '\\$&'); }

    function renderAddPicker(box, prefix, excludeNeutral) {
      box.innerHTML = '';
      ADDITIVE_DEFS.forEach(a => {
        if (excludeNeutral && a.kind === 'neutral') return;
        const st = stockById(a.stockId);
        if (!st) return;
        const concLabel = st.concM != null ? st.concM + ' M' : st.pct + '%';
        const div = document.createElement('div');
        div.className = 'sysrow';
        div.innerHTML = `<label><input type="checkbox" class="${prefix}AddChk" data-key="${a.key}"> ${esc(a.label)}</label>
          <span class="nm muted">母液 ${esc(concLabel)}${a.note ? ' · ' + esc(a.note) : ''}</span>
          <input type="number" class="${prefix}AddConc" data-key="${a.key}" min="0" step="1" disabled>
          <span class="muted">${esc(a.unit)}</span>`;
        box.appendChild(div);
      });
      box.querySelectorAll(`.${prefix}AddChk`).forEach(chk => on(chk, 'change', () => {
        const inp = box.querySelector(`.${prefix}AddConc[data-key="${chk.dataset.key}"]`);
        if (!inp) return;
        inp.disabled = !chk.checked;
        if (chk.checked && !inp.value) {
          const def = ADDITIVE_DEFS.find(x => x.key === chk.dataset.key).def;
          inp.value = def || 10;
        }
      }));
    }

    // 刷新选择器时保留用户已勾选项与已填浓度/倍数
    function capturePickerState() {
      const state = { sys: [], add: [] };
      $$('input[type=checkbox][class$=SysChk]').forEach(chk => {
        const inp = root.querySelector(`.${chk.className.replace('SysChk', 'SysConc')}[data-id="${cssEscape(chk.dataset.id)}"]`);
        state.sys.push({ cls: chk.className, id: chk.dataset.id, checked: chk.checked, value: inp ? inp.value : '' });
      });
      $$('input[type=checkbox][class$=AddChk]').forEach(chk => {
        const inp = root.querySelector(`.${chk.className.replace('AddChk', 'AddConc')}[data-key="${chk.dataset.key}"]`);
        state.add.push({ cls: chk.className, key: chk.dataset.key, checked: chk.checked, value: inp ? inp.value : '' });
      });
      return state;
    }
    function applyPickerState(state) {
      state.sys.forEach(item => {
        const chk = root.querySelector(`input.${item.cls}[data-id="${cssEscape(item.id)}"]`);
        if (!chk) return;
        chk.checked = item.checked;
        const inp = root.querySelector(`input.${item.cls.replace('SysChk', 'SysConc')}[data-id="${cssEscape(item.id)}"]`);
        if (inp) { inp.disabled = !item.checked; inp.value = item.value; }
      });
      state.add.forEach(item => {
        const chk = root.querySelector(`input.${item.cls}[data-key="${item.key}"]`);
        if (!chk) return;
        chk.checked = item.checked;
        const inp = root.querySelector(`input.${item.cls.replace('AddChk', 'AddConc')}[data-key="${item.key}"]`);
        if (inp) { inp.disabled = !item.checked; inp.value = item.value; }
      });
    }

    function collectSystems(prefix) {
      const buffers = [], premixes = [];
      $$(`.${prefix}SysChk`).forEach(chk => {
        if (!chk.checked) return;
        const inp = root.querySelector(`.${prefix}SysConc[data-id="${cssEscape(chk.dataset.id)}"]`);
        const v = parseFloat(inp ? inp.value : '');
        if (!(v > 0)) throw new Error('请为勾选的缓冲体系填写浓度/倍数');
        const def = systemById(chk.dataset.id);
        if (!def) throw new Error('缓冲体系已不存在，请重新选择');
        if (def.premix) {
          const st = stockById(def.stockId);
          if (!st || !st.premix) throw new Error('预混母液已不存在或缺少预混配方');
          const sysDef = systemById(st.premix.sysId);
          if (!sysDef) throw new Error('预混母液引用的缓冲体系不存在');
          premixes.push({ pm: st.premix, sysDef, stock: st, fold: v });
        } else {
          buffers.push({ system: hydrate(def), concM: v / 1000 });
        }
      });
      return { buffers, premixes };
    }
    function collectAdditives(prefix, V_L) {
      const additives = [];
      $$(`.${prefix}AddChk`).forEach(chk => {
        if (!chk.checked) return;
        const key = chk.dataset.key;
        const inp = root.querySelector(`.${prefix}AddConc[data-key="${key}"]`);
        const v = parseFloat(inp ? inp.value : '');
        if (!(v > 0)) throw new Error('请为勾选的添加剂填写浓度');
        const def = ADDITIVE_DEFS.find(x => x.key === key);
        const st = stockById(def.stockId);
        if (!st) throw new Error(`添加剂母液「${def.label}」不存在，请在管理页确认`);
        if (def.kind === 'neutral') {
          if (V_L != null) additives.push({ kind: 'neutral', stock: st, volL: V_L * (v / st.pct) });
        } else if (def.kind === 'salt') {
          additives.push({ kind: 'salt', concM: v / 1000, stock: st, zCat: 1, zAn: -1 });
        } else {
          additives.push({ kind: def.kind, concM: v / 1000, stock: st, system: systemFromStock(st) });
        }
      });
      return additives;
    }
    function currentModel() {
      const r = root.querySelector('input[name=model]:checked');
      return r ? r.value : 'edh';
    }

    /* ============================================================
     * 标签页①：缓冲液配制
     * ============================================================ */
    function recipeName(buffers, premixes, additives, pH, volumeL) {
      const fmt = n => String(Number(n.toFixed(6)));
      const parts = buffers.map(b => `${fmt(b.concM * 1000)}mM ${b.system.name}`);
      for (const px of premixes) parts.push(`${fmt(px.fold)}× ${px.stock.id === 'pbs10x' ? 'PBS' : px.stock.name}`);
      for (const ad of additives) {
        if (ad.kind === 'premix') continue;
        if (ad.kind === 'neutral') {
          const label = (ADDITIVE_DEFS.find(d => d.stockId === ad.stock.id) || {}).label || ad.stock.name;
          parts.push(`${fmt(ad.stock.pct * ad.volL / volumeL)}% ${label}`);
        } else parts.push(`${fmt(ad.concM * 1000)}mM ${ad.stock.name}`);
      }
      const phText = Number.isInteger(pH) ? pH.toFixed(1) : String(pH);
      return parts.concat(`pH${phText}`).join(', ');
    }

    function computeOne(prefix, pHId, volId, label) {
      const { buffers, premixes } = collectSystems(prefix);
      const pH = num(pHId), volML = num(volId);
      if (!buffers.length && !premixes.length) throw new Error(label + '：请至少勾选一个缓冲体系');
      if (pH == null || pH < 0 || pH > 14) throw new Error(label + '：目标 pH 无效');
      if (volML == null || volML <= 0) throw new Error(label + '：目标体积无效');
      const V_L = volML / 1000;
      const additives = collectAdditives(prefix, V_L);
      for (const px of premixes) {
        additives.push({ kind: 'premix', stock: px.stock, volL: V_L * px.fold / 10,
          system: hydrate(px.sysDef), concM: px.pm.concM, dbarStock: px.pm.dbar, saltIons: px.pm.saltIons });
      }
      const allowTitrant = $('#allowTitrant').checked;
      const r = Engine.calcRecipe({
        buffers, targetPH: pH, targetVolL: V_L, additives, model: currentModel(), empirical: $('#empiricalRecipe').checked,
        titrantConcM: { NaOH: num('#naohConc') || 1, HCl: num('#hclConc') || 1 },
      });
      const totalConc = buffers.reduce((s, b) => s + b.concM, 0) * 1000
        + premixes.reduce((s, px) => s + px.pm.concM * px.fold / 10 * 1000, 0);
      const side = label.slice(-1);
      const nameText = recipeName(buffers, premixes, additives, pH, V_L);
      let html = `<div class="card rcard"><div class="rcard-hd"><h3>${label} · 配方结果</h3><span class="nm" data-buffer-name="${side}">${esc(nameText)}</span><span class="hd-act noprint"><button class="ghost small" data-copy="${side}">复制配方</button><button class="ghost small" data-copy_name="${side}">复制名称</button></span></div>`
        + '<div class="sec-t">母液吸取体积</div><table class="res"><tr><th>母液 / 试剂</th><th>吸取体积</th><th>备注</th></tr>';
      const titrantLines = r.lines.filter(l => l.kind === 'titrant');
      const kindOrder = { stock: 0, premix: 1, additive: 2 };
      const normalLines = r.lines.filter(l => l.kind !== 'titrant')
        .sort((a, b) => (kindOrder[a.kind] != null ? kindOrder[a.kind] : 3) - (kindOrder[b.kind] != null ? kindOrder[b.kind] : 3));
      normalLines.forEach(l => {
        html += `<tr><td>${esc(l.name)}</td><td class="num">${fmtVol(l.volL)}</td><td class="muted">${esc(l.note || '')}</td></tr>`;
      });
      let titrantBlocked = false;
      if (titrantLines.length) {
        if (allowTitrant) {
          titrantLines.forEach(l => {
            html += `<tr><td>${esc(l.name)}</td><td class="num">${fmtVol(l.volL)}</td><td class="muted">${esc(l.note || '')}</td></tr>`;
          });
        } else titrantBlocked = true;
      }
      const omittedTitrantVol = titrantBlocked ? titrantLines.reduce((s, l) => s + l.volL, 0) : 0;
      const shownWaterL = r.waterL + omittedTitrantVol;
      html += `<tr class="water"><td>超纯水（预计补加）</td><td class="num">${fmtWaterVol(shownWaterL)}</td><td class="muted">预计值；最后以容量刻度定容至 ${volML.toFixed(1)} mL</td></tr></table>`;

      const pHCheckText = titrantBlocked ? '不可达（需酸碱调节）' : (r.checkPH != null ? r.checkPH.toFixed(2) : '—');
      const reach = r.reachability;
      const reachText = titrantBlocked
        ? '当前条件可达到的 pH：需勾选「允许使用 NaOH/HCl」后由模型给出'
        : (reach == null || reach.achieved == null
          ? '当前条件可达到的 pH：无法反算'
          : (reach.feasible
            ? `当前条件可达到的 pH：<b>${reach.achieved.toFixed(2)}</b>（命中目标）`
            : `当前条件<b>无法命中</b>目标 pH ${reach.target.toFixed(2)}；可达到的 pH 为 <b>${reach.achieved.toFixed(2)}</b>（相差 ${reach.deviation >= 0 ? '+' : ''}${reach.deviation.toFixed(2)}）`));
      const ionicText = titrantBlocked ? '—' : `${(r.ionicStrength * 1000).toFixed(1)} mM`;
      const conductivityText = titrantBlocked ? '—' : (r.conductivity != null ? r.conductivity.toFixed(1) + ' mS/cm' : '—');
      const betaText = titrantBlocked ? '—' : `${(r.beta * 1000).toFixed(1)} mmol/L/pH`;
      html += `<div class="sec-t">校验信息</div><div class="statgrid">
        <span class="stat">理论 pH 复核：<b>${pHCheckText}</b></span>
        <span class="stat">总缓冲浓度：<b>${totalConc.toFixed(1)} mM</b></span>
        <span class="stat">离子强度：<b>${ionicText}</b></span>
        <span class="stat">估算电导率：<b>${conductivityText}</b></span>
        <span class="stat">缓冲容量 β：<b>${betaText}</b></span>
        <span class="stat">模型：<b>${currentModel() === 'edh' ? '扩展 Debye-Hückel' : 'Davies'}</b></span>
        </div>
        <div class="stat reachline" style="margin-top:6px">${reachText}</div>
        <div class="muted" style="margin-top:6px">缓冲容量 β：使 1 L 溶液的 pH 改变 1 个单位所需强酸/强碱的量（mmol），数值越高抗 pH 波动能力越强。电导率使用有限浓度估计及有条件的经验总值；参考常数约25°C，经验测量温度未确认。高盐、混合盐和不同缓冲背景需实测确认。</div>`;

      const warns = r.warnings.slice();
      if (titrantBlocked) {
        warns.unshift(`该配方必须借助酸碱滴定才能命中 pH ${pH}（涉及：${titrantLines.map(l => l.name.replace(/（.*$/, '')).join('、')}）。当前未计入、未复制这些酸碱体积，补水量按实际不加入酸碱计算；如需得到目标pH，请勾选「允许使用 NaOH/HCl」后重新计算。`);
      }
      if (shownWaterL < 0) warns.push('母液总体积超过目标体积，无法配制！');
      if (warns.length) html += '<div class="warnbox" style="margin-top:8px">' + warns.map(w => '⚠ ' + esc(w)).join('<br>') + '</div>';

      const lines = [`${label}（目标 pH ${pH}，定容 ${volML} mL，模型：${currentModel()}）`];
      normalLines.forEach(l => lines.push(`${l.name}: ${fmtVol(l.volL)}`));
      if (allowTitrant) titrantLines.forEach(l => lines.push(`${l.name}: ${fmtVol(l.volL)}`));
      lines.push(`超纯水（预计补加）: ${fmtWaterVol(shownWaterL)}（最后以容量刻度定容至 ${volML} mL）`);
      if (titrantBlocked) lines.push(`未加入所需的${titrantLines.map(l => l.name.replace(/（.*$/, '')).join('、')}，当前配方不能达到目标 pH ${pH}`);
      else lines.push(`复核 pH ${r.checkPH != null ? r.checkPH.toFixed(2) : '—'}，离子强度 ${r.ionicStrength.toFixed(3)} M`);
      const copyText = lines.join('\n');

      const recKey = calibKey(buffers, premixes, additives, pH);
      const recHistory = calibrationFor(recKey);
      const devTxt = recHistory.length
        ? `<div class="muted" style="margin-top:4px">已记录 <b>${recHistory.length}</b> 条；最近 3 条偏差（实测 − 目标）：${recHistory.slice(-3).map(x => (x.measuredPH - pH >= 0 ? '+' : '') + (x.measuredPH - pH).toFixed(2)).join('、')} pH</div>`
        : '<div class="muted" style="margin-top:4px">尚无实测记录。每次配完把实测 pH 记下来，累积后用于阶段性回归校准。</div>';
      html += `<div class="sec-t noprint">实测 pH 记录</div>
        <div class="calib-body noprint" data-calib-card="${side}" data-calib-key="${esc(recKey)}" data-calib-target="${pH}">
        <div class="muted">下方文本与「复制配方」逐字一致（可直接复制给同事）。配完后在末尾补一行填写实测 pH 即可存档。</div>
        <textarea class="calib-recipe" data-calib-text="${side}" spellcheck="false">${esc(copyText)}</textarea>
        <div class="row" style="margin-top:8px">
          <label>实测 pH</label><input type="number" data-calib-ph="${side}" min="0" max="14" step="0.001" placeholder="如 7.32" style="width:90px">
          <label>温度(°C，可留空)</label><input type="number" data-calib-temp="${side}" min="0" max="60" step="0.5" placeholder="25" style="width:80px">
          <button class="primary" data-calib-save="${side}" data-write-action>记录实测值</button>
          <button class="ghost" data-calib-export="${side}" data-output-action>导出本卡片记录</button>
        </div>
        ${devTxt}
        <div data-calib-history="${side}"></div>
      </div></div>`;
      return { html, copyText, nameText };
    }

    function computeRecipe() {
      tokens.recipe++;
      const zone = $('#resultZone');
      lastCopy.A = ''; lastCopy.B = '';
      lastName.A = ''; lastName.B = '';
      try {
        const a = computeOne('t1A', '#pHA', '#volA', 'Buffer A');
        lastCopy.A = a.copyText;
        lastName.A = a.nameText;
        const parts = [a.html];
        if ($$('.t1BSysChk').some(c => c.checked)) {
          const b = computeOne('t1B', '#pHB', '#volB', 'Buffer B');
          lastCopy.B = b.copyText;
          lastName.B = b.nameText;
          parts.push(b.html);
        }
        zone.innerHTML = parts.length > 1 ? `<div class="result-grid two">${parts.join('')}</div>` : parts.join('');
        renderCalibHistories();
        clearNotify();
      } catch (e) {
        zone.innerHTML = `<div class="errbox">✕ ${esc(errText(e))}</div>`;
      }
    }

    /* ============================================================
     * 标签页②：洗脱中和
     * ============================================================ */
    const volFromSlider = t => Math.pow(10, Math.log10(VOL_MIN) + (t / 1000) * (Math.log10(VOL_MAX) - Math.log10(VOL_MIN)));
    const sliderFromVol = v => 1000 * (Math.log10(v) - Math.log10(VOL_MIN)) / (Math.log10(VOL_MAX) - Math.log10(VOL_MIN));
    function roundSig(v, sig) {
      if (v <= 0) return 0;
      const d = Math.pow(10, Math.floor(Math.log10(v)) - (sig - 1));
      return Math.round(v / d) * d;
    }
    function bindSlider(sliderSel, numSel, opts) {
      const sl = $(sliderSel), nm = $(numSel);
      on(sl, 'input', () => {
        let v = parseFloat(sl.value);
        if (opts.log) v = roundSig(volFromSlider(v), 3);
        nm.value = opts.log ? v : parseFloat(v.toFixed(opts.dec != null ? opts.dec : 2));
      });
      on(nm, 'input', () => {
        let v = parseFloat(nm.value);
        if (Number.isNaN(v)) return;
        v = Math.min(opts.max, Math.max(opts.min, v));
        sl.value = opts.log ? sliderFromVol(v) : v;
      });
    }
    function renderNeutSelectors() {
      renderSysPicker($('#nSysPickA'), 'nA');
      renderSysPicker($('#nSysPickB'), 'nB');
      renderAddPicker($('#nAddPickA'), 'nA', true);
      renderAddPicker($('#nAddPickB'), 'nB', true);
      $('#nTitrant').innerHTML = neutralizationTitrantOptions();
      const arg = DB.stocks.find(s => s.id === 'arg' && s.pka != null);
      if (arg) $('#nTitrant').value = 'arg';
    }
    function collectSide(prefix) {
      const { buffers, premixes } = collectSystems(prefix);
      const components = buffers.map(b => ({ system: b.system, concM: b.concM }));
      let saltI = 0;
      for (const px of premixes) {
        const f = px.fold / 10;
        components.push({ system: hydrate(px.sysDef), concM: px.pm.concM * f });
        const cat = px.pm.saltIons.reduce((s, i) => s + Math.max(0, i.z) * i.concM, 0);
        const an = px.pm.saltIons.reduce((s, i) => s + Math.max(0, -i.z) * i.concM, 0);
        saltI += Math.min(cat, an) * f;
      }
      for (const ad of collectAdditives(prefix, null)) {
        if (ad.kind === 'salt') saltI += ad.concM;
        else if (ad.kind === 'protSalt' || ad.kind === 'protBase') components.push({ system: ad.system, concM: ad.concM });
      }
      const pH = num(prefix === 'nA' ? '#nPHA' : '#nPHB');
      if (pH == null) throw new Error('请填写 Buffer ' + (prefix === 'nA' ? 'A' : 'B') + ' 的 pH');
      if (!components.length) throw new Error('请为 Buffer ' + (prefix === 'nA' ? 'A' : 'B') + ' 至少勾选一个缓冲体系或质子性添加剂');
      return { components, pH, saltI };
    }
    function resolveTitrant() {
      const src = (root.querySelector('input[name=titrantSrc]:checked') || {}).value || 'stock';
      if (src === 'custom') {
        const sid = $('#nCtSys').value;
        const sysDef = sid === 'arg_sys' ? DefaultDB.argSystem : systemById(sid);
        if (!sysDef) throw new Error('自定义试剂的缓冲对不存在');
        const c = num('#nCtConc'), p = num('#nCtPH');
        if (!(c > 0)) throw new Error('自定义试剂浓度无效');
        if (p == null || p < 0 || p > 14) throw new Error('自定义试剂 pH 无效');
        const label = `${sysDef.name}（自定义 ${c} M，pH ${p}）`;
        return { titrant: { system: { id: 'ct_' + sid, name: sysDef.name, steps: sysDef.steps }, concM: c, reagentPH: p, name: label }, label };
      }
      const tStock = stockById($('#nTitrant').value);
      if (!tStock) throw new Error('请选择中和试剂');
      if (tStock.pka == null && !ACID_TITRANT_SYSTEM[tStock.id]) {
        throw new Error(`「${tStock.name}」缺少 pKa 且不在支持的酸性试剂列表内，无法作为中和试剂`);
      }
      const neutralization = neutralizationTitrantFor(tStock);
      return { titrant: neutralization, label: tStock.name };
    }
    function setNeutBusy(busy) {
      const b = $('#btnNeut');
      if (!b) return;
      if (busy) { b.dataset.origText = b.textContent; b.disabled = true; b.textContent = '计算中…'; }
      else { b.disabled = false; if (b.dataset.origText) b.textContent = b.dataset.origText; }
    }
    async function computeNeutralization() {
      const run = ++tokens.neut;
      setNeutBusy(true);
      const pane = $('#neutZone');
      try {
        const bufA = collectSide('nA');
        const bufB = collectSide('nB');
        const lower = num('#numFracBLo'), upper = num('#numFracB');
        if (lower == null || upper == null || lower < 0 || upper > 100 || lower > upper) throw new Error('Buffer B范围需满足0 ≤ 下限 ≤ 上限 ≤ 100');
        const fracB = (lower + upper) / 200;
        const pHt = num('#numPH'), volML = num('#numVol');
        if (pHt == null || pHt < 0 || pHt > 14) throw new Error('目标 pH 无效');
        if (!(volML > 0)) throw new Error('样品体积无效');
        const { titrant, label: tName } = resolveTitrant();
        const tReagentPH = titrant.reagentPH;
        const mdl = (root.querySelector('input[name=model2]:checked') || {}).value || 'edh';
        const tol = num('#nTol');
        if (tol == null || tol < 0 || pHt - tol < 0 || pHt + tol > 14) throw new Error('pH容差无效');
        const input = { bufA, bufB, fracB, targetPH: pHt, sampleVolL: volML / 1000, titrant, model: mdl, tolerancePH: tol };
        pane.innerHTML = '<div class="card" role="status">正在计算所选B%范围…</div>';
        await new Promise(requestAnimationFrame);
        if (!alive || run !== tokens.neut) return;
        const points = [], steps = lower === upper ? 0 : Math.ceil((upper - lower) / .5);
        for (let j = 0; j <= steps; j++) {
          if (!alive || run !== tokens.neut) return;
          const b = steps ? lower + (upper - lower) * j / steps : lower;
          points.push({ b, r: Engine.calcNeutralization(Object.assign({}, input, { fracB: b / 100 })) });
          if (j % 8 === 0) await new Promise(requestAnimationFrame);
        }
        if (!alive || run !== tokens.neut) return;
        const r = Engine.calcNeutralization(input);
        const dirText = r.direction === 'acid' ? '加酸' : (r.direction === 'base' ? '加碱' : '方向未定');
        const dirNote = r.direction ? `<span class="stat">滴定方向：<b>${dirText}</b></span>` : '';
        const unreachable = r.reachable
          ? `<div class="errbox">目标 pH <b>${pHt}</b> 用 <b>${esc(tName)}</b> 无法达到：当前条件可达到的 pH 为 <b>${r.reachable.nearest.toFixed(2)}</b>。可达范围 ${r.reachable.lo.toFixed(2)}–${r.reachable.hi.toFixed(2)}（混合后 pH ${r.mixPH.toFixed(2)}${tReagentPH != null ? `，试剂自身 pH ${Number(tReagentPH).toFixed(2)}` : ''}）。${r.reachable.reason === 'wrongDirection' ? '该目标需要相反方向的试剂。' : '该目标超出试剂可达极限。'}</div>`
          : '';
        const good = points.filter(p => Number.isFinite(p.r.volL.mid) && p.r.volL.mid >= 0);
        let html = '<div class="card"><h3>所选B%范围 · 中和试剂用量</h3>';
        html += dirNote ? `<div style="margin-bottom:6px">${dirNote}</div>` : '';
        html += unreachable;
        if (good.length) {
          const min = good.reduce((a, b) => a.r.volL.mid < b.r.volL.mid ? a : b), max = good.reduce((a, b) => a.r.volL.mid > b.r.volL.mid ? a : b);
          html += `<div class="big-result" id="neutRangeResult">${esc(tName)}：${fmtVol(min.r.volL.mid)} – ${fmtVol(max.r.volL.mid)}</div>
          <div>Buffer B <b>${lower}%–${upper}%</b> · 样品 ${volML} mL · 目标pH ${pHt}</div>
          <div class="muted">最小值位于B ${min.b.toFixed(2)}%；最大值位于B ${max.b.toFixed(2)}%。按≤0.5个百分点采样估计极值，共${points.length}点；不是pH容差范围。</div>`;
        } else html += '<div class="errbox">所选范围内没有可用的加碱中和剂量：可能需加酸、试剂能力不足或模型未收敛。</div>';
        if (good.length < points.length) html += `<div class="warnbox">${points.length - good.length}/${points.length}个采样点无法用当前试剂达到目标；曲线留空，体积范围仅统计可行点。</div>`;
        html += '</div><div class="neut-detail-row"><div class="card"><h3>中和滴定 pH 热力图</h3><div id="neutPlot"></div><div class="muted">颜色越深表示预计pH越高；橙线为目标pH剂量，虚线为目标pH±容差。十字光标可在图内自由取点；预计pH是模型值，实际操作需实测确认。</div></div>';
        html += `<div class="card"><h3>区间中点 B ${((lower + upper) / 2).toFixed(2)}% · 过程信息</h3><div class="statgrid">
          <span class="stat">中和前 pH：<b>${r.mixPH.toFixed(2)}</b></span>
          ${r.conductivityBefore != null ? `<span class="stat">中和前估算电导率：<b>${r.conductivityBefore.toFixed(1)} mS/cm</b></span>` : ''}
          <span class="stat">净质子需求：<b>${(r.needMol.mid * 1000).toFixed(3)} mmol</b></span>
          <span class="stat">试剂有效中和比例：<b>${(r.effFrac.mid * 100).toFixed(1)}%</b></span>
          ${Number.isFinite(r.titrantCapacityM && r.titrantCapacityM.mid) ? `<span class="stat">试剂有效当量浓度：<b>${r.titrantCapacityM.mid.toFixed(3)} mol H⁺/L</b></span>` : ''}
          <span class="stat">估算离子强度：<b>${(r.ionicStrength * 1000).toFixed(1)} mM</b></span>
          ${r.conductivity != null ? `<span class="stat">中和后估算电导率：<b>${r.conductivity.toFixed(1)} mS/cm</b></span>` : ''}
          ${r.checkPH != null ? `<span class="stat">中和后 pH 复核：<b>${r.checkPH.toFixed(2)}</b>（目标 ${pHt}）</span>` : ''}
          ${r.finalVolL ? `<span class="stat">加试剂后总体积：<b>${fmtVol(r.finalVolL)}</b>（稀释 ${(r.finalVolL / (volML / 1000)).toFixed(2)}×）</span>` : ''}
          </div>
          ${r.conductivity != null ? '<div class="muted" style="margin-top:6px">「中和后 pH 复核」为按推荐用量加试剂后、由质子守恒反算的平衡 pH，应与目标 pH 一致。电导率使用有限浓度工程估计；混合盐及温度影响尚未校准。</div>' : ''}
          </div>`;
        html += '</div>';
        if (r.warnings.length) html += '<div class="warnbox">' + r.warnings.map(w => '⚠ ' + esc(w)).join('<br>') + '</div>';
        pane.innerHTML = html;
        NeutralChart.render($('#neutPlot'), points, Object.assign({}, input, { __dir: r.direction }), lower, upper);
        clearNotify();
      } catch (e) {
        if (!alive || run !== tokens.neut) return;
        pane.innerHTML = `<div class="errbox">✕ ${esc(errText(e))}</div>`;
      } finally {
        if (alive && run === tokens.neut) setNeutBusy(false);
      }
    }

    /* ============================================================
     * 标签页③：母液与缓冲体系管理
     * ============================================================ */
    function renderStockTable() {
      const t = $('#stockTable');
      let html = '<tr><th>名称</th><th>浓度</th><th>类型</th><th>pKa</th><th>参考pH</th><th>Na⁺</th><th>Cl⁻</th><th></th></tr>';
      DB.stocks.forEach(s => {
        html += `<tr><td><b>${esc(s.name)}</b></td>
          <td>${s.concM != null ? esc(s.concM) + ' M' : (s.pct != null ? esc(s.pct) + '% w/v' : (s.premix ? '预混配方' : '—'))}</td>
          <td>${TYPE_NAMES[s.type] || esc(s.type)}</td>
          <td>${s.pka != null ? esc(s.pka) : '—'}</td>
          <td>${s.refpH != null ? esc(s.refpH) : '—'}</td>
          <td>${esc(s.na || 0)}</td><td>${esc(s.cl || 0)}</td>
          <td class="noprint"><button class="ghost small" data-edit-stock="${esc(s.id)}">编辑</button>
          <button class="ghost small danger" data-del-stock="${esc(s.id)}" data-write-action>删除</button></td></tr>`;
      });
      t.innerHTML = html;
    }
    function renderSysTable() {
      const t = $('#sysTable');
      let html = '<tr><th>启用</th><th>名称</th><th>pKa</th><th>母液（d 值）</th><th>建议范围</th><th></th></tr>';
      DB.systems.forEach(s => {
        const isPm = !!s.premix;
        const pkaCell = isPm ? '<span class="muted">预混</span>' : (s.steps || []).map(x => `${esc(x.pKa)}(${esc(x.zA)}→${esc(x.zB)})`).join(', ');
        const stockCell = isPm
          ? esc((stockById(s.stockId) || {}).name || s.stockId)
          : ((s.stocks || []).map(x => { const st = stockById(x.stockId); return st ? esc(st.name) + '(d=' + esc(x.dStock) + ')' : `<span class="danger">${esc(x.stockId)}(缺母液)</span>`; }).join('、') || '<span class="danger">无可用母液</span>');
        html += `<tr><td><input type="checkbox" data-toggle-sys="${esc(s.id)}" data-write-action ${s.enabled ? 'checked' : ''}></td>
          <td><b>${esc(s.name)}</b></td>
          <td>${pkaCell}</td>
          <td>${stockCell}</td>
          <td class="muted">${s.range ? esc(s.range[0]) + '–' + esc(s.range[1]) : '—'}${s.range2 ? '；' + esc(s.range2[0]) + '–' + esc(s.range2[1]) : ''}</td>
          <td class="noprint">${isPm ? '' : `<button class="ghost small" data-edit-sys="${esc(s.id)}">编辑</button>`}
          <button class="ghost small danger" data-del-sys="${esc(s.id)}" data-write-action>删除</button></td></tr>`;
      });
      t.innerHTML = html;
      t.querySelectorAll('[data-toggle-sys]').forEach(chk => on(chk, 'change', async () => {
        const want = chk.checked;
        try {
          await commit(db => {
            const s = db.systems.find(x => x.id === chk.dataset.toggleSys);
            if (!s) throw Object.assign(new Error('缓冲体系已不存在'), { code: 'VALIDATION' });
            s.enabled = want;
          });
          refreshAll();
        } catch (error) {
          chk.checked = !want;   // 失败还原勾选
          notify(describeError(error), 'error');
        }
      }));
    }

    /* ---------- 表单（草稿在弹层内，只有保存成功才写库） ---------- */
    async function stockForm(existing) {
      const isNew = !existing;
      const draft = existing
        ? BufferData.clone(existing)
        : { id: uid(), name: '', concM: 0.2, refpH: null, na: 0, cl: 0, type: 'base', pka: null, pct: null };
      const body = `
        <div class="row"><label>名称</label><input type="text" id="f_name" class="wide" value="${esc(draft.name)}"></div>
        <div class="row"><label>类型</label><select id="f_type">${Object.keys(TYPE_NAMES).map(k => `<option value="${k}" ${draft.type === k ? 'selected' : ''}>${TYPE_NAMES[k]}</option>`).join('')}</select>
        <span class="muted">非离子类（蔗糖）请用下方 % 字段；预混液为特殊类型，组成改动请联系维护</span></div>
        <div class="row"><label>浓度 (M)</label><input type="number" id="f_conc" step="any" value="${draft.concM != null ? esc(draft.concM) : ''}">
        <label>或 % w/v</label><input type="number" id="f_pct" step="any" value="${draft.pct != null ? esc(draft.pct) : ''}" style="width:70px"></div>
        <div class="row"><label>参考 pH</label><input type="number" id="f_refpH" step="0.01" value="${draft.refpH != null ? esc(draft.refpH) : ''}">
        <label>pKa（作中和试剂/质子性添加剂时必填）</label><input type="number" id="f_pka" step="0.01" value="${draft.pka != null ? esc(draft.pka) : ''}" style="width:70px"></div>
        <div class="row"><label>Na⁺ 数/分子</label><input type="number" id="f_na" step="1" min="0" value="${esc(draft.na || 0)}" style="width:60px">
        <label>Cl⁻ 数/分子</label><input type="number" id="f_cl" step="1" min="0" value="${esc(draft.cl || 0)}" style="width:60px"></div>
        <div class="errbox" id="f_error" hidden></div>`;
      let settled = false;
      // 表单提交交给弹层的 submit 通道：校验或写入失败时弹层保持打开、草稿保留，
      // 只有确认写入成功才 closeModal（T-008 F-02）。
      const submit = async () => {
        if (settled) return;
        const name = $m('#f_name').value.trim();
        const errorBox = $m('#f_error');
        const fail = message => { errorBox.textContent = message; errorBox.hidden = false; };
        errorBox.hidden = true;
        if (!name) return fail('请填写名称');
        const conc = parseFloat($m('#f_conc').value), pct = parseFloat($m('#f_pct').value);
        const next = Object.assign({}, draft, {
          name,
          type: $m('#f_type').value,
          concM: Number.isNaN(conc) ? null : conc,
          pct: Number.isNaN(pct) ? null : pct,
          refpH: (v => Number.isNaN(v) ? null : v)(parseFloat($m('#f_refpH').value)),
          pka: (v => Number.isNaN(v) ? null : v)(parseFloat($m('#f_pka').value)),
          na: parseInt($m('#f_na').value) || 0,
          cl: parseInt($m('#f_cl').value) || 0,
        });
        try {
          await commit(db => {
            const i = db.stocks.findIndex(x => x.id === next.id);
            if (i < 0) db.stocks.push(BufferData.clone(next));
            else db.stocks[i] = BufferData.clone(next);
          });
        } catch (error) {
          // 保留草稿与弹层，只显示错误（弹层此时仍挂载在页面上）
          fail(describeError(error));
          return;
        }
        settled = true;
        closeModal(true);
        refreshAll();
        notify(`已保存母液「${next.name}」`, 'ok');
      };
      return askText(`${isNew ? '新增' : '编辑'}母液`, body, '保存', null, { confirm: 'f_save', cancel: 'f_cancel' }, submit, '保存中…');
    }

    async function sysForm(existing) {
      const isNew = !existing;
      const draft = existing
        ? BufferData.clone(existing)
        : { id: uid(), name: '', enabled: true, range: [3, 10], steps: [{ pKa: 7.0, zA: 0, zB: -1 }], stocks: [] };
      const stockOpts = sel => DB.stocks.map(st => `<option value="${esc(st.id)}" ${st.id === sel ? 'selected' : ''}>${esc(st.name)}</option>`).join('');
      const body = `
        <div class="row"><label>名称</label><input type="text" id="g_name" class="wide" value="${esc(draft.name)}"></div>
        <div class="row"><label>建议 pH 范围</label><input type="number" id="g_r0" step="0.1" value="${draft.range ? esc(draft.range[0]) : ''}" style="width:70px"> –
          <input type="number" id="g_r1" step="0.1" value="${draft.range ? esc(draft.range[1]) : ''}" style="width:70px">
          <span class="muted">第二段（可选，如甘氨酸高 pH 段）</span>
          <input type="number" id="g_r20" step="0.1" value="${draft.range2 ? esc(draft.range2[0]) : ''}" style="width:70px"> –
          <input type="number" id="g_r21" step="0.1" value="${draft.range2 ? esc(draft.range2[1]) : ''}" style="width:70px"></div>
        <h4>解离步骤（pKa，酸式电荷 → 碱式电荷）</h4>
        <div id="g_steps"></div>
        <button class="ghost small" id="g_addstep">+ 加一级 pKa</button>
        <h4 style="margin-top:14px">母液与 d 值（d = 该母液形态相对全质子化形态已解离的质子数）</h4>
        <div class="muted" style="margin-bottom:6px">例：PB 体系 H3PO4 d=0、NaH2PO4 d=1、Na2HPO4 d=2；Tris-HCl d=0、Tris d=1</div>
        <div id="g_stocks"></div>
        <button class="ghost small" id="g_addstock">+ 加母液</button>
        <div class="errbox" id="g_error" hidden></div>`;
      let settled = false;
      return askText(`${isNew ? '新增' : '编辑'}缓冲体系`, body, '保存', (slot, buttons) => {
        void buttons;
        function renderSteps() {
          const box = $m('#g_steps');
          box.innerHTML = '';
          draft.steps.forEach((st, i) => {
            const div = document.createElement('div');
            div.className = 'row';
            div.innerHTML = `<label>pKa${i + 1}</label>
              <input type="number" step="0.01" value="${esc(st.pKa)}" data-step-pka="${i}" style="width:80px">
              <label>电荷</label>
              <input type="number" step="1" value="${esc(st.zA)}" data-step-za="${i}" style="width:60px"> →
              <input type="number" step="1" value="${esc(st.zB)}" data-step-zb="${i}" style="width:60px">
              ${draft.steps.length > 1 ? `<button class="ghost small danger" data-del-step="${i}">删</button>` : ''}`;
            box.appendChild(div);
          });
          box.querySelectorAll('[data-step-pka], [data-step-za], [data-step-zb]').forEach(inp => on(inp, 'change', () => {
            const i = +(inp.dataset.stepPka != null ? inp.dataset.stepPka : (inp.dataset.stepZa != null ? inp.dataset.stepZa : inp.dataset.stepZb));
            draft.steps[i].pKa = parseFloat(box.querySelector(`[data-step-pka="${i}"]`).value);
            draft.steps[i].zA = parseInt(box.querySelector(`[data-step-za="${i}"]`).value) || 0;
            draft.steps[i].zB = parseInt(box.querySelector(`[data-step-zb="${i}"]`).value) || 0;
          }));
          box.querySelectorAll('[data-del-step]').forEach(btn => on(btn, 'click', () => {
            draft.steps.splice(+btn.dataset.delStep, 1);
            renderSteps();
          }));
        }
        function renderStocks() {
          const box = $m('#g_stocks');
          box.innerHTML = '';
          (draft.stocks || []).forEach((x, i) => {
            const div = document.createElement('div');
            div.className = 'row';
            div.innerHTML = `<select data-gstk="${i}">${stockOpts(x.stockId)}</select>
              <label>d =</label><input type="number" step="1" min="0" value="${esc(x.dStock)}" data-gd="${i}" style="width:60px">
              <button class="ghost small danger" data-del-gstk="${i}">删</button>`;
            box.appendChild(div);
          });
          box.querySelectorAll('[data-gstk]').forEach(sel => on(sel, 'change', () => { draft.stocks[+sel.dataset.gstk].stockId = sel.value; }));
          box.querySelectorAll('[data-gd]').forEach(inp => on(inp, 'change', () => { draft.stocks[+inp.dataset.gd].dStock = parseInt(inp.value) || 0; }));
          box.querySelectorAll('[data-del-gstk]').forEach(btn => on(btn, 'click', () => {
            draft.stocks.splice(+btn.dataset.delGstk, 1);
            renderStocks();
          }));
        }
        renderSteps();
        renderStocks();
        on($m('#g_addstep'), 'click', () => {
          const last = draft.steps[draft.steps.length - 1];
          draft.steps.push({ pKa: last.pKa + 2, zA: last.zB, zB: last.zB - 1 });
          renderSteps();
        });
        on($m('#g_addstock'), 'click', () => {
          if (!DB.stocks.length) { notify('请先新增母液', 'error'); return; }
          draft.stocks = draft.stocks || [];
          draft.stocks.push({ stockId: DB.stocks[0].id, dStock: draft.stocks.length });
          renderStocks();
        });
      }, { confirm: 'g_save', cancel: 'g_cancel' }, submit, '保存中…');
      // 提交通道：校验或写入失败保留弹层与草稿，只有确认写入成功才关闭（T-008 F-02）
      async function submit() {
        if (settled) return;
        const errorBox = $m('#g_error');
        const fail = message => { errorBox.textContent = message; errorBox.hidden = false; };
        errorBox.hidden = true;
        const name = $m('#g_name').value.trim();
        if (!name) return fail('请填写名称');
        const next = BufferData.clone(draft);
        next.name = name;
        next.steps = Array.from($m('#g_steps').querySelectorAll('[data-step-pka]')).map(inp => {
          const i = inp.dataset.stepPka;
          return {
            pKa: parseFloat(inp.value),
            zA: parseFloat($m('#g_steps').querySelector(`[data-step-za="${i}"]`).value),
            zB: parseFloat($m('#g_steps').querySelector(`[data-step-zb="${i}"]`).value),
          };
        });
        if (!next.steps.length) return fail('至少一个 pKa');
        if (next.steps.some((st, i) => !Number.isFinite(st.pKa) || !Number.isInteger(st.zA) || !Number.isInteger(st.zB)
          || st.zB !== st.zA - 1 || (i > 0 && st.zA !== next.steps[i - 1].zB))) {
          return fail('请填写有效 pKa 与整数电荷；每步电荷须减少 1，相邻步骤电荷须连续');
        }
        const r0 = parseFloat($m('#g_r0').value), r1 = parseFloat($m('#g_r1').value);
        next.range = (Number.isNaN(r0) || Number.isNaN(r1)) ? null : [r0, r1];
        if (next.range === null) delete next.range;
        const r20 = parseFloat($m('#g_r20').value), r21 = parseFloat($m('#g_r21').value);
        if (Number.isNaN(r20) || Number.isNaN(r21)) delete next.range2; else next.range2 = [r20, r21];
        try {
          await commit(db => {
            const i = db.systems.findIndex(x => x.id === next.id);
            if (i < 0) db.systems.push(BufferData.clone(next));
            else db.systems[i] = BufferData.clone(next);
          });
        } catch (error) {
          fail(describeError(error));
          return;
        }
        settled = true;
        closeModal(true);
        refreshAll();
        notify(`已保存缓冲体系「${next.name}」`, 'ok');
      }
    }

    /* ---------- 管理页：实测记录汇总 ---------- */
    function renderCalibAdmin() {
      const box = $('#calibAdmin');
      if (!box) return;
      const all = calibAll();
      if (!all.length) {
        box.innerHTML = '<div class="empty-state">尚无实测记录。<br>在「缓冲液配制」页配方结果卡的「实测 pH 记录」小节录入；记录随「导出 JSON」一起备份。</div>';
        return;
      }
      const groups = new Map();
      for (const x of all) {
        if (!groups.has(x.key)) groups.set(x.key, []);
        groups.get(x.key).push(x);
      }
      let html = `<div class="muted" style="margin-bottom:6px">共 <b>${all.length}</b> 条记录，覆盖 <b>${groups.size}</b> 个「体系+浓度+添加剂+目标pH」组合。偏差 = 实测 − 目标。</div>
        <div class="row noprint" style="margin-bottom:8px">
          <button class="ghost" id="btnCalibExportAll" data-output-action>导出全部记录（含配方全文）</button>
          <button class="ghost" id="btnCalibExportTable" data-output-action>导出偏差表（TSV，便于回归）</button>
          <button class="ghost" id="btnCalibClear" data-write-action>清空全部实测记录</button>
        </div>`;
      for (const [key, rows] of groups) {
        const devs = rows.map(x => x.measuredPH - x.targetPH);
        const mean = devs.reduce((a, b) => a + b, 0) / devs.length;
        const absMean = devs.reduce((a, b) => a + Math.abs(b), 0) / devs.length;
        const maxAbs = Math.max(...devs.map(Math.abs));
        html += `<div style="margin-top:10px"><b>${esc(rows[0].label)}</b>
          <span class="muted">（目标 pH ${esc(rows[0].targetPH)}，${rows.length} 条）</span>
          <div class="muted">平均偏差 ${mean >= 0 ? '+' : ''}${mean.toFixed(3)} pH · 平均绝对偏差 ${absMean.toFixed(3)} pH · 最大绝对偏差 ${maxAbs.toFixed(3)} pH</div>
          <div style="overflow-x:auto"><table class="res"><tr><th>时间</th><th>实测 pH</th><th>偏差</th><th>温度</th><th>模型</th><th></th></tr>`
          + rows.slice().reverse().map(x => {
            const dv = x.measuredPH - x.targetPH;
            return `<tr><td class="muted">${esc(x.at)}</td><td class="num">${x.measuredPH.toFixed(3)}</td><td class="num">${dv >= 0 ? '+' : ''}${dv.toFixed(3)}</td><td class="num">${x.tempC == null ? '—' : esc(x.tempC)}</td><td class="muted">${esc(x.model || '')}</td><td><button class="ghost small" data-calib-del="${esc(x.id)}" data-write-action>删除</button></td></tr>`;
          }).join('')
          + '</table></div></div>';
      }
      box.innerHTML = html;
    }
    function renderCalibHistories() {
      $$('[data-calib-card]').forEach(card => {
        const box = card.querySelector('[data-calib-history]');
        if (!box) return;
        const rows = calibrationFor(card.dataset.calibKey).slice().reverse();
        if (!rows.length) { box.innerHTML = ''; return; }
        const shown = rows.slice(0, 10);
        box.innerHTML = `<table class="res" style="margin-top:8px"><tr><th>时间</th><th>实测 pH</th><th>偏差</th><th>温度</th><th></th></tr>`
          + shown.map(x => {
            const dv = x.measuredPH - x.targetPH;
            return `<tr><td class="muted">${esc(x.at)}</td><td class="num">${x.measuredPH.toFixed(3)}</td>`
              + `<td class="num">${dv >= 0 ? '+' : ''}${dv.toFixed(3)}</td>`
              + `<td class="num">${x.tempC == null ? '—' : esc(x.tempC)}</td>`
              + `<td><button class="ghost small" data-calib-del="${esc(x.id)}" data-write-action>删除</button></td></tr>`;
          }).join('')
          + `</table>${rows.length > shown.length ? `<div class="muted">仅显示最近 ${shown.length} 条，共 ${rows.length} 条；完整数据在管理页「实测 pH 记录」。</div>` : ''}`;
      });
    }
    async function calibRecord(side) {
      const card = root.querySelector(`[data-calib-card="${side}"]`);
      if (!card) return;
      const pHInput = card.querySelector(`[data-calib-ph="${side}"]`);
      const measured = parseFloat(pHInput.value);
      if (!Number.isFinite(measured) || measured < 0 || measured > 14) {
        notify('请填写 0–14 之间的实测 pH。', 'error');
        pHInput.focus();
        return;
      }
      const tempRaw = parseFloat((card.querySelector(`[data-calib-temp="${side}"]`) || {}).value);
      const target = parseFloat(card.dataset.calibTarget);
      const text = (card.querySelector(`[data-calib-text="${side}"]`) || {}).value || '';
      // 记录 ID 在用户点击时生成一次；重试复用同一个 id，一次重试不会插入两条。
      const id = 'c' + Date.now().toString(36) + Math.random().toString(36).slice(2, 6);
      const rec = {
        id,
        key: card.dataset.calibKey,
        label: (root.querySelector(`[data-buffer-name="${side}"]`) || {}).textContent || side,
        targetPH: target,
        measuredPH: measured,
        tempC: Number.isFinite(tempRaw) ? tempRaw : null,
        at: nowText(),
        model: currentModel(),
        text,
      };
      try {
        await commit(db => {
          if (!Array.isArray(db.calibration)) db.calibration = [];
          if (db.calibration.some(x => x.id === id)) throw Object.assign(new Error('记录 ID 冲突，请重试'), { code: 'VALIDATION' });
          db.calibration.push(BufferData.clone(rec));
        });
      } catch (error) {
        notify(describeError(error), 'error');
        return;   // 失败保留输入
      }
      pHInput.value = '';
      const tempIn = card.querySelector(`[data-calib-temp="${side}"]`);
      if (tempIn) tempIn.value = '';
      renderCalibHistories();
      const box = card.querySelector('[data-calib-history]');
      if (box) box.insertAdjacentHTML('afterbegin', `<div class="muted" style="margin-top:6px">已记录：实测 ${measured.toFixed(3)}，偏差 ${(measured - target) >= 0 ? '+' : ''}${(measured - target).toFixed(3)} pH（共 ${calibrationFor(card.dataset.calibKey).length} 条）</div>`);
      renderCalibAdmin();
      notify('实测记录已保存', 'ok');
    }

    /* ============================================================
     * 输出（保存 / 复制 / 打印）
     * ============================================================ */
    async function exportText({ suggestedName, format, text, label }) {
      setOutputBusy(true);
      try {
        const result = await platform.saveText({ suggestedName, format, text });
        if (result.status === 'saved') notify(`${label}已保存：${suggestedName}`, 'ok');
        else notify(`${label}已取消，未写入文件。`, 'info');
        return result;
      } catch (error) {
        notify(describeError(error), 'error');
        return null;
      } finally {
        setOutputBusy(false);
      }
    }
    async function copyText(text, button, doneText) {
      if (!text) return;
      setOutputBusy(true);
      const original = button ? button.textContent : '';
      if (button) button.disabled = true;
      try {
        await platform.copyText(text);   // 成功返回 undefined
        if (button) button.textContent = doneText || '已复制 ✓';
        notify('已复制到剪贴板。', 'ok');
      } catch (error) {
        notify(describeError(error), 'error');
      } finally {
        setOutputBusy(false);
        if (button) {
          button.disabled = false;
          if (alive) setTimeout(() => { if (alive) button.textContent = original; }, 1500);
        }
      }
    }
    async function printCurrentView() {
      if (modal) { notify('请先关闭确认弹层再打印。', 'error'); return; }
      setOutputBusy(true);
      try {
        const result = await platform.printView();
        if (result.status === 'submitted') notify('已提交系统打印服务；打印结果与纸张输出请在系统打印队列核对。', 'ok');
        else notify('已取消打印。', 'info');
      } catch (error) {
        notify(describeError(error), 'error');
      } finally {
        setOutputBusy(false);
      }
    }

    /* ---------- 导入 / 恢复默认 ---------- */
    async function importFile(file) {
      const token = ++tokens.import;
      if (!file) return;
      if (file.size > 4 * 1024 * 1024) { notify('文件超过 4 MiB 读取上限，未导入。', 'error'); return; }
      let text;
      try {
        text = await readFileText(file, token);
      } catch (error) {
        if (alive && token === tokens.import) notify('读取文件失败：' + errText(error), 'error');
        return;
      }
      if (!alive || token !== tokens.import) return;
      let parsed;
      try {
        parsed = JSON.parse(text);
      } catch (error) {
        notify('导入失败：不是合法 JSON。', 'error');
        return;
      }
      let prepared;
      try {
        prepared = BufferData.prepare(parsed);
      } catch (error) {
        notify('导入失败：' + errText(error), 'error');
        return;
      }
      // 注意：这里必须把 prepared.db 作为值捕获，不能在 change 回调里读外层变量——
      // 否则回调拿到的是与 prepared 同名的旧绑定，会把导入前的数据重新写回去。
      const candidate = prepared.db;
      const capacity = BufferData.checkCapacity(candidate);
      if (!capacity.ok) {
        notify(`导入失败：数据容量 ${capacity.length} 字符，超过工具箱上限 ${capacity.limit} 字符。未改动现有数据。`, 'error');
        return;
      }
      const counts = `母液 ${Array.isArray(candidate.stocks) ? candidate.stocks.length : 0} 条、缓冲体系 ${Array.isArray(candidate.systems) ? candidate.systems.length : 0} 条、实测记录 ${Array.isArray(candidate.calibration) ? candidate.calibration.length : 0} 条`;
      const warnText = prepared.warnings.length
        ? `\n兼容性提示（${prepared.warnings.length} 条）：${prepared.warnings.slice(0, 6).join('；')}${prepared.warnings.length > 6 ? ' …' : ''}`
        : '';
      const ok = await askConfirm('确认导入并替换整个库', `将把当前库整体替换为文件内容（${counts}），不会合并。当前数据将被覆盖，建议先「导出 JSON」备份。${warnText}`, '替换');
      if (!ok) { notify('已取消导入，现有数据未改动。', 'info'); return; }
      try {
        await commit(() => BufferData.clone(candidate));
      } catch (error) {
        notify('导入失败：' + describeError(error), 'error');
        return;
      }
      refreshAll();
      notify(`${prepared.warnings.length ? '导入完成（存在兼容性提示，见管理页数据提示）' : '导入完成'}：${counts}。`, prepared.warnings.length ? 'warn' : 'ok');
    }
    function readFileText(file, token) {
      return new Promise((resolve, reject) => {
        const reader = new FileReader();
        reader.onload = () => resolve(String(reader.result));
        reader.onerror = () => reject(new Error('文件读取失败'));
        reader.onabort = () => reject(new Error('文件读取已取消'));
        const abortIfStale = () => { if (!alive || token !== tokens.import) { try { reader.abort(); } catch (error) { /* 已结束 */ } } };
        reader.onloadend = abortIfStale;
        reader.readAsText(file);
      });
    }
    async function resetToDefaults() {
      const nCal = calibAll().length;
      const ok = await askConfirm('确认恢复出厂默认', `你的全部自定义修改将丢失${nCal ? `；⚠ 已记录的 ${nCal} 条实测 pH 数据也会一并清除` : ''}。建议先「导出 JSON」备份。`, '恢复默认');
      if (!ok) { notify('已取消恢复默认。', 'info'); return; }
      // 与导入同理：固定值捕获，避免回调读到的绑定随后被覆盖
      let fresh;
      try {
        fresh = BufferData.prepare(null).db;
      } catch (error) {
        notify('恢复默认失败：' + errText(error), 'error');
        return;
      }
      try {
        await commit(() => BufferData.clone(fresh));
      } catch (error) {
        notify('恢复默认失败：' + describeError(error), 'error');
        return;
      }
      refreshAll();
      notify('已恢复出厂默认。', 'ok');
    }

    /* ---------- 事件绑定 ---------- */
    function bindShell() {
      on($('#btnPrint'), 'click', () => printCurrentView());
      $$('nav.tabs button').forEach(btn => on(btn, 'click', () => showView(btn.dataset.tab)));
      on($('#btnCalc'), 'click', () => computeRecipe());
      on($('#btnNeut'), 'click', () => { computeNeutralization().catch(reportAsyncError); });
      on($('#btnAddStock'), 'click', () => { stockForm(null).catch(reportAsyncError); });
      on($('#btnAddSys'), 'click', () => { sysForm(null).catch(reportAsyncError); });
      on($('#btnExport'), 'click', async () => {
        await store.whenIdle();
        if (!alive) return;
        let snapshot;
        try { snapshot = store.snapshot(); } catch (error) { notify(describeError(error), 'error'); return; }
        await exportText({ suggestedName: `buffer-calculator-db-${stamp(false)}.json`, format: 'json', text: JSON.stringify(snapshot, null, 2), label: '数据库 JSON ' });
      });
      on($('#btnImport'), 'click', () => $('#fileImport').click());
      on($('#fileImport'), 'change', event => {
        const file = event.target.files && event.target.files[0];
        importFile(file).catch(reportAsyncError).finally(() => { event.target.value = ''; });
      });
      on($('#btnReset'), 'click', () => { resetToDefaults().catch(reportAsyncError); });
      on($('#allowTitrant'), 'change', () => { $('#titrantConcRow').style.display = $('#allowTitrant').checked ? '' : 'none'; });
      $$('input[name=titrantSrc]').forEach(radio => on(radio, 'change', () => {
        const custom = (root.querySelector('input[name=titrantSrc]:checked') || {}).value === 'custom';
        $('#nTitrantStockRow').style.display = custom ? 'none' : '';
        $('#nTitrantCustom').style.display = custom ? '' : 'none';
      }));

      // 管理页与结果卡的委托事件（限定在 root 内，实例销毁后不再响应）
      on(root, 'click', event => {
        const t = event.target.closest('button');
        if (!t) return;
        const d = t.dataset;
        if (d.copy || d.copyName || d.copy_name) {
          const side = d.copyName || d.copy_name;
          const text = side ? lastName[side] : lastCopy[d.copy];
          copyText(text || '', t).catch(reportAsyncError);
          return;
        }
        if (d.calibSave) { calibRecord(d.calibSave).catch(reportAsyncError); return; }
        if (d.calibDel) {
          askConfirm('删除这条实测记录？', '删除后无法恢复；如需保留请先导出记录。', '删除').then(async ok => {
            if (!ok) return;
            try {
              await commit(db => {
                if (!Array.isArray(db.calibration)) return;
                const i = db.calibration.findIndex(x => x.id === d.calibDel);
                if (i >= 0) db.calibration.splice(i, 1);
              });
            } catch (error) { notify(describeError(error), 'error'); return; }
            renderCalibHistories();
            renderCalibAdmin();
            notify('已删除该条实测记录。', 'ok');
          }).catch(reportAsyncError);
          return;
        }
        if (d.calibExport) {
          const side = d.calibExport;
          const card = root.querySelector(`[data-calib-card="${side}"]`);
          if (!card) return;
          const rows = calibrationFor(card.dataset.calibKey);
          if (!rows.length) { notify('该卡片还没有实测记录。', 'error'); return; }
          exportText({ suggestedName: `实测pH记录-${side}-${stamp(false)}.txt`, format: 'txt', text: calibrationTSV(rows, true), label: '实测记录 ' }).catch(reportAsyncError);
          return;
        }
        if (d.editStock) { stockForm(stockById(d.editStock)).catch(reportAsyncError); return; }
        if (d.delStock) {
          const s = stockById(d.delStock);
          if (!s) return;
          const usedBy = DB.systems.filter(x => (x.stocks || []).some(y => y.stockId === s.id) || x.stockId === s.id).map(x => x.name);
          const msg = usedBy.length
            ? `母液「${s.name}」正被体系「${usedBy.join('、')}」使用，删除后这些体系将缺母液（保留删除标记，不会自动补回）。确认删除？`
            : `确认删除母液「${s.name}」？`;
          askConfirm('删除母液', msg, '删除').then(async ok => {
            if (!ok) return;
            try {
              // 删除母液与关联引用调整必须在同一事务
              await commit(db => {
                const id = s.id;
                if (DefaultDB.stocks.some(x => x.id === id)) {
                  db.deletedDefaults = db.deletedDefaults || {};
                  const ids = new Set(db.deletedDefaults.stocks || []);
                  ids.add(id);
                  db.deletedDefaults.stocks = Array.from(ids);
                }
                db.stocks = db.stocks.filter(x => x.id !== id);
                db.systems.forEach(x => { x.stocks = (x.stocks || []).filter(y => y.stockId !== id); });
              });
            } catch (error) { notify(describeError(error), 'error'); return; }
            refreshAll();
            notify(`已删除母液「${s.name}」。`, 'ok');
          }).catch(reportAsyncError);
          return;
        }
        if (d.editSys) {
          const s = systemById(d.editSys);
          if (s && !s.premix) sysForm(s).catch(reportAsyncError);
          return;
        }
        if (d.delSys) {
          const s = systemById(d.delSys);
          if (!s) return;
          askConfirm('删除缓冲体系', `确认删除缓冲体系「${s.name}」？删除后保留删除标记，重开不会被默认补回。`, '删除').then(async ok => {
            if (!ok) return;
            try {
              await commit(db => {
                const id = s.id;
                if (DefaultDB.systems.some(x => x.id === id)) {
                  db.deletedDefaults = db.deletedDefaults || {};
                  const ids = new Set(db.deletedDefaults.systems || []);
                  ids.add(id);
                  db.deletedDefaults.systems = Array.from(ids);
                }
                db.systems = db.systems.filter(x => x.id !== id);
              });
            } catch (error) { notify(describeError(error), 'error'); return; }
            refreshAll();
            notify(`已删除缓冲体系「${s.name}」。`, 'ok');
          }).catch(reportAsyncError);
          return;
        }
        if (t.id === 'btnCalibExportAll') {
          const all = calibAll();
          if (!all.length) { notify('尚无实测记录。', 'error'); return; }
          exportText({ suggestedName: `实测pH记录-全部-${stamp(true)}.txt`, format: 'txt', text: calibrationTSV(all, true), label: '全部实测记录 ' }).catch(reportAsyncError);
          return;
        }
        if (t.id === 'btnCalibExportTable') {
          const all = calibAll();
          if (!all.length) { notify('尚无实测记录。', 'error'); return; }
          exportText({ suggestedName: `实测pH偏差表-${stamp(true)}.tsv`, format: 'tsv', text: calibrationTSV(all, false), label: '偏差表 ' }).catch(reportAsyncError);
          return;
        }
        if (t.id === 'btnCalibClear') {
          const n = calibAll().length;
          if (!n) { notify('尚无实测记录。', 'error'); return; }
          askConfirm('清空全部实测记录', `确认清空全部 ${n} 条实测记录？此操作不可恢复，建议先「导出全部记录」。`, '清空').then(async ok => {
            if (!ok) return;
            try {
              await commit(db => { db.calibration = []; });
            } catch (error) { notify(describeError(error), 'error'); return; }
            renderCalibHistories();
            renderCalibAdmin();
            notify('已清空全部实测记录。', 'ok');
          }).catch(reportAsyncError);
        }
      });

      // 滑块与区间
      bindSlider('#slPH', '#numPH', { min: 4, max: 9, dec: 2 });
      bindSlider('#slVol', '#numVol', { min: VOL_MIN, max: VOL_MAX, log: true });
      $('#slVol').value = sliderFromVol(10);
      for (const id of ['slFracBLo', 'slFracB', 'numFracBLo', 'numFracB']) on($('#' + id), 'input', e => syncFracRange(e.target));
      for (const id of ['numFracBLo', 'numFracB']) on($('#' + id), 'change', e => syncFracRange(e.target, true));
      syncFracRange($('#numFracBLo'));

      // 输入变化只标记待更新，不自动计算、不重算曲线
      for (const eventName of ['input', 'change']) {
        on($('#t1'), eventName, markRecipeDirty);
        on($('#t2'), eventName, markNeutralizationDirty);
      }
    }

    function paintFracRange() {
      const low = $('#numFracBLo'), high = $('#numFracB'), a = parseFloat(low.value), b = parseFloat(high.value);
      const invalid = !Number.isFinite(a) || !Number.isFinite(b) || a < 0 || b > 100 || a > b;
      low.setAttribute('aria-invalid', invalid ? 'true' : 'false');
      high.setAttribute('aria-invalid', invalid ? 'true' : 'false');
      $('.dual-range').classList.toggle('range-invalid', invalid);
      if (!Number.isFinite(a) || !Number.isFinite(b)) return;
      const left = Math.max(0, Math.min(100, Math.min(a, b))), right = Math.max(0, Math.min(100, Math.max(a, b)));
      $('#fracRangeFill').style.left = left + '%';
      $('#fracRangeFill').style.width = (right - left) + '%';
    }
    function syncFracRange(changed, commitValue) {
      const isLow = changed.id.endsWith('Lo'), isSlider = changed.type === 'range';
      const low = $('#numFracBLo'), high = $('#numFracB'), lowSl = $('#slFracBLo'), highSl = $('#slFracB');
      const ownNum = isLow ? low : high, otherNum = isLow ? high : low, ownSlider = isLow ? lowSl : highSl;
      let v = parseFloat(changed.value);
      if (!Number.isFinite(v)) { paintFracRange(); return; }
      const clamp = x => Math.max(0, Math.min(100, x));
      if (isSlider) {
        const other = parseFloat(otherNum.value);
        v = clamp(v);
        if (Number.isFinite(other)) v = isLow ? Math.min(v, other) : Math.max(v, other);
        ownSlider.value = v;
        ownNum.value = v;
      } else {
        if (commitValue) { v = clamp(v); ownNum.value = v; }
        ownSlider.value = clamp(v);
      }
      paintFracRange();
    }
    function markRecipeDirty() {
      if (!$('#resultZone').querySelector('.rcard')) return;
      if ($('#recipePending')) return;
      $('#resultZone').insertAdjacentHTML('afterbegin', '<div class="warnbox" id="recipePending" role="status">配制条件已修改，请点击「计算」更新。下方结果仍对应上一次计算条件。</div>');
    }
    function markNeutralizationDirty() {
      const pane = $('#neutZone');
      if (!$('#neutChart') && !$('#neutRangeResult')) return;
      ++tokens.neut;
      setNeutBusy(false);   // 取消进行中的计算后恢复按钮，避免停留在「计算中…」
      if ($('#neutPending')) return;
      const warning = '<div class="warnbox" id="neutPending" role="status">中和条件已修改，请点击「计算」更新。下方若有结果，仍对应上一次计算条件。</div>';
      pane.insertAdjacentHTML('afterbegin', warning);
    }

    /* ---------- 视图、主题、界面状态 ---------- */
    function showView(id) {
      const target = TABS.includes(id) ? id : 't1';
      activeTab = target;
      $$('nav.tabs button').forEach(b => b.classList.toggle('active', b.dataset.tab === target));
      $$('.tabpage').forEach(p => p.classList.toggle('active', p.id === target));
      root.dataset.view = target;
      return target;
    }
    function setTheme(next) {
      theme = next === 'dark' ? 'dark' : 'light';
      // 只保存主题并设置根属性：init 前调用安全，也不触发重算
      if (root) root.setAttribute('data-theme', theme);
      NeutralChart.setTheme(theme);
      return theme;
    }
    function renderDbWarnings(warnings) {
      const box = $('#dbWarnings');
      if (!box) return;
      if (!warnings || !warnings.length) { box.hidden = true; box.innerHTML = ''; return; }
      box.hidden = false;
      box.innerHTML = '<div class="warnbox">数据提示（不影响已有数据，可在管理页修复）：<br>'
        + warnings.slice(0, 12).map(w => '⚠ ' + esc(w)).join('<br>')
        + (warnings.length > 12 ? `<br>…等共 ${warnings.length} 条` : '') + '</div>';
    }
    function refreshAll() {
      const picker = capturePickerState();
      renderSysPicker($('#t1ASys'), 't1A');
      renderSysPicker($('#t1BSys'), 't1B');
      renderAddPicker($('#t1AAdd'), 't1A', false);
      renderAddPicker($('#t1BAdd'), 't1B', false);
      renderNeutSelectors();
      applyPickerState(picker);
      renderStockTable();
      renderSysTable();
      renderCalibHistories();
      renderCalibAdmin();
      setWriteBusy(busyDepth > 0);
    }
    function setPhase(phase, message) {
      root.dataset.phase = phase;
      const business = $('#businessRoot');
      const gate = $('#gateRoot');
      if (business) business.hidden = phase !== 'ready';
      if (gate) gate.hidden = phase === 'ready';
      if (message) {
        const target = $('#gateMessage');
        if (target) target.textContent = message;
      }
    }
    // 运行中进入恢复状态：必须同时收起业务界面与任何未决弹层，
    // 否则用户会看到“上面还压着失败表单、下面才是恢复入口”的混合状态（T-008 F-03）。
    function enterRecovery(error, options) {
      if (modal) closeModal(null);
      showRecovery(error, options);
    }
    // 恢复界面的文案必须区分三种情况，不能统一声称“未改动”：
    //  - uncertain：写入结果无法确认，可能已经落盘，因此不提供基于缓存快照的“覆盖”入口。
    //  - readSucceeded：读到了可用的 JSON 值，可原样导出或整库替换。
    //  - 读盘失败：宿主存储文件不可读，插件拿不到原始字节，只能重试读取。
    function showRecovery(error, options) {
      const recovery = store.recovery();
      const uncertain = !!(options && options.uncertain) || !!recovery.uncertain;
      setPhase('recovery');
      const detail = $('#gateDetail');
      if (detail) {
        detail.innerHTML = '';
        const lines = [describeError(error)];
        if (recovery.code) lines.push(`错误码：${recovery.code}`);
        if (uncertain) {
          lines.push('本次保存结果无法确认：既不能断言已写入，也不能断言没有写入。为避免覆盖，插件已暂停一切写入。');
          lines.push('请点击「重试读取」，以实际存储内容为准核对；未被确认的修改需要在该次核对后重新填写。');
        } else if (recovery.readSucceeded) {
          lines.push('读取到的原数据仍保留在插件存储中，未被本次失败改动。可先导出原始 JSON 备份，再选择有效 JSON 导入或恢复默认。');
        } else {
          lines.push('宿主存储文件本身不可读取，插件无法取得原始字节；请通过宿主的插件管理途径恢复，或卸载后重新安装（本操作不会自动删除数据）。');
        }
        lines.forEach(line => {
          const p = root.ownerDocument.createElement('div');
          p.textContent = line;
          detail.appendChild(p);
        });
      }
      // 结果不确定时，缓存快照不能冒充“重读后的原始存储”，因此不提供导出原始值与整库覆盖。
      const canUseRaw = recovery.readSucceeded && !uncertain;
      const exportRaw = $('#btnRecoveryExport');
      if (exportRaw) exportRaw.hidden = !(canUseRaw && recovery.raw != null);
      const replaceBtns = [$('#btnRecoveryImport'), $('#btnRecoveryReset')];
      replaceBtns.forEach(btn => { if (btn) btn.hidden = !canUseRaw; });
      const retry = $('#btnRecoveryRetry');
      if (retry) retry.hidden = false;
    }

    /* ---------- 恢复界面的动作 ---------- */
    async function retryInit() {
      setPhase('loading', '正在重新读取插件数据…');
      try {
        const result = await store.init();
        if (!alive) return;
        DB = store.snapshot();
        renderDbWarnings(result.warnings);
        refreshAll();
        setPhase('ready');
        notify(result.status === 'migrated' ? '已重新读取并完成默认迁移。' : '已重新读取插件数据。', 'ok');
      } catch (error) {
        if (!alive) return;
        enterRecovery(error);
        notify(describeError(error), 'error');
      }
    }
    async function exportRawRecovery() {
      const recovery = store.recovery();
      if (!recovery.readSucceeded || recovery.raw == null) { notify('当前无可导出的原始数据。', 'error'); return; }
      await exportText({
        suggestedName: `buffer-calculator-raw-backup-${stamp(true)}.json`,
        format: 'json',
        text: JSON.stringify(recovery.raw, null, 2),
        label: '原始数据备份 ',
      });
    }
    async function replaceFromRecovery(candidate, confirmTitle, confirmText) {
      const ok = await askConfirm(confirmTitle, confirmText, '覆盖并继续');
      if (!ok) { notify('已取消，原数据未改动。', 'info'); return false; }
      try {
        const result = await store.replace(candidate);
        if (!alive) return false;
        DB = store.snapshot();
        renderDbWarnings(result.warnings);
        refreshAll();
        setPhase('ready');
        notify('已替换插件数据并进入可用状态。', 'ok');
        return true;
      } catch (error) {
        if (!alive) return false;
        enterRecovery(error, { uncertain: !!(error && error.uncertain) });
        notify(describeError(error), 'error');
        return false;
      }
    }
    function bindRecoveryActions() {
      on($('#btnRecoveryRetry'), 'click', () => { retryInit().catch(reportAsyncError); });
      on($('#btnRecoveryExport'), 'click', () => { exportRawRecovery().catch(reportAsyncError); });
      on($('#btnRecoveryImport'), 'click', () => { const f = $('#fileRecoveryImport'); if (f) f.click(); });
      on($('#fileRecoveryImport'), 'change', event => {
        const file = event.target.files && event.target.files[0];
        const token = ++tokens.import;
        const done = () => { event.target.value = ''; };
        if (!file) { done(); return; }
        readFileText(file, token).then(text => {
          if (!alive || token !== tokens.import) return;
          let parsed;
          try { parsed = JSON.parse(text); } catch (error) { notify('导入失败：不是合法 JSON。', 'error'); return; }
          let candidate;
          try { candidate = BufferData.prepare(parsed).db; } catch (error) { notify('导入失败：' + errText(error), 'error'); return; }
          const capacity = BufferData.checkCapacity(candidate);
          if (!capacity.ok) { notify(`导入失败：数据容量 ${capacity.length} 字符，超过上限 ${capacity.limit} 字符。`, 'error'); return; }
          replaceFromRecovery(candidate, '确认用该 JSON 覆盖当前存储', '原存储内容将被整体替换，此操作不可撤销。确认后进入可用状态。').catch(reportAsyncError);
        }).catch(error => {
          if (alive && token === tokens.import) notify('读取文件失败：' + errText(error), 'error');
        }).finally(done);
      });
      on($('#btnRecoveryReset'), 'click', () => {
        let candidate;
        try { candidate = BufferData.prepare(null).db; } catch (error) { notify('恢复默认失败：' + errText(error), 'error'); return; }
        replaceFromRecovery(candidate, '确认恢复出厂默认并覆盖存储', '你的全部自定义修改与原存储内容将被替换，此操作不可撤销。').catch(reportAsyncError);
      });
    }

    /* ---------- 初始化 ---------- */
    function init(env) {
      if (disposed) return Promise.reject(new Error('实例已关闭'));
      if (initPromise) return initPromise;   // 重复调用复用同一 Promise
      initPromise = (async () => {
        if (env && env.theme) setTheme(env.theme);
        setPhase('loading', '正在读取插件数据…');
        try {
          const result = await store.init();
          if (disposed) return { status: 'disposed' };
          DB = store.snapshot();
          renderDbWarnings(result.warnings);
          refreshAll();
          setPhase('ready');
          return result;
        } catch (error) {
          // 可恢复的读库/迁移/写入错误必须在 init 内部捕获并显示恢复界面，
          // 否则宿主会在 activate 回调拒绝时停掉插件、恢复界面随之消失。
          if (!disposed) {
            enterRecovery(error, { uncertain: !!(error && error.uncertain) });
            notify(describeError(error), 'error');
          }
          return { status: 'recovery', code: error && error.code };
        }
      })();
      return initPromise;
    }

    function dispose() {
      if (disposed) return;
      alive = false;
      disposed = true;
      tokens.recipe++; tokens.neut++; tokens.import++;
      if (modal) closeModal(null);
      try { NeutralChart.dispose($('#neutPlot')); } catch (error) { /* 图表已卸载 */ }
      // 事件监听随 root 内节点移除而失效；这里显式清空引用并复原界面状态
      if (root) {
        root.dataset.phase = 'disposed';
        const business = $('#businessRoot');
        const gate = $('#gateRoot');
        if (business) business.hidden = true;
        if (gate) gate.hidden = true;
      }
      DB = null;
    }

    return {
      init, showView, setTheme, dispose,
      get state() { return disposed ? 'disposed' : (root ? root.dataset.phase : 'created'); },
      get activeView() { return activeTab; },
      get theme() { return theme; },
      // 供 plugin-entry 绑定根节点；必须在 init 之前调用一次
      attach(node) {
        root = node;
        root.setAttribute('data-theme', theme);
        root.dataset.phase = 'loading';
        const gate = $('#gateRoot');
        if (gate) gate.hidden = false;
        const business = $('#businessRoot');
        if (business) business.hidden = true;
        bindShell();
        bindRecoveryActions();
        return root;
      },
    };
  }

  const BufferApp = { create };
  global.BufferApp = BufferApp;
  if (typeof module !== 'undefined' && module.exports) module.exports = BufferApp;
})(typeof window !== 'undefined' ? window : globalThis);
