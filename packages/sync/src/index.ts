export { AccessDenied, SyncClient, type SyncClientOptions, type SyncStatus } from "./client";
export {
  awarenessMessage,
  BOARD_ID,
  CloseCode,
  HEARTBEAT,
  MessageType,
  PROTOCOL_VERSION,
  syncStep1,
  syncUpdate,
} from "./protocol";
export { type Peer, type Role, Room } from "./room";
export { fromWebSocket, type Socket, type WebSocketLike } from "./socket";
