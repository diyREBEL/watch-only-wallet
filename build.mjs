// Baut index.html: bündelt src/ui.js (inkl. Bibliotheken) in die Vorlage src/template.html.
import * as esbuild from 'esbuild';
import fs from 'node:fs';
const r = await esbuild.build({ entryPoints: ['src/ui.js'], bundle: true, format: 'iife', minify: true, write: false, target: ['chrome111', 'firefox113', 'safari16.4'], legalComments: 'none', charset: 'utf8' });
const js = r.outputFiles[0].text.replace(/<\/script/gi, '<\\/script');
const tpl = fs.readFileSync('src/template.html', 'utf8');
const html = tpl.replace('/*APP*/', () => js);
fs.writeFileSync('index.html', html);
console.log('index.html', (html.length / 1024).toFixed(0) + ' KB');
