// E-17: gate Jev — wake word "Pablo" en modo gate. Solo el habla que
// invoca a Pablo activa al equipo; el resto se ignora (con telemetría).
// Determinístico sobre texto normalizado (usa el STT existente).

const WAKE_WORDS = ['pablo', 'pablo,' ];

function norm(text) {
  return String(text || '').toLowerCase().normalize('NFD').replace(/[\u0300-\u036f]/g, '')
    .replace(/[¡!¿?.,;:()"'«»]/g, ' ').replace(/\s+/g, ' ').trim();
}

// ¿Invoca a Pablo? Acepta prefijo ("Pablo, hacé X", "che Pablo X", "ok pablo")
// o mención en frase corta (≤6 palabras). Devuelve {wake, command}.
export function jevGate(text) {
  const clean = norm(text);
  if (!clean) {
    return { wake: false, command: '' };
  }
  const words = clean.split(' ');
  const idx = words.indexOf('pablo');
  if (idx === -1) {
    return { wake: false, command: '' };
  }
  // Mención tardía en frase larga = hablando DE Pablo, no CON Pablo.
  if (idx > 3 && words.length > 6) {
    return { wake: false, command: '' };
  }
  const command = [...words.slice(0, idx), ...words.slice(idx + 1)].join(' ').trim();
  return { wake: true, command };
}

export function stripWakeWord(text) {
  const { command } = jevGate(text);
  return command;
}
