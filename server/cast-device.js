'use strict';

/* Talks Google Cast v2 to a TV: the same protocol YouTube's cast button uses.
   No app on the TV is involved - the built-in Default Media Receiver plays the
   stream the server hands it. */

const tls = require('tls');
const { buildMessage, parseMessage } = require('./cast-proto');

const NS = {
  connection: 'urn:x-cast:com.google.cast.tp.connection',
  heartbeat: 'urn:x-cast:com.google.cast.tp.heartbeat',
  receiver: 'urn:x-cast:com.google.cast.receiver',
  media: 'urn:x-cast:com.google.cast.media',
};

const DEFAULT_RECEIVER = 'CC1AD845';
const SENDER_ID = 'sender-0';

function withTimeout(promise, ms, message) {
  let timer;
  return Promise.race([
    promise,
    new Promise((resolve, reject) => {
      timer = setTimeout(() => reject(new Error(message)), ms);
    }),
  ]).finally(() => clearTimeout(timer));
}

class CastSession {
  constructor(device) {
    this.device = device;
    this.socket = null;
    this.buffer = Buffer.alloc(0);
    this.requestId = 0;
    this.pending = new Map();
    this.listeners = [];
    this.heartbeat = null;
    this.transportId = null;
    this.sessionId = null;
    this.closed = false;
  }

  open() {
    return new Promise((resolve, reject) => {
      const socket = tls.connect(
        {
          host: this.device.address,
          port: this.device.port || 8009,
          rejectUnauthorized: false,
        },
        () => {
          this.socket = socket;
          this.send('receiver-0', NS.connection, { type: 'CONNECT' });
          this.heartbeat = setInterval(() => {
            try {
              this.send('receiver-0', NS.heartbeat, { type: 'PING' });
            } catch (err) {
              /* the socket closed; error handling covers it */
            }
          }, 5000);
          resolve();
        }
      );
      socket.setNoDelay(true);
      socket.on('data', (chunk) => this.receive(chunk));
      socket.on('error', (err) => {
        this.closed = true;
        reject(err);
        this.fail(err.message);
      });
      socket.on('close', () => {
        this.closed = true;
        this.stopHeartbeat();
        this.fail('The TV closed the connection');
      });
    });
  }

  stopHeartbeat() {
    if (this.heartbeat) clearInterval(this.heartbeat);
    this.heartbeat = null;
  }

  fail(reason) {
    for (const [, entry] of this.pending) {
      clearTimeout(entry.timer);
      entry.reject(new Error(reason));
    }
    this.pending.clear();
  }

  send(destinationId, namespace, payload) {
    if (!this.socket) throw new Error('Not connected to the TV');
    this.socket.write(
      buildMessage({ sourceId: SENDER_ID, destinationId, namespace, payload })
    );
  }

  receive(chunk) {
    this.buffer = Buffer.concat([this.buffer, chunk]);
    while (this.buffer.length >= 4) {
      const length = this.buffer.readUInt32BE(0);
      if (this.buffer.length < 4 + length) break;
      const body = this.buffer.slice(4, 4 + length);
      this.buffer = this.buffer.slice(4 + length);
      let message;
      try {
        message = parseMessage(body);
      } catch (err) {
        continue;
      }
      this.handle(message);
    }
  }

  handle(message) {
    const payload = message.payload || {};
    if (message.namespace === NS.heartbeat) {
      if (payload.type === 'PING') this.send(message.sourceId, NS.heartbeat, { type: 'PONG' });
      return;
    }
    for (const listener of this.listeners) listener(message);
    if (payload.requestId && this.pending.has(payload.requestId)) {
      const entry = this.pending.get(payload.requestId);
      this.pending.delete(payload.requestId);
      clearTimeout(entry.timer);
      entry.resolve(payload);
    }
  }

