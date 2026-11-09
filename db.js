/* 默认数据库：母液 + 缓冲体系（与 HTML 内置一致，供 node 自测用） */
(function (global) {
  'use strict';

  // 母液：concM 摩尔浓度；na/cl 每分子带入的 Na+/Cl- 数；refpH 母液实测 pH；pct 用于 % w/v 类
  const DEFAULT_STOCKS = [
    { id: 'ca',       name: 'CA',               concM: 0.2,  refpH: 1.9,  na: 0, cl: 0, type: 'acid' },
    { id: 'na3ca',    name: 'Na3CA',            concM: 0.2,  refpH: 7.6,  na: 3, cl: 0, type: 'base' },
    { id: 'h3po4',    name: 'H3PO4',            concM: 0.2,  refpH: 1.6,  na: 0, cl: 0, type: 'acid' },
    { id: 'nah2po4',  name: 'NaH2PO4',          concM: 0.2,  refpH: 4.3,  na: 1, cl: 0, type: 'acid' },
    { id: 'na2hpo4',  name: 'Na2HPO4',          concM: 0.2,  refpH: 9.0,  na: 2, cl: 0, type: 'base' },
    { id: 'hac',      name: 'HAc',              concM: 0.2,  refpH: 2.7,  na: 0, cl: 0, type: 'acid' },
    { id: 'naac',     name: 'NaAc',             concM: 0.2,  refpH: 8.3,  na: 1, cl: 0, type: 'base' },
    { id: 'tris',     name: 'Tris',             concM: 0.2,  refpH: 11.6, na: 0, cl: 0, type: 'base', pka: 8.07 },
    { id: 'tris_hcl', name: 'Tris-HCl',         concM: 0.2,  refpH: 4.6,  na: 0, cl: 1, type: 'acid' },
    { id: 'his',      name: 'His',              concM: 0.2,  refpH: 7.6,  na: 0, cl: 0, type: 'base' },
    { id: 'his_hcl',  name: 'His-HCl',          concM: 0.2,  refpH: 4.0,  na: 0, cl: 1, type: 'acid' },
    // noTitrant：不出现在中和试剂候选（咪唑是洗脱添加剂，不作中和试剂）
    { id: 'imidazole',name: '咪唑',             concM: 2.4,  refpH: 8.1,  na: 0, cl: 0, type: 'base', pka: 7.00, rev: 3, noTitrant: true },
    { id: 'gly',      name: 'Gly',              concM: 0.2,  refpH: 5.98, na: 0, cl: 0, type: 'base' },
    { id: 'nacl',     name: 'NaCl',             concM: 5,    refpH: null, na: 1, cl: 1, type: 'salt' },
    { id: 'arg_hcl',  name: 'Arg-HCl',          concM: 2,    refpH: 5.3,  na: 0, cl: 1, type: 'salt', pka: 9.04, rev: 2 },
    { id: 'arg',      name: 'Arg',              concM: 1,    refpH: 9.0,  na: 0, cl: 0, type: 'titrant', pka: 9.04 },
    { id: 'gdnhcl',   name: 'GdnHCl 盐酸胍',    concM: 6,    refpH: 6.0,  na: 0, cl: 1, type: 'salt' },
    { id: 'suc',      name: '蔗糖 SUC 60%',     concM: null, refpH: null, na: 0, cl: 0, type: 'neutral', pct: 60 },
    // 10× PBS：盐组成按 Sambrook（NaCl 1.37M、KCl 27mM）；磷酸盐总量 100mM，
    // dbar=1.79 为引擎在 1× 离子强度、pH 7.4 下的自洽值（即该母液按标签 pH 7.4 锚定，
    // 加入 pH7.4 体系时无需微调）。Na+/K+/Cl- 计数已按此自洽。
    { id: 'pbs10x',   name: 'PBS 10× pH7.4',    concM: null, refpH: 7.4,  na: 0, cl: 0, type: 'premix', rev: 4,
      premix: { sysId: 'pb', concM: 0.100, dbar: 1.79,
        saltIons: [ { z: 1, concM: 1.531, lambda: 50.1 }, { z: 1, concM: 0.045, lambda: 73.5 }, { z: -1, concM: 1.397, lambda: 76.3 } ] } },
  ];

  // 缓冲体系：steps[{pKa,zA,zB}]；stocks 引用母液并标注 d（已解离质子数）
  const DEFAULT_SYSTEMS = [
    { id: 'pb', name: 'PB', enabled: true, range: [6.2, 8.2],
      steps: [ { pKa: 2.15, zA: 0, zB: -1 }, { pKa: 7.20, zA: -1, zB: -2 }, { pKa: 12.35, zA: -2, zB: -3 } ],
      stocks: [ { stockId: 'h3po4', dStock: 0 }, { stockId: 'nah2po4', dStock: 1 }, { stockId: 'na2hpo4', dStock: 2 } ] },
    { id: 'acetate', name: 'NaAc', enabled: true, range: [3.8, 5.8],
      steps: [ { pKa: 4.76, zA: 0, zB: -1 } ],
      stocks: [ { stockId: 'hac', dStock: 0 }, { stockId: 'naac', dStock: 1 } ] },
    { id: 'tris', name: 'Tris', enabled: true, range: [7.1, 9.1],
      steps: [ { pKa: 8.07, zA: 1, zB: 0 } ],
      stocks: [ { stockId: 'tris_hcl', dStock: 0 }, { stockId: 'tris', dStock: 1 } ] },
    { id: 'citrate', name: 'CA', enabled: true, range: [3.0, 6.2],
      steps: [ { pKa: 3.13, zA: 0, zB: -1 }, { pKa: 4.76, zA: -1, zB: -2 }, { pKa: 6.40, zA: -2, zB: -3 } ],
      stocks: [ { stockId: 'ca', dStock: 0 }, { stockId: 'na3ca', dStock: 3 } ] },
    { id: 'histidine', name: 'His', enabled: true, range: [5.0, 7.0],
      steps: [ { pKa: 1.82, zA: 2, zB: 1 }, { pKa: 6.00, zA: 1, zB: 0 }, { pKa: 9.17, zA: 0, zB: -1 } ],
      stocks: [ { stockId: 'his_hcl', dStock: 1 }, { stockId: 'his', dStock: 2 } ] },
    { id: 'glycine', name: 'Gly', enabled: true, range: [2.2, 3.2], range2: [8.6, 10.6],
      steps: [ { pKa: 2.34, zA: 1, zB: 0 }, { pKa: 9.60, zA: 0, zB: -1 } ],
      stocks: [ { stockId: 'gly', dStock: 1 } ] },
    // PBS 作为缓冲体系（预混 10× 母液），浓度单位是"×"（1 = 1×）
    { id: 'pbs', name: 'PBS（10× 母液）', enabled: true, premix: true, stockId: 'pbs10x', unit: '×', range: [7.0, 7.8] },
  ];

  // Arg 平衡体系（Arg-HCl 添加剂 / Arg 中和试剂用）
  const ARG_SYSTEM = { id: 'arg_sys', name: 'Arg', steps: [ { pKa: 2.17, zA: 2, zB: 1 }, { pKa: 9.04, zA: 1, zB: 0 }, { pKa: 12.48, zA: 0, zB: -1 } ] };

  // 已从默认缓冲体系中移除的条目：若用户未自定义过（内容与旧默认完全一致），迁移时自动删除
  const OBSOLETE_SYSTEMS = [
    { id: 'imidazole', match: { id: 'imidazole', name: '咪唑', enabled: true, range: [6, 8],
      steps: [ { pKa: 7, zA: 1, zB: 0 } ], stocks: [ { stockId: 'imidazole', dStock: 1 } ] } },
  ];

  // 显示名英文化迁移（rev 1）：老用户 localStorage 里的中文名一次性改为英文缩写
  const RENAME_REV = 1;
  const RENAME_MAP = {
    stocks: {
      ca: 'CA', na3ca: 'Na3CA', h3po4: 'H3PO4', hac: 'HAc', naac: 'NaAc',
      tris: 'Tris', his: 'His', gly: 'Gly', arg: 'Arg',
    },
    systems: {
      pb: 'PB', acetate: 'NaAc', citrate: 'CA', histidine: 'His', glycine: 'Gly',
    },
  };

  const DefaultDB = { stocks: DEFAULT_STOCKS, systems: DEFAULT_SYSTEMS, argSystem: ARG_SYSTEM, obsoleteSystems: OBSOLETE_SYSTEMS, renameRev: RENAME_REV, renameMap: RENAME_MAP };
  global.DefaultDB = DefaultDB;
  if (typeof module !== 'undefined' && module.exports) module.exports = DefaultDB;
})(typeof window !== 'undefined' ? window : globalThis);
