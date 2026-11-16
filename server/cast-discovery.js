'use strict';

/* Finds Chromecast / Android TV devices on the local network over mDNS.
   No app is needed on the TV for this: every Google Cast device advertises
   `_googlecast._tcp.local`, and that advertisement carries the name you see in
   YouTube's cast list. */

const dgram = require('dgram');

const SERVICE = '_googlecast._tcp.local';
const RECORD_PTR = 12;
const RECORD_A = 1;

function encodeName(name) {
  const parts = [];
  for (const label of name.split('.')) {
    if (!label) continue;
    const bytes = Buffer.from(label, 'utf8');
    parts.push(Buffer.from([bytes.length]), bytes);
  }
  parts.push(Buffer.from([0]));
  return Buffer.concat(parts);
}

function buildQuery(name, type) {
  const header = Buffer.alloc(12);
  header.writeUInt16BE(0, 0); // id
  header.writeUInt16BE(0, 2); // standard query
  header.writeUInt16BE(1, 4); // one question
  const question = Buffer.alloc(4);
  question.writeUInt16BE(type, 0);
  question.writeUInt16BE(1, 2); // class IN
  return Buffer.concat([header, encodeName(name), question]);
}

// DNS names inside a response may use compression pointers; walk them safely.
function readName(buf, offset) {
  const labels = [];
  let at = offset;
  let jumped = false;
  let guard = 0;
  while (at < buf.length && guard++ < 128) {
    const length = buf[at];
    if (length === 0) {
      at += 1;
      break;
    }
    if ((length & 0xc0) === 0xc0) {
      const pointer = ((length & 0x3f) << 8) | buf[at + 1];
      if (!jumped) {
        offset = at + 2;
        jumped = true;
      }
      at = pointer;
      continue;
    }
    labels.push(buf.slice(at + 1, at + 1 + length).toString('utf8'));
    at += 1 + length;
  }
  return { name: labels.join('.'), next: jumped ? offset : at };
}

function record(name, type, data, out) {
  if (type === RECORD_PTR) {
    out.push({ kind: 'ptr', name, target: readName(data, 0).name });
  } else if (type === 33) {
    if (data.length < 7) return;
    out.push({ kind: 'srv', name, port: data.readUInt16BE(4), target: readName(data, 6).name });
  } else if (type === 16) {
    const fields = {};
    let at = 0;
    while (at < data.length) {
      const length = data[at];
      const entry = data.slice(at + 1, at + 1 + length).toString('utf8');
      const eq = entry.indexOf('=');
      if (eq > 0) fields[entry.slice(0, eq)] = entry.slice(eq + 1);
      at += 1 + length;
    }
    out.push({ kind: 'txt', name, fields });
  } else if (type === RECORD_A) {
    if (data.length !== 4) return;
    out.push({ kind: 'a', name, address: [...data].join('.') });
  }
}

function parsePacket(buf) {
  if (buf.length < 12) return [];
  const questions = buf.readUInt16BE(4);
  const total = buf.readUInt16BE(6) + buf.readUInt16BE(8) + buf.readUInt16BE(10);
  let at = 12;
  for (let i = 0; i < questions; i += 1) {
    const { next } = readName(buf, at);
    at = next + 4;
  }
  const records = [];
  for (let i = 0; i < total && at + 10 <= buf.length; i += 1) {
    const { name, next } = readName(buf, at);
    at = next;
    const type = buf.readUInt16BE(at);
    const length = buf.readUInt16BE(at + 8);
    const start = at + 10;
    at = start + length;
    if (at > buf.length) break;
    record(name, type, buf.slice(start, at), records);
  }
  return records;
}

// One mDNS round: ask for the given names and gather everything that answers.
function round(questions, timeoutMs) {
  return new Promise((resolve) => {
    const records = [];
    let socket;
    try {
      socket = dgram.createSocket({ type: 'udp4', reuseAddr: true });
    } catch (err) {
      resolve(records);
      return;
    }
    let settled = false;
    const done = () => {
      if (settled) return;
      settled = true;
      try {
        socket.close();
      } catch (err) {
        /* already closed */
      }
      resolve(records);
    };
    socket.on('error', done);
    socket.on('message', (message, rinfo) => {
      try {
        // The sender of the packet is the device itself, which saves having to
        // resolve the .local host name it advertises.
        for (const entry of parsePacket(message)) records.push({ ...entry, from: rinfo.address });
      } catch (err) {
        /* ignore malformed packets */
      }
    });
    socket.bind(0, () => {
      try {
        socket.setBroadcast(true);
        socket.setMulticastTTL(255);
      } catch (err) {
        /* defaults are fine */
      }
      for (const question of questions) {
        const packet = buildQuery(question.name, question.type);
        socket.send(packet, 0, packet.length, 5353, '224.0.0.251', () => {});
      }
    });
    setTimeout(done, timeoutMs);
  });
}

function collect(records) {
  const devices = new Map();
  const addresses = new Map();
  for (const entry of records) {
    if (entry.kind === 'a') addresses.set(entry.name, entry.address);
  }
  for (const entry of records) {
    if (entry.kind !== 'ptr' && entry.kind !== 'srv' && entry.kind !== 'txt') continue;
    const instance = entry.kind === 'ptr' ? entry.target : entry.name;
    if (!instance || !instance.endsWith(SERVICE)) continue;
    const device = devices.get(instance) || { instance, name: '', model: '', id: '' };
    if (entry.from) device.address = entry.from;
    if (entry.kind === 'srv') {
      device.port = entry.port;
      device.host = entry.target;
    }
    if (entry.kind === 'txt') {
      if (entry.fields.fn) device.name = entry.fields.fn;
      if (entry.fields.md) device.model = entry.fields.md;
      if (entry.fields.id) device.id = entry.fields.id;
    }
    devices.set(instance, device);
  }
  return { devices: [...devices.values()], addresses };
}

async function discover(timeoutMs = 1500) {
  const first = await round([{ name: SERVICE, type: RECORD_PTR }], timeoutMs);
  const { devices, addresses } = collect(first);

  // The service record names a host; a second round turns that into an IP.
  const unknown = devices.filter((device) => device.host && !addresses.has(device.host));
  if (unknown.length) {
    const second = await round(
      unknown.map((device) => ({ name: device.host, type: RECORD_A })),
      900
    );
    const extra = collect(second).addresses;
    for (const [host, address] of extra) addresses.set(host, address);
  }

  const list = [];
  for (const device of devices) {
    if (!device.port) continue;
    const address = device.address || addresses.get(device.host) || '';
    if (!address) continue;
    list.push({
      name: device.name || device.instance.replace('.' + SERVICE, ''),
      model: device.model || 'Google Cast',
      id: device.id || device.name || address,
      address,
      port: device.port,
    });
  }
  return list;
}

module.exports = { discover, SERVICE };
