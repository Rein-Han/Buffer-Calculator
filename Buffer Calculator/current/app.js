/* app.js — 界面逻辑（依赖 engine.js 的 Engine 与 db.js 的 DefaultDB） */
(function () {
  'use strict';
  const LS_KEY = 'bufferCalcDB_v1';
  const $ = s => document.querySelector(s);
  const $$ = s => Array.from(document.querySelectorAll(s));

  /* ---------- 数据持久化与迁移 ---------- */
  function canon(o) { // 键排序的稳定序列化，用于迁移比对
    if (Array.isArray(o)) return '[' + o.map(canon).join(',') + ']';
    if (o && typeof o === 'object') return '{' + Object.keys(o).sort().map(k => JSON.stringify(k) + ':' + canon(o[k])).join(',') + '}';
    return JSON.stringify(o);
  }
  function loadDB() {
    let d = null;
    try {
      const raw = localStorage.getItem(LS_KEY);
      if (raw) {
        const p = JSON.parse(raw);
        if (p && Array.isArray(p.stocks) && Array.isArray(p.systems)) d = p;
      }
    } catch (e) { /* 忽略损坏数据 */ }
    if (!d) return JSON.parse(JSON.stringify({ stocks: DefaultDB.stocks, systems: DefaultDB.systems }));
    // 迁移1：出厂新增条目按 id 并入；带更高 rev 的默认条目覆盖旧版
    let changed = false;
    const deletedStocks = new Set(d.deletedDefaults?.stocks || []);
    const deletedSystems = new Set(d.deletedDefaults?.systems || []);
    for (const s of DefaultDB.stocks) {
      if (deletedStocks.has(s.id)) continue;
      const i = d.stocks.findIndex(x => x.id === s.id);
      if (i < 0) { d.stocks.push(JSON.parse(JSON.stringify(s))); changed = true; }
      else if ((s.rev || 0) > (d.stocks[i].rev || 0)) {
        if(s.id==='pbs10x' && s.rev===4) {
          const old=JSON.parse(JSON.stringify(s)); old.rev=3; old.premix.saltIons[0].concM=1.549;
          if(canon(d.stocks[i])!==canon(old)) continue; // preserve custom PBS composition
        }
        d.stocks[i] = JSON.parse(JSON.stringify(s)); changed = true;
      }
    }
    for (const s of DefaultDB.systems) {
      if (deletedSystems.has(s.id)) continue;
      const i = d.systems.findIndex(x => x.id === s.id);
      if (i < 0) { d.systems.push(JSON.parse(JSON.stringify(s))); changed = true; }
      else if ((s.rev || 0) > (d.systems[i].rev || 0)) { d.systems[i] = JSON.parse(JSON.stringify(s)); changed = true; }
    }
    const oldHis={id:'histidine',name:'His',enabled:true,range:[5,7],steps:[{pKa:6,zA:1,zB:0}],stocks:[{stockId:'his_hcl',dStock:0},{stockId:'his',dStock:1}]};
    const hi=d.systems.findIndex(s=>s.id==='histidine');
    if(hi>=0 && canon(d.systems[hi])===canon(oldHis)) { d.systems[hi]=JSON.parse(JSON.stringify(DefaultDB.systems.find(s=>s.id==='histidine'))); changed=true; }
    // 迁移2：已废弃的默认体系，若用户从未修改过则自动移除
    for (const ob of (DefaultDB.obsoleteSystems || [])) {
      const i = d.systems.findIndex(x => x.id === ob.id);
      if (i >= 0 && canon(d.systems[i]) === canon(ob.match)) {
        d.systems.splice(i, 1); changed = true;
      }
    }
    // 迁移3：显示名英文化（一次性执行，之后用户在管理页自改的名字不再覆盖）
    if ((d.renameRev || 0) < (DefaultDB.renameRev || 0) && DefaultDB.renameMap) {
      for (const id of Object.keys(DefaultDB.renameMap.stocks || {})) {
        const s = d.stocks.find(x => x.id === id);
        if (s) { s.name = DefaultDB.renameMap.stocks[id]; changed = true; }
      }
      for (const id of Object.keys(DefaultDB.renameMap.systems || {})) {
        const s = d.systems.find(x => x.id === id);
        if (s) { s.name = DefaultDB.renameMap.systems[id]; changed = true; }
      }
      d.renameRev = DefaultDB.renameRev;
    }
    if (changed) localStorage.setItem(LS_KEY, JSON.stringify(d));
    return d;
  }
  function markDeletedDefault(kind, id) {
    if (!DefaultDB[kind].some(x => x.id === id)) return;
    DB.deletedDefaults = DB.deletedDefaults || {};
    const ids = new Set(DB.deletedDefaults[kind] || []);
    ids.add(id);
    DB.deletedDefaults[kind] = Array.from(ids);
  }
  function saveDB() { localStorage.setItem(LS_KEY, JSON.stringify(DB)); }
  let DB = loadDB();

  function stockById(id) { return DB.stocks.find(s => s.id === id); }
  // 供引擎使用的水合体系：stocks 换成完整母液对象
  function hydrate(sysDef) {
    const s = JSON.parse(JSON.stringify(sysDef));
    s.stocks = (s.stocks || []).map(x => {
      const st = stockById(x.stockId);
      return st ? Object.assign({}, st, { dStock: x.dStock }) : null;
    }).filter(Boolean);
    return s;
  }
  // 添加剂（Arg/咪唑等）的单步平衡体系，pKa 取自母液
  function systemFromStock(st) {
    if(st.id==='arg' || st.id==='arg_hcl') return {...DefaultDB.argSystem,id:'ad_'+st.id,steps:DefaultDB.argSystem.steps.map((s,i)=>({...s,pKa:i===1 ? (st.pka ?? s.pKa) : s.pKa}))};
    return { id: 'ad_' + st.id, name: st.name, steps: [{ pKa: st.pka != null ? st.pka : 9.04, zA: 1, zB: 0 }] };
  }

  /* ---------- 中和试剂的酸/碱方向 ---------- */
  // 无 pKa 字段的酸性母液必须映射到它所属的缓冲体系；否则会退化成 systemFromStock 的
  // 单步碱式假设（默认 pKa 9.04），把加酸算成加碱。
  const ACID_TITRANT_SYSTEM = { hac: 'acetate', ca: 'citrate', h3po4: 'pb', nah2po4: 'pb' };
  const ACID_TITRANT_ORDER = ['hac', 'ca', 'h3po4', 'nah2po4'];
  // 酸性候选 = 显式映射的四种（HAc/CA/H3PO4/NaH2PO4，其中 HAc 与 CA 无 pKa 字段），
  // 外加母液库中明确带酸性 pKa 的条目。
  function isAcidTitrantStock(st) {
    return ACID_TITRANT_SYSTEM[st.id] != null || (st.pka != null && st.pka < 7);
  }
  // 酸性试剂：优先按显式映射取所属缓冲对，其次看该母液是否已是某个缓冲体系的酸式一端。
  function acidTitrantSystemOf(st) {
    const sysId = ACID_TITRANT_SYSTEM[st.id];
    if (sysId) {
      const def = DB.systems.find(s => s.id === sysId);
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
    return {
      system: asAcid ? acidTitrantSystemOf(st) : systemFromStock(st),
      concM: st.concM, reagentPH: st.refpH, name: st.name,
    };
  }
  function neutralizationTitrantOptions() {
    const acids = DB.stocks.filter(isAcidTitrantStock)
      .sort((a, b) => {
        const ia = ACID_TITRANT_ORDER.indexOf(a.id), ib = ACID_TITRANT_ORDER.indexOf(b.id);
        return (ia < 0 ? 99 : ia) - (ib < 0 ? 99 : ib);
      });
    // 碱性候选：带 pKa、未被标记 noTitrant、且试剂 pH 不低于 7（咪唑已由 noTitrant 排除）
    const bases = DB.stocks.filter(s => s.pka != null && !s.noTitrant && !isAcidTitrantStock(s));
    const opt = s => `<option value="${s.id}">${esc(s.name)}（${s.concM} M，pKa ${s.pka}）</option>`;
    return (acids.length ? `<optgroup label="酸性试剂（用于降低 pH）">${acids.map(opt).join('')}</optgroup>` : '')
         + (bases.length ? `<optgroup label="碱性试剂（用于升高 pH）">${bases.map(opt).join('')}</optgroup>` : '');
  }
  const uid = () => 'x' + Math.random().toString(36).slice(2, 9);

  /* ---------- 实测 pH 记录（累积后用于阶段性回归校准） ----------
   * 记录粒度按 D-007：只由「缓冲体系 + 浓度 + 添加剂 + 目标pH」构成的键分组，
   * 一条记录只代表它自己那个组合。仅存稳定标识，不存会随 UI 变的展示字段。
   * 数据随既有导出/导入 JSON 一起走，不额外维护第二份持久化。 */
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
  function calibAll() {
    if (!Array.isArray(DB.calibration)) DB.calibration = [];
    return DB.calibration;
  }
  function calibrationFor(key) { return calibAll().filter(x => x.key === key); }
  function addCalibrationRecord(rec) { calibAll().push(rec); saveDB(); return rec; }
  function deleteCalibrationRecord(id) {
    const a = calibAll(), i = a.findIndex(x => x.id === id);
    if (i >= 0) { a.splice(i, 1); saveDB(); }
  }
  function calibrationTSV(rows, withText) {
    const head = ['记录时间', '目标pH', '实测pH', '偏差(实测-目标)', '温度C', '卡片名称', '模型'];
    return rows.map((x, i) => {
      const body = [x.at, x.targetPH, x.measuredPH, (x.measuredPH - x.targetPH).toFixed(3), x.tempC ?? '', x.label, x.model].join('\t');
      return (i === 0 ? head.join('\t') + '\n' : '') + body + (withText ? '\n' + x.text : '');
    }).join('\n');
  }
  function downloadText(filename, text) {
    const blob = new Blob([text], { type: 'text/plain;charset=utf-8' });
    const a = document.createElement('a');
    a.href = URL.createObjectURL(blob);
    a.download = filename;
    a.click();
    URL.revokeObjectURL(a.href);
  }

  /* ---------- 通用小工具 ---------- */
  function fmtVol(volL) {
    if (volL == null) return '—';
    const mL = volL * 1000;
    if (mL >= 1000) return (mL / 1000).toFixed(2) + ' L';
    if (mL >= 1) return mL.toFixed(2) + ' mL';
    return (mL * 1000).toFixed(1) + ' µL';
  }
  // 配方定容水始终使用 mL，避免大体积时换算为 L 后丢失两位小数之外的有效体积信息。
  function fmtWaterVol(volL) {
    return volL == null ? '—' : (volL * 1000).toFixed(2) + ' mL';
  }
  function esc(s) { return String(s == null ? '' : s).replace(/[&<>"]/g, c => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;' }[c])); }
  function num(id) { const v = parseFloat($(id).value); return isNaN(v) ? null : v; }

  /* ---------- 标签页切换 ---------- */
  $$('nav.tabs button').forEach(b => b.addEventListener('click', () => {
    $$('nav.tabs button').forEach(x => x.classList.toggle('active', x === b));
    $$('.tabpage').forEach(p => p.classList.toggle('active', p.id === b.dataset.tab));
  }));

  /* ============================================================
   * 通用选择器（配制页与中和页 A/B 共用）
   * ============================================================ */
  const ADDITIVE_DEFS = [
    { key: 'nacl',     label: 'NaCl',         unit: 'mM',    kind: 'salt',     stockId: 'nacl',     def: 150 },
    { key: 'arghcl',   label: 'Arg-HCl',      unit: 'mM',    kind: 'protSalt', stockId: 'arg_hcl',  def: 0 },
    { key: 'arg',      label: 'Arg',            unit: 'mM',    kind: 'protBase', stockId: 'arg',      def: 0, note: '默认不参与，特殊需求时启用' },
    { key: 'gdnhcl',   label: 'GdnHCl 盐酸胍', unit: 'mM',   kind: 'salt',     stockId: 'gdnhcl',   def: 0 },
    { key: 'imidazole',label: '咪唑',         unit: 'mM',    kind: 'protBase', stockId: 'imidazole',def: 0 },
    { key: 'suc',      label: '蔗糖',         unit: '% w/v', kind: 'neutral',  stockId: 'suc',      def: 0 },
  ];

  function renderSysPicker(box, prefix) {
    box.innerHTML = '';
    DB.systems.filter(s => s.enabled).forEach(s => {
      const isPm = !!s.premix;
      const meta = isPm
        ? '预混母液（PB + NaCl + KCl），按倍数使用'
        : s.steps.map(x => 'pKa ' + x.pKa).join(' / ') + (s.range ? ` · 建议 ${s.range[0]}–${s.range[1]}` : '');
      const unit = isPm ? '×' : 'mM';
      const div = document.createElement('div');
      div.className = 'sysrow';
      div.innerHTML = `<label><input type="checkbox" class="${prefix}SysChk" data-id="${s.id}"> <b>${esc(s.name)}</b></label>
        <span class="nm muted">${esc(meta)}</span>
        <input type="number" class="${prefix}SysConc" data-id="${s.id}" min="0" step="${isPm ? '0.1' : '1'}" placeholder="浓度" disabled>
        <span class="muted">${unit}</span>`;
      box.appendChild(div);
    });
    box.querySelectorAll(`.${prefix}SysChk`).forEach(chk => chk.addEventListener('change', () => {
      const def = DB.systems.find(s => s.id === chk.dataset.id);
      const inp = box.querySelector(`.${prefix}SysConc[data-id="${chk.dataset.id}"]`);
      inp.disabled = !chk.checked;
      if (chk.checked && !inp.value) inp.value = def && def.premix ? 1 : 20;
    }));
  }

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
        <span class="nm muted">母液 ${concLabel}${a.note ? ' · ' + esc(a.note) : ''}</span>
        <input type="number" class="${prefix}AddConc" data-key="${a.key}" min="0" step="1" disabled>
        <span class="muted">${a.unit}</span>`;
      box.appendChild(div);
    });
    box.querySelectorAll(`.${prefix}AddChk`).forEach(chk => chk.addEventListener('change', () => {
      const inp = box.querySelector(`.${prefix}AddConc[data-key="${chk.dataset.key}"]`);
      inp.disabled = !chk.checked;
      if (chk.checked && !inp.value) {
        const def = ADDITIVE_DEFS.find(x => x.key === chk.dataset.key).def;
        inp.value = def || 10;
      }
    }));
  }

  // 收集勾选的缓冲体系；返回 {buffers:[{system,concM}], premixes:[{pm,sysDef,fold}]}
  function collectSystems(prefix) {
    const buffers = [], premixes = [];
    $$(`.${prefix}SysChk`).forEach(chk => {
      if (!chk.checked) return;
      const v = parseFloat($(`.${prefix}SysConc[data-id="${chk.dataset.id}"]`).value);
      if (!(v > 0)) throw new Error('请为勾选的缓冲体系填写浓度/倍数');
      const def = DB.systems.find(s => s.id === chk.dataset.id);
      if (def.premix) {
        const st = stockById(def.stockId);
        const sysDef = DB.systems.find(s => s.id === st.premix.sysId);
        if (!sysDef) throw new Error('预混母液引用的缓冲体系不存在');
        premixes.push({ pm: st.premix, sysDef, stock: st, fold: v });
      } else {
        buffers.push({ system: hydrate(def), concM: v / 1000 });
      }
    });
    return { buffers, premixes };
  }

  // 收集勾选的添加剂 → 引擎 additive 数组（V_L = 目标体积 L；中和页传 null 表示不展开体积相关项）
  function collectAdditives(prefix, V_L) {
    const additives = [];
    $$(`.${prefix}AddChk`).forEach(chk => {
      if (!chk.checked) return;
      const key = chk.dataset.key;
      const v = parseFloat($(`.${prefix}AddConc[data-key="${key}"]`).value);
      if (!(v > 0)) throw new Error('请为勾选的添加剂填写浓度');
      const def = ADDITIVE_DEFS.find(x => x.key === key);
      const st = stockById(def.stockId);
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
    const r = document.querySelector('input[name=model]:checked');
    return r ? r.value : 'edh';
  }

  /* ============================================================
   * 标签页①：缓冲液配制（A/B 两组配方，B 组不勾体系则只算 A）
   * ============================================================ */
  const lastCopy = { A: '', B: '' };
  const lastName = { A: '', B: '' };

  function recipeName(buffers, premixes, additives, pH, volumeL) {
    const fmt = n => String(Number(n.toFixed(6)));
    const parts = buffers.map(b => `${fmt(b.concM * 1000)}mM ${b.system.name}`);
    // Preserve the actual concentration units for premixes and mass-percent additives.
    for (const px of premixes) parts.push(`${fmt(px.fold)}× ${px.stock.id === 'pbs10x' ? 'PBS' : px.stock.name}`);
    for (const ad of additives) {
      if (ad.kind === 'premix') continue;
      if (ad.kind === 'neutral') {
        const label = ADDITIVE_DEFS.find(d => d.stockId === ad.stock.id)?.label || ad.stock.name;
        parts.push(`${fmt(ad.stock.pct * ad.volL / volumeL)}% ${label}`);
      } else parts.push(`${fmt(ad.concM * 1000)}mM ${ad.stock.name}`);
    }
    // Keep at least one decimal without changing a more precise target such as 7.45.
    const phText = Number.isInteger(pH) ? pH.toFixed(1) : String(pH);
    return parts.concat(`pH${phText}`).join(', ');
  }

  // 计算单侧配方，返回 {html, copyText}
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

    // 渲染
    const totalConc = buffers.reduce((s, b) => s + b.concM, 0) * 1000
      + premixes.reduce((s, px) => s + px.pm.concM * px.fold / 10 * 1000, 0);
    const side = label.slice(-1); // 'A' / 'B'
    const nameText = recipeName(buffers, premixes, additives, pH, V_L);
    let html = `<div class="card rcard"><div class="rcard-hd"><h3>${label} · 配方结果</h3><span class="nm" data-buffer-name="${side}">${esc(nameText)}</span><span class="hd-act noprint"><button class="ghost small" data-copy="${side}">复制配方</button><button class="ghost small" data-copy_name="${side}">复制名称</button></span></div>`
      + `<div class="sec-t">母液吸取体积</div><table class="res"><tr><th>母液 / 试剂</th><th>吸取体积</th><th>备注</th></tr>`;
    const titrantLines = r.lines.filter(l => l.kind === 'titrant');
    // 输出顺序：缓冲对母液 → 预混缓冲液（PBS）→ 添加剂 → （虚拟滴定剂）→ 水
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
      } else {
        titrantBlocked = true;
      }
    }
    // Engine always computes the amount needed to hit target pH. When the user disables
    // acid/base adjustment, omit that physical volume everywhere and return it to water.
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
    if (warns.length) {
      html += '<div class="warnbox" style="margin-top:8px">' + warns.map(w => '⚠ ' + esc(w)).join('<br>') + '</div>';
    }
    // 配方文本先行构造：记录窗口的文本框与「复制配方」必须逐字一致。
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
        <button class="primary" data-calib-save="${side}">记录实测值</button>
        <button class="ghost" data-calib-export="${side}">导出本卡片记录</button>
      </div>
      ${devTxt}
      <div data-calib-history="${side}"></div>
    </div></div>`;
    return { html, copyText, nameText };
  }

  let recipeStarted = false;
  function computeRecipe() {
    recipeStarted = true;
    const zone = $('#resultZone');
    lastCopy.A = ''; lastCopy.B = '';
    lastName.A = ''; lastName.B = '';
    try {
      const a = computeOne('t1A', '#pHA', '#volA', 'Buffer A');
      lastCopy.A = a.copyText;
      lastName.A = a.nameText;
      const parts = [a.html];
      // B 组：勾选了任意体系才计算，否则只出 A
      if ($$('.t1BSysChk').some(c => c.checked)) {
        const b = computeOne('t1B', '#pHB', '#volB', 'Buffer B');
        lastCopy.B = b.copyText;
        lastName.B = b.nameText;
        parts.push(b.html);
      }
      zone.innerHTML = parts.length > 1 ? `<div class="result-grid two">${parts.join('')}</div>` : parts.join('');
      renderCalibHistories();
    } catch (e) {
      zone.innerHTML = `<div class="errbox">✕ ${esc(e.message)}</div>`;
    }
  }

  /* ============================================================
   * 标签页②：洗脱中和
   * ============================================================ */
  const VOL_MIN = 0.5, VOL_MAX = 10000;
  const volFromSlider = t => Math.pow(10, Math.log10(VOL_MIN) + (t / 1000) * (Math.log10(VOL_MAX) - Math.log10(VOL_MIN)));
  const sliderFromVol = v => 1000 * (Math.log10(v) - Math.log10(VOL_MIN)) / (Math.log10(VOL_MAX) - Math.log10(VOL_MIN));
  function roundSig(v, sig) {
    if (v <= 0) return 0;
    const d = Math.pow(10, Math.floor(Math.log10(v)) - (sig - 1));
    return Math.round(v / d) * d;
  }
  function bindSlider(sliderSel, numSel, opts) {
    const sl = $(sliderSel), nm = $(numSel);
    sl.addEventListener('input', () => {
      let v = parseFloat(sl.value);
      if (opts.log) v = roundSig(volFromSlider(v), 3);
      nm.value = opts.log ? v : parseFloat(v.toFixed(opts.dec != null ? opts.dec : 2));
    });
    nm.addEventListener('input', () => {
      let v = parseFloat(nm.value);
      if (isNaN(v)) return;
      v = Math.min(opts.max, Math.max(opts.min, v));
      sl.value = opts.log ? sliderFromVol(v) : v;
    });
  }

  function renderNeutSelectors() {
    renderSysPicker($('#nSysPickA'), 'nA');
    renderSysPicker($('#nSysPickB'), 'nB');
    renderAddPicker($('#nAddPickA'), 'nA', true);
    renderAddPicker($('#nAddPickB'), 'nB', true);
    // 中和试剂：酸/碱两组。酸性候选含无 pKa 字段的 HAc/CA/H3PO4/NaH2PO4，
    // 通过 ACID_TITRANT_SYSTEM 映射到所属缓冲对。
    $('#nTitrant').innerHTML = neutralizationTitrantOptions();
    const arg = DB.stocks.find(s => s.id === 'arg' && s.pka != null);
    if (arg) $('#nTitrant').value = 'arg';
  }

  // 收集中和页一侧（A 或 B）的组成：{components:[{system,concM}], pH, saltI}
  function collectSide(prefix) {
    const { buffers, premixes } = collectSystems(prefix);
    const components = buffers.map(b => ({ system: b.system, concM: b.concM }));
    let saltI = 0;
    for (const px of premixes) {
      const f = px.fold / 10;
      components.push({ system: hydrate(px.sysDef), concM: px.pm.concM * f });
      // Only neutral salt pairs here; phosphate counterions are inferred by the engine.
      const cat=px.pm.saltIons.reduce((s,i)=>s+Math.max(0,i.z)*i.concM,0);
      const an=px.pm.saltIons.reduce((s,i)=>s+Math.max(0,-i.z)*i.concM,0);
      saltI += Math.min(cat,an) * f;
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

  // 解析中和试剂：现有母液 或 自定义（缓冲对 + 浓度 + 试剂 pH）
  function resolveTitrant() {
    const src = (document.querySelector('input[name=titrantSrc]:checked') || {}).value || 'stock';
    if (src === 'custom') {
      const sid = $('#nCtSys').value;
      const sysDef = sid === 'arg_sys' ? DefaultDB.argSystem : DB.systems.find(s => s.id === sid);
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

  let neutRun=0,neutStarted=false;
  function setNeutBusy(on){
    const b=$('#btnNeut'); if(!b)return;
    if(on){ b.dataset.origText=b.textContent; b.disabled=true; b.textContent='计算中…'; }
    else { b.disabled=false; if(b.dataset.origText)b.textContent=b.dataset.origText; }
  }
  async function computeNeutralization() {
    const run=++neutRun; neutStarted=true;
    setNeutBusy(true);
    const pane = $('#neutZone');
    try {
      const bufA = collectSide('nA');
      const bufB = collectSide('nB');
      const lower=num('#numFracBLo'),upper=num('#numFracB');
      if(lower==null || upper==null || lower<0 || upper>100 || lower>upper) throw new Error('Buffer B范围需满足0 ≤ 下限 ≤ 上限 ≤ 100');
      const fracB=(lower+upper)/200;
      const pHt = num('#numPH'), volML = num('#numVol');
      if (pHt == null || pHt<0 || pHt>14) throw new Error('目标 pH 无效');
      if (!(volML > 0)) throw new Error('样品体积无效');
      const { titrant, label: tName } = resolveTitrant();
      const tReagentPH = titrant.reagentPH;
      const mdl = (document.querySelector('input[name=model2]:checked') || {}).value || 'edh';

      const tol=num('#nTol');
      if(tol==null || tol<0 || pHt-tol<0 || pHt+tol>14) throw new Error('pH容差无效');
      const input={bufA,bufB,fracB,targetPH:pHt,sampleVolL:volML/1000,titrant,model:mdl,tolerancePH:tol};
      pane.innerHTML='<div class="card" role="status">正在计算所选B%范围…</div>';
      await new Promise(requestAnimationFrame);
      const points=[],steps=lower===upper?0:Math.ceil((upper-lower)/.5);
      for(let j=0;j<=steps;j++) {
        if(run!==neutRun)return;
        const b=steps?lower+(upper-lower)*j/steps:lower;
        points.push({b,r:Engine.calcNeutralization({...input,fracB:b/100})});
        if(j%8===0)await new Promise(requestAnimationFrame);
      }
      if(run!==neutRun)return;
      const r=Engine.calcNeutralization(input);
      const dirText = r.direction === 'acid' ? '加酸' : (r.direction === 'base' ? '加碱' : '方向未定');
      const dirNote = r.direction ? `<span class="stat">滴定方向：<b>${dirText}</b></span>` : '';
      const unreachable = r.reachable
        ? `<div class="errbox">目标 pH <b>${pHt}</b> 用 <b>${esc(tName)}</b> 无法达到：当前条件可达到的 pH 为 <b>${r.reachable.nearest.toFixed(2)}</b>。可达范围 ${r.reachable.lo.toFixed(2)}–${r.reachable.hi.toFixed(2)}（混合后 pH ${r.mixPH.toFixed(2)}${tReagentPH != null ? `，试剂自身 pH ${Number(tReagentPH).toFixed(2)}` : ''}）。${r.reachable.reason === 'wrongDirection' ? '该目标需要相反方向的试剂。' : '该目标超出试剂可达极限。'}</div>`
        : '';
      const good=points.filter(p=>Number.isFinite(p.r.volL.mid)&&p.r.volL.mid>=0);
      let html='<div class="card"><h3>所选B%范围 · 中和试剂用量</h3>';
      html += dirNote ? `<div style="margin-bottom:6px">${dirNote}</div>` : '';
      html += unreachable;
      if(good.length) {
        const min=good.reduce((a,b)=>a.r.volL.mid<b.r.volL.mid?a:b),max=good.reduce((a,b)=>a.r.volL.mid>b.r.volL.mid?a:b);
        html+=`<div class="big-result" id="neutRangeResult">${esc(tName)}：${fmtVol(min.r.volL.mid)} – ${fmtVol(max.r.volL.mid)}</div>
        <div>Buffer B <b>${lower}%–${upper}%</b> · 样品 ${volML} mL · 目标pH ${pHt}</div>
        <div class="muted">最小值位于B ${min.b.toFixed(2)}%；最大值位于B ${max.b.toFixed(2)}%。按≤0.5个百分点采样估计极值，共${points.length}点；不是pH容差范围。</div>`;
      } else html+='<div class="errbox">所选范围内没有可用的加碱中和剂量：可能需加酸、试剂能力不足或模型未收敛。</div>';
      if(good.length<points.length)html+=`<div class="warnbox">${points.length-good.length}/${points.length}个采样点无法用当前试剂达到目标；曲线留空，体积范围仅统计可行点。</div>`;
      html+='</div><div class="neut-detail-row"><div class="card"><h3>中和滴定 pH 热力图</h3><div id="neutPlot"></div><div class="muted">颜色越深表示预计pH越高；橙线为目标pH剂量，虚线为目标pH±容差。十字光标可在图内自由取点；预计pH是模型值，实际操作需实测确认。</div></div>';
      html += `<div class="card"><h3>区间中点 B ${((lower+upper)/2).toFixed(2)}% · 过程信息</h3><div class="statgrid">
        <span class="stat">中和前 pH：<b>${r.mixPH.toFixed(2)}</b></span>
        ${r.conductivityBefore != null ? `<span class="stat">中和前估算电导率：<b>${r.conductivityBefore.toFixed(1)} mS/cm</b></span>` : ''}
        <span class="stat">净质子需求：<b>${(r.needMol.mid * 1000).toFixed(3)} mmol</b></span>
        <span class="stat">试剂有效中和比例：<b>${(r.effFrac.mid * 100).toFixed(1)}%</b></span>
        ${Number.isFinite(r.titrantCapacityM?.mid) ? `<span class="stat">试剂有效当量浓度：<b>${r.titrantCapacityM.mid.toFixed(3)} mol H⁺/L</b></span>` : ''}
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
      NeutralChart.render($('#neutPlot'),points,{...input,__dir:r.direction},lower,upper);
    } catch (e) {
      if(run!==neutRun)return;
      pane.innerHTML = `<div class="errbox">✕ ${esc(e.message)}</div>`;
    } finally {
      if(run===neutRun)setNeutBusy(false);
    }
  }

  /* ============================================================
   * 标签页③：管理
   * ============================================================ */
  const TYPE_NAMES = { acid: '酸式', base: '碱式', salt: '盐', neutral: '非离子', titrant: '中和试剂', premix: '预混液' };

  function renderStockTable() {
    const t = $('#stockTable');
    let html = '<tr><th>名称</th><th>浓度</th><th>类型</th><th>pKa</th><th>参考pH</th><th>Na⁺</th><th>Cl⁻</th><th></th></tr>';
    DB.stocks.forEach(s => {
      html += `<tr><td><b>${esc(s.name)}</b></td>
        <td>${s.concM != null ? s.concM + ' M' : (s.pct != null ? s.pct + '% w/v' : (s.premix ? '预混配方' : '—'))}</td>
        <td>${TYPE_NAMES[s.type] || esc(s.type)}</td>
        <td>${s.pka != null ? s.pka : '—'}</td>
        <td>${s.refpH != null ? s.refpH : '—'}</td>
        <td>${s.na || 0}</td><td>${s.cl || 0}</td>
        <td class="noprint"><button class="ghost small" data-edit-stock="${s.id}">编辑</button>
        <button class="ghost small danger" data-del-stock="${s.id}">删除</button></td></tr>`;
    });
    t.innerHTML = html;
  }

  function renderSysTable() {
    const t = $('#sysTable');
    let html = '<tr><th>启用</th><th>名称</th><th>pKa</th><th>母液（d 值）</th><th>建议范围</th><th></th></tr>';
    DB.systems.forEach(s => {
      const isPm = !!s.premix;
      const pkaCell = isPm ? '<span class="muted">预混</span>' : s.steps.map(x => `${x.pKa}(${x.zA}→${x.zB})`).join(', ');
      const stockCell = isPm
        ? esc((stockById(s.stockId) || {}).name || s.stockId)
        : ((s.stocks || []).map(x => { const st = stockById(x.stockId); return st ? esc(st.name) + '(d=' + x.dStock + ')' : '?'; }).join('、') || '—');
      html += `<tr><td><input type="checkbox" data-toggle-sys="${s.id}" ${s.enabled ? 'checked' : ''}></td>
        <td><b>${esc(s.name)}</b></td>
        <td>${pkaCell}</td>
        <td>${stockCell}</td>
        <td class="muted">${s.range ? s.range[0] + '–' + s.range[1] : '—'}${s.range2 ? '；' + s.range2[0] + '–' + s.range2[1] : ''}</td>
        <td class="noprint">${isPm ? '' : `<button class="ghost small" data-edit-sys="${s.id}">编辑</button>`}
        <button class="ghost small danger" data-del-sys="${s.id}">删除</button></td></tr>`;
    });
    t.innerHTML = html;
    t.querySelectorAll('[data-toggle-sys]').forEach(chk => chk.addEventListener('change', () => {
      const s = DB.systems.find(x => x.id === chk.dataset.toggleSys);
      if (s) { s.enabled = chk.checked; saveDB(); refreshAll(); }
    }));
  }

  /* ---------- 模态框 ---------- */
  function openModal(html) { $('#modalBox').innerHTML = html; $('#overlay').classList.add('show'); }
  function closeModal() { $('#overlay').classList.remove('show'); $('#modalBox').innerHTML = ''; }
  $('#overlay').addEventListener('click', e => { if (e.target.id === 'overlay') closeModal(); });

  function stockForm(s) {
    const isNew = !s;
    s = s || { id: uid(), name: '', concM: 0.2, refpH: null, na: 0, cl: 0, type: 'base', pka: null, pct: null };
    openModal(`<h3>${isNew ? '新增' : '编辑'}母液</h3>
      <div class="row"><label>名称</label><input type="text" id="f_name" class="wide" value="${esc(s.name)}"></div>
      <div class="row"><label>类型</label><select id="f_type">${Object.keys(TYPE_NAMES).map(k => `<option value="${k}" ${s.type === k ? 'selected' : ''}>${TYPE_NAMES[k]}</option>`).join('')}</select>
      <span class="muted">非离子类（蔗糖）请用下方 % 字段；预混液为特殊类型，组成改动请联系维护</span></div>
      <div class="row"><label>浓度 (M)</label><input type="number" id="f_conc" step="any" value="${s.concM != null ? s.concM : ''}">
      <label>或 % w/v</label><input type="number" id="f_pct" step="any" value="${s.pct != null ? s.pct : ''}" style="width:70px"></div>
      <div class="row"><label>参考 pH</label><input type="number" id="f_refpH" step="0.01" value="${s.refpH != null ? s.refpH : ''}">
      <label>pKa（作中和试剂/质子性添加剂时必填）</label><input type="number" id="f_pka" step="0.01" value="${s.pka != null ? s.pka : ''}" style="width:70px"></div>
      <div class="row"><label>Na⁺ 数/分子</label><input type="number" id="f_na" step="1" min="0" value="${s.na || 0}" style="width:60px">
      <label>Cl⁻ 数/分子</label><input type="number" id="f_cl" step="1" min="0" value="${s.cl || 0}" style="width:60px"></div>
      <div class="row" style="margin-top:12px"><button class="primary" id="f_save">保存</button>
      <button class="ghost" id="f_cancel">取消</button></div>`);
    $('#f_cancel').addEventListener('click', closeModal);
    $('#f_save').addEventListener('click', () => {
      const name = $('#f_name').value.trim();
      if (!name) { alert('请填写名称'); return; }
      const conc = parseFloat($('#f_conc').value), pct = parseFloat($('#f_pct').value);
      s.name = name;
      s.type = $('#f_type').value;
      s.concM = isNaN(conc) ? null : conc;
      s.pct = isNaN(pct) ? null : pct;
      s.refpH = parseFloat($('#f_refpH').value); if (isNaN(s.refpH)) s.refpH = null;
      s.pka = parseFloat($('#f_pka').value); if (isNaN(s.pka)) s.pka = null;
      s.na = parseInt($('#f_na').value) || 0;
      s.cl = parseInt($('#f_cl').value) || 0;
      if (isNew) DB.stocks.push(s);
      saveDB(); closeModal(); refreshAll();
    });
  }

  function sysForm(s) {
    const isNew = !s;
    if (s) s = JSON.parse(JSON.stringify(s)); // 独立草稿，取消不会修改数据库
    s = s || { id: uid(), name: '', enabled: true, range: [3, 10], steps: [{ pKa: 7.0, zA: 0, zB: -1 }], stocks: [] };
    const stockOpts = sel => DB.stocks.map(st => `<option value="${st.id}" ${st.id === sel ? 'selected' : ''}>${esc(st.name)}</option>`).join('');
    openModal(`<h3>${isNew ? '新增' : '编辑'}缓冲体系</h3>
      <div class="row"><label>名称</label><input type="text" id="g_name" class="wide" value="${esc(s.name)}"></div>
      <div class="row"><label>建议 pH 范围</label><input type="number" id="g_r0" step="0.1" value="${s.range ? s.range[0] : ''}" style="width:70px"> –
        <input type="number" id="g_r1" step="0.1" value="${s.range ? s.range[1] : ''}" style="width:70px">
        <span class="muted">第二段（可选，如甘氨酸高 pH 段）</span>
        <input type="number" id="g_r20" step="0.1" value="${s.range2 ? s.range2[0] : ''}" style="width:70px"> –
        <input type="number" id="g_r21" step="0.1" value="${s.range2 ? s.range2[1] : ''}" style="width:70px"></div>
      <h4>解离步骤（pKa，酸式电荷 → 碱式电荷）</h4>
      <div id="g_steps"></div>
      <button class="ghost small" id="g_addstep">+ 加一级 pKa</button>
      <h4 style="margin-top:14px">母液与 d 值（d = 该母液形态相对全质子化形态已解离的质子数）</h4>
      <div class="muted" style="margin-bottom:6px">例：PB 体系 H3PO4 d=0、NaH2PO4 d=1、Na2HPO4 d=2；Tris-HCl d=0、Tris d=1</div>
      <div id="g_stocks"></div>
      <button class="ghost small" id="g_addstock">+ 加母液</button>
      <div class="row" style="margin-top:14px"><button class="primary" id="g_save">保存</button>
      <button class="ghost" id="g_cancel">取消</button></div>`);

    function renderSteps() {
      const box = $('#g_steps');
      box.innerHTML = '';
      s.steps.forEach((st, i) => {
        const div = document.createElement('div');
        div.className = 'row';
        div.innerHTML = `<label>pKa${i + 1}</label>
          <input type="number" step="0.01" value="${st.pKa}" data-step-pka="${i}" style="width:80px">
          <label>电荷</label>
          <input type="number" step="1" value="${st.zA}" data-step-za="${i}" style="width:60px"> →
          <input type="number" step="1" value="${st.zB}" data-step-zb="${i}" style="width:60px">
          ${s.steps.length > 1 ? `<button class="ghost small danger" data-del-step="${i}">删</button>` : ''}`;
        box.appendChild(div);
      });
      box.querySelectorAll('[data-step-pka], [data-step-za], [data-step-zb]').forEach(inp => inp.addEventListener('change', () => {
        const i = +(inp.dataset.stepPka ?? inp.dataset.stepZa ?? inp.dataset.stepZb);
        s.steps[i].pKa = parseFloat(box.querySelector(`[data-step-pka="${i}"]`).value);
        s.steps[i].zA = parseInt(box.querySelector(`[data-step-za="${i}"]`).value) || 0;
        s.steps[i].zB = parseInt(box.querySelector(`[data-step-zb="${i}"]`).value) || 0;
      }));
      box.querySelectorAll('[data-del-step]').forEach(b => b.addEventListener('click', () => {
        s.steps.splice(+b.dataset.delStep, 1); renderSteps();
      }));
    }
    function renderStocks() {
      const box = $('#g_stocks');
      box.innerHTML = '';
      (s.stocks || []).forEach((x, i) => {
        const div = document.createElement('div');
        div.className = 'row';
        div.innerHTML = `<select data-gstk="${i}">${stockOpts(x.stockId)}</select>
          <label>d =</label><input type="number" step="1" min="0" value="${x.dStock}" data-gd="${i}" style="width:60px">
          <button class="ghost small danger" data-del-gstk="${i}">删</button>`;
        box.appendChild(div);
      });
      box.querySelectorAll('[data-gstk]').forEach(sel => sel.addEventListener('change', () => {
        s.stocks[+sel.dataset.gstk].stockId = sel.value;
      }));
      box.querySelectorAll('[data-gd]').forEach(inp => inp.addEventListener('change', () => {
        s.stocks[+inp.dataset.gd].dStock = parseInt(inp.value) || 0;
      }));
      box.querySelectorAll('[data-del-gstk]').forEach(b => b.addEventListener('click', () => {
        s.stocks.splice(+b.dataset.delGstk, 1); renderStocks();
      }));
    }
    renderSteps(); renderStocks();
    $('#g_addstep').addEventListener('click', () => {
      const last = s.steps[s.steps.length - 1];
      s.steps.push({ pKa: last.pKa + 2, zA: last.zB, zB: last.zB - 1 });
      renderSteps();
    });
    $('#g_addstock').addEventListener('click', () => {
      if (!DB.stocks.length) { alert('请先新增母液'); return; }
      s.stocks = s.stocks || [];
      s.stocks.push({ stockId: DB.stocks[0].id, dStock: s.stocks.length });
      renderStocks();
    });
    $('#g_cancel').addEventListener('click', closeModal);
    $('#g_save').addEventListener('click', () => {
      const name = $('#g_name').value.trim();
      if (!name) { alert('请填写名称'); return; }
      s.steps = Array.from($('#g_steps').querySelectorAll('[data-step-pka]')).map(inp => {
        const i = inp.dataset.stepPka;
        return {
          pKa: parseFloat(inp.value),
          zA: parseFloat($('#g_steps').querySelector(`[data-step-za="${i}"]`).value),
          zB: parseFloat($('#g_steps').querySelector(`[data-step-zb="${i}"]`).value),
        };
      });
      if (!s.steps.length) { alert('至少一个 pKa'); return; }
      if (s.steps.some((st, i) => !Number.isFinite(st.pKa) ||
          !Number.isInteger(st.zA) || !Number.isInteger(st.zB) ||
          st.zB !== st.zA - 1 || (i > 0 && st.zA !== s.steps[i - 1].zB))) {
        alert('请填写有效 pKa 与整数电荷；每步电荷须减少 1，相邻步骤电荷须连续'); return;
      }
      s.name = name;
      const r0 = parseFloat($('#g_r0').value), r1 = parseFloat($('#g_r1').value);
      s.range = (isNaN(r0) || isNaN(r1)) ? null : [r0, r1];
      const r20 = parseFloat($('#g_r20').value), r21 = parseFloat($('#g_r21').value);
      s.range2 = (isNaN(r20) || isNaN(r21)) ? undefined : [r20, r21];
      if (isNew) DB.systems.push(s);
      else DB.systems[DB.systems.findIndex(x => x.id === s.id)] = s;
      saveDB(); closeModal(); refreshAll();
    });
  }

  /* 管理页「实测 pH 记录」汇总：全部卡片的记录集中查看、导出、清理。
   * 这是阶段性回归校准的数据出口——按卡片分组展示偏差，便于看出偏差规律。 */
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
        <button class="ghost" id="btnCalibExportAll">导出全部记录（含配方全文）</button>
        <button class="ghost" id="btnCalibExportTable">导出偏差表（TSV，便于回归）</button>
        <button class="ghost" id="btnCalibClear">清空全部实测记录</button>
      </div>`;
    for (const [key, rows] of groups) {
      const devs = rows.map(x => x.measuredPH - x.targetPH);
      const mean = devs.reduce((a, b) => a + b, 0) / devs.length;
      const absMean = devs.reduce((a, b) => a + Math.abs(b), 0) / devs.length;
      const maxAbs = Math.max(...devs.map(Math.abs));
      html += `<div style="margin-top:10px"><b>${esc(rows[0].label)}</b>
        <span class="muted">（目标 pH ${rows[0].targetPH}，${rows.length} 条）</span>
        <div class="muted">平均偏差 ${mean >= 0 ? '+' : ''}${mean.toFixed(3)} pH · 平均绝对偏差 ${absMean.toFixed(3)} pH · 最大绝对偏差 ${maxAbs.toFixed(3)} pH</div>
        <div style="overflow-x:auto"><table class="res"><tr><th>时间</th><th>实测 pH</th><th>偏差</th><th>温度</th><th>模型</th><th></th></tr>`
        + rows.slice().reverse().map(x => {
          const dv = x.measuredPH - x.targetPH;
          return `<tr><td class="muted">${esc(x.at)}</td><td class="num">${x.measuredPH.toFixed(3)}</td><td class="num">${dv >= 0 ? '+' : ''}${dv.toFixed(3)}</td><td class="num">${x.tempC == null ? '—' : x.tempC}</td><td class="muted">${esc(x.model || '')}</td><td><button class="ghost small" data-calib-del="${esc(x.id)}">删除</button></td></tr>`;
        }).join('')
        + `</table></div></div>`;
    }
    box.innerHTML = html;
  }

  function refreshAll() {
    renderSysPicker($('#t1ASys'), 't1A');
    renderSysPicker($('#t1BSys'), 't1B');
    renderAddPicker($('#t1AAdd'), 't1A', false);
    renderAddPicker($('#t1BAdd'), 't1B', false);
    renderNeutSelectors();
    renderStockTable(); renderSysTable();
    renderCalibHistories(); renderCalibAdmin();
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
            + `<td class="num">${x.tempC == null ? '—' : x.tempC}</td>`
            + `<td><button class="ghost small" data-calib-del="${esc(x.id)}">删除</button></td></tr>`;
        }).join('')
        + `</table>${rows.length > shown.length ? `<div class="muted">仅显示最近 ${shown.length} 条，共 ${rows.length} 条；完整数据在管理页「实测 pH 记录」。</div>` : ''}`;
    });
  }
  function calibRecord(side) {
    const card = document.querySelector(`[data-calib-card="${side}"]`);
    if (!card) return;
    const pHInput = card.querySelector(`[data-calib-ph="${side}"]`);
    const measured = parseFloat(pHInput.value);
    if (!Number.isFinite(measured) || measured < 0 || measured > 14) {
      alert('请填写 0–14 之间的实测 pH。');
      pHInput.focus();
      return;
    }
    const tempRaw = parseFloat((card.querySelector(`[data-calib-temp="${side}"]`) || {}).value);
    const target = parseFloat(card.dataset.calibTarget);
    const text = (card.querySelector(`[data-calib-text="${side}"]`) || {}).value || '';
    const rec = {
      id: 'c' + Date.now().toString(36) + Math.random().toString(36).slice(2, 6),
      key: card.dataset.calibKey,
      label: (document.querySelector(`[data-buffer-name="${side}"]`) || {}).textContent || side,
      targetPH: target,
      measuredPH: measured,
      tempC: Number.isFinite(tempRaw) ? tempRaw : null,
      at: new Date().toISOString().slice(0, 16).replace('T', ' '),
      model: currentModel(),
      text,
    };
    addCalibrationRecord(rec);
    pHInput.value = '';
    const tIn = card.querySelector(`[data-calib-temp="${side}"]`);
    if (tIn) tIn.value = '';
    renderCalibHistories();
    const box = card.querySelector('[data-calib-history]');
    if (box) box.insertAdjacentHTML('afterbegin', `<div class="muted" style="margin-top:6px">已记录：实测 ${measured.toFixed(3)}，偏差 ${(measured - target) >= 0 ? '+' : ''}${(measured - target).toFixed(3)} pH（共 ${calibrationFor(card.dataset.calibKey).length} 条）</div>`);
    renderCalibAdmin();
  }

  /* ---------- 管理页事件（事件委托） ---------- */
  document.addEventListener('click', e => {
    const t = e.target;
    if (t.dataset && (t.dataset.copy_ || t.dataset.copy || t.dataset.copyName || t.dataset.copy_name)) { // 结果区复制按钮
      const nm = t.dataset.copyName || t.dataset.copy_name;
      const cp = t.dataset.copy || t.dataset.copy_;
      const txt = nm ? lastName[nm] : lastCopy[cp];
      if (txt) navigator.clipboard.writeText(txt).then(() => {
        const orig = t.textContent;
        t.textContent = '已复制 ✓';
        setTimeout(() => { t.textContent = orig; }, 1500);
      }).catch(() => { alert('复制失败，请允许浏览器访问剪贴板，或手动选中结果复制。'); });
      return;
    }
    if (t.dataset && t.dataset.calibSave) { calibRecord(t.dataset.calibSave); return; }
    if (t.dataset && t.dataset.calibDel) {
      if (confirm('删除这条实测记录？')) { deleteCalibrationRecord(t.dataset.calibDel); renderCalibHistories(); renderCalibAdmin(); }
      return;
    }
    if (t.dataset && t.dataset.calibExport) {
      const side = t.dataset.calibExport;
      const card = document.querySelector(`[data-calib-card="${side}"]`);
      if (!card) return;
      const rows = calibrationFor(card.dataset.calibKey);
      if (!rows.length) { alert('该卡片还没有实测记录。'); return; }
      downloadText(`实测pH记录-${side}-${new Date().toISOString().slice(0, 10)}.txt`, calibrationTSV(rows, true));
      return;
    }
    if (t.dataset && t.dataset.editStock) stockForm(DB.stocks.find(s => s.id === t.dataset.editStock));
    if (t.dataset && t.dataset.delStock) {
      const s = stockById(t.dataset.delStock);
      const usedBy = DB.systems.filter(x => (x.stocks || []).some(y => y.stockId === s.id) || x.stockId === s.id).map(x => x.name);
      const msg = usedBy.length
        ? `母液「${s.name}」正被体系「${usedBy.join('、')}」使用，删除后这些体系将缺母液。确认删除？`
        : `确认删除母液「${s.name}」？`;
      if (confirm(msg)) {
        markDeletedDefault('stocks', s.id);
        DB.stocks = DB.stocks.filter(x => x.id !== s.id);
        DB.systems.forEach(x => { x.stocks = (x.stocks || []).filter(y => y.stockId !== s.id); });
        saveDB(); refreshAll();
      }
    }
    if (t.dataset && t.dataset.editSys) {
      const s = DB.systems.find(x => x.id === t.dataset.editSys);
      if (s && !s.premix) sysForm(s);
    }
    if (t.dataset && t.dataset.delSys) {
      const s = DB.systems.find(x => x.id === t.dataset.delSys);
      if (confirm(`确认删除缓冲体系「${s.name}」？`)) {
        markDeletedDefault('systems', s.id);
        DB.systems = DB.systems.filter(x => x.id !== s.id);
        saveDB(); refreshAll();
      }
    }
  });
  $('#btnAddStock').addEventListener('click', () => stockForm(null));
  $('#btnAddSys').addEventListener('click', () => sysForm(null));
  $('#btnExport').addEventListener('click', () => {
    const blob = new Blob([JSON.stringify(DB, null, 2)], { type: 'application/json' });
    const a = document.createElement('a');
    a.href = URL.createObjectURL(blob);
    a.download = 'buffer-calculator-db.json';
    a.click();
    URL.revokeObjectURL(a.href);
  });
  // 实测记录：汇总导出与清理（按钮由 renderCalibAdmin 生成）
  document.addEventListener('click', e => {
    const t = e.target;
    const stamp = new Date().toISOString().slice(0, 10);
    if (t.id === 'btnCalibExportAll') {
      const all = calibAll();
      if (!all.length) { alert('尚无实测记录。'); return; }
      downloadText(`实测pH记录-全部-${stamp}.txt`, calibrationTSV(all, true));
    } else if (t.id === 'btnCalibExportTable') {
      const all = calibAll();
      if (!all.length) { alert('尚无实测记录。'); return; }
      downloadText(`实测pH偏差表-${stamp}.tsv`, calibrationTSV(all, false));
    } else if (t.id === 'btnCalibClear') {
      const n = calibAll().length;
      if (!n) { alert('尚无实测记录。'); return; }
      if (confirm(`确认清空全部 ${n} 条实测记录？此操作不可恢复，建议先「导出全部记录」。`)) {
        DB.calibration = []; saveDB(); renderCalibHistories(); renderCalibAdmin();
      }
    }
  });
  $('#btnImport').addEventListener('click', () => $('#fileImport').click());
  $('#fileImport').addEventListener('change', e => {
    const f = e.target.files[0];
    if (!f) return;
    const rd = new FileReader();
    rd.onload = () => {
      try {
        const d = JSON.parse(rd.result);
        if (!d || !Array.isArray(d.stocks) || !Array.isArray(d.systems)) throw new Error('格式不正确');
        DB = d; saveDB(); refreshAll();
        alert('导入成功');
      } catch (err) { alert('导入失败：' + err.message); }
      e.target.value = '';
    };
    rd.readAsText(f);
  });
  $('#btnReset').addEventListener('click', () => {
    const nCal = calibAll().length;
    if (confirm(`确认恢复出厂默认？你的全部自定义修改将丢失${nCal ? `；⚠ 已记录的 ${nCal} 条实测 pH 数据也会一并清除` : ''}（可先导出备份）。`)) {
      DB = JSON.parse(JSON.stringify({ stocks: DefaultDB.stocks, systems: DefaultDB.systems }));
      saveDB(); refreshAll();
    }
  });

  /* ---------- 绑定 ---------- */
  $('#btnCalc').addEventListener('click', computeRecipe);
  $('#btnNeut').addEventListener('click', computeNeutralization);
  $('#allowTitrant').addEventListener('change', () => {
    $('#titrantConcRow').style.display = $('#allowTitrant').checked ? '' : 'none';
  });
  function paintFracRange() {
    const low=$('#numFracBLo'),high=$('#numFracB'),a=parseFloat(low.value),b=parseFloat(high.value);
    const invalid=!Number.isFinite(a)||!Number.isFinite(b)||a<0||b>100||a>b;
    low.setAttribute('aria-invalid',invalid?'true':'false');high.setAttribute('aria-invalid',invalid?'true':'false');
    $('.dual-range').classList.toggle('range-invalid',invalid);
    if(!Number.isFinite(a)||!Number.isFinite(b))return;
    const left=Math.max(0,Math.min(100,Math.min(a,b))),right=Math.max(0,Math.min(100,Math.max(a,b)));
    $('#fracRangeFill').style.left=left+'%';$('#fracRangeFill').style.width=(right-left)+'%';
  }
  function syncFracRange(changed,commit=false) {
    const isLow=changed.id.endsWith('Lo'),isSlider=changed.type==='range';
    const low=$('#numFracBLo'),high=$('#numFracB'),lowSl=$('#slFracBLo'),highSl=$('#slFracB');
    const ownNum=isLow?low:high,otherNum=isLow?high:low,ownSlider=isLow?lowSl:highSl;
    let v=parseFloat(changed.value);if(!Number.isFinite(v)){paintFracRange();return;}
    const clamp=x=>Math.max(0,Math.min(100,x));
    if(isSlider) {
      const other=parseFloat(otherNum.value);
      v=clamp(v);
      if(Number.isFinite(other))v=isLow?Math.min(v,other):Math.max(v,other);
      ownSlider.value=v;ownNum.value=v;
    } else {
      if(commit) {
        v=clamp(v);
        ownNum.value=v;
      }
      ownSlider.value=clamp(v);
    }
    paintFracRange();
  }
  for(const id of ['slFracBLo','slFracB','numFracBLo','numFracB']) $('#'+id).addEventListener('input',e=>syncFracRange(e.target));
  for(const id of ['numFracBLo','numFracB']) $('#'+id).addEventListener('change',e=>syncFracRange(e.target,true));
  syncFracRange($('#numFracBLo'));
  function markRecipeDirty() {
    if(!recipeStarted || $('#recipePending'))return;
    $('#resultZone').insertAdjacentHTML('afterbegin','<div class="warnbox" id="recipePending" role="status">配制条件已修改，请点击「计算」更新。下方结果仍对应上一次计算条件。</div>');
  }
  function markNeutralizationDirty() {
    if(!neutStarted)return;
    ++neutRun;
    setNeutBusy(false); // 取消进行中的计算后恢复按钮，避免一直停留在「计算中…」
    const pane=$('#neutZone');
    if($('#neutPending'))return;
    const warning='<div class="warnbox" id="neutPending" role="status">中和条件已修改，请点击「计算」更新。下方若有结果，仍对应上一次计算条件。</div>';
    if(pane.querySelector('#neutChart')||pane.querySelector('#neutRangeResult'))pane.insertAdjacentHTML('afterbegin',warning);
    else pane.innerHTML=warning;
  }
  for(const eventName of ['input','change']) {
    $('#t1').addEventListener(eventName,markRecipeDirty);
    $('#t2').addEventListener(eventName,markNeutralizationDirty);
  }
  bindSlider('#slPH', '#numPH', { min: 4, max: 9, dec: 2 });
  bindSlider('#slVol', '#numVol', { min: VOL_MIN, max: VOL_MAX, log: true });
  $('#slVol').value = sliderFromVol(10);
  // 中和试剂来源切换：现有母液 / 自定义
  $$('input[name=titrantSrc]').forEach(r => r.addEventListener('change', () => {
    const custom = (document.querySelector('input[name=titrantSrc]:checked') || {}).value === 'custom';
    $('#nTitrantStockRow').style.display = custom ? 'none' : '';
    $('#nTitrantCustom').style.display = custom ? '' : 'none';
  }));

  refreshAll();
})();

