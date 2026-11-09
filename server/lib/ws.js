import { WebSocketServer } from 'ws';

import { parseClientMessage } from '../../shared/protocol.ts';
import { MeetingSession } from './meeting-session.js';
import { getErrorText } from './text.js';

const MAX_WS_PAYLOAD_BYTES = 1024 * 1024;

export function attachMeetingServer(server, keyRing, store) {
  const wss = new WebSocketServer({ server, path: '/meeting', maxPayload: MAX_WS_PAYLOAD_BYTES });

  // Heartbeat (patrón del README de `ws`): sin esto, un cliente colgado
  // deja un MeetingSession vivo del lado servidor sin que nadie se entere.
  // El navegador/Tauri responde pong solo: sin cambios en el cliente.
  const heartbeat = setInterval(() => {
    for (const socket of wss.clients) {
      if (socket.isAlive === false) {
        socket.terminate();
        continue;
      }
      socket.isAlive = false;
      try {
        socket.ping();
      } catch {
        socket.terminate();
      }
    }
  }, 30000);
  wss.on('close', () => clearInterval(heartbeat));

  wss.on('connection', (socket) => {
    // meeting_ready se envía cuando el cliente manda `hello {meetingId?}`
    // (reanuda esa reunión o crea una nueva).
    const meeting = new MeetingSession(socket, keyRing, store);
    socket.isAlive = true;
    socket.on('pong', () => {
      socket.isAlive = true;
    });

    socket.on('message', async (raw) => {
      const parsed = parseClientMessage(String(raw));
      if (!parsed.ok) {
        meeting.send({
          type: 'error',
          message: "Couldn't process that message.",
          detail: parsed.error
        });
        return;
      }
      try {
        await meeting.handleClientMessage(parsed.message);
      } catch (error) {
        meeting.send({
          type: 'error',
          message: "Couldn't process that message.",
          detail: getErrorText(error)
        });
      }
    });

    socket.on('close', () => meeting.close());
  });

  return wss;
}
