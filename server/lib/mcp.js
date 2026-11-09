// Cliente MCP (Model Context Protocol) sobre stdio.
// Habla JSON-RPC 2.0 delimitado por newlines con un servidor hijo (spawn).
// Sin dependencias: solo builtins de node.

import { spawn } from 'node:child_process';

// Versión de protocolo que ofrecemos al hacer initialize.
export const MCP_PROTOCOL_VERSION = '2024-11-05';
export const MCP_CLIENT_NAME = 'manos';
export const MCP_CLIENT_VERSION = '1.0';
// Timeout por defecto de cada request (20s según contrato).
export const DEFAULT_TIMEOUT_MS = 20000;

// Construye env limpio para hijos MCP: strip 4 vars proxy + NODE_USE_ENV_PROXY=0,
// mergeado con entry.env (solo valores string). entry.env gana si colisiona.
export function buildMcpEnv(extraEnv) {
  const env = { ...process.env };
  delete env.http_proxy;
  delete env.https_proxy;
  delete env.HTTP_PROXY;
  delete env.HTTPS_PROXY;
  env.NODE_USE_ENV_PROXY = '0';
  if (extraEnv && typeof extraEnv === 'object' && !Array.isArray(extraEnv)) {
    for (const [k, v] of Object.entries(extraEnv)) {
      if (typeof k === 'string' && typeof v === 'string') env[k] = v;
    }
  }
  return env;
}

export class McpClient {
  #child = null;
  #nextId = 1;
  #pending = new Map(); // id -> { resolve, reject, timer, method }
  #buffer = '';
  #started = false;
  #closed = false;

  constructor({ cmd, args = [], timeoutMs = DEFAULT_TIMEOUT_MS, env = undefined } = {}) {
    if (!cmd || typeof cmd !== 'string') throw new TypeError('McpClient: cmd requerido');
    this.cmd = cmd;
    this.args = Array.isArray(args) ? args : [];
    this.timeoutMs = timeoutMs;
    this.extraEnv = (env && typeof env === 'object' && !Array.isArray(env)) ? env : {};
  }

