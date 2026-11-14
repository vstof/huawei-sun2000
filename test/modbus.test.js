// -----------------------------------------------------------------------------
// Modbus TCP client tests: frame building, response parsing, persistent
// connection behavior. The socket is stubbed: these tests never touch the
// network.
// -----------------------------------------------------------------------------

import { test } from 'node:test';
import assert from 'node:assert/strict';
import {
  IDLE_CLOSE_MS,
  ModbusError,
  buildReadFrame,
  buildWriteFrame,
  createModbusClient,
  parseReadResponse,
  parseWriteResponse,
} from '../src/modbus.js';
import { normalizeConfig } from '../src/config.js';

const config = normalizeConfig({ host: '192.168.1.60', port: 502, unit_id: 0 });

function responseFrame({ transactionId = 1, unitId = 0, functionCode = 3, registers = [] } = {}) {
  const data = Buffer.alloc(registers.length * 2);
  registers.forEach((value, index) => data.writeUInt16BE(value, 2 * index));
  const pdu = Buffer.concat([Buffer.from([functionCode, data.length]), data]);
  const frame = Buffer.alloc(7);
  frame.writeUInt16BE(transactionId, 0);
  frame.writeUInt16BE(0, 2); // protocol id
  frame.writeUInt16BE(pdu.length + 1, 4); // unit id + pdu
  frame.writeUInt8(unitId, 6);
  return Buffer.concat([frame, pdu]);
}

test('buildReadFrame writes the MBAP header and the read request', () => {
  const frame = buildReadFrame(1, 0, 32064, 27);
  assert.deepEqual(
    [...frame],
    [0x00, 0x01, 0x00, 0x00, 0x00, 0x06, 0x00, 0x03, 0x7d, 0x40, 0x00, 0x1b],
  );
});

test('buildReadFrame refuses an out-of-range count', () => {
  assert.throws(() => buildReadFrame(1, 0, 30000, 0), /count out of range/);
  assert.throws(() => buildReadFrame(1, 0, 30000, 126), /count out of range/);
});

test('buildWriteFrame writes the MBAP header and the single-register write', () => {
  // Startup command: write 0 to register 40200 on slave 0.
  const frame = buildWriteFrame(2, 0, 40200, 0);
  assert.deepEqual(
    [...frame],
    [0x00, 0x02, 0x00, 0x00, 0x00, 0x06, 0x00, 0x06, 0x9d, 0x08, 0x00, 0x00],
  );
  // Heartbeat: write 1 to the magic register 49999.
  const heartbeat = buildWriteFrame(3, 0, 49999, 1);
  assert.deepEqual(
    [...heartbeat],
    [0x00, 0x03, 0x00, 0x00, 0x00, 0x06, 0x00, 0x06, 0xc3, 0x4f, 0x00, 0x01],
  );
});

test('buildWriteFrame refuses an out-of-range value', () => {
  assert.throws(() => buildWriteFrame(1, 0, 40200, -1), /value out of range/);
  assert.throws(() => buildWriteFrame(1, 0, 40200, 65536), /value out of range/);
});

test('parseWriteResponse validates the echo of address and value', () => {
  const frame = Buffer.from([0x00, 0x02, 0x00, 0x00, 0x00, 0x06, 0x00, 0x06, 0x9d, 0x08, 0x00, 0x00]);
  assert.doesNotThrow(() => parseWriteResponse(frame, 2, 40200, 0));
  const wrongEcho = Buffer.from([0x00, 0x02, 0x00, 0x00, 0x00, 0x06, 0x00, 0x06, 0x9d, 0x08, 0x00, 0x01]);
  assert.throws(() => parseWriteResponse(wrongEcho, 2, 40200, 0), /echo mismatch/);
});

test('parseWriteResponse turns an exception response into a readable error', () => {
  // Permission denied on a refused command often comes back as exception 2.
  const frame = Buffer.from([0x00, 0x02, 0x00, 0x00, 0x00, 0x03, 0x00, 0x86, 0x02]);
  let caught;
  try {
    parseWriteResponse(frame, 2, 40200, 0);
  } catch (error) {
    caught = error;
  }
  assert.ok(caught instanceof ModbusError, 'a ModbusError is thrown');
  assert.equal(caught.code, 2);
  assert.match(caught.message, /exception 2/);
});

test('parseReadResponse decodes the registers in order', () => {
  const frame = responseFrame({ transactionId: 7, registers: [0x0001, 0x8000, 0xffff] });
  const values = parseReadResponse(frame, 7, 3);
  assert.equal(values.length, 3);
  assert.equal(values[0], 1);
  assert.equal(values[1], 0x8000);
  assert.equal(values[2], 0xffff);
});

test('parseReadResponse rejects a transaction id mismatch', () => {
  const frame = responseFrame({ transactionId: 2, registers: [1] });
  assert.throws(() => parseReadResponse(frame, 7, 1), /transaction id mismatch/);
});

