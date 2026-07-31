// Lo que el usuario RECIBE. El verificador determinista es lo último que se
// interpone entre el equipo y una entrega rota, así que acá se prueba desde el
// lado de quien abre la carpeta del proyecto: ¿la página anda?, ¿está en
// español?, ¿los enlaces llevan a algún lado?, ¿el CSS respeta los tokens?
//
// La regla que más importa es la inversa: una página BIEN hecha no puede
// producir un solo hallazgo. Cada falso positivo le hace romper al agente algo
// que ya estaba bien.

import { test } from 'node:test';
import assert from 'node:assert/strict';

import {
  renderVerificationReport,
  verifyCss,
  verifyProject
} from '../server/lib/verify.js';

const que = (hallazgos) => hallazgos.map((h) => `[${h.archivo}] ${h.que}`).join(' || ') || '(sin hallazgos)';

// ── Una entrega terminada de verdad ─────────────────────────────────────

const PAGINA_TERMINADA = `<!doctype html>
<html lang="es">
<head>
  <meta charset="utf-8">
  <meta name="viewport" content="width=device-width, initial-scale=1">
  <title>Gurruchaga — pan de masa madre en Villa Crespo</title>
  <meta name="description" content="Panadería de barrio en Villa Crespo: masa madre horneada cada mañana y mesas en la vereda.">
  <link rel="stylesheet" href="tokens.css">
  <link rel="stylesheet" href="estilos.css">
</head>
<body>
  <a class="saltar" href="#contenido">Saltar al contenido</a>
  <header>
    <nav aria-label="Principal">
      <a href="#horarios">Horarios</a>
      <a href="#pedidos">Pedidos</a>
      <a href="nosotros.html">Quiénes somos</a>
    </nav>
  </header>
  <main id="contenido">
    <h1>Pan de masa madre, horneado cada mañana</h1>
    <section id="horarios">
      <h2>Cuándo abrimos</h2>
      <p>De martes a domingo, de 8 a 20. Los lunes descansamos.</p>
      <img src="fachada.svg" alt="La fachada de la panadería con las mesas en la vereda">
    </section>
    <section id="pedidos">
      <h2>Encargá tu hogaza</h2>
      <form>
        <label for="cuantas">¿Cuántas hogazas querés?</label>
        <input id="cuantas" name="cuantas" type="number" min="1" value="1">
        <button type="submit">Encargar</button>
      </form>
      <p>También podés escribirnos a <a href="mailto:hola@gurruchaga.test">hola@gurruchaga.test</a> o llamarnos al <a href="tel:+541148001234">11 4800-1234</a>.</p>
    </section>
  </main>
  <footer><p>Gurruchaga 1200, Villa Crespo, Buenos Aires.</p></footer>
  <script src="app.js"></script>
</body>
</html>`;

const TOKENS = `:root {
  --fondo: #fdf6ec;
  --superficie: #ffffff;
  --tinta: #2b2118;
  --acento: #a8582b;
  --espacio-2: 0.75rem;
  --espacio-3: 1.5rem;
  --tipografia: Georgia, 'Times New Roman', serif;
}`;

// CSS de producción: todo por var(), sombras en negro translúcido y
// `font-family: inherit` en los controles de formulario, que es la forma
// estándar de que el botón no salga con la tipografía del sistema operativo.
const ESTILOS = `.saltar { position: absolute; left: -9999px; }
.saltar:focus { left: var(--espacio-2); background: var(--superficie); color: var(--tinta); }
body { background: var(--fondo); color: var(--tinta); font-family: var(--tipografia); }
main { max-width: 68ch; margin: 0 auto; padding: var(--espacio-3); }
.tarjeta { background: var(--superficie); box-shadow: 0 1px 2px rgba(0, 0, 0, 0.08); border: 1px solid transparent; }
button, input { font-family: inherit; font-size: 1rem; }`;

const APP = `const anclas = document.querySelectorAll('a[href^="#"]');
for (const ancla of anclas) {
  ancla.addEventListener('click', (evento) => {
    const destino = document.querySelector(ancla.getAttribute('href'));
    if (!destino) {
      return;
    }
    evento.preventDefault();
    destino.scrollIntoView({ behavior: 'smooth' });
  });
}`;

test('una entrega terminada de verdad no le devuelve ni un solo hallazgo al equipo', () => {
  const archivos = new Map([
    ['index.html', PAGINA_TERMINADA],
    ['tokens.css', TOKENS],
    ['estilos.css', ESTILOS],
    ['app.js', APP]
  ]);
  // La página también apunta a nosotros.html y fachada.svg: existen en el
  // proyecto aunque esta corrida no los haya tocado.
  const rutas = ['index.html', 'nosotros.html', 'tokens.css', 'estilos.css', 'app.js', 'fachada.svg'];

  const hallazgos = verifyProject(archivos, rutas);
  assert.deepEqual(hallazgos, [], `el verificador inventó problemas sobre una página que está bien: ${que(hallazgos)}`);
});