  request(destinationId, namespace, payload, timeoutMs = 9000) {
    const requestId = ++this.requestId;
    return new Promise((resolve, reject) => {
      const timer = setTimeout(() => {
        this.pending.delete(requestId);
        reject(new Error('The TV did not answer'));
      }, timeoutMs);
      this.pending.set(requestId, { resolve, reject, timer });
      try {
        this.send(destinationId, namespace, { ...payload, requestId });
      } catch (err) {
        clearTimeout(timer);
        this.pending.delete(requestId);
        reject(err);
      }
    });
  }

  async status() {
    return this.request('receiver-0', NS.receiver, { type: 'GET_STATUS' }, 6000);
  }

  async launch(appId = DEFAULT_RECEIVER) {
    const reply = await this.request(
      'receiver-0',
      NS.receiver,
      { type: 'LAUNCH', appId },
      20000
    );
    const apps = (reply.status && reply.status.applications) || [];
    const app = apps.find((entry) => entry.appId === appId) || apps[0];
    if (!app || !app.transportId) {
      throw new Error(
        reply.status && reply.status.reason
          ? 'The TV refused to start the player: ' + reply.status.reason
          : 'The TV did not start the player'
      );
    }
    this.transportId = app.transportId;
    this.sessionId = app.sessionId;
    this.send(this.transportId, NS.connection, { type: 'CONNECT' });
    return app;
  }

  async load({ url, contentType, title, image, autoplay = true }) {
    if (!this.transportId) throw new Error('No player on the TV yet');
    const media = {
      contentId: url,
      streamType: 'BUFFERED',
      contentType,
      metadata: {
        type: 0,
        metadataType: 0,
        title: title || '',
        images: image ? [{ url: image }] : [],
      },
    };
    const reply = await this.request(
      this.transportId,
      NS.media,
      { type: 'LOAD', autoplay, media },
      20000
    );
    const status = (reply.status && reply.status[0]) || null;
    if (!status) throw new Error('The TV did not accept the video');
    return status;
  }

  async setVolume(level) {
    // Cast keeps its own volume: a receiver left at 0 is silent even though
    // the media reports sound and the TV's own volume is up.
    return this.request('receiver-0', NS.receiver, {
      type: 'SET_VOLUME',
      volume: { level: Math.max(0, Math.min(1, Number(level))) },
    });
  }

  async playState() {
    if (!this.transportId) return null;
    const reply = await this.request(
      this.transportId,
      NS.media,
      { type: 'GET_STATUS' },
      6000
    );
    return (reply.status && reply.status[0]) || null;
  }

  async pause() {
    const status = await this.playState();
    if (!status) return null;
    return this.request(this.transportId, NS.media, {
      type: 'PAUSE',
      mediaSessionId: status.mediaSessionId,
    });
  }

  async resume() {
    const status = await this.playState();
    if (!status) return null;
    return this.request(this.transportId, NS.media, {
      type: 'PLAY',
      mediaSessionId: status.mediaSessionId,
    });
  }

  async seek(seconds) {
    const status = await this.playState();
    if (!status) return null;
    return this.request(this.transportId, NS.media, {
      type: 'SEEK',
      mediaSessionId: status.mediaSessionId,
      currentTime: Math.max(0, seconds),
    });
  }

  async stop() {
    if (!this.transportId) return null;
    const status = await this.playState();
    return this.request(this.transportId, NS.media, {
      type: 'STOP',
      mediaSessionId: status ? status.mediaSessionId : undefined,
    });
  }

  close() {
    this.stopHeartbeat();
    this.fail('Connection closed');
    if (this.socket) {
      try {
        this.socket.end();
      } catch (err) {
        /* already gone */
      }
      this.socket = null;
    }
  }
}

async function connect(device) {
  const session = new CastSession(device);
  await withTimeout(session.open(), 6000, 'The TV did not accept the connection');
  return session;
}

module.exports = { connect, CastSession, NS, DEFAULT_RECEIVER };