test('parseReadResponse turns an exception response into a readable error', () => {
  // Illegal data address (code 2): the register block does not exist.
  const frame = Buffer.from([0x00, 0x01, 0x00, 0x00, 0x00, 0x03, 0x00, 0x83, 0x02]);
  let caught;
  try {
    parseReadResponse(frame, 1, 27);
  } catch (error) {
    caught = error;
  }
  assert.ok(caught instanceof ModbusError, 'a ModbusError is thrown');
  assert.match(caught.message, /exception 2/);
  assert.match(caught.message, /illegal data address/);
});

test('parseReadResponse rejects a truncated or wrong-size response', () => {
  const frame = responseFrame({ transactionId: 1, registers: [1, 2] });
  assert.throws(() => parseReadResponse(frame, 1, 5), /size mismatch/);
  assert.throws(() => parseReadResponse(Buffer.from([0, 1, 0, 0]), 1, 1), /short response/);
});

test('parseReadResponse rejects an unexpected function code', () => {
  const frame = responseFrame({ transactionId: 1, functionCode: 4, registers: [1] });
  assert.throws(() => parseReadResponse(frame, 1, 1), /function code 4/);
});

// --- Fake sockets (the client opens one persistent connection) ---------------

function fakeSocket() {
  return {
    listeners: {},
    written: [],
    destroyed: false,
    on(event, handler) {
      (this.listeners[event] ??= []).push(handler);
    },
    setTimeout() {}, // armed by the client, never fires on a fake socket
    setNoDelay() {}, // called by the client after the handshake
    write(frame) {
      this.written.push(frame);
    },
    destroy() {
      this.destroyed = true;
    },
    emit(event, ...args) {
      for (const handler of this.listeners[event] ?? []) handler(...args);
    },
  };
}

// A socket that answers every request: reads (FC 03) with `registers`, writes
// (FC 06) with the echo the client validates.
function responderSocket({ registers = [0] } = {}) {
  const sock = fakeSocket();
  sock.write = (frame) => {
    sock.written.push(frame);
    const transactionId = frame.readUInt16BE(0);
    const functionCode = frame.readUInt8(7);
    let pdu;
    if (functionCode === 0x03) {
      const count = frame.readUInt16BE(10);
      const data = Buffer.alloc(count * 2);
      for (let index = 0; index < count; index += 1) {
        data.writeUInt16BE(registers[index % registers.length], 2 * index);
      }
      pdu = Buffer.concat([Buffer.from([functionCode, data.length]), data]);
    } else {
      pdu = frame.subarray(7, 12); // FC + address + value echo
    }
    const response = Buffer.alloc(7 + pdu.length);
    response.writeUInt16BE(transactionId, 0);
    response.writeUInt16BE(0, 2);
    response.writeUInt16BE(pdu.length + 1, 4);
    response.writeUInt8(frame.readUInt8(6), 6);
    pdu.copy(response, 7);
    sock.emit('data', response);
  };
  return sock;
}

// net.connect stub: each call opens a new (recorded) socket whose 'connect'
// event fires asynchronously, like a real socket.
function connectStub(sockets, makeSocket = () => responderSocket()) {
  return () => {
    const sock = makeSocket();
    sockets.push(sock);
    process.nextTick(() => sock.emit('connect'));
    return sock;
  };
}

test('readRegisters reuses one connection across reads', async () => {
  const sockets = [];
  const client = createModbusClient(config, {
    connect: connectStub(sockets, () => responderSocket({ registers: [32064] })),
    connectDelayMs: 0,
  });

  const first = await client.readRegisters(30000, 1);
  const second = await client.readRegisters(30000, 1);

  assert.equal(sockets.length, 1, 'one persistent connection, not one per frame');
  assert.deepEqual([...first], [32064]);
  assert.deepEqual([...second], [32064]);
  assert.equal(sockets[0].written.length, 2, 'two frames on the same socket');
  assert.deepEqual(
    sockets[0].written.map((frame) => frame.readUInt16BE(0)),
    [1, 2],
    'transaction ids increment across exchanges',
  );
  // The request asked for 1 register at 30000 on unit 0.
  assert.equal(sockets[0].written[0].readUInt16BE(8), 30000);
  assert.equal(sockets[0].written[0].readUInt16BE(10), 1);
  assert.equal(sockets[0].written[0].readUInt8(6), 0);
});

test('a failed exchange is retried once on a fresh connection', async () => {
  const sockets = [];
  const connect = () => {
    // First connection dies silently right after the connect; the retry
    // succeeds on a brand-new one.
    const socket =
      sockets.length === 0
        ? (() => {
            const dying = fakeSocket();
            process.nextTick(() => {
              dying.emit('connect');
              process.nextTick(() => dying.emit('error', new Error('ECONNRESET')));
            });
            return dying;
          })()
        : responderSocket({ registers: [7] });
    sockets.push(socket);
    process.nextTick(() => socket.emit('connect'));
    return socket;
  };
  const client = createModbusClient(config, { connect, connectDelayMs: 0 });

  const values = await client.readRegisters(30000, 1);

  assert.deepEqual([...values], [7]);
  assert.equal(sockets.length, 2, 'exactly one retry');
  assert.ok(sockets[0].destroyed, 'the dead socket was dropped');
});

