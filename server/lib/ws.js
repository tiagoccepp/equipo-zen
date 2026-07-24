import { WebSocketServer } from 'ws';

import { parseClientMessage } from '../../shared/protocol.ts';
import { MeetingSession } from './meeting-session.js';
import { getErrorText } from './text.js';

const MAX_WS_PAYLOAD_BYTES = 1024 * 1024;

export function attachMeetingServer(server, keyRing, store) {
  const wss = new WebSocketServer({ server, path: '/meeting', maxPayload: MAX_WS_PAYLOAD_BYTES });

  wss.on('connection', (socket) => {
    // meeting_ready se envía cuando el cliente manda `hello {meetingId?}`
    // (reanuda esa reunión o crea una nueva).
    const meeting = new MeetingSession(socket, keyRing, store);

    socket.on('message', async (raw) => {
      const parsed = parseClientMessage(String(raw));
      if (!parsed.ok) {
        meeting.send({
          type: 'error',
          message: 'No pude procesar ese mensaje.',
          detail: parsed.error
        });
        return;
      }
      try {
        await meeting.handleClientMessage(parsed.message);
      } catch (error) {
        meeting.send({
          type: 'error',
          message: 'No pude procesar ese mensaje.',
          detail: getErrorText(error)
        });
      }
    });

    socket.on('close', () => meeting.close());
  });

  return wss;
}
