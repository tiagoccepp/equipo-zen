import { test } from 'node:test';
import assert from 'node:assert/strict';

import {
  renderVerificationReport,
  verifyCss,
  verifyHtml,
  verifyJs,
  verifyProject,
  verifyTexto
} from '../server/lib/verify.js';

const que = (hallazgos) => hallazgos.map((h) => h.que).join(' || ');

// A page that meets everything: the case that must NEVER yield findings. A
// false positive makes the agent break something that was fine.
const PAGINA_BUENA = `<!doctype html>
<html lang="es">
<head>
  <meta charset="utf-8" />
  <title>Panadería del barrio</title>
  <meta name="description" content="Pan de masa madre horneado cada mañana en Villa Crespo." />
  <link rel="stylesheet" href="tokens.css" />
</head>
<body>
  <header><nav><a href="#horarios">Horarios</a></nav></header>
  <main>
    <h1>Pan de masa madre, todos los días</h1>
    <section id="horarios">
      <h2>Cuándo abrimos</h2>
      <p>De martes a domingo, de 8 a 20.</p>
      <img src="tokens.css" alt="Hogaza recién salida del horno" />
    </section>
  </main>
  <footer><p>Gurruchaga 1200, Villa Crespo.</p></footer>
</body>
</html>`;

test('a well-made page produces no findings', () => {
  const archivos = new Map([['index.html', PAGINA_BUENA], ['tokens.css', ':root { --tinta: #1a1a1a; }']]);
  assert.deepEqual(verifyProject(archivos), [], que(verifyProject(archivos)));
});

test('detects unclosed tags', () => {
  const hallazgos = verifyHtml('index.html', '<!doctype html><html lang="es"><head><title>X</title><meta name="description" content="y"></head><body><main><h1>Hola</h1><section><p>Texto</section></main></body></html>');
  assert.ok(/mal balanceado/.test(que(hallazgos)), que(hallazgos));
  assert.ok(/<p> sin cerrar/.test(que(hallazgos)));
});

test('does not mistake void tags for unclosed tags', () => {
  const hallazgos = verifyHtml('x.html', '<div><br><hr><img src="a.svg" alt="a"><input type="text" /></div>');
  assert.equal(hallazgos.filter((h) => /balanceado/.test(h.que)).length, 0, que(hallazgos));
});

test('the "<" inside a script is not read as a tag', () => {
  const hallazgos = verifyHtml('x.html', '<div><script>for (let i = 0; i < 10; i++) { console.log(i); }</script></div>');
  assert.equal(hallazgos.filter((h) => /balanceado/.test(h.que)).length, 0, que(hallazgos));
});

test('finds placeholders and filler', () => {
  const hallazgos = verifyTexto('index.html', 'Lorem ipsum dolor. Servicio 1. TODO: completar después.');
  assert.ok(/relleno/.test(que(hallazgos)), que(hallazgos));
});

test('does not flag normal Rioplatense Spanish words as English', () => {
  const hallazgos = verifyTexto('index.html', 'Escribinos por email o por chat. Somos una empresa de software y hacemos tests.');
  assert.deepEqual(hallazgos, [], que(hallazgos));
});

test('does flag English leaking into the UI', () => {
  const hallazgos = verifyTexto('index.html', 'Nuestros servicios. Read more. Get started hoy mismo.');
  assert.ok(/inglés/.test(que(hallazgos)), que(hallazgos));
});

test('flags hand-written colors outside the tokens', () => {
  const hallazgos = verifyCss('estilos.css', '.tarjeta { background: #e3fafc; color: rgb(12, 34, 56); }');
  assert.ok(/color\(es\) escritos a mano/.test(que(hallazgos)), que(hallazgos));
});

test('tokens declared in :root are exactly where literals DO belong', () => {
  const hallazgos = verifyCss('estilos.css', ':root { --fondo: #f8f9fa; --tinta: #212529; }\n.tarjeta { background: var(--fondo); }');
  assert.deepEqual(hallazgos, [], que(hallazgos));
});

test('the token file itself is never flagged', () => {
  const hallazgos = verifyCss('tokens.css', '.lo-que-sea { color: #ff0000; font-family: Georgia, serif; }', { esArchivoDeTokens: true });
  assert.deepEqual(hallazgos, [], que(hallazgos));
});

