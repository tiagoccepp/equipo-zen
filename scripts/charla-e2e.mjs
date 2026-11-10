// Real conversation test: I talk to the team the way the user talks.
//
// Not a unit test: it opens a WebSocket against the live backend, sends the
// messages just as a person would write them —loose, incomplete, with
// mid-way questions— and measures what they deliver.
//
// Usage:
//   node scripts/charla-e2e.mjs <plantilla> <titulo> "mensaje 1" "mensaje 2" ...
//   node scripts/charla-e2e.mjs --escenario fasa

import WebSocket from 'ws';

const BASE = process.env.BASE || 'http://127.0.0.1:8787';
const WS = BASE.replace('http', 'ws') + '/meeting';

// How the real user talks, taken from their conversations: greeting, fuzzy
// request, mid-way correction, open question, and "dale" ("go ahead").
const ESCENARIOS = {
  fasa: {
    plantilla: 'movil-rn',
    titulo: 'Tres en raya',
    mensajes: [
      'Hola chicos, ¿cómo están?',
      'bueno lo que quiero es que me hagan una app',
      'un tic tac toe, algo simple',
      'contra la máquina nada más',
      'dale, repartan las tareas'
    ]
  },
  menu: {
    plantilla: 'web',
    titulo: 'Menu del bodegon',
    mensajes: [
      'buenas',
      'necesito una carta digital para un bodegón',
      'que se vea lindo, con fotos de los platos digo con dibujitos porque no tengo fotos',
      'y los precios',
      'listo dale'
    ]
  },
  android: {
    plantilla: 'android',
    titulo: 'Lista de compras',
    mensajes: [
      'hola',
      'quiero una app de lista de compras',
      'que pueda tachar lo que ya compré',
      'dale arranquen'
    ]
  }
};

const dormir = (ms) => new Promise((r) => setTimeout(r, ms));

async function api(ruta, opciones = {}) {
  const r = await fetch(`${BASE}${ruta}`, {
    ...opciones,
    headers: { 'Content-Type': 'application/json', ...(opciones.headers || {}) }
  });
  if (!r.ok) {
    throw new Error(`${ruta} → ${r.status} ${(await r.text()).slice(0, 200)}`);
  }
  return r.status === 204 ? null : r.json();
}

export async function charlar({ plantilla, titulo, mensajes, esperaTrabajoMs = 0, silencioso = false }) {
  const log = (...a) => { if (!silencioso) console.log(...a); };

  const { company } = await api('/api/companies', {
    method: 'POST',
    body: JSON.stringify({ templateId: plantilla })
  });
  const { project } = await api(`/api/companies/${company.id}/projects`, {
    method: 'POST',
    body: JSON.stringify({ title: titulo })
  });
  log(`\n[${company.name}] proyecto "${project.title}" (${project.stack})`);

  const ws = new WebSocket(WS);
  const turnos = [];
  let i = 0;
  let listo = false;

  await new Promise((resolve, reject) => {
    const fin = setTimeout(() => resolve(), 420000);
    let siguienteTimer = null;
    const programarSiguiente = (ms = 6000) => {
      clearTimeout(siguienteTimer);
      siguienteTimer = setTimeout(() => {
        if (i < mensajes.length) {
          log(`\n  YO » ${mensajes[i]}`);
          ws.send(JSON.stringify({ type: 'user_turn', text: mensajes[i++] }));
          // Safety net: if the team answers nothing, carry on anyway.
          programarSiguiente(45000);
        } else {
          clearTimeout(fin);
          resolve();
        }
      }, ms);
    };
    ws.on('open', () => ws.send(JSON.stringify({ type: 'hello', companyId: company.id, goalId: project.id })));
    ws.on('error', reject);
    ws.on('message', (raw) => {
      let m;
      try { m = JSON.parse(raw); } catch { return; }

      if (m.type === 'meeting_ready') {
        listo = true;
        log(`  proyecto en la reunión: ${m.project?.title || 'NINGUNO'}`);
        programarSiguiente(600);
      }

      if (m.type === 'agent_turn_complete' && m.text) {
        turnos.push({ agentId: m.agentId, text: m.text });
        log(`     ${m.text.slice(0, 150)}`);
      }

      // When the team goes quiet, I send the next one. It reschedules on
      // ANY signal that the turn ended: a lone greeting may produce no
      // response at all (everyone silent by protocol) and the script would
      // wait forever.
      if (['agent_turn_complete', 'agent_silence', 'no_agent_response', 'agents_idle', 'route_decision'].includes(m.type)) {
        programarSiguiente();
      }
    });
  });

  ws.close();
  if (!listo) {
    throw new Error('la reunión nunca se abrió');
  }

  // Let the team work if asked.
  if (esperaTrabajoMs > 0) {
    log(`\n  … dejando trabajar ${Math.round(esperaTrabajoMs / 1000)}s`);
    await dormir(esperaTrabajoMs);
  }

  const detalle = await api(`/api/projects/${project.id}`);
  return { company, project, turnos, detalle };
}

// What came out: what matters to the user, not internal metrics.
export function juzgar(detalle) {
  const tareas = detalle.tasks || [];
  const archivos = (detalle.project.files || []).map((f) => f.path);
  return {
    tareas: tareas.length,
    hechas: tareas.filter((t) => t.status === 'done').length,
    trabadas: tareas.filter((t) => t.status === 'blocked').length,
    enCurso: tareas.filter((t) => t.status === 'in_progress').length,
    sinArchivo: tareas.filter((t) => t.kind === 'entregable' && !t.targetFile).length,
    archivos,
    motivos: tareas.filter((t) => t.blockedReason).map((t) => t.blockedReason)
  };
}

if (import.meta.url === `file://${process.argv[1]}`) {
  const args = process.argv.slice(2);
  let config;
  if (args[0] === '--escenario') {
    config = ESCENARIOS[args[1]];
    if (!config) {
      console.error(`Escenarios: ${Object.keys(ESCENARIOS).join(', ')}`);
      process.exit(1);
    }
  } else {
    config = { plantilla: args[0], titulo: args[1], mensajes: args.slice(2) };
  }
  config.esperaTrabajoMs = Number(process.env.ESPERA_MS || 0);

  const { detalle } = await charlar(config);
  const r = juzgar(detalle);
  console.log('\n── RESULTADO ──');
  console.log(`  tareas: ${r.tareas} · hechas: ${r.hechas} · trabadas: ${r.trabadas} · en curso: ${r.enCurso}`);
  console.log(`  entregables sin archivo asignado: ${r.sinArchivo}`);
  console.log(`  archivos: ${r.archivos.length ? r.archivos.join(', ') : '(ninguno)'}`);
  for (const m of r.motivos) console.log(`  TRABADA: ${m}`);
  process.exit(0);
}

export { ESCENARIOS };