  get started() { return this.#started; }
  get closed() { return this.#closed; }

  // true si el hijo sigue vivo y el cliente no se cerró.
  isAlive() {
    const c = this.#child;
    return !this.#closed && !!c && c.exitCode === null && c.signalCode == null;
  }

  // Levanta el hijo y hace el handshake initialize + notifications/initialized.
  async start() {
    if (this.#started) return;
    if (this.#closed) throw new Error('McpClient: cliente cerrado');
    const child = spawn(this.cmd, this.args, { stdio: ['pipe', 'pipe', 'pipe'], env: buildMcpEnv(this.extraEnv) });
    this.#child = child;
    child.stdout.setEncoding('utf8');
    child.stdout.on('data', (chunk) => this.#onData(chunk));
    child.stderr.setEncoding('utf8');
    // El stderr del servidor son sus logs: van a nuestro stderr, no rompen nada.
    child.stderr.on('data', (chunk) => {
      process.stderr.write(`[mcp:${this.cmd}] ${chunk}`);
    });
    // EPIPE al escribir a un hijo muerto: lo maneja el callback de write;
    // este handler evita que el 'error' del stream stdin reviente el proceso.
    child.stdin.on('error', () => {});
    child.on('error', (err) => this.#failAll(err));
    child.on('exit', (code, signal) => {
      this.#failAll(new Error(`McpClient: servidor terminó (code=${code} signal=${signal})`));
    });
    // Detectar spawn fallido inmediato (ENOENT llega como 'error' asíncrono).
    await new Promise((resolve, reject) => {
      const onError = (err) => reject(err);
      child.once('error', onError);
      setImmediate(() => {
        child.off('error', onError);
        resolve();
      });
    }).catch((err) => {
      throw new Error(`McpClient: no se pudo iniciar "${this.cmd}": ${err.message}`);
    });
    let hello;
    try {
      hello = await this.#request('initialize', {
        protocolVersion: MCP_PROTOCOL_VERSION,
        capabilities: {},
        clientInfo: { name: MCP_CLIENT_NAME, version: MCP_CLIENT_VERSION },
      });
    } catch (err) {
      // Handshake fallido: no dejar huérfanos.
      await this.close();
      throw err;
    }
    // Notificación de "listo" (sin id, no espera respuesta).
    this.#notify('notifications/initialized', {});
    this.#started = true;
    return hello;
  }

  async listTools() {
    const res = await this.#request('tools/list', {});
    const tools = res?.tools;
    return Array.isArray(tools) ? tools : [];
  }

  async callTool(name, args = {}) {
    return this.#request('tools/call', { name, arguments: args ?? {} });
  }

  // Cierre ordenado: rechaza pendientes y mata al hijo (SIGTERM, SIGKILL si insiste).
  async close() {
    if (this.#closed) return;
    this.#closed = true;
    this.#failAll(new Error('McpClient: cliente cerrado'));
    const child = this.#child;
    this.#child = null;
    if (child && child.exitCode === null && child.signalCode == null) {
      try { child.kill('SIGTERM'); } catch { /* ya muerto */ }
      await new Promise((resolve) => {
        const t = setTimeout(() => {
          try { child.kill('SIGKILL'); } catch { /* best-effort */ }
          resolve();
        }, 2000);
        if (typeof t.unref === 'function') t.unref();
        child.once('exit', () => {
          clearTimeout(t);
          resolve();
        });
      });
    }
  }

  // Cierre sincrónico best-effort para process.on('exit') (ahí no hay async).
  closeSync() {
    if (this.#closed) return;
    this.#closed = true;
    try { this.#child?.kill('SIGKILL'); } catch { /* best-effort */ }
    this.#child = null;
  }

  #request(method, params) {
    if (this.#closed || !this.#child) {
      return Promise.reject(new Error('McpClient: cliente cerrado'));
    }
    const id = this.#nextId++;
    const line = JSON.stringify({ jsonrpc: '2.0', id, method, params }) + '\n';
    return new Promise((resolve, reject) => {
      const timer = setTimeout(() => {
        this.#pending.delete(id);
        reject(new Error(`McpClient: timeout (${this.timeoutMs}ms) en "${method}"`));
      }, this.timeoutMs);
      if (typeof timer.unref === 'function') timer.unref();
      this.#pending.set(id, { resolve, reject, timer, method });
      this.#child.stdin.write(line, (err) => {
        if (err) {
          clearTimeout(timer);
          this.#pending.delete(id);
          reject(err);
        }
      });
    });
  }

  #notify(method, params) {
    if (this.#closed || !this.#child) return;
    try {
      this.#child.stdin.write(JSON.stringify({ jsonrpc: '2.0', method, params }) + '\n');
    } catch { /* notificar es best-effort */ }
  }

  // Acumula stdout y procesa líneas completas (delimitadas por \n).
  #onData(chunk) {
    this.#buffer += chunk;
    const lines = this.#buffer.split('\n');
    this.#buffer = lines.pop();
    for (const raw of lines) {
      const line = raw.trim();
      if (!line) continue;
      let msg;
      try {
        msg = JSON.parse(line);
      } catch {
        // Servidor ruidoso: log a stderr y seguir, nunca throw.
        process.stderr.write(`[mcp:${this.cmd}] línea no-JSON ignorada: ${line.slice(0, 120)}\n`);
        continue;
      }
      this.#onMessage(msg);
    }
  }

  #onMessage(msg) {
    if (!msg || typeof msg !== 'object') return;
    // Respuesta a un request nuestro.
    if (msg.id !== undefined && this.#pending.has(msg.id)) {
      const { resolve, reject, timer } = this.#pending.get(msg.id);
      this.#pending.delete(msg.id);
      clearTimeout(timer);
      if (msg.error) {
        const detail = typeof msg.error === 'object'
          ? (msg.error.message ?? JSON.stringify(msg.error))
          : String(msg.error);
        reject(new Error(`McpClient: error JSON-RPC: ${detail}`));
      } else {
        resolve(msg.result ?? null);
      }
      return;
    }
    // Notificación del servidor o respuesta tardía: se ignora.
  }

  #failAll(err) {
    if (this.#pending.size === 0) return;
    const pendings = [...this.#pending.values()];
    this.#pending.clear();
    for (const p of pendings) {
      clearTimeout(p.timer);
      p.reject(err);
    }
  }
}

// Helper: abre un cliente, corre fn(client) y lo cierra siempre.
export async function withMcpClient(opts, fn) {
  const client = new McpClient(opts);
  await client.start();
  try {
    return await fn(client);
  } finally {
    await client.close();
  }
}
