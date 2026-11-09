/* ============================================================
 * BufferCalc Engine — 缓冲液/中和计算引擎（纯函数，无 DOM 依赖）
 * 参考常数约 25 °C；经验数据测量温度未确认。活度模型：扩展 Debye-Hückel ('edh') / Davies ('davies')
 * ============================================================ */
(function (global) {
  'use strict';

  // 25 °C 参考常数（未实现温度换算）
  const A_DH = 0.509;      // Debye-Hückel A (kg^1/2 mol^-1/2)
  const B_DH = 0.328;      // Debye-Hückel B (Å^-1)
  const ION_SIZE = 4.5;     // 默认离子尺寸参数 å (Å)
  const KW = 1e-14;
  const TITRANT_EPS_M = 1e-10; // 仅忽略随定容体积缩放的浮点残差 (mol/L)

  /* ---------- 电导率估算（极限摩尔电导 λ°，25°C 文献值，S·cm²/mol） ---------- */
  const L_NA = 50.1, L_K = 73.5, L_CL = 76.3, L_H = 349.8, L_OH = 198.6;
  // 各缓冲体系逐物种 λ°（顺序 = d 值 0..n，全质子化在前；中性物种为 0）
  const SYS_LAMBDA = {
    pb:        [0, 33, 57, 69],   // H3PO4 / H2PO4⁻ / HPO4²⁻ / PO4³⁻
    acetate:   [0, 40.9],         // HAc / Ac⁻
    citrate:   [0, 30, 53, 72],   // H3CA / H2CA⁻ / HCA²⁻ / CA³⁻
    tris:      [29, 0],           // TrisH⁺ / Tris
    histidine: [45, 28, 0, 28],           // HisH⁺ / His
    glycine:   [38, 0, 37],       // GlyH⁺ / Gly± / Gly⁻
    arg_sys:   [45, 30, 0, 30],           // ArgH⁺ / Arg
    ad_arg: [45, 30, 0, 30], ad_arg_hcl: [45, 30, 0, 30], ad_tris: [29, 0],
    ad_imidazole: [32, 0], ad_his: [28, 0], ad_gly: [38, 0],
  };
  function speciesLambda(sysId, k, z) {
    if (isArg(sysId)) sysId = 'arg_sys';
    else if (sysId && sysId.startsWith('ct_')) sysId = sysId.slice(3);
    const arr = SYS_LAMBDA[sysId];
    if (arr && arr[k] != null) return arr[k];
    return z === 0 ? 0 : 35 + 20 * (Math.abs(z) - 1); // 未收录离子的通用估计
  }
  function isArg(id) { return ['arg_sys','ad_arg','ad_arg_hcl','t_arg','ct_arg_sys'].includes(id); }
  // 由离子清单 {concM, lambda} 求电导率（mS/cm）：κ = Σ c(M)·λ + H⁺/OH⁻ 水项
  function conductivityOf(ions, pH, finite = true) {
    let k = 0;
    for (const ion of ions) k += ion.concM * (ion.lambda != null ? ion.lambda : speciesLambda(null, null, ion.z));
    const h = Math.pow(10, -pH);
    k += h * L_H + (KW / h) * L_OH;
    if (finite) {
      const sum = lambda => ions.filter(i => i.lambda === lambda).reduce((s,i) => s+i.concM,0);
      // Composition-based transport estimate, not a thermodynamic activity correction.
      const arg = Math.min(ions.filter(i=>i.transport==='arg' && i.z===1 && i.lambda===30).reduce((s,i)=>s+i.concM,0), sum(L_CL));
      const nacl = Math.min(sum(L_NA), Math.max(0, sum(L_CL)-arg));
      if (nacl > 1.2 || arg > 1) return null;
      k -= nacl*(L_NA+L_CL) + arg*(30+L_CL);
      k += nacl*(L_NA+L_CL)/(1+0.55*Math.sqrt(nacl));
      // HEPES literature values are TOTALS. With no matched blank available,
      // use them only as a conservative transport envelope, not isolated Arg data.
      k += interpolate([[0,0],[.3,18],[.5,28],[.7,36],[.8,38],[.9,41],[1,43]],arg);
    }
    return Math.max(0,k); // mol/L · S·cm²/mol = 1e-3 S/cm = mS/cm
  }

  function interpolate(points, x) {
    if (x <= points[0][0]) return points[0][1];
    for (let j=1;j<points.length;j++) if(x<=points[j][0]) {
      const [a,u]=points[j-1], [b,v]=points[j]; return u+(v-u)*(x-a)/(b-a);
    }
    return points[points.length-1][1];
  }

  // Effective phosphate calibration, not a change to the thermodynamic pKa.
  const lowArgCache=new Map();
  function fitLowArgPoints(pb,arg,model) {
    const key=JSON.stringify([pb.steps,arg.steps,model]);
    if(lowArgCache.has(key))return lowArgCache.get(key);
    // Analytical dibasic phosphate in the previously generated pH6.0 recipes.
    // 5.55 is a provisional fit center for the reported interval [5.5,5.6].
    const records=[{c:.02,baseM:.002001678455289216,pH:5.84},
      {c:.2,baseM:.0029329831812836864,pH:5.55}];
    const points=records.map(record=>{
      const {c,baseM,pH}=record,cp=.02,initialD=arg.steps[0].zA-1;
      const Q=cp+baseM+c*initialD,water=KW/10**(-pH)-10**(-pH);
      let I=c+cp+2*baseM,pk=7.2;
      for(let j=0;j<100;j++) {
        const sa=speciation(arg,pH,I,model),target=(Q-c*sa.dbar-water)/cp;
        let lo=3,hi=10,sp;
        for(let k=0;k<70;k++) {
          pk=(lo+hi)/2;
          sp=speciation({...pb,empiricalPka:{1:pk},pbArgCalibration:undefined},pH,I,model);
          if(sp.dbar>target)lo=pk;else hi=pk;
        }
        const next=.5*(cp+baseM+c+cp*sp.fracs.reduce((s,f,k)=>s+f*sp.charges[k]**2,0)
          +c*sa.fracs.reduce((s,f,k)=>s+f*sa.charges[k]**2,0)+10**(-pH)+KW/10**(-pH));
        if(Math.abs(next-I)<1e-11)break;I=(I+next)/2;
      }
      return [c,pk];
    });
    lowArgCache.set(key,points);return points;
  }
  // Effective acetate calibration, not a change to the thermodynamic pKa.
  const acNaclCache=new Map();
  function fitAcetateNaclPoints(acSys,model) {
    const key=JSON.stringify([acSys.steps,model]);
    if(acNaclCache.has(key))return acNaclCache.get(key);
    // 实测均使用默认 EDH 页面配方。50 mM 点来自校准前配方；300 mM 点采用
    // v5 校准后实际配方（NaAc 79.7542%）的新复测 pH 4.7，替代旧的 4.8 先验。
    // totalQ 是对应配方在 1 L 中的 NaAc 摩尔数；显式冻结组成可避免拟合递归。
    const records=[
      {c:.05,pH:4.9,totalQ:.01365215849944258},
      {c:.3,pH:4.7,totalQ:.015950846206720472},
    ];
    const points=records.map(({c,pH,totalQ})=>{
      const cp=.02,h=10**(-pH),oh=KW/h;
      const dbar=(totalQ-oh+h)/cp; // 单步体系闭式反解：cp·dbar + oh − h = Q
      if(!(dbar>0&&dbar<1))return [c,acSys.steps[0].pKa]; // 组成异常时退回理论值
      return [c,pH-Math.log10(dbar/(1-dbar))];
    });
    acNaclCache.set(key,points);return points;
  }
  const acArgCache=new Map();
  function fitAcetateArgPoints(acSys,arg,model) {
    const key=JSON.stringify([acSys.steps,arg.steps,model]);
    if(acArgCache.has(key))return acArgCache.get(key);
    // 20 mM NaAc/HAc＋Arg-HCl。300 mM组来自历史表第123–126行，另加入
    // 用户按旧计算器精确配方（NaAc 86.96002%）复配后的pH5.30；该直接复测权重为2。
    // 500 mM仅有历史表第132行的内部比例点，因此单独标记为单点校准。
    const records=[
      {c:.3,f:.94,pH:5.60,w:1},{c:.3,f:.96,pH:5.75,w:1},
      {c:.3,f:.97,pH:5.80,w:1},{c:.3,f:.88,pH:5.20,w:1},
      {c:.3,f:4.348001/5,pH:5.30,w:2},{c:.5,f:.91,pH:5.36,w:1},
    ];
    const fitted=records.map(record=>{
      const cp=.02,h=10**(-record.pH),water=KW/h-h,initialD=arg.steps[0].zA-1;
      const totalQ=cp*record.f+record.c*initialD;
      let I=record.c+cp*record.f,pk=acSys.steps[0].pKa;
      for(let j=0;j<200;j++) {
        const sa=speciation(arg,record.pH,I,model);
        const dbar=(totalQ-record.c*sa.dbar-water)/cp;
        if(!(dbar>0&&dbar<1)) { pk=acSys.steps[0].pKa;break; }
        pk=record.pH-Math.log10(dbar/(1-dbar));
        const sp=speciation({...acSys,empiricalPka:{0:pk},naAcArgCalibration:undefined},record.pH,I,model);
        const argZ2=sa.fracs.reduce((s,f,k)=>s+f*sa.charges[k]**2,0);
        const next=.5*(cp*record.f+record.c+cp*sp.dbar+record.c*argZ2+h+KW/h);
        if(Math.abs(next-I)<1e-12){I=next;break;}I=(I+next)/2;
      }
      return {...record,pk};
    });
    const points=[.3,.5].map(c=>{
      const rows=fitted.filter(r=>r.c===c),weight=rows.reduce((s,r)=>s+r.w,0);
      return [c,rows.reduce((s,r)=>s+r.pk*r.w,0)/weight];
    });
    acArgCache.set(key,points);return points;
  }
  function calibratedInput(input) {
    if(input.empirical===false)return input;
    const bs=input.buffers||[],ads=input.additives||[];
    // 醋酸盐校准只在单一NaAc/HAc体系、单一添加剂下启用，避免参数泄漏到复合体系。
    if(bs.length===1 && bs[0].system.id==='acetate' && bs[0].system.steps.length===1 && bs[0].system.steps[0].pKa===4.76){
      const saltsA=ads.filter(a=>a.kind!=='neutral'),cpA=bs[0].concM,phA=input.targetPH;
      if(saltsA.length!==1)return input;
      const adA=saltsA[0];
      const model=input.model||'edh',cA=adA.concM;
      if(adA.stock.id==='nacl' && adA.kind==='salt' && cA>0 && cpA>=.02-1e-9 && cpA<=.025+1e-9) {
        let note='NaAc＋NaCl使用浓度相关局部校准：20 mM NaAc、目标pH5.0；50 mM NaCl校准前配方实测4.9，300 mM NaCl的v5校准配方（NaAc 79.754%）复测4.7。300 mM点以最新复测替代旧先验；新配比尚待复配实测验证。';
        if(cpA>.020000001)note+=' 实测仅20 mM NaAc，其他NaAc浓度为近似迁移。';
        if(cA>.3+1e-9 || phA<4.5 || phA>5.5)note+=' 当前条件含未验证外推：NaCl>300 mM固定300 mM处参数，pH实测仅覆盖5.0。';
        return {...input,buffers:[{...bs[0],system:{...bs[0].system,naAcNaclCalibration:{c:cA,points:fitAcetateNaclPoints(bs[0].system,model)}}}],calibrationNote:note};
      }
      if(adA.stock.id==='arg_hcl' && adA.kind==='protSalt' && isArg(adA.system?.id)
        && adA.system.steps.some(s=>s.pKa===9.04) && cA>0 && cpA>=.02-1e-9 && cpA<=.025+1e-9) {
        let note='NaAc＋Arg-HCl使用浓度相关局部校准：20 mM NaAc/HAc、300 mM历史内部点及旧计算器配方复测pH5.30，另含500 mM单点；300 mM采用稳健加权中心，新配比尚待复配实测验证。';
        if(cpA>.020000001)note+=' 实测仅20 mM NaAc，其他NaAc浓度为近似迁移。';
        if(cA>.5+1e-9 || phA<5.2 || phA>5.8)note+=' 当前条件含未验证外推：Arg-HCl>500 mM固定500 mM处参数，pH实测仅覆盖5.2–5.8。';
        return {...input,buffers:[{...bs[0],system:{...bs[0].system,naAcArgCalibration:{c:cA,points:fitAcetateArgPoints(bs[0].system,adA.system,model)}}}],calibrationNote:note};
      }
      return input;
    }
    if(bs.length!==1 || bs[0].system.id!=='pb' || bs[0].system.steps[1].pKa!==7.2)return input;
    const cp=bs[0].concM,ph=input.targetPH,salts=ads.filter(a=>a.kind!=='neutral');
    if(salts.length!==1)return input;
    const ad=salts[0];
    if(ad.stock.id==='nacl' && Math.abs(ad.concM-.5)<1e-8 && Math.abs(cp-.02)<1e-8 && ph>=6.4 && ph<=7.5) {
      return {...input,buffers:[{...bs[0],system:{...bs[0].system,empiricalPka:{1:6.383682}}}],
        calibrationNote:'PB配比使用20 mM PB＋500 mM NaCl历史记录的局部表观pKa校准。'};
    }
    if(ad.stock.id!=='arg_hcl' || ad.kind!=='protSalt' || !isArg(ad.system.id) || !ad.system.steps.some(s=>s.pKa===9.04)
      || cp<.02-1e-9 || cp>.025+1e-9 || !(ad.concM>0))return input;
    const model=input.model||'edh',c=ad.concM,pb=bs[0].system;
    const fit=([a,b,f,h])=>{
      const sp=speciation(ad.system,h,a+b*(1+2*f),model),d0=ad.system.steps[0].zA-1;
      const free=f-a/b*(sp.dbar-d0);return [a,h-Math.log10(free/(1-free))];
    };
    const old=[[.1,.025,.87,7.24],[.15,.025,.87,7.129],[.2,.025,.87,7],[.3,.025,.90,7]].map(fit);
    const shift20=fit([.3,.02,.90,6.9])[1]-old[3][1];
    const high=old.map(([a,pk])=>[a,pk+shift20*(.025-cp)/.005*a/.3]);
    const low=fitLowArgPoints(pb,ad.system,model).map(([a,pk])=>[a,pk-shift20*(cp-.02)/.005*a/.3]);
    // Both branches have the same dilute limit. Smooth pH blending avoids the
    // previous discontinuities at pH6.4 and 100mM; retain high-pH training values.
    const cal={c,low:low.concat([high[3]]),high:[low[0],...high]};
    let note='PB＋Arg-HCl使用浓度相关局部校准：新增pH6.0配方实测5.84及5.5–5.6（后者暂以5.55作拟合中心），原配方按默认EDH重建；新配比尚待复配实测验证。';
    if(cp>.020000001)note+=' 低pH数据仅有20 mM PB，其他PB浓度为近似迁移。';
    if(c<.02 || c>.3 || ph<5.5 || ph>7.5)note+=' 当前条件含未验证外推；高浓度固定300 mM边界条件参数，极端pH平滑回归理论模型。';
    return {...input,buffers:[{...bs[0],system:{...pb,pbArgCalibration:cal}}],calibrationNote:note};
  }
  function phosphateArgPka(system,pH,I,model) {
    const cal=system.pbArgCalibration,base=apparentPka(system.steps[1],I,model);
    const smooth=x=>{x=Math.max(0,Math.min(1,x));return x*x*(3-2*x);};
    const lo=interpolate([[0,base],...cal.low],cal.c),hi=interpolate([[0,base],...cal.high],cal.c);
    const blend=smooth((pH-6)/.4),local=lo+(hi-lo)*blend;
    const weight=smooth(pH-4.5)*(1-smooth(pH-7.5));
    return base+weight*(local-base);
  }
  function acetateNaclPka(system,pH,I,model) {
    const cal=system.naAcNaclCalibration,base=apparentPka(system.steps[0],I,model);
    return interpolate([[0,base],...cal.points],cal.c); // c→0 平滑回到理论表观 pKa
  }
  function acetateArgPka(system,pH,I,model) {
    const cal=system.naAcArgCalibration,base=apparentPka(system.steps[0],I,model);
    // 保持同一组成下的pH→解离度严格单调；实测pH范围外只警告，不在pH轴上切换参数。
    return interpolate([[0,base],...cal.points],cal.c);
  }

  /* ---------- 活度 ---------- */
  function logGamma(z, I, model) {
    if (z === 0 || I <= 0) return 0;
    const s = Math.sqrt(I);
    if (model === 'davies') {
      return -A_DH * z * z * (s / (1 + s) - 0.3 * I);
    }
    return -A_DH * z * z * s / (1 + B_DH * ION_SIZE * s); // edh
  }
  function gamma(z, I, model) { return Math.pow(10, logGamma(z, I, model)); }

  // 表观 pKa：pKa_app = pKa + logγ(zB) − logγ(zA)
  function apparentPka(step, I, model) {
    return step.pKa + logGamma(step.zB, I, model) - logGamma(step.zA, I, model);
  }

  /* ---------- 体系物种分布 ----------
   * system.steps: [{pKa, zA, zB}] 按解离顺序排列
   * 物种 k = 0..n，k 为已解离质子数（d 值）
   * 返回 {fracs:[f0..fn], dbar, charges:[z0..zn]}
   */
  function speciation(system, pH, I, model) {
    const steps = system.steps;
    const n = steps.length;
    const w = [1];
    for (let k = 0; k < n; k++) {
      const pk = k===0 && system.naAcArgCalibration ? acetateArgPka(system,pH,I,model)
        : k===0 && system.naAcNaclCalibration ? acetateNaclPka(system,pH,I,model)
        : k===1 && system.pbArgCalibration ? phosphateArgPka(system,pH,I,model)
        : (system.empiricalPka?.[k] ?? apparentPka(steps[k],I,model));
      const r = Math.pow(10,pH-pk);
      w.push(w[k] * r);
    }
    let sum = 0; for (const v of w) sum += v;
    const fracs = w.map(v => v / sum);
    let dbar = 0;
    for (let k = 0; k <= n; k++) dbar += k * fracs[k];
    const charges = [steps[0].zA];
    for (let k = 0; k < n; k++) charges.push(steps[k].zB);
    return { fracs, dbar, charges };
  }

  /* ---------- 由一组组分求混合 pH（质子守恒，二分法） ----------
   * components: [{system, conc(M), vol(L), fromPH}]
   */
  function solveMixPH(components, I, model, solutions) {
    // 每份实际溶液仅计一次水项；旧调用默认每条组分代表独立溶液。
    const liquids = solutions || components;
    const oh = pH => KW / Math.pow(10, -pH);
    const h = pH => Math.pow(10, -pH);
    let volTot = 0;
    for (const c of liquids) volTot += c.vol;
    function Q(pH) { // 需要从外界加入的强碱 mol（>0 表示偏酸）
      let q = 0;
      for (const c of components) {
        const s = speciation(c.system, pH, I, model);
        const s0 = speciation(c.system, c.fromPH, c.sourceI ?? I, model);
        q += c.conc * c.vol * (s.dbar - s0.dbar);
      }
      q += volTot * (oh(pH) - h(pH));
      for (const c of liquids) q -= c.vol * (oh(c.fromPH) - h(c.fromPH));
      return q;
    }
    let lo = 0, hi = 14;
    for (let i = 0; i < 200; i++) {
      const mid = (lo + hi) / 2;
      if (Q(mid) > 0) hi = mid; else lo = mid;
    }
    return (lo + hi) / 2;
  }

  /* ---------- 配方计算（标签页①核心） ----------
   * input: {
   *   buffers: [{system, concM}],          // 已勾选缓冲体系及浓度(M)
   *   targetPH, targetVolL,
   *   additives: [
   *     {kind:'salt',    concM, stock, zCat, zAn}        // NaCl/GdnHCl 类
   *     {kind:'neutral', stock, volL}                    // 蔗糖类，只占体积
   *     {kind:'protSalt',concM, stock, system}           // Arg-HCl 类：加入时全质子化
   *     {kind:'protBase',concM, stock, system}           // Arg/咪唑游离碱类：加入时全去质子化
   *     {kind:'premix',  stock, volL, system, concM, dbarStock, saltIons:[{z,concM}]}
   *   ],
   *   model, titrantConcM: {NaOH, HCl}
   * }
   * 质子负荷（添加剂吸/放质子、预混液 pH 差）优先摊入有酸碱配比自由的缓冲体系，
   * 摊不下的部分才折算为虚拟 NaOH/HCl。
   */
  function calcRecipe(input) {
    input = calibratedInput(input);
    const model = input.model || 'edh';
    const pH = input.targetPH;
    const V = input.targetVolL;
    const tConc = input.titrantConcM || { NaOH: 1, HCl: 1 };

    let I = 0, result = null, converged=false;
    for (let iter = 0; iter < 50; iter++) {
      result = recipeAtI(input, I, model, pH, V, tConc);
      const Inew = result.ionicStrength;
      if (Math.abs(Inew - I) < 1e-6) { I = Inew; converged=true; break; }
      I = Inew;
    }
    result = recipeAtI(input,I,model,pH,V,tConc);
    if(!converged) result.warnings.push('离子强度迭代尚未收敛，配方仅供参考。');
    result.ionicStrength = I;
    // 反推 pH 校验所需组分（含质子化盐/游离碱/预混液的缓冲组分）
    result._comps = input.buffers.map(b => ({ system: b.system, CV: b.concM * V }));
    for (const ad of (input.additives || [])) {
      if (ad.kind === 'protSalt' || ad.kind === 'protBase') result._comps.push({ system: ad.system, CV: ad.concM * V });
      if (ad.kind === 'premix') result._comps.push({ system: ad.system, CV: ad.concM * ad.volL });
    }
    result.checkPH = backCheckPH(result, I, model, V);
    result.chargeResidual=result.ions.reduce((s,a)=>s+a.z*a.concM,0)+Math.pow(10,-pH)-KW/Math.pow(10,-pH);
    if(Math.abs(result.chargeResidual)>1e-6) result.warnings.push('配方离子清单不满足电中性：请核对自定义母液的Na/Cl计数、解离步数和预混组成；模型内pH复核不能证明此配方正确。');
    if (result.checkPH == null || !Number.isFinite(result.checkPH) || Math.abs(result.checkPH - pH) > 0.02) {
      result.warnings.push(`配方 pH 复核未达到目标 ${pH}，请勿直接使用该配方；请检查输入或调整配方。`);
    }
    // 可达性：配制页用虚拟强酸/强碱调节，故"不可达"指终态 pH 未命中目标。
    // 报出模型能给出的最近 pH（即复核值）与差距，供用户直接判断改怎么调。
    {
      const achieved = result.checkPH;
      const deviation = (achieved == null || !Number.isFinite(achieved)) ? null : achieved - pH;
      result.reachability = {
        target: pH,
        achieved: (achieved == null || !Number.isFinite(achieved)) ? null : achieved,
        deviation,
        feasible: deviation != null && Math.abs(deviation) <= 0.02,
        reason: deviation == null ? 'noCheckPH' : (Math.abs(deviation) > 0.02 ? 'checkMismatch' : null),
      };
      if (result.reachability.reason === 'checkMismatch') {
        result.warnings.push(`当前条件可达到的 pH 为 ${achieved.toFixed(2)}（目标 ${pH}，相差 ${deviation >= 0 ? '+' : ''}${deviation.toFixed(2)} pH）。请调整缓冲剂浓度/体积，或勾选「允许使用 NaOH/HCl」后重算。`);
      } else if (result.reachability.reason === 'noCheckPH') {
        result.warnings.push('无法反算该配方的终态 pH，不能判断目标 pH 是否可达；请检查缓冲体系与母液定义。');
      }
    }
    // 缓冲容量 β (mol/L/pH)，只计缓冲体系
    let beta = 0;
    const dp = 0.001;
    for (const b of input.buffers) {
      const s1 = speciation(b.system, pH + dp, I, model);
      const s0 = speciation(b.system, pH - dp, I, model);
      beta += b.concM * (s1.dbar - s0.dbar) / (2 * dp);
    }
    result.beta = beta;
    // 估算电导率（mS/cm，极限摩尔电导加和，含 H⁺/OH⁻ 水项）
    result.conductivityIdeal = conductivityOf(result.ions, pH, false);
    result.conductivity = conductivityOf(result.ions, pH);
    const ads=input.additives||[], active=ads.filter(a=>a.kind!=='neutral');
    const na=active.find(a=>a.stock.id==='nacl');
    if(na && na.concM>1) result.conductivity=null;
    if(active.some(a=>isArg(a.system?.id) && a.concM>1)) result.conductivity=null;
    // Fit the salt-dependent increment in the SAME background, retaining its baseline.
    // Reference recalculations are pure and do not apply this normalization recursively.
    const pbs=active.find(a=>a.stock.id==='pbs10x');
    const pbBackground=active.length===1 && na && input.buffers.length===1 && input.buffers[0].system.id==='pb' && Math.abs(input.buffers[0].concM-.02)<1e-8 && Math.abs(pH-7)<.01;
    const pbsBackground=active.length===2 && na && pbs && Math.abs(pbs.volL/V-.1)<1e-8 && !input.buffers.length && Math.abs(pH-7.4)<.01;
    if(!input._conductivityReference && na && na.concM<=1 && (pbBackground || pbsBackground)) {
      const refC=pbBackground ? .5 : 1, target=pbBackground ? 50 : 100;
      const baseline=calcRecipe({...input,empirical:false,_conductivityReference:true,
        buffers:input.buffers.map(b=>({...b,system:{...b.system,empiricalPka:undefined}})),
        additives:ads.map(a=>a===na ? {...a,concM:0} : a)}).conductivity;
      const backgroundSalt=pbsBackground ? .137 : 0;
      const transport=c=>c/(1+.55*Math.sqrt(c));
      const increment=c=>transport(c+backgroundSalt)-transport(backgroundSalt);
      if(result.conductivity!=null) result.conductivity=baseline+(target-baseline)*increment(na.concM)/increment(refC);
      result.warnings.push(pbBackground ? '电导率曲线按20 mM PB、pH约7、500 mM NaCl总值50 mS/cm归一化；其余浓度为工程插值/外推，限NaCl≤1 M。' : '电导率按额外1 M NaCl＋1×PBS、pH约7.4总值100 mS/cm归一化；包含PBS，其他浓度为近似。');
    }
    if(input.calibrationNote) result.warnings.push(input.calibrationNote);
    result.warnings.push('电导率为有限浓度工程估计，测量温度与混合盐效应未校准；超范围不报数值。');
    if(active.some(a=>isArg(a.system?.id))) result.warnings.push('Arg-HCl：300 mM暂按约18 mS/cm的盐贡献处理；HEPES文献总值仅作贡献上沿近似，含背景偏差，不是PB总电导率实测曲线。');
    result.warnings.push('pH复核只检查模型内部守恒，不是实测准确性验证；母液按标签化学组成计量，若预先调过酸碱需记录实际组成。');
    return result;
  }

  function recipeAtI(input, I, model, pH, V, tConc) {
    const lines = [];       // {name, moles, volL, note, stockId, kind}
    const warnings = [];
    const ions = [];        // {z, concM}
    let totalQ = 0;         // 母液提供的去质子化数总和 (mol·d)
    let netLoad = V * (KW / Math.pow(10, -pH) - Math.pow(10, -pH));        // 净质子负荷（>0 = 需要额外碱式组分）

    // 母液游离质子修正：q = 每 mol 母液带入的游离 (H+ − OH−)
    // dStock is the analytical proton inventory of a chemical stock.
    // Dissociation redistributes bound/free protons; refpH must not be added twice.
    const qm = () => 0;

    /* ---- 1) 添加剂（先算，收集质子负荷） ---- */
    for (const ad of (input.additives || [])) {
      if (ad.kind === 'neutral') {
        lines.push({ name: ad.stock.name, stockId: ad.stock.id, moles: 0, volL: ad.volL || 0, kind: 'additive', note: '非离子，不占离子强度' });
        continue;
      }
      if (ad.kind === 'salt') {
        const moles = ad.concM * V;
        lines.push({ name: ad.stock.name, stockId: ad.stock.id, moles, volL: moles / ad.stock.concM, kind: 'additive', note: '' });
        // 阳离子：NaCl 类为 Na⁺；GdnHCl 类（na=0,cl=1）为有机阳离子本身（λ≈54）
        ions.push({ z: ad.zCat || 1, concM: ad.concM, lambda: ad.stock.na ? L_NA : 54 });
        ions.push({ z: ad.zAn || -1, concM: ad.concM, lambda: ad.stock.cl ? L_CL : 40 });
        continue;
      }
      if (ad.kind === 'premix') {
        // 预混母液（如 10× PBS）：含已知组成的缓冲组分 + 盐
        const volL = ad.volL;
        const moles = ad.concM * volL;
        const cf = moles / V;
        lines.push({ name: ad.stock.name, stockId: ad.stock.id, moles, volL, kind: 'premix', note: `预混，缓冲组分终浓度 ${(cf * 1000).toFixed(1)} mM` });
        const sp = speciation(ad.system, pH, I, model);
        for (let k = 0; k < sp.fracs.length; k++) {
          if (sp.charges[k] !== 0) ions.push({ z: sp.charges[k], concM: cf * sp.fracs[k], transport: isArg(ad.system.id) ? 'arg' : null, lambda: speciesLambda(ad.system.id, k, sp.charges[k]) });
        }
        for (const ion of (ad.saltIons || [])) ions.push({ z: ion.z, concM: ion.concM * volL / V, lambda: ion.lambda != null ? ion.lambda : (ion.z > 0 ? L_NA : L_CL) });
        netLoad += moles * (sp.dbar - ad.dbarStock);
        totalQ += moles * ad.dbarStock;
        continue;
      }
      if (ad.kind === 'protSalt') {
        // Arg-HCl 类：按带一个Cl⁻的分析质子库存加入；目标pH下可向任一方向发生微量质子交换。
        const moles = ad.concM * V;
        lines.push({ name: ad.stock.name, stockId: ad.stock.id, moles, volL: moles / ad.stock.concM, kind: 'additive', note: '' });
        const sp = speciation(ad.system, pH, I, model);
        for (let k = 0; k < sp.fracs.length; k++) {
          if (sp.charges[k] !== 0) ions.push({ z: sp.charges[k], concM: ad.concM * sp.fracs[k], transport: isArg(ad.system.id) ? 'arg' : null, lambda: speciesLambda(ad.system.id, k, sp.charges[k]) });
        }
        ions.push({ z: -1, concM: ad.concM, lambda: L_CL }); // Cl-
        const initialD = ad.system.steps[0].zA - 1;
        totalQ += moles * initialD;
        const released = moles * (sp.dbar - initialD);
        netLoad += released;
        if (released > 1e-9) warnings.push(`「${ad.stock.name}」在 pH ${pH.toFixed(1)} 下部分去质子化，释放 ${(released * 1000).toFixed(2)} mmol 质子，已由缓冲体系配比吸收（不足部分折算 NaOH）`);
        else if (released < -1e-9) warnings.push(`「${ad.stock.name}」在 pH ${pH.toFixed(1)} 下进一步质子化，吸收 ${(-released * 1000).toFixed(2)} mmol 质子，已由缓冲体系配比吸收（不足部分折算 HCl）`);
        continue;
      }
      if (ad.kind === 'protBase') {
        // Arg/咪唑游离碱类：加入时全去质子化（d=1），目标 pH 下部分质子化消耗质子
        const moles = ad.concM * V;
        lines.push({ name: ad.stock.name, stockId: ad.stock.id, moles, volL: moles / ad.stock.concM, kind: 'additive', note: '' });
        const sp = speciation(ad.system, pH, I, model);
        for (let k = 0; k < sp.fracs.length; k++) {
          if (sp.charges[k] !== 0) ions.push({ z: sp.charges[k], concM: ad.concM * sp.fracs[k], transport: isArg(ad.system.id) ? 'arg' : null, lambda: speciesLambda(ad.system.id, k, sp.charges[k]) });
        }
        const initialD = ad.system.steps[0].zA;
        const consumed = moles * (initialD - sp.dbar);
        netLoad -= consumed;
        if (Math.abs(consumed) > 1e-9) {
          warnings.push(`「${ad.stock.name}」在 pH ${pH.toFixed(1)} 下部分质子化，消耗 ${(consumed * 1000).toFixed(2)} mmol 质子，已由缓冲体系配比吸收（不足部分折算 HCl）`);
        }
        totalQ += moles * initialD;
        continue;
      }
    }

    /* ---- 2) 缓冲体系：候选方案全局优选 ----
     * 复合配方（多缓冲对）在同一目标 pH 下存在多种母液组合（体系间质子负荷可相互转移），
     * 这里枚举各体系的候选用量方案，按"尽量避免 <1 mL 吸取体积 → 尽量避免虚拟滴定剂 → 最小体积最大化"优选。
     */
    const MIN_VOL_L = 1e-3; // 1 mL 最小吸取体积
    const sysInfos = [];
    for (const b of input.buffers) {
      const sp = speciation(b.system, pH, I, model);
      const CV = b.concM * V;
      for (let k = 0; k < sp.fracs.length; k++) {
        if (sp.charges[k] !== 0) ions.push({ z: sp.charges[k], concM: b.concM * sp.fracs[k], transport: isArg(b.system.id) ? 'arg' : null, lambda: speciesLambda(b.system.id, k, sp.charges[k]) });
      }
      const stocks = (b.system.stocks || []).slice().sort((a, c) => a.dStock - c.dStock);
      if (!stocks.length) { warnings.push(`体系「${b.system.name}」没有可用母液`); continue; }
      if (b.system.id==='histidine' && b.system.steps.length===1) warnings.push('自定义His仍为单步模型；极端pH缺少羧基/氨基解离，请采用新版默认三步体系。');
      const inRange = b.system.range && pH >= b.system.range[0] && pH <= b.system.range[1];
      const inRange2 = b.system.range2 && pH >= b.system.range2[0] && pH <= b.system.range2[1];
      if (b.system.range && !inRange && !inRange2) {
        warnings.push(`「${b.system.name}」目标 pH ${pH.toFixed(2)} 超出建议范围 ${b.system.range[0]}–${b.system.range[1]}${b.system.range2 ? ' / ' + b.system.range2[0] + '–' + b.system.range2[1] : ''}，缓冲能力弱`);
      }
      sysInfos.push({ b, CV, dbar: sp.dbar, stocks });
    }

    // 单体系候选方案；supplied = Σ moles·(d−q)，与 needed = CV·dbar 之差 = 向外转移的质子负荷
    function candidatesOf(info) {
      const { CV, dbar, stocks } = info;
      const solo = s => ({ acid: { stock: s, moles: CV }, base: null, supplied: CV * (s.dStock - qm(s)) });
      if (dbar <= stocks[0].dStock) return [solo(stocks[0])];
      if (dbar >= stocks[stocks.length - 1].dStock) return [solo(stocks[stocks.length - 1])];
      const cands = [];
      // 相邻夹逼配对（与旧版贪心一致，作为自然配比）
      let adjI = -1;
      for (let i = 0; i < stocks.length - 1; i++) {
        if (stocks[i].dStock <= dbar && stocks[i + 1].dStock >= dbar) { adjI = i; break; }
      }
      for (let i = 0; i < stocks.length; i++) {
        for (let j = i + 1; j < stocks.length; j++) {
          const s0 = stocks[i], s1 = stocks[j];
          if (!(s0.dStock <= dbar && s1.dStock >= dbar)) continue;
          const d0 = s0.dStock - qm(s0), d1 = s1.dStock - qm(s1);
          const denom = d1 - d0;
          if (denom < 1e-9) continue;
          const baseMol = CV * (dbar - d0) / denom;
          // 相邻配对为自然配比（无负荷转移时的默认解）
          cands.push({ acid: { stock: s0, moles: CV - baseMol }, base: { stock: s1, moles: baseMol }, supplied: CV * dbar, natural: j === adjI + 1 && i === adjI, d0, d1 });
          // 边界变体：让某一侧恰好为 1 mL 当量（换取另一侧省掉或达标）
          const minA = MIN_VOL_L * s0.concM, minB = MIN_VOL_L * s1.concM;
          if (CV - minA > 1e-12) cands.push({ acid: { stock: s0, moles: minA }, base: { stock: s1, moles: CV - minA }, supplied: minA * d0 + (CV - minA) * d1 });
          if (CV - minB > 1e-12) cands.push({ acid: { stock: s0, moles: CV - minB }, base: { stock: s1, moles: minB }, supplied: (CV - minB) * d0 + minB * d1 });
        }
      }
      // 单母液方案（省掉另一种母液，质子差额由其他体系/滴定补偿）
      for (const s of stocks) cands.push(solo(s));
      return cands;
    }

    const candLists = sysInfos.map(candidatesOf);
    // 连续调节者：拥有自然配对且 CV 最大的体系，沿其配对微调 baseMol 吸收残差
    let contIdx = -1, contRoom = -1;
    sysInfos.forEach((info, i) => {
      if (candLists[i].some(c => c.natural) && info.CV > contRoom) { contRoom = info.CV; contIdx = i; }
    });
    const discreteIdxs = sysInfos.map((_, i) => i).filter(i => i !== contIdx);
    let combos = [[]];
    let overflow = false;
    for (const i of discreteIdxs) {
      const next = [];
      for (const combo of combos) {
        for (const cand of candLists[i]) {
          next.push(combo.concat([[i, cand]]));
          if (next.length > 300000) { overflow = true; break; }
        }
        if (overflow) break;
      }
      if (overflow) { // 组合爆炸时退化为全自然配比
        combos = [sysInfos.map((_, ii) => [ii, (candLists[ii].find(c => c.natural) || candLists[ii][0])])];
        break;
      }
      combos = next;
    }

    function scoreOf(assignEntries, naoh, hcl) {
      let tiny = 0, minVol = Infinity, nonNat = 0;
      for (const [, cand] of assignEntries) {
        if (!cand.natural) nonNat++;
        for (const u of [cand.acid, cand.base]) {
          if (!u || u.moles <= 1e-12) continue;
          const vol = u.moles / u.stock.concM;
          if (vol < MIN_VOL_L - 1e-9) tiny++;
          else if (vol < minVol) minVol = vol;
        }
      }
      const titrantBad = (naoh + hcl) > (TITRANT_EPS_M * V) ? 1 : 0;
      return [tiny, titrantBad, nonNat, -minVol];
    }
    function cmpScore(a, b) {
      for (let k = 0; k < 4; k++) { if (a[k] !== b[k]) return a[k] < b[k] ? -1 : 1; }
      return 0;
    }

    let best = null;
    for (const combo of combos) {
      const assign = new Map(combo);
      let transfer = 0;
      for (const [i, cand] of combo) transfer += cand.supplied - sysInfos[i].CV * sysInfos[i].dbar;
      let residual = netLoad - transfer;
      if (contIdx >= 0) {
        const info = sysInfos[contIdx];
        const nat = candLists[contIdx].find(c => c.natural);
        let baseMol = nat.base.moles + residual / (nat.d1 - nat.d0);
        baseMol = Math.max(0, Math.min(info.CV, baseMol));
        const contCand = { acid: { stock: nat.acid.stock, moles: info.CV - baseMol }, base: { stock: nat.base.stock, moles: baseMol }, supplied: (info.CV - baseMol) * nat.d0 + baseMol * nat.d1, natural: true };
        residual -= (contCand.supplied - info.CV * info.dbar);
        assign.set(contIdx, contCand);
      }
      const naoh = residual > 0 ? residual : 0, hcl = residual < 0 ? -residual : 0;
      const score = scoreOf(Array.from(assign), naoh, hcl);
      if (!best || cmpScore(score, best.score) < 0) best = { assign, naoh, hcl, score };
    }

    // 按体系顺序生成母液行与离子台账
    sysInfos.forEach((info, i) => {
      const cand = best.assign.get(i);
      if (!cand) return;
      // 每个缓冲对先展示较高解离当量的碱式母液，再展示酸式母液。
      for (const u of [cand.base, cand.acid]) {
        if (!u || u.moles <= 1e-12) continue;
        const volL = u.moles / u.stock.concM;
        lines.push({ name: u.stock.name, stockId: u.stock.id, moles: u.moles, volL, kind: 'stock', note: `d=${u.stock.dStock}` });
        totalQ += u.moles * u.stock.dStock;
        if (u.stock.na) ions.push({ z: 1, concM: u.stock.na * u.moles / V, lambda: L_NA });
        if (u.stock.cl) ions.push({ z: -1, concM: u.stock.cl * u.moles / V, lambda: L_CL });
      }
    });

    /* ---- 3) 摊不完的质子负荷 → 虚拟滴定剂 ---- */
    let naohMol = 0, hclMol = 0;
    if (best) { naohMol = best.naoh; hclMol = best.hcl; }
    else if (netLoad > 0) naohMol = netLoad; else hclMol = -netLoad;
    if (naohMol > (TITRANT_EPS_M * V)) {
      lines.push({ name: `NaOH（虚拟，${tConc.NaOH} M）`, moles: naohMol, volL: naohMol / tConc.NaOH, kind: 'titrant', note: '缓冲体系配比无法吸收的残余质子负荷' });
      ions.push({ z: 1, concM: naohMol / V, lambda: L_NA });
      totalQ += naohMol;
    }
    if (hclMol > (TITRANT_EPS_M * V)) {
      lines.push({ name: `HCl（虚拟，${tConc.HCl} M）`, moles: hclMol, volL: hclMol / tConc.HCl, kind: 'titrant', note: '缓冲体系配比无法吸收的残余质子负荷' });
      ions.push({ z: -1, concM: hclMol / V, lambda: L_CL });
      totalQ -= hclMol;
    }

    // 离子强度
    let Isum = 0;
    for (const ion of ions) Isum += ion.concM * ion.z * ion.z;
    const ionicStrength = 0.5 * (Isum + Math.pow(10,-pH) + KW/Math.pow(10,-pH));

    // 补水
    let used = 0;
    for (const l of lines) used += l.volL;
    const waterL = V - used;

    for (const l of lines) {
      if (l.kind === 'stock' && l.volL * 1e6 < 10) {
        warnings.push(`「${l.name}」吸取体积 ${(l.volL * 1e6).toFixed(1)} µL 过小，建议预稀释母液`);
      } else if (l.kind === 'stock' && l.volL < MIN_VOL_L) {
        warnings.push(`「${l.name}」吸取体积 ${(l.volL * 1000).toFixed(2)} mL 小于 1 mL（复合配方已优化仍无法避免），建议预稀释母液后吸取`);
      }
    }
    if (waterL < 0) warnings.push('母液总体积超过目标体积，无法配制！请降低浓度或换更浓母液');
    if (ionicStrength > 0.1) warnings.push(`离子强度 ${(ionicStrength * 1000).toFixed(0)} mM > 100 mM，活度模型误差增大，仅供参考`);

    return { lines, warnings, ions, ionicStrength, waterL, totalQ, naohMol, hclMol };
  }

  // 用配方反推 pH：Σ CV·dbar(pH) = totalQ + 水项
  function backCheckPH(result, I, model, V) {
    const comps = result._comps || [];
    if (!comps.length) return null;
    const Q = result.totalQ;
    function f(pH) {
      let lhs = 0;
      for (const c of comps) lhs += c.CV * speciation(c.system, pH, I, model).dbar;
      lhs += V * ((KW / Math.pow(10, -pH)) - Math.pow(10, -pH));
      return lhs - Q;
    }
    let lo = 0, hi = 14;
    if (f(lo) > 0 || f(hi) < 0) return null;
    for (let i = 0; i < 200; i++) {
      const mid = (lo + hi) / 2;
      if (f(mid) > 0) hi = mid; else lo = mid;
    }
    return (lo + hi) / 2;
  }

  function sourceIonicStrength(buf, model) {
    let I=buf.saltI||0;
    for(let j=0;j<100;j++) {
      let sum=2*(buf.saltI||0), net=Math.pow(10,-buf.pH)-KW/Math.pow(10,-buf.pH);
      for(const c of buf.components) {
        const sp=speciation(c.system,buf.pH,I,model);
        sp.fracs.forEach((f,k)=>{sum+=c.concM*f*sp.charges[k]**2;net+=c.concM*f*sp.charges[k];});
      }
      const next=.5*(sum+Math.abs(net)+Math.pow(10,-buf.pH)+KW/Math.pow(10,-buf.pH));
      if(Math.abs(next-I)<1e-10) return next;
      I=(I+next)/2;
    }
    return I;
  }

  /* ---------- 洗脱中和计算（标签页②核心） ----------
   * input: {
   *   bufA: {components:[{system, concM}], pH, saltI},   // saltI = 1:1 盐浓度之和(M)
   *   bufB: {components:[{system, concM}], pH, saltI},
   *   fracB (0-1), targetPH, sampleVolL,
   *   titrant: {system, concM, reagentPH, name}
   *     （兼容旧式 {system, stock(concM, refpH), name}；system 可为多 pKa 缓冲对）
   *   model, tolerancePH
   * }
   */
  function calcNeutralization(input) {
    const model = input.model || 'edh';
    const x = input.fracB;
    const V = input.sampleVolL;
    const solutions = [
      { vol: V * (1 - x), fromPH: input.bufA.pH },
      { vol: V * x, fromPH: input.bufB.pH },
    ].filter(s => s.vol > 0);
    const sourceIA=sourceIonicStrength(input.bufA,model), sourceIB=sourceIonicStrength(input.bufB,model);
    const comps = [];
    for (const c of input.bufA.components) comps.push({ system: c.system, conc: c.concM, vol: V * (1 - x), fromPH: input.bufA.pH, sourceI: sourceIA });
    for (const c of input.bufB.components) comps.push({ system: c.system, conc: c.concM, vol: V * x, fromPH: input.bufB.pH, sourceI: sourceIB });
    const live = comps.filter(c => c.vol > 0 && c.conc > 0);
    const saltI = (input.bufA.saltI || 0) * (1 - x) + (input.bufB.saltI || 0) * x;

    const water=p=>KW/Math.pow(10,-p)-Math.pow(10,-p);
    // Each physical stock contributes ONE fixed counterion inventory.
    function counterOf(buf, sourceI, vol) {
      let net=-water(buf.pH);
      for(const c of buf.components) {
        const sp=speciation(c.system,buf.pH,sourceI,model);
        net+=c.concM*sp.fracs.reduce((s,f,k)=>s+f*sp.charges[k],0);
      }
      return {z:net>0 ? -1 : 1,moles:Math.abs(net)*vol,lambda:net>0 ? L_CL : L_NA};
    }
    const fixed=[counterOf(input.bufA,sourceIA,V*(1-x)),counterOf(input.bufB,sourceIB,V*x),
      {z:1,moles:saltI*V,lambda:L_NA},{z:-1,moles:saltI*V,lambda:L_CL}];
    function sampleIons(pHstate, ionicI, vol) {
      const arr=fixed.map(a=>({...a,concM:a.moles/vol}));
      for(const c of live) {
        const sp=speciation(c.system,pHstate,ionicI,model);
        sp.fracs.forEach((f,k)=>{if(sp.charges[k]) arr.push({z:sp.charges[k],concM:c.conc*c.vol*f/vol,
          transport:isArg(c.system.id)?'arg':null,lambda:speciesLambda(c.system.id,k,sp.charges[k])});});
      }
      return arr;
    }
    const ionStrength=(ions,pH)=>.5*(ions.reduce((s,a)=>s+a.concM*a.z*a.z,0)+Math.pow(10,-pH)+KW/Math.pow(10,-pH));
    let I=Math.max(.001,saltI),mixPH=null;
    for(let j=0;j<100;j++) {
      mixPH=solveMixPH(live,I,model,solutions);
      const next=ionStrength(sampleIons(mixPH,I,V),mixPH);
      if(Math.abs(next-I)<1e-10) {I=next;break;}
      I=(I+next)/2;
    }
    mixPH=solveMixPH(live,I,model,solutions);

    function needBaseMol(pHt) { // 从 mixPH 滴定到 pHt 所需强碱 mol
      let n = 0;
      for (const c of live) {
        const s1 = speciation(c.system, pHt, I, model);
        const s0 = speciation(c.system, mixPH, I, model);
        n += c.conc * c.vol * (s1.dbar - s0.dbar);
      }
      const oh = p => KW / Math.pow(10, -p), hh = p => Math.pow(10, -p);
      n += V * ((oh(pHt) - hh(pHt)) - (oh(mixPH) - hh(mixPH)));
      return n;
    }

    const t = input.titrant;
    // 兼容两种形态：新式 {system, concM, reagentPH}；旧式 {system, stock{concM, refpH}}
    const tConcM = t.concM != null ? t.concM : (t.stock ? t.stock.concM : 0);
    const tRefPH = t.reagentPH != null ? t.reagentPH : (t.stock ? t.stock.refpH : null);
    const titrantI=tRefPH==null ? I : sourceIonicStrength({components:[{system:t.system,concM:tConcM}],pH:tRefPH,saltI:0},model);
    function effectiveFrac(pHt) {
      // 每 mol 试剂净吸收质子 = 试剂自身 pH 下平均解离度 − 目标 pH 下平均解离度
      // （对单 pKa 碱式试剂，等价于旧式"目标 pH 质子化比例 − 母液 pH 质子化比例"）
      if (tRefPH == null) return 0;
      return speciation(t.system, tRefPH, titrantI, model).dbar - speciation(t.system, pHt, I, model).dbar;
    }

    const warnings = ['中和计算分别求原液、试剂与加液后离子强度；电导率为有限浓度近似，高盐混合体系未校准。'];
    const titrantCounter=tRefPH==null ? null : counterOf({components:[{system:t.system,concM:tConcM}],pH:tRefPH},titrantI,1);
    function finalIons(pHstate, ionicI, dose) {
      const vol=V+dose,arr=sampleIons(pHstate,ionicI,vol);
      const sp=speciation(t.system,pHstate,ionicI,model);
      sp.fracs.forEach((f,k)=>{if(sp.charges[k]) arr.push({z:sp.charges[k],concM:tConcM*dose*f/vol,
        transport:isArg(t.system.id)?'arg':null,lambda:speciesLambda(t.system.id,k,sp.charges[k])});});
      if(titrantCounter) arr.push({...titrantCounter,concM:titrantCounter.moles*dose/vol});
      return arr;
    }
    // Independent forward equilibrium for the chart cursor's arbitrary dose.
    if (input.probeDoseL != null) {
      const dose=input.probeDoseL;
      if(!Number.isFinite(dose) || dose<0 || tRefPH==null) throw new Error('滴定体积或试剂pH无效');
      const probeComps=live.concat([{system:t.system,conc:tConcM,vol:dose,fromPH:tRefPH,sourceI:titrantI}]);
      const probeSolutions=solutions.concat([{vol:dose,fromPH:tRefPH}]);
      let endI=I,ph=mixPH;
      for(let j=0;j<150;j++) {
        ph=solveMixPH(probeComps,endI,model,probeSolutions);
        const next=ionStrength(finalIons(ph,endI,dose),ph);
        if(Math.abs(next-endI)<1e-9) return {pH:ph,ionicStrength:endI,converged:true};
        endI=(endI+next)/2;
      }
      return {pH:null,ionicStrength:endI,converged:false};
    }
    // 滴定方向由质子守恒的符号决定：n>0 需加碱，n<0 需加酸（不依赖 pHt 与 mixPH 的大小比较）。
    // 可行性判据 = n 与 capacity 同号，等价于目标 pH 落在 [mixPH, 试剂pH] 区间内。
    const titrantIsAcid = tRefPH != null && tRefPH < mixPH;
    function doseAt(pHt) {
      if(tRefPH==null || !(tConcM>0)) return {v:null,I:null,n:needBaseMol(pHt),g:effectiveFrac(pHt)};
      let endI=I,v=0,n=0,g=0,converged=false;
      for(let j=0;j<200;j++) {
        n=V*water(pHt)-solutions.reduce((s,c)=>s+c.vol*water(c.fromPH),0);
        for(const c of live) n+=c.conc*c.vol*(speciation(c.system,pHt,endI,model).dbar-speciation(c.system,c.fromPH,c.sourceI,model).dbar);
        g=speciation(t.system,tRefPH,titrantI,model).dbar-speciation(t.system,pHt,endI,model).dbar;
        const capacity=tConcM*g+water(tRefPH)-water(pHt);
        // 同号 => 方向可行且 v=n/capacity>0；异号 => 试剂能力方向相反，目标不可达。
        if(!((n>0&&capacity>0)||(n<0&&capacity<0))) return {v:null,I:null,n,g};
        v=n/capacity;
        const next=ionStrength(finalIons(pHt,endI,v),pHt);
        if(Math.abs(next-endI)<1e-10) {converged=true;break;}
        endI=(next+endI)/2;
      }
      if(!converged) { warnings.push('中和终态迭代未收敛，不提供推荐体积。');return {v:null,I:null,n,g}; }
      return {v,I:endI,n,g};
    }
    const tol=input.tolerancePH ?? .2;
    const mid=doseAt(input.targetPH),lo=doseAt(input.targetPH-tol),hi=doseAt(input.targetPH+tol);
    const vMid=mid.v,vLo=lo.v,vHi=hi.v,nMid=mid.n,nLo=lo.n,nHi=hi.n,gMid=mid.g,gLo=lo.g,gHi=hi.g;
    const capacityOf=(pHt,r)=>tRefPH==null || !Number.isFinite(r.g) ? null : tConcM*r.g+water(tRefPH)-water(pHt);
    const capacityMid=capacityOf(input.targetPH,mid),capacityLo=capacityOf(input.targetPH-tol,lo),capacityHi=capacityOf(input.targetPH+tol,hi);
    // 方向与可达性：剂量 v→∞ 时混合液趋近纯试剂，故可达 pH 区间 = [mixPH, 试剂pH]（端点为极限值）。
    // 目标在该区间内即可行；区间外只能报出最近可达 pH。
    const reachLo = tRefPH == null ? null : Math.min(mixPH, tRefPH);
    const reachHi = tRefPH == null ? null : Math.max(mixPH, tRefPH);
    const nearestReachablePH = pHx => {
      if (reachLo == null) return null;
      return pHx < reachLo ? reachLo : (pHx > reachHi ? reachHi : pHx);
    };
    const direction = tRefPH == null ? null
      : (tRefPH < mixPH ? 'acid' : (tRefPH > mixPH ? 'base' : null));
    let reachInfo = null;
    if (vMid == null && tRefPH != null) {
      const nearest = nearestReachablePH(input.targetPH);
      const infeasibleByDirection = (nMid > 0 && direction === 'acid') || (nMid < 0 && direction === 'base');
      const nTxt = Number.isFinite(nMid) ? nMid.toExponential(2) : '—';
      if (infeasibleByDirection) {
        warnings.push(`目标 pH ${input.targetPH.toFixed(2)} 与当前试剂方向相反：混合后 pH 为 ${mixPH.toFixed(2)}，${direction === 'acid' ? `加入 ${t.name} 只能降低 pH` : `加入 ${t.name} 只能升高 pH`}。当前条件可达到的 pH 为 ${nearest.toFixed(2)}（需净${nMid > 0 ? '加碱' : '加酸'} ${nTxt} mol）。请更换方向相反的试剂。`);
      } else {
        warnings.push(`目标 pH ${input.targetPH.toFixed(2)} 超出当前试剂可达范围 ${reachLo.toFixed(2)}–${reachHi.toFixed(2)}（试剂 ${t.name} 自身 pH 为 ${tRefPH}）。当前条件可达到的 pH 为 ${nearest.toFixed(2)}。`);
      }
      reachInfo = { nearest, lo: reachLo, hi: reachHi, reason: infeasibleByDirection ? 'wrongDirection' : 'beyondReagent' };
    }
    if (direction) {
      warnings.push(`本次中和为「${direction === 'acid' ? '加酸' : '加碱'}」路径：向 pH ${mixPH.toFixed(2)} 的混合液加入 ${t.name}${tRefPH != null ? `（试剂 pH ${tRefPH}）` : ''}。`);
    }
    // |g| 反映试剂在该 pH 处的可用当量强度，与加酸/加碱方向无关。
    if (Number.isFinite(gMid) && Math.abs(gMid) <= 0.01) warnings.push('目标 pH 接近或高于中和试剂的 pKa，试剂几乎无中和能力，请更换试剂');
    if (vMid != null && vMid / V > 0.2) warnings.push(`试剂体积约为样品的 ${(100 * vMid / V).toFixed(0)}%，稀释明显，建议用更浓试剂`);
    if (x > .7+1e-12) {
      const capText=Number.isFinite(capacityMid) ? `模型采用的试剂有效当量浓度约为 ${capacityMid.toFixed(3)} mol H⁺/L。` : '';
      warnings.push(`B占比超过70%时，结果主要由Buffer B的酸容量和中和试剂实测效价决定；当前没有高B%实验校准。${capText}若实测用量偏小，请优先核对Buffer B实际浓度、pH及试剂母液的实测pH/滴定效价。`);
    }

    // 中和前（未加试剂）电导率
    const conductivityBefore = conductivityOf(sampleIons(mixPH,I,V), mixPH);
    // 中和后（加入中值体积试剂）电导率 + 终态 pH 复合验算
    let conductivity = null, checkPH = null;
    if (vMid != null) {
      conductivity = conductivityOf(finalIons(input.targetPH,mid.I,vMid), input.targetPH);
      // 复合验算：把试剂当作一个组分，质子守恒求解混合平衡 pH，应 ≈ 目标 pH
      const compsChk = live.map(c => ({ system: c.system, conc: c.conc, vol: c.vol, fromPH: c.fromPH, sourceI: c.sourceI }));
      compsChk.push({ system: t.system, conc: tConcM, vol: vMid, fromPH: tRefPH != null ? tRefPH : mixPH, sourceI: titrantI });
      checkPH = solveMixPH(compsChk, mid.I, model, solutions.concat([
        { vol: vMid, fromPH: tRefPH != null ? tRefPH : mixPH }
      ]));
      if (!Number.isFinite(checkPH) || Math.abs(checkPH - input.targetPH) > 0.02) {
        warnings.push('中和后 pH 复核偏离目标，请检查输入并重新计算。');
      }
    }

    return {
      mixPH, ionicStrength: I, finalIonicStrength: mid.I,
      direction, reachable: reachInfo,
      needMol: { mid: nMid, lo: nLo, hi: nHi },
      effFrac: { mid: gMid, lo: gLo, hi: gHi },
      titrantCapacityM: { mid: capacityMid, lo: capacityLo, hi: capacityHi },
      volL: { mid: vMid, lo: vLo, hi: vHi },
      finalVolL: vMid != null ? V + vMid : null,
      conductivity, conductivityBefore, checkPH,
      chargeResidual: vMid==null ? null : finalIons(input.targetPH,mid.I,vMid).reduce((s,a)=>s+a.z*a.concM,0)-water(input.targetPH),
      warnings,
    };
  }

  const Engine = {
    logGamma, gamma, apparentPka, speciation, solveMixPH,
    calcRecipe, calcNeutralization, conductivityOf, calibratedInput,
    _backCheckPH: backCheckPH,
    consts: { A_DH, B_DH, ION_SIZE, KW },
  };
  global.Engine = Engine;
  if (typeof module !== 'undefined' && module.exports) module.exports = Engine;
})(typeof window !== 'undefined' ? window : globalThis);
