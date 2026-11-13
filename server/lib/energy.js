// E-17: modos de energía (V-11) — always-on / gate / manual + autostart.
// always-on: app completa al boot. gate: solo orbe + mic + Jev al boot
// (despierta con "Pablo"). manual: Tito la abre. Sin tocar Rust: autostart
// vía .desktop XDG (Linux) con EQUIPO_ENERGY_MODE.

import { mkdirSync, readFileSync, rmSync, writeFileSync, existsSync } from 'node:fs';
import { join } from 'node:path';
import { homedir } from 'node:os';

export const ENERGY_MODES = ['always-on', 'gate', 'manual'];
export const ENERGY_ENV = 'EQUIPO_ENERGY_MODE';

export function energyModeFromEnv() {
  const v = String(process.env[ENERGY_ENV] || '').trim().toLowerCase();
  return ENERGY_MODES.includes(v) ? v : null;
}

// E-25: autostart por OS (directorios fakeables en tests).
export function autostartFile(home = process.env.HOME || homedir(), platform = process.platform) {
  if (platform === 'win32') {
    const appData = process.env.APPDATA || join(home, 'AppData', 'Roaming');
    return join(appData, 'Microsoft', 'Windows', 'Start Menu', 'Programs', 'Startup', 'equipo.bat');
  }
  if (platform === 'darwin') {
    return join(home, 'Library', 'LaunchAgents', 'com.equipo.pablo.plist');
  }
  return join(home, '.config', 'autostart', 'equipo.desktop');
}

function startupEntry(platform, mode, exePath) {
  if (platform === 'win32') {
    const exe = exePath || '%ProgramFiles%\Equipo\equipo.exe';
    return `@echo off\r\nset EQUIPO_ENERGY_MODE=${mode}\r\nstart "" "${exe}"\r\n`;
  }
  if (platform === 'darwin') {
    const exe = exePath || '/Applications/Equipo.app/Contents/MacOS/equipo';
    return [
      '<?xml version="1.0" encoding="UTF-8"?>',
      '<!DOCTYPE plist PUBLIC "-//Apple//DTD PLIST 1.0//EN" "http://www.apple.com/DTDs/PropertyList-1.0.dtd">',
      '<plist version="1.0"><dict>',
      '  <key>Label</key><string>com.equipo.pablo</string>',
      '  <key>ProgramArguments</key><array>',
      `    <string>${exe}</string>`,
      '  </array>',
      '  <key>EnvironmentVariables</key><dict>',
      `    <key>EQUIPO_ENERGY_MODE</key><string>${mode}</string>`,
      '  </dict>',
      '  <key>RunAtLoad</key><true/>',
      '</dict></plist>',
      ''
    ].join('\n');
  }
  return null; // linux usa desktopEntry()
}

function desktopEntry(mode) {
  return [
    '[Desktop Entry]',
    'Type=Application',
    'Name=Equipo Pablo',
    'Comment=Tu equipo IA en el escritorio',
    `Exec=env ${ENERGY_ENV}=${mode} /usr/bin/equipo`,
    'Terminal=false',
    'Categories=Productivity;',
    'X-GNOME-Autostart-enabled=true'
  ].join('\n') + '\n';
}

// Aplica autostart según modo. manual = sin autostart. Devuelve estado.
export function applyEnergyMode(mode, { home = null, platform = process.platform, exePath = null } = {}) {
  const m = ENERGY_MODES.includes(mode) ? mode : 'manual';
  const file = autostartFile(home || undefined, platform);
  if (m === 'manual') {
    try {
      rmSync(file, { force: true });
    } catch { /* best-effort */ }
    return { mode: m, autostart: false, file };
  }
  try {
    mkdirSync(join(file, '..'), { recursive: true });
    const content = platform === 'linux' || (!['win32', 'darwin'].includes(platform))
      ? desktopEntry(m)
      : startupEntry(platform, m, exePath);
    writeFileSync(file, content, 'utf-8');
  } catch (error) {
    return { mode: m, autostart: false, file, error: String(error?.message || error).slice(0, 160) };
  }
  return { mode: m, autostart: true, file };
}

export function readAutostartMode({ home = null } = {}) {
  try {
    const file = autostartFile(home || undefined);
    if (!existsSync(file)) {
      return { installed: false, mode: 'manual' };
    }
    const content = readFileSync(file, 'utf-8');
    const m = content.match(/EQUIPO_ENERGY_MODE=([a-z-]+)/)?.[1];
    return { installed: true, mode: ENERGY_MODES.includes(m) ? m : 'always-on' };
  } catch {
    return { installed: false, mode: 'manual' };
  }
}