test('black, white and transparent do not count as a custom palette', () => {
  const hallazgos = verifyCss('estilos.css', '.sombra { box-shadow: 0 1px 2px rgba(0, 0, 0, 0.08); border: 1px solid transparent; }');
  assert.deepEqual(hallazgos, [], que(hallazgos));
});

test('detects JavaScript that does not parse', () => {
  const hallazgos = verifyJs('app.js', 'function roto( { return 1 }');
  assert.ok(/sintaxis/.test(que(hallazgos)), que(hallazgos));
});

test('valid JavaScript passes clean', () => {
  const hallazgos = verifyJs('app.js', 'const abrir = (id) => document.getElementById(id)?.classList.toggle("abierto");');
  assert.deepEqual(hallazgos, [], que(hallazgos));
});

test('an ES module and JSX are not a syntax error', () => {
  // new Function compiles a SCRIPT: import, export, top-level await and JSX
  // are SyntaxError there even when perfect. A theme.js with `export const`,
  // any <script type="module"> and all the JSX of a React Native project
  // were flagged as broken — and an invented finding makes the agent break
  // something that was fine, the one thing this file cannot afford.
  const validos = {
    'import estático': "import { useState } from 'react';\nexport default function App() { return null; }",
    'export suelto': 'export const colores = { fondo: "#101a12" };',
    'import.meta': 'const aca = import.meta.url;',
    'await de módulo': 'const datos = await leer();',
    'JSX con hijos': 'const x = <View><Text>hola</Text></View>;',
    'JSX autocerrado': 'const x = <StatusBar style="light" />;'
  };
  for (const [caso, codigo] of Object.entries(validos)) {
    assert.deepEqual(verifyJs('theme.js', codigo), [], `${caso}: ${que(verifyJs('theme.js', codigo))}`);
  }
});

test('genuinely broken JavaScript still gets flagged', () => {
  for (const roto of ['function a( { return 1', 'const a = {;', 'if (x) { y(] }']) {
    const hallazgos = verifyJs('app.js', roto);
    assert.ok(/sintaxis/.test(que(hallazgos)), `"${roto}" tendría que marcarse: ${que(hallazgos)}`);
  }
  // A `<` that is a comparison is not JSX and cannot hide a real error.
  assert.deepEqual(verifyJs('app.js', 'if (a < b && c > d) { hacer(); }'), []);
});

test('finds dead links, images without alt, and several h1', () => {
  const hallazgos = verifyHtml('index.html', '<h1>Uno</h1><h1>Dos</h1><a href="#">Ver más</a><img src="a.svg">');
  const texto = que(hallazgos);
  assert.ok(/2 <h1>/.test(texto), texto);
  assert.ok(/no llevan a ningún lado/.test(texto), texto);
  assert.ok(/sin atributo alt/.test(texto), texto);
});

test('warns when pointing to a file that does not exist', () => {
  const hallazgos = verifyHtml('index.html', '<link rel="stylesheet" href="estilos.css"><script src="app.js"></script>', {
    archivosDelProyecto: ['index.html', 'estilos.css']
  });
  assert.ok(/app\.js/.test(que(hallazgos)), que(hallazgos));
});

test('warns about remote resources: where this opens there is no internet', () => {
  const hallazgos = verifyHtml('index.html', '<link href="https://fonts.googleapis.com/css2?family=Inter" rel="stylesheet">');
  assert.ok(/remoto/.test(que(hallazgos)), que(hallazgos));
});

test('the report tells the agent what to fix and how', () => {
  const informe = renderVerificationReport(verifyHtml('index.html', '<img src="a.svg">'));
  assert.ok(informe.includes('index.html'));
  assert.ok(informe.includes('alt'));
  assert.ok(/finish/.test(informe), 'tiene que decirle que arregle ANTES de cerrar');
});

test('no findings, no report', () => {
  assert.equal(renderVerificationReport([]), '');
});

test('the same issue is not reported twice', () => {
  const archivos = new Map([
    ['index.html', '<style>.a { color: #123456; }</style>'],
    ['otro.html', '<style>.a { color: #123456; }</style>']
  ]);
  const porArchivo = verifyProject(archivos).filter((h) => /escritos a mano/.test(h.que));
  assert.equal(porArchivo.length, 2, 'se reporta una vez por archivo, no una por coincidencia');
});
