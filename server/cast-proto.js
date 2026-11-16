'use strict';

/* Minimal Google Cast v2 wire format: a length-prefixed protobuf CastMessage
   carrying a JSON payload as a string. Only what MattStream uses is encoded,
   so there is no protobuf dependency to ship. */

function varint(value) {
  const bytes = [];
  let left = value;
  while (left > 127) {
    bytes.push((left & 0x7f) | 0x80);
    left >>>= 7;
  }
  bytes.push(left);
  return Buffer.from(bytes);
}

function key(field, type) {
  return varint((field << 3) | type);
}

function stringField(field, value) {
  const data = Buffer.from(value, 'utf8');
  return Buffer.concat([key(field, 2), varint(data.length), data]);
}

function buildMessage({ sourceId, destinationId, namespace, payload }) {
  const body = Buffer.concat([
    key(1, 0), varint(0), // protocol_version: CASTV2_1_0
    stringField(2, sourceId),
    stringField(3, destinationId),
    stringField(4, namespace),
    key(5, 0), varint(0), // payload_type: STRING
    stringField(6, JSON.stringify(payload)),
  ]);
  const frame = Buffer.alloc(4);
  frame.writeUInt32BE(body.length, 0);
  return Buffer.concat([frame, body]);
}

function readVarint(buf, start) {
  let value = 0;
  let shift = 0;
  let at = start;
  while (at < buf.length) {
    const byte = buf[at];
    at += 1;
    value |= (byte & 0x7f) << shift;
    if ((byte & 0x80) === 0) break;
    shift += 7;
  }
  return { value, next: at };
}

function parseMessage(body) {
  const out = { namespace: '', sourceId: '', destinationId: '', payload: null };
  let at = 0;
  while (at < body.length) {
    const keyRead = readVarint(body, at);
    const field = keyRead.value >> 3;
    const type = keyRead.value & 7;
    at = keyRead.next;
    if (type === 0) {
      const valueRead = readVarint(body, at);
      at = valueRead.next;
      continue;
    }
    if (type !== 2) {
      if (type === 5) at += 4;
      else if (type === 1) at += 8;
      else break;
      continue;
    }
    const lengthRead = readVarint(body, at);
    const start = lengthRead.next;
    const end = start + lengthRead.value;
    const chunk = body.slice(start, end);
    at = end;
    if (field === 4) out.namespace = chunk.toString('utf8');
    else if (field === 2) out.sourceId = chunk.toString('utf8');
    else if (field === 3) out.destinationId = chunk.toString('utf8');
    else if (field === 6) {
      try {
        out.payload = JSON.parse(chunk.toString('utf8'));
      } catch (err) {
        out.payload = { raw: chunk.toString('utf8') };
      }
    }
  }
  return out;
}

module.exports = { buildMessage, parseMessage };
