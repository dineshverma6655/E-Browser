export interface ChatMessage {
  id: string;
  sender: 'me' | 'peer' | 'system';
  senderName?: string;
  text?: string;
  imageUrl?: string;
  videoUrl?: string;
  isViewOnce?: boolean;
  isOpened?: boolean;
  status?: 'sent' | 'seen';
  /** video transfer in flight (P2P chunks or cloud) */
  transfer?: 'sending' | 'receiving';
  mediaKind?: 'image' | 'video';
  /** the message this one replies to (`mine` is from the viewer's point of view) */
  replyTo?: ReplyRef;
  /** emoji reactions: mine / partner's */
  reactions?: { me?: string; peer?: string };
  /** "delete for everyone" leaves a tombstone */
  deleted?: boolean;
  /** a call record shown in the chat (duration / missed / declined) */
  call?: { video: boolean; status: 'completed' | 'missed' | 'declined'; duration: number; outgoing: boolean };
  progress?: number;
  timestamp: number;
}

export interface ReplyRef {
  id: string;
  text?: string;
  kind: 'text' | 'photo' | 'video';
  mine: boolean;
}

export interface PeerMediaStatus {
  audio: boolean;
  video: boolean;
  isFrontCamera?: boolean;
}

export type ConnectionStatus =
  | 'idle'
  | 'connecting'
  | 'waiting'
  | 'connected'
  | 'disconnected'
  | 'failed'
  | 'full';

export interface CallLogEntry {
  id: number | string;
  caller_id: string;
  callee_id: string;
  status: 'ringing' | 'answered' | 'missed' | 'declined' | 'completed';
  started_at: string;
  duration_s: number;
}