test('a late or unexpected frame is discarded, the connection is kept', async () => {
  const sockets = [];
  // The device first replays a stale answer (wrong transaction id — the reply
  // to a request we already gave up on), then answers the actual request.
  const staleThenAnswer = () => {
    const sock = fakeSocket();
    sock.write = (frame) => {
      sock.written.push(frame);
      const stale = responseFrame({ transactionId: 9999, unitId: frame.readUInt8(6), registers: [0] });
      sock.emit('data', stale);
      sock.emit('data', responseFrame({ transactionId: frame.readUInt16BE(0), unitId: frame.readUInt8(6), registers: [7] }));
    };
    return sock;
  };
  const client = createModbusClient(config, {
    connect: connectStub(sockets, staleThenAnswer),
    connectDelayMs: 0,
  });

  const values = await client.readRegisters(30000, 1);

  assert.deepEqual([...values], [7]);
  assert.equal(sockets.length, 1, 'the stale frame did not cost the connection');
  assert.ok(!sockets[0].destroyed, 'the connection is still alive');
});

test('a clean close during an exchange rejects it and retries on a fresh connection', async () => {
  const sockets = [];
  const connect = () => {
    // First connection: closes cleanly right after the first write, without
    // answering. The retry succeeds on a brand-new one.
    const socket =
      sockets.length === 0
        ? (() => {
            const closing = fakeSocket();
            closing.write = (frame) => {
              closing.written.push(frame);
              closing.emit('close');
            };
            return closing;
          })()
        : responderSocket({ registers: [9] });
    sockets.push(socket);
    process.nextTick(() => socket.emit('connect'));
    return socket;
  };
  const client = createModbusClient(config, { connect, connectDelayMs: 0 });

  const values = await client.readRegisters(30000, 1);

  assert.deepEqual([...values], [9]);
  assert.equal(sockets.length, 2, 'exactly one retry after the close');
  assert.ok(sockets[0].destroyed, 'the closed socket was dropped');
});

test('the first request waits after the TCP handshake', async (t) => {
  t.mock.timers.enable({ apis: ['setTimeout'] });
  const tick = () => new Promise((resolve) => setImmediate(resolve));
  const sockets = [];
  const client = createModbusClient(config, {
    connect: connectStub(sockets, () => responderSocket({ registers: [5] })),
    connectDelayMs: 1000,
  });

  const promise = client.readRegisters(30000, 1);
  await tick(); // connect event fired
  await tick();
  assert.equal(sockets[0].written.length, 0, 'nothing is sent right after the handshake');

  t.mock.timers.tick(1000); // the post-handshake delay elapses
  const values = await promise;
  assert.deepEqual([...values], [5]);
  assert.equal(sockets[0].written.length, 1, 'the request goes out after the delay');
});

test('a timeout is retried once, then surfaces as a readable error', async () => {
  const tick = () => new Promise((resolve) => setImmediate(resolve));
  const sockets = [];
  const client = createModbusClient(config, { connect: connectStub(sockets, () => fakeSocket()), connectDelayMs: 0 });

  const promise = client.readRegisters(30000, 1);
  await tick(); // first connection established, frame written
  sockets[0].emit('timeout'); // attempt 1 gets no answer
  await tick(); // retry: second connection established, frame written
  sockets[1].emit('timeout'); // attempt 2 gets no answer either

  await assert.rejects(promise, /timeout after 10000 ms/);
  assert.equal(sockets.length, 2, 'exactly one retry');
  assert.ok(sockets[0].destroyed, 'the silent socket was dropped');
  assert.ok(sockets[1].destroyed, 'the second silent socket was dropped too');
});

test('writeRegister validates the echo over the persistent connection', async () => {
  const sockets = [];
  const client = createModbusClient(config, {
    connect: connectStub(sockets),
    connectDelayMs: 0,
  });

  await client.writeRegister(40200, 0);

  const frame = sockets[0].written[0];
  assert.equal(frame.readUInt8(7), 6, 'function code 06');
  assert.equal(frame.readUInt16BE(8), 40200);
  assert.equal(frame.readUInt16BE(10), 0);
});

test('an idle connection is closed after 30 s, reopened on demand', async (t) => {
  t.mock.timers.enable({ apis: ['setTimeout'] });
  const sockets = [];
  const client = createModbusClient(config, {
    connect: connectStub(sockets, () => responderSocket({ registers: [1] })),
    connectDelayMs: 0,
  });

  await client.readRegisters(30000, 1);
  t.mock.timers.tick(IDLE_CLOSE_MS);
  assert.ok(sockets[0].destroyed, 'the idle connection was closed');

  const values = await client.readRegisters(30000, 1);
  assert.deepEqual([...values], [1]);
  assert.equal(sockets.length, 2, 'reopened on demand');
});

test('a client without a host refuses to start with a readable error', () => {
  assert.throws(() => createModbusClient(normalizeConfig({}), {}), /address is empty/);
});