// ── Una entrega rota ────────────────────────────────────────────────────

test('si la página llega rota, el equipo se entera antes de que la abra alguien', () => {
  const rota = `<!doctype html>
<html lang="es">
<head><title>Tienda del barrio</title><meta name="description" content="Almacén y fiambrería en Lanús."></head>
<body>
  <main>
    <h1>Tienda del barrio</h1>
    <section id="ofertas">
      <p>Dos por uno todos los martes.
    </section>
    <section id="ofertas">
      <h1>Ofertas de la semana</h1>
      <img src="oferta.png">
    </section>
  </main>
</body>
</html>`;
  const hallazgos = verifyProject(new Map([['index.html', rota]]), ['index.html', 'oferta.png']);
  const texto = que(hallazgos);

  assert.match(texto, /<p> sin cerrar/, `no vio el párrafo abierto: ${texto}`);
  assert.match(texto, /id repetidos: ofertas/, `no vio los dos id iguales: ${texto}`);
  assert.match(texto, /2 <h1>/, `no vio los dos encabezados principales: ${texto}`);
  assert.match(texto, /sin atributo alt/, `no vio la imagen sin alt: ${texto}`);

  // Y el informe le dice al agente qué pasa, dónde y que arregle antes de cerrar.
  const informe = renderVerificationReport(hallazgos);
  assert.match(informe, /index\.html/);
  assert.match(informe, /finish/, 'el informe tiene que frenar el cierre de la tarea');
});

test('una página a medio hacer, con relleno adentro, no pasa por terminada', () => {
  const archivos = new Map([
    ['index.html', `<!doctype html><html lang="es"><head><title>Estudio contable Ramírez</title>
<meta name="description" content="Estudio contable en Quilmes."></head><body>
<h1>Estudio contable Ramírez</h1>
<p>Lorem ipsum dolor sit amet, consectetur adipiscing elit.</p>
<ul><li>Servicio 1</li><li>Servicio 2</li></ul>
<p>Próximamente vamos a publicar los honorarios.</p>
</body></html>`],
    ['README.md', '# Entrega\n\nTODO: escribir la parte de honorarios.\nTu contenido acá.\n']
  ]);
  const hallazgos = verifyProject(archivos);
  const enPagina = que(hallazgos.filter((h) => h.archivo === 'index.html'));
  const enReadme = que(hallazgos.filter((h) => h.archivo === 'README.md'));

  assert.match(enPagina, /relleno/, enPagina);
  assert.match(enPagina, /Lorem ipsum/, enPagina);
  assert.match(enPagina, /Servicio 1/, `"Servicio 1" es el relleno más típico y hay que cazarlo: ${enPagina}`);
  assert.match(enPagina, /Próximamente/i, enPagina);
  assert.match(enReadme, /TODO/, `el relleno en los documentos también llega al usuario: ${enReadme}`);
  assert.match(enReadme, /Tu contenido acá/i, enReadme);
});

// ── Idioma ──────────────────────────────────────────────────────────────

test('el inglés que se cuela en la navegación y en los botones sale marcado', () => {
  const html = `<!doctype html><html lang="es"><head><title>Estudio Norte</title>
<meta name="description" content="Estudio de arquitectura en Rosario."></head><body>
<nav><a href="#inicio">Home</a><a href="#contacto">Contact us</a></nav>
<main>
  <h1>Estudio Norte</h1>
  <section id="inicio"><p>Diseñamos casas en Rosario.</p><a href="#obras">Get started</a></section>
  <section id="obras"><h2>Obras</h2><p>Tres casas en Fisherton y un galpón reciclado.</p><a href="#obras">Read more</a></section>
  <section id="contacto"><h2>Contacto</h2><p>Escribinos y coordinamos una visita.</p></section>
</main>
</body></html>`;
  const hallazgos = verifyProject(new Map([['index.html', html]]));
  const texto = que(hallazgos);

  assert.equal(hallazgos.length, 1, `el único problema de esta página es el idioma: ${texto}`);
  assert.match(texto, /texto en inglés/, texto);
  for (const frase of ['home', 'contact us', 'get started', 'read more']) {
    assert.ok(texto.toLowerCase().includes(frase), `faltó marcar "${frase}", que el usuario lee en pantalla: ${texto}`);
  }
});

