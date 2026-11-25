import { io, Socket } from 'socket.io-client';
import { BACKEND_URL } from './backend';

let socket: Socket | null = null;

export const getSocket = (): Socket => {
  if (!socket) {
    // Connect to current origin in browser
    socket = io(BACKEND_URL || undefined, {
      autoConnect: false,
      reconnectionAttempts: Infinity, // never give up: the pairing must survive any network drop
      reconnectionDelay: 1000,
      reconnectionDelayMax: 5000,
      timeout: 10000,
    });
  }
  return socket;
};
