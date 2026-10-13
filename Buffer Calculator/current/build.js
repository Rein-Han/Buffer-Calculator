/* build.js — 把 engine.js / db.js / app.js 注入 template.html，产出单文件 buffer-calculator.html */
const fs = require('fs');
const path = require('path');

const read = f => fs.readFileSync(path.join(__dirname, f), 'utf8');
let html = read('template.html');
html = html.replace('//__ENGINE_JS__', () => read('engine.js'));
html = html.replace('//__DB_JS__', () => read('db.js'));
html = html.replace('//__NEUT_CHART_JS__', () => read('neut-chart.js'));
html = html.replace('//__APP_JS__', () => read('app.js'));
fs.writeFileSync(path.join(__dirname, 'buffer-calculator.html'), html, 'utf8');
console.log('built buffer-calculator.html,', html.length, 'bytes');