test('cómo hablamos acá no es inglés: mail, chat, software y tests quedan como están', () => {
  const html = `<!doctype html><html lang="es"><head><title>Muty — software a medida</title>
<meta name="description" content="Hacemos software a medida: web, mobile y automatizaciones."></head><body>
<h1>Hacemos software a medida</h1>
<p>Escribinos por mail o por chat, o mandanos un email con el brief. Cada release pasa por tests automáticos antes del deploy.</p>
<p>El link al repo te lo pasamos en la primera call, y el backup lo dejamos andando desde el día uno.</p>
<form>
  <label for="mensaje">Contanos qué necesitás</label>
  <textarea id="mensaje" name="mensaje"></textarea>
  <button type="submit" data-action="get-started">Enviar</button>
</form>
<script>
  const home = document.querySelector('#inicio');
  const form = document.querySelector('form');
  form.addEventListener('submit', (evento) => {
    evento.preventDefault();
    console.log('learn more about the submit', home);
  });
</script>
</body></html>`;
  const hallazgos = verifyProject(new Map([['index.html', html]]));
  assert.deepEqual(hallazgos, [], `se marcó como inglés lo que es español rioplatense normal, o se leyó el código como si fuera texto de la interfaz: ${que(hallazgos)}`);
});

// ── Que la página se pueda abrir y navegar ──────────────────────────────

test('los enlaces llevan a algún lado, los archivos existen y nada depende de internet', () => {
  const html = `<!doctype html><html lang="es"><head><title>Bicicletería Sur</title>
<meta name="description" content="Taller de bicicletas en Lanús.">
<link rel="stylesheet" href="https://fonts.googleapis.com/css2?family=Inter">
<link rel="stylesheet" href="estilos.css"></head><body>
<nav><a href="#taller">El taller</a><a href="precios.html">Precios</a></nav>
<main>
  <h1>Bicicletería Sur</h1>
  <section id="taller">
    <h2>El taller</h2>
    <p>Service completo en el día.</p>
    <a href="#" class="cta">Pedí tu turno</a>
    <a href="mailto:hola@sur.test">Escribinos</a>
    <img src="logo.svg" alt="Logo de Bicicletería Sur">
  </section>
</main>
</body></html>`;
  const hallazgos = verifyProject(new Map([['index.html', html]]), ['index.html', 'estilos.css', 'logo.svg']);
  const texto = que(hallazgos);

  assert.match(texto, /no llevan a ningún lado/, `el botón "Pedí tu turno" no hace nada: ${texto}`);
  assert.match(texto, /archivos que no existen: precios\.html/, `el menú lleva a una página inexistente: ${texto}`);
  assert.match(texto, /recurso\(s\) remoto\(s\)/, `la tipografía se baja de internet y ahí no hay internet: ${texto}`);
  assert.doesNotMatch(texto, /estilos\.css|logo\.svg|mailto/, `lo que sí existe no se puede reportar como roto: ${texto}`);
});

test('si el JavaScript no arranca, lo interactivo queda muerto y hay que decirlo', () => {
  const roto = `<!doctype html><html lang="es"><head><title>Turnos</title>
<meta name="description" content="Pedí tu turno online."></head><body>
<h1>Pedí tu turno</h1>
<script>
  function abrirPanel(id) {
    const panel = document.getElementById(id);
    if (panel) { panel.hidden = false;
  }
</script>
</body></html>`;
  // JavaScript moderno pero perfectamente válido: campos privados, async,
  // encadenamiento opcional. Nada de esto puede reportarse como error.
  const sano = `class Agenda {
  #turnos = [];
  agregar(turno) {
    this.#turnos.push(turno);
    return this;
  }
  async cargar(url) {
    const respuesta = await fetch(url);
    return respuesta?.ok ? respuesta.json() : [];
  }
  get total() {
    return this.#turnos.length;
  }
}
window.agenda = new Agenda();`;

  const hallazgos = verifyProject(new Map([['index.html', roto], ['app.js', sano]]));
  const enPagina = que(hallazgos.filter((h) => h.archivo === 'index.html'));
  const enApp = hallazgos.filter((h) => h.archivo === 'app.js');

  assert.match(enPagina, /sintaxis/, `el script de la página no cierra la llave y nadie avisó: ${enPagina}`);
  assert.deepEqual(enApp, [], `JavaScript moderno y válido reportado como roto: ${que(enApp)}`);
});

test('el CSS de una página normal no se confunde con una paleta escrita a mano', () => {
  // Una paleta propia, escrita a ojo, SÍ tiene que salir marcada: así es como
  // un proyecto termina con cinco azules distintos.
  const propia = verifyCss('estilos.css', '.hero { background: #e63946; color: #f1faee; border-bottom: 2px solid rgb(29, 53, 87); }');
  assert.match(que(propia), /escritos a mano/, que(propia));

  // Pero un selector de sección que casualmente se escribe con letras
  // hexadecimales (#cafe, en una panadería, es de lo más común) no es un color.
  const normal = verifyCss('estilos.css', `:root { --tinta: #2b2118; }
#cafe {
  padding: var(--espacio-3);
  background: var(--superficie);
  color: var(--tinta);
}
#cafe h2 { font-family: var(--tipografia); }`);
  assert.deepEqual(normal, [], `un id de sección se leyó como si fuera un color: ${que(normal)}`);
});
