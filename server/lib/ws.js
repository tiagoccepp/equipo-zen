import { WebSocketServer } from 'ws';

import { MODEL } from './config.js';
import { MeetingSession } from './meeting-session.js';
import { getErrorText } from './text.js';

export function attachMeetingServer(server, keyRing) {
  const wss = new WebSocketServer({ server, path: '/meeting' });

  wss.on('connection', (socket) => {
    const meeting = new MeetingSession(socket, keyRing);
    meeting.send({
      type: 'meeting_ready',
      id: meeting.id,
      agents: meeting.publicAgents(),
      model: MODEL,
      liveMode: keyRing.hasKeys()
    });

    socket.on('message', async (raw) => {
      try {
        const message = JSON.parse(String(raw));
        await meeting.handleClientMessage(message);
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
