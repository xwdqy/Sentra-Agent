declare module 'ws' {
  import { EventEmitter } from 'events';

  export type RawData = string | Buffer | ArrayBuffer | Uint8Array;

  class WebSocket extends EventEmitter {
    static OPEN: number;
    readyState: number;
    constructor(url: string);
    send(data: string): void;
    close(): void;
    on(event: 'open', listener: () => void): this;
    on(event: 'message', listener: (data: RawData) => void): this;
    on(event: 'error', listener: (err: Error) => void): this;
    on(event: 'close', listener: () => void): this;
  }

  export default WebSocket;
}
