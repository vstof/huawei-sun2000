// -----------------------------------------------------------------------------
// Minimal Modbus TCP client, built on node:net only.
//
// The SUN2000 does not expose a REST API on its LAN endpoint: the Smart Dongle
// (Wi-Fi module) or a SmartLogger serves the Huawei "Solar Inverter Modbus
// Interface Definitions" over **Modbus TCP**, port 502 by default. Every value
// is a HOLDING register (function code 0x03), and Huawei's register numbers
// (30000, 32064...) are used as wire addresses directly.
//
// Connection policy: ONE TCP connection per read. The dongle is a small
// embedded server that silently drops idle connections and answers only one
// master at a time — a short-lived connection per poll is the most robust
// pattern here (no reconnect bookkeeping, no stale sockets, and the
// integration is the only master on the dongle).
//
// The transport is injectable so the tests never touch the network.
// -----------------------------------------------------------------------------

import net from 'node:net';

const PROTOCOL_ID = 0;
const FUNCTION_READ_HOLDING = 0x03;
const FUNCTION_EXCEPTION_FLAG = 0x80;
// Modbus reads at most 125 registers per request; Huawei's own tooling stays
// well under it. Our largest block is 75 registers.
export const MAX_REGISTERS_PER_READ = 125;
const DEFAULT_TIMEOUT_MS = 5000;

export class ModbusError extends Error {
  constructor(message, { code, host } = {}) {
    super(message);
    this.name = 'ModbusError';
    this.code = code;
    this.host = host;
  }
}

const EXCEPTION_MESSAGES = {
  1: 'illegal function',
  2: 'illegal data address (register block not supported by this firmware)',
  3: 'illegal data value',
  4: 'server failure',
  6: 'server busy, retry later',
};

/**
 * Build one MBAP read request (function 0x03).
 * @param {number} transactionId 0..65535, echoed by the server
 * @param {number} unitId Modbus slave id (0 = directly connected device)
 * @param {number} start first register address (Huawei numbering, e.g. 32064)
 * @param {number} count register count, 1..125
 * @returns {Buffer} the 12-byte frame
 */
export function buildReadFrame(transactionId, unitId, start, count) {
  if (!Number.isInteger(count) || count < 1 || count > MAX_REGISTERS_PER_READ) {
    throw new ModbusError(`register count out of range: ${count}`);
  }
  const frame = Buffer.alloc(12);
  frame.writeUInt16BE(transactionId, 0);
  frame.writeUInt16BE(PROTOCOL_ID, 2);
  frame.writeUInt16BE(6, 4); // bytes after the protocol id
  frame.writeUInt8(unitId & 0xff, 6);
  frame.writeUInt8(FUNCTION_READ_HOLDING, 7);
  frame.writeUInt16BE(start, 8);
  frame.writeUInt16BE(count, 10);
  return frame;
}

/**
 * Parse one read response. Throws a readable ModbusError on every deviation
 * (wrong transaction, exception response, truncated frame, byte count).
 * @param {Buffer} frame raw response
 * @param {number} transactionId the id that was sent
 * @param {number} count register count that was requested
 * @returns {Uint16Array} register values
 */
export function parseReadResponse(frame, transactionId, count) {
  if (frame.length < 9) {
    throw new ModbusError(`short response: ${frame.length} byte(s)`);
  }
  if (frame.readUInt16BE(0) !== transactionId) {
    throw new ModbusError('response transaction id mismatch');
  }
  const functionCode = frame.readUInt8(7);
  if (functionCode === (FUNCTION_READ_HOLDING | FUNCTION_EXCEPTION_FLAG)) {
    const code = frame.length >= 9 ? frame.readUInt8(8) : 0;
    throw new ModbusError(`Modbus exception ${code}: ${EXCEPTION_MESSAGES[code] ?? 'unknown exception'}`, { code });
  }
  if (functionCode !== FUNCTION_READ_HOLDING) {
    throw new ModbusError(`unexpected function code ${functionCode}`);
  }
  const byteCount = frame.readUInt8(8);
  if (byteCount !== count * 2 || frame.length < 9 + byteCount) {
    throw new ModbusError(`response size mismatch: ${byteCount} bytes for ${count} registers`);
  }
  const values = new Uint16Array(count);
  for (let index = 0; index < count; index += 1) {
    values[index] = frame.readUInt16BE(9 + 2 * index);
  }
  return values;
}

/**
 * Default transport: open one TCP connection, send the frame, read exactly one
 * response (the MBAP header announces its total length), close.
 * @param {object} options { timeoutMs }
 */
function tcpTransport({ timeoutMs } = {}) {
  return ({ host, port, frame }) =>
    new Promise((resolve, reject) => {
      const socket = net.connect({ host, port });
      let settled = false;
      const settle = (fn, arg) => {
        if (settled) return;
        settled = true;
        socket.destroy();
        fn(arg);
      };
      socket.setTimeout(timeoutMs, () => settle(reject, new ModbusError(`timeout after ${timeoutMs} ms`, { host })));
      socket.on('error', (error) => settle(reject, new ModbusError(`connection failed: ${error.message}`, { host })));
      socket.on('connect', () => socket.write(frame));
      const chunks = [];
      socket.on('data', (chunk) => {
        chunks.push(chunk);
        const buffer = Buffer.concat(chunks);
        if (buffer.length < 6) return;
        // MBAP: the length field (bytes 4-5) counts unit id + PDU.
        const expected = 6 + buffer.readUInt16BE(4);
        if (buffer.length >= expected) {
          settle(resolve, buffer.subarray(0, expected));
        }
      });
    });
}

/**
 * Create a Modbus TCP client bound to one inverter.
 * @param {object} config normalized config (host, port, unit_id)
 * @param {object} [options] `transport` overrides the TCP implementation (tests)
 */
export function createModbusClient(config, { transport = tcpTransport } = {}) {
  const host = String(config.host ?? '').trim();
  if (!host) {
    throw new ModbusError('The inverter address is empty: fill in the IP address in the configuration.');
  }
  const port = Number(config.port) || 502;
  const unitId = Number(config.unit_id ?? 0);
  const timeoutMs = DEFAULT_TIMEOUT_MS;
  const send = transport({ timeoutMs });

  let transactionId = 0;

  /**
   * Read a block of holding registers. Huawei register numbers are wire
   * addresses (32064 is read as-is, not 32063).
   * @param {number} start first register address
   * @param {number} count register count (<= 125)
   * @returns {Promise<Uint16Array>}
   */
  async function readRegisters(start, count) {
    transactionId = (transactionId + 1) & 0xffff;
    const frame = buildReadFrame(transactionId, unitId, start, count);
    const response = await send({ host, port, frame });
    return parseReadResponse(response, transactionId, count);
  }

  return { host, port, unitId, readRegisters };
}
