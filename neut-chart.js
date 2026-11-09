/* neut-chart.js — 自绘 SVG 中和热力图与滴定曲线（无网络依赖）
 * 观察器、帧回调与热力图缓存全部按 container 保存：替换 SVG 前先清理旧监听与帧任务，
 * dispose(container) 供实例销毁时调用。主题只改配色，不重新求解曲线。
 */
(function (global) {
  'use strict';

  const PALETTE = {
    light: {
      axisText: '#536174', grid: '#ffffff', gridOpacity: '.58', label: '#334155',
      legend: '#2563eb', bg: '#ffffff', readoutBg: '#f1f5fb', readoutText: '#17243b',
      halo: '#ffffff', target: '#f97316', bound: '#17243b', cross: '#0f172a',
      tipBg: '#17243b', tipText: '#ffffff', tipAccent: '#93c5fd',
      hatchFill: '#e2e8f0', hatchLine: '#94a3b8', empty: '#e2e8f0',
      noteHigh: '#475569', dir: '#ea580c', tolerance: '#334155',
    },
    dark: {
      axisText: '#c3ccd8', grid: '#14171c', gridOpacity: '.7', label: '#c3ccd8',
      legend: '#8bbaff', bg: '#ffffff', readoutBg: '#232a33', readoutText: '#e6e9ee',
      halo: '#ffffff', target: '#fb923c', bound: '#334155', cross: '#0f172a',
      tipBg: '#0b0e12', tipText: '#ffffff', tipAccent: '#93c5fd',
      hatchFill: '#cbd5e1', hatchLine: '#64748b', empty: '#e2e8f0',
      noteHigh: '#c3ccd8', dir: '#fb923c', tolerance: '#c3ccd8',
    },
  };
  // 热力图本身打印/屏幕都用白底深字，避免深色主题导致纸面白字。
  const CHART_BG = '#ffffff';
  let theme = 'light';
  const frames = new WeakMap();
  const observers = new WeakMap();
  const valid = v => Number.isFinite(v) && v >= 0;

  function palette() { return PALETTE[theme] || PALETTE.light; }

  // 不可达时 volL.mid 为 null，纵轴会退化成兜底常数（刻度无意义）。
  // 此时按 5% 样品体积的参考剂量给一个有量级的纵轴，并在下方标注为参考刻度。
  function fallbackYmax(input, lower, upper) {
    try {
      const V = input.sampleVolL, conc = input.titrant && input.titrant.concM > 0 ? input.titrant.concM : .2;
      const b = lower === upper ? lower : (lower + upper) / 2;
      const r = Engine.calcNeutralization(Object.assign({}, input, { fracB: b / 100 }));
      const amp = Number.isFinite(r.mixPH) ? Math.abs(r.mixPH - input.targetPH) : 1;
      if (amp < .05) return Math.max(V * .05 * conc, .05 * V) * 1.18;
      return Math.max(V * .05 * conc / (amp * 8), .02 * V) * 1.18;
    } catch (e) { return .01 * 1.18; }
  }
  const heatColor = (p, min, max) => {
    if (!Number.isFinite(p)) return PALETTE.light.empty;
    const t = Math.max(0, Math.min(1, (p - min) / Math.max(max - min, 1e-9)));
    return `hsl(212,85%,${96 - 62 * t}%)`;
  };
  function heatData(container, input, lower, upper, ymax) {
    if (container.__neutralHeat) return container.__neutralHeat;
    const cols = lower === upper ? 1 : 16, rows = 12, cells = [], values = [];
    for (let row = 0; row < rows; row++) {
      const dose = ymax * (1 - (row + .5) / rows);
      for (let col = 0; col < cols; col++) {
        const b = lower === upper ? lower : lower + (upper - lower) * (col + .5) / cols;
        const state = Engine.calcNeutralization(Object.assign({}, input, { fracB: b / 100, probeDoseL: dose }));
        const pH = state.pH;
        cells.push({ row, col, b, dose, pH });
        if (Number.isFinite(pH)) values.push(pH);
      }
    }
    let min = values.length ? Math.min(...values) : 0, max = values.length ? Math.max(...values) : 14;
    if (max - min < .2) { const mid = (min + max) / 2; min = mid - .1; max = mid + .1; }
    const rowPH = [];
    for (let row = 0; row < rows; row++) {
      const vs = cells.filter(c => c.row === row && Number.isFinite(c.pH)).map(c => c.pH);
      if (vs.length) rowPH.push({ row, min: Math.min(...vs), max: Math.max(...vs) });
    }
    container.__neutralHeat = { cols, rows, cells, min, max, rowPH };
    return container.__neutralHeat;
  }

  function clearContainerEffects(container) {
    const frame = frames.get(container);
    if (frame) { cancelAnimationFrame(frame); frames.delete(container); }
    const observer = observers.get(container);
    if (observer) { observer.disconnect(); observers.delete(container); }
  }

  global.NeutralChart = {
    setTheme(next) { theme = next === 'dark' ? 'dark' : 'light'; },
    get theme() { return theme; },

    // 卸载或重绑前清理：观察器、帧回调、缓存与容器标记
    dispose(container) {
      if (!container) return;
      clearContainerEffects(container);
      delete container.__neutralHeat;
      delete container.__neutralChartArgs;
    },
    // 业务参数变化时失效缓存（主题/尺寸变化不调用它）
    invalidate(container) {
      if (!container) return;
      delete container.__neutralHeat;
    },

    render(container, points, input, lower, upper) {
      if (!container || !container.isConnected) return;
      clearContainerEffects(container);
      const C = palette();
      const W = Math.max(260, container.clientWidth), H = 320, L = 70, R = W - 100, T = 35, B = 260;
      const all = points.flatMap(p => [p.r.volL.mid, p.r.volL.lo, p.r.volL.hi]).filter(valid);
      const curveUnreachable = all.length === 0;
      const ymax = curveUnreachable ? fallbackYmax(input, lower, upper) : Math.max(...all, 1e-6) * 1.18;
      const scale = ymax < .001 ? 1e6 : 1000, unit = scale === 1e6 ? 'µL' : 'mL';
      const x = v => lower === upper ? (L + R) / 2 : L + (v - lower) / (upper - lower) * (R - L);
      const y = v => B - v / ymax * (B - T);
      const f = v => Number(v.toFixed(3)).toString();
      const ft = v => { const a = Math.abs(v), d = a >= 100 ? 0 : a >= 10 ? 1 : 2; let s = v.toFixed(d); if (s.indexOf('.') > 0) s = s.replace(/0+$/, '').replace(/\.$/, ''); return s; };
      const heat = heatData(container, input, lower, upper, ymax), cw = (R - L) / heat.cols, ch = (B - T) / heat.rows;
      const cells = heat.cells.map(c => `<rect class="ph-heat-cell" data-ph="${Number.isFinite(c.pH) ? c.pH : ''}" data-b="${c.b}" data-dose="${c.dose}" x="${L + c.col * cw}" y="${T + c.row * ch}" width="${cw + .25}" height="${ch + .25}" fill="${heatColor(c.pH, heat.min, heat.max)}"/>`).join('');
      const tgt = input.targetPH;
      const pHInBand = tgt >= heat.min - 1e-9 && tgt <= heat.max + 1e-9;
      const yOfRow = q => {
        const rows = heat.rowPH; if (!rows.length) return null;
        if (q <= rows[0].min) return T;
        for (let i = 1; i < rows.length; i++) {
          const pr = rows[i - 1], cu = rows[i];
          if (q <= cu.min) { const span = Math.max(1e-9, cu.min - pr.min); const fac = (q - pr.min) / span; return T + ch * ((pr.row + fac * (cu.row - pr.row)) + .5); }
        }
        const last = rows[rows.length - 1];
        if (q <= last.max) return T + ch * (last.row + .5);
        return B;
      };
      let unreachableBand = '', unreachableNote = '';
      if (!pHInBand) {
        const yb = yOfRow(tgt); const tooHigh = tgt > heat.max;
        const yEdge = tooHigh ? T : B;
        const yTop = Math.min(yb, yEdge), yBot = Math.max(yb, yEdge);
        unreachableBand = `<rect class="unreachable-band" data-edge-pH="${tooHigh ? heat.max : heat.min}" x="${L}" y="${yTop}" width="${Math.max(0, R - L)}" height="${Math.max(0, yBot - yTop)}" fill="url(#unreachableHatch)" stroke="#64748b" stroke-dasharray="4 3" stroke-width="1"/>`;
        unreachableNote = `<span style="color:${C.noteHigh}">▨ 不可达区（任何加液量都到不了 ${tgt}，${tooHigh ? '该区域最高只能到约 ' + heat.max.toFixed(2) : '该区域最低只能到约 ' + heat.min.toFixed(2)}）</span>`;
      }
      const dir = input.__dir || null;
      const dirLabel = dir === 'acid' ? '加酸' : (dir === 'base' ? '加碱' : null);
      let grid = '';
      for (let k = 0; k <= 5; k++) {
        const yy = T + (B - T) * k / 5, xx = L + (R - L) * k / 5;
        grid += `<path d="M${L},${yy}H${R} M${xx},${T}V${B}" stroke="${C.grid}" stroke-opacity="${C.gridOpacity}" fill="none"/><text x="${L - 12}" y="${yy + 5}" text-anchor="end">${ft(ymax * (1 - k / 5) * scale)}</text>`;
        grid += `<text x="${xx}" y="${B + 26}" text-anchor="middle">${ft(lower + (upper - lower) * k / 5)}%</text>`;
      }
      const runs = predicate => { const out = []; let run = []; for (const p of points) { if (predicate(p)) run.push(p); else if (run.length) { out.push(run); run = []; } } if (run.length) out.push(run); return out; };
      let bands = '', bounds = '';
      for (const run of runs(p => valid(p.r.volL.mid) && valid(p.r.volL.lo) && valid(p.r.volL.hi))) {
        const coords = run.map(p => `${x(p.b)},${y(p.r.volL.lo)}`).concat([...run].reverse().map(p => `${x(p.b)},${y(p.r.volL.hi)}`));
        bands += `<polygon points="${coords.join(' ')}" fill="#ffffff" opacity=".18"/>`;
        for (const key of ['lo', 'hi']) bounds += `<polyline class="tolerance-boundary" points="${run.map(p => `${x(p.b)},${y(p.r.volL[key])}`).join(' ')}" fill="none" stroke="${C.bound}" stroke-opacity=".62" stroke-width="1.5" stroke-dasharray="5 4"/>`;
      }
      const lineRuns = runs(p => valid(p.r.volL.mid));
      const targetHalo = lineRuns.map(run => run.length === 1 ? `<circle class="target-dose-halo" cx="${x(run[0].b)}" cy="${y(run[0].r.volL.mid)}" r="5" fill="${C.halo}"/>` : `<polyline class="target-dose-halo" points="${run.map(p => `${x(p.b)},${y(p.r.volL.mid)}`).join(' ')}" fill="none" stroke="${C.halo}" stroke-width="6" stroke-linejoin="round"/>`).join('');
      const targetLine = lineRuns.map(run => run.length === 1 ? `<circle class="target-dose-line" cx="${x(run[0].b)}" cy="${y(run[0].r.volL.mid)}" r="3.5" fill="${C.target}"/>` : `<polyline class="target-dose-line" points="${run.map(p => `${x(p.b)},${y(p.r.volL.mid)}`).join(' ')}" fill="none" stroke="${C.target}" stroke-width="3" stroke-linejoin="round"/>`).join('');
      const lowColor = heatColor(heat.min, heat.min, heat.max), highColor = heatColor(heat.max, heat.min, heat.max);
      container.innerHTML = `<div class="chart-legend"><span class="heat-legend"><i style="display:inline-block;width:90px;height:10px;border-radius:5px;background:linear-gradient(90deg,${lowColor},${highColor});margin-right:7px"></i>预计pH ${heat.min.toFixed(2)}–${heat.max.toFixed(2)}（颜色越深越高）</span><span style="color:${C.dir}">━━ 达到目标 pH ${input.targetPH}</span><span style="color:${C.tolerance}">┄ 目标 pH ±${input.tolerancePH}</span>${unreachableNote}</div>
      ${curveUnreachable ? '<div class="warnbox">当前条件下橙色目标剂量曲线无解（所选范围内没有可行的加液量），纵轴改用参考刻度，仅供估计量级。</div>' : ''}
      <svg id="neutChart" viewBox="0 0 ${W} ${H}" role="img" aria-label="Buffer B占比、中和试剂体积与预计pH热力图" style="width:100%;display:block;touch-action:none;font-family:inherit;font-size:14px;fill:${C.axisText}">
      <defs><pattern id="unreachableHatch" width="8" height="8" patternTransform="rotate(45)" patternUnits="userSpaceOnUse"><rect width="8" height="8" fill="${C.hatchFill}" opacity=".45"/><line x1="0" y1="0" x2="0" y2="8" stroke="${C.hatchLine}" stroke-width="3"/></pattern></defs>
      <rect width="${W}" height="${H}" fill="${CHART_BG}"/><g id="phHeatmap" data-ph-min="${heat.min}" data-ph-max="${heat.max}" data-heat-cells="${heat.cells.length}" data-target-reachable="${pHInBand}" data-direction="${dir || ''}" shape-rendering="crispEdges">${cells}${unreachableBand}</g>${grid}${bands}${bounds}${targetHalo}${targetLine}
      <text x="${L}" y="20">${dirLabel ? dirLabel + '剂' : '中和试剂'}体积 (${unit})${curveUnreachable ? ' · 参考刻度' : ''}</text><text x="${(L + R) / 2}" y="310" text-anchor="middle">Buffer B 占比 (%)</text>
      <g id="crosshair" visibility="hidden" pointer-events="none">
      <path id="crossLines" stroke="${C.cross}" stroke-dasharray="5 4" fill="none"/><circle id="crossDot" r="4" fill="${C.cross}" stroke="white" stroke-width="2"/>
      <g id="crossX"><rect x="-40" y="0" width="80" height="25" rx="4" fill="${C.tipBg}"/><text y="17" text-anchor="middle" fill="${C.tipText}"/></g>
      <g id="crossY"><rect x="0" y="-13" width="95" height="26" rx="4" fill="${C.tipBg}"/><text x="8" y="5" fill="${C.tipText}"/></g>
      <g id="crossTip"><rect width="220" height="94" rx="8" fill="${C.tipBg}" opacity=".94"/><text x="14" y="25" fill="${C.tipText}"/><text x="14" y="51" fill="${C.tipText}"/><text x="14" y="77" fill="${C.tipAccent}"/></g>
      </g><rect id="chartHit" x="${L}" y="${T}" width="${R - L}" height="${B - T}" fill="transparent" style="cursor:crosshair"/></svg>
      <div id="chartReadout" class="chart-readout" aria-live="off">在热力图内移动光标：横向选B%，纵向选加液体积，实时反算预计pH。</div>`;
      const svg = container.querySelector('svg'), cross = container.querySelector('#crosshair'), hit = container.querySelector('#chartHit'), readout = container.querySelector('#chartReadout');
      let pending = null;
      function update() {
        frames.delete(container);
        if (!pending || !svg.isConnected) return;
        const { xx, yy } = pending;
        const b = lower === upper ? lower : lower + (xx - L) / (R - L) * (upper - lower), dose = (B - yy) / (B - T) * ymax;
        cross.setAttribute('visibility', 'visible');
        container.querySelector('#crossLines').setAttribute('d', `M${xx},${T}V${B} M${L},${yy}H${R}`);
        const dot = container.querySelector('#crossDot'); dot.setAttribute('cx', xx); dot.setAttribute('cy', yy);
        const tx = container.querySelector('#crossX'), ty = container.querySelector('#crossY');
        tx.setAttribute('transform', `translate(${xx},${B + 2})`);
        ty.setAttribute('transform', `translate(${R + 3},${yy})`);
        tx.querySelector('text').textContent = b.toFixed(2) + '%';
        ty.querySelector('text').textContent = f(dose * scale) + ' ' + unit;
        const state = Engine.calcNeutralization(Object.assign({}, input, { fracB: b / 100, probeDoseL: dose }));
        const tip = container.querySelector('#crossTip');
        tip.setAttribute('transform', `translate(${Math.max(8, Math.min(W - 228, xx > (L + R) / 2 ? xx - 235 : xx + 15))},${yy > T + 110 ? yy - 108 : yy + 15})`);
        const labels = tip.querySelectorAll('text');
        labels[0].textContent = `Buffer B  ${b.toFixed(2)}%`;
        labels[1].textContent = `加液体积  ${f(dose * scale)} ${unit}`;
        labels[2].textContent = `预计 pH  ${state.pH == null ? '未收敛' : state.pH.toFixed(3)}`;
        readout.innerHTML = `<span>Buffer B <b>${b.toFixed(2)}%</b></span><span>加液体积 <b>${f(dose * scale)} ${unit}</b></span><span>预计 pH <b>${state.pH == null ? '未收敛' : state.pH.toFixed(3)}</b></span><span class="muted">目标 ${input.targetPH} · 光标自由取点</span>`;
        readout.dataset.b = b; readout.dataset.dose = dose; readout.dataset.ph = state.pH == null ? '' : state.pH;
      }
      hit.addEventListener('pointermove', e => {
        const pt = svg.createSVGPoint(); pt.x = e.clientX; pt.y = e.clientY;
        const a = pt.matrixTransform(svg.getScreenCTM().inverse());
        pending = { xx: Math.max(L, Math.min(R, a.x)), yy: Math.max(T, Math.min(B, a.y)) };
        if (!frames.has(container)) frames.set(container, requestAnimationFrame(update));
      });
      hit.addEventListener('pointerleave', () => {
        pending = null;
        const frame = frames.get(container);
        if (frame) { cancelAnimationFrame(frame); frames.delete(container); }
        cross.setAttribute('visibility', 'hidden');
        readout.textContent = '在热力图内移动光标查看当前B%、加液体积与预计pH。';
      });
      // 隐藏/零宽视口不忙循环：只在可见且宽度真正变化时重排
      const observer = new ResizeObserver(() => {
        if (!container.isConnected) { clearContainerEffects(container); return; }
        const width = container.clientWidth;
        if (width <= 0) return;
        if (Math.abs(Math.max(260, width) - W) > .5) global.NeutralChart.render(container, points, input, lower, upper);
      });
      observers.set(container, observer);
      observer.observe(container);
    },
  };
})(typeof window !== 'undefined' ? window : globalThis);
