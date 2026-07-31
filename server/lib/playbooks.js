import { readFileSync } from 'node:fs';
import path from 'node:path';

import { rootDir } from './config.js';

// Los playbooks son el criterio del oficio: qué tecnología usar en cada caso y
// cuál es el piso de diseño. Van al prompt de TRABAJO, no al de conversación —
// en la reunión el agente habla como persona, no recita su manual.
//
// Se leen una sola vez al arrancar: son archivos del repo, no cambian en
// caliente, y leerlos en cada paso costaría una lectura de disco por llamada.

const PLAYBOOK_DIR = path.join(rootDir, 'server', 'playbooks');

// Stacks conocidos. Un proyecto sin stack declarado usa 'web', que es el caso
// más común y el único que corre tal cual en el navegador integrado.
export const STACKS = ['web', 'automatizacion', 'movil-rn', 'android', 'python'];
export const DEFAULT_STACK = 'web';

function leer(nombre) {
  try {
    return readFileSync(path.join(PLAYBOOK_DIR, `${nombre}.md`), 'utf-8').trim();
  } catch {
    // Un playbook faltante no puede romper el arranque: el equipo trabaja
    // igual, solo que sin ese criterio extra.
    return '';
  }
}

const DISENO = leer('diseno');
// El piso de diseño se partió en dos porque estaba escrito en vocabulario web y
// viajaba igual a los cuatro nichos que no hacen HTML. En movil-rn se contradecía
// con su propio playbook — "Colores y medidas desde tokens.css con var(--…)"
// tres líneas debajo de "Estilos con StyleSheet.create. Nada de CSS." — y eso es
// exactamente cómo se cuela una web disfrazada de app. Lo que es cierto en todo
// nicho quedó en diseno.md; lo que solo existe en una pantalla web, acá.
const DISENO_WEB = leer('diseno-web');
// Nichos que entregan una pantalla web de verdad. Los demás (móvil, android,
// python) tienen su propio criterio visual dentro de su playbook.
const STACKS_WEB = new Set(['web']);
const POR_STACK = Object.fromEntries(STACKS.map((stack) => [stack, leer(stack)]));
// El FLUJO es distinto del criterio técnico: uno dice QUÉ construir, el otro EN
// QUÉ ORDEN y qué verificar antes de cerrar. Sin el flujo el agente escribía
// cinco archivos sin plan, dejaba el punto de entrada con la plantilla por
// defecto y se quedaba sin pasos antes de llegar al finish.
const FLUJO_POR_STACK = Object.fromEntries(STACKS.map((stack) => [stack, leer(`flujo-${stack}`)]));
const ROLES = leer('roles');

export function normalizeStack(stack) {
  return STACKS.includes(stack) ? stack : DEFAULT_STACK;
}

// Cómo se llama el archivo de tokens de cada nicho. Es la misma decisión que
// toma tokensComoCodigo() al traducir el diseño; acá vive solo el NOMBRE, que es
// lo único que el prompt necesita decir. Sin esto el motor le pedía "escribí
// tokens.css" a un dev de React Native, que tiene prohibido el CSS por su propio
// playbook: la orden y el criterio se contradecían en el mismo prompt.
const TOKENS_POR_STACK = {
  web: 'tokens.css',
  automatizacion: 'tokens.css',
  'movil-rn': 'src/theme.js',
  android: 'app/src/main/java/<paquete>/ui/Tokens.kt',
  // Un programa de consola no tiene superficie que mirar: no hay archivo de
  // tokens hasta que tenga una pantalla.
  python: null
};

export function archivoDeTokens(stack) {
  return TOKENS_POR_STACK[normalizeStack(stack)] || null;
}

// El bloque que se inyecta en el prompt de trabajo: primero el criterio técnico
// del nicho (qué construir con qué) y después el estándar de diseño (cómo tiene
// que verse y sentirse). Los dos son obligatorios, no sugerencias.
export function renderPlaybooks(stack, { incluirDiseno = true } = {}) {
  const partes = [];
  const tecnico = POR_STACK[normalizeStack(stack)];
  if (tecnico) {
    partes.push(tecnico);
  }
  if (incluirDiseno) {
    partes.push(renderDesignStandard(stack));
  }
  const utiles = partes.filter(Boolean);
  if (utiles.length === 0) {
    return '';
  }
  return [
    '━━ CÓMO TRABAJA ESTE ESTUDIO (obligatorio, te van a revisar contra esto) ━━',
    ...utiles,
    '━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━'
  ].join('\n\n');
}

// Solo el criterio de diseño, para quien revisa: el revisor necesita el piso
// contra el que juzgar, pero no el manual de decisiones técnicas.
//
// Lleva stack porque el piso NO es el mismo en todos los nichos: pedirle
// var(--…) o alt en las imágenes a una app React Native es pedirle que rompa su
// propio playbook, y quien revisa terminaba marcando como falla lo que estaba
// bien hecho.
export function renderDesignStandard(stack) {
  return [DISENO, STACKS_WEB.has(normalizeStack(stack)) ? DISENO_WEB : '']
    .filter(Boolean)
    .join('\n\n');
}

// El orden de trabajo del nicho, con el comando exacto que verifica y los
// errores que se cometen siempre ahí. Va con encabezado propio porque el
// agente tiene que poder distinguirlo del criterio técnico: esto es la
// secuencia, no el catálogo de tecnologías.
export function renderFlujo(stack) {
  const flujo = FLUJO_POR_STACK[normalizeStack(stack)];
  if (!flujo) {
    return '';
  }
  return `━━ CÓMO SE HACE BIEN ESTE TRABAJO (el orden importa) ━━\n${flujo}`;
}

// Quién hace qué y cuándo entra. Es corto a propósito: alcanza para que nadie
// haga el trabajo de otro ni espere a alguien que todavía no le toca.
export function renderRoles() {
  if (!ROLES) {
    return '';
  }
  return ROLES;
}
