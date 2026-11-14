// -----------------------------------------------------------------------------
// Minimal Modbus TCP client, built on node:net only.
//
// The SUN2000 does not expose a REST API on its LAN endpoint: the Smart Dongle
// (Wi-Fi module), the inverter's built-in Wi-Fi (port 6607) or a SmartLogger
// serves the Huawei "Solar Inverter Modbus Interface Definitions" over **Modbus
// TCP**. Values are HOLDING registers read with function code 0x03; the two
// command registers (startup 40200 / shutdown 40201) are written with function
// code 0x06. Huawei's register numbers (30000, 32064...) are used as wire
// addresses directly.
//
// Connection policy: ONE persistent TCP connection, opened lazily on the first
// exchange and kept open between polls (closed after 30 s of inactivity).
// Modbus TCP servers accept a single connection at a time — and some firmwares
// (in particular the built-in Wi-Fi of older SUN2000, port 6607) ignore or drop
// clients that reconnect for every frame. A persistent connection is exactly
// what the Home Assistant integration does, and it survived that hardware for
// years. A failed exchange is retried once on a brand-new connection: the only
// writes this client performs (heartbeat 49999, startup/shutdown commands) are
// idempotent, so a retry after a dead connection cannot double-fire a command
// in a harmful way.
//
// The socket is injectable so the tests never touch the network.
// -----------------------------------------------------------------------------

import net from 'node:net';

const PROTOCOL_ID = 0;
const FUNCTION_READ_HOLDING = 0x03;
const FUNCTION_WRITE_SINGLE = 0x06;
const FUNCTION_EXCEPTION_FLAG = 0x80;
// Modbus reads at most 125 registers per request; Huawei's own tooling stays
// well under it. Our largest block is 75 registers.
export const MAX_REGISTERS_PER_READ = 125;
// Generous by design: the built-in Wi-Fi module of older inverters answers
// slowly, and a timeout only costs time on a failure path anyway.
export const DEFAULT_TIMEOUT_MS = 10000;
// An idle connection is closed after this delay; the next exchange reopens
// one. Long enough to span several 60 s polls in a row, short enough not to
// hold the inverter's single connection slot when Gladys idles.
export const IDLE_CLOSE_MS = 30000;

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
 * Build one MBAP write request (function 0x06, write single register).
 * @param {number} transactionId 0..65535, echoed by the server
 * @param {number} unitId Modbus slave id (0 = directly connected device)
 * @param {number} address register address (Huawei numbering, e.g. 40200)
 * @param {number} value 16-bit value to write
 * @returns {Buffer} the 12-byte frame
 */
export function buildWriteFrame(transactionId, unitId, address, value) {
  if (!Number.isInteger(value) || value < 0 || value > 0xffff) {
    throw new ModbusError(`register value out of range: ${value}`);
  }
  const frame = Buffer.alloc(12);
  frame.writeUInt16BE(transactionId, 0);
  frame.writeUInt16BE(PROTOCOL_ID, 2);
  frame.writeUInt16BE(6, 4); // bytes after the protocol id
  frame.writeUInt8(unitId & 0xff, 6);
  frame.writeUInt8(FUNCTION_WRITE_SINGLE, 7);
  frame.writeUInt16BE(address, 8);
  frame.writeUInt16BE(value, 10);
  return frame;
}

/**
 * Parse one write response (function 0x06 echoes address and value).
 * Throws a readable ModbusError on every deviation.
 * @param {Buffer} frame raw response
 * @param {number} transactionId the id that was sent
 * @param {number} address the register address that was written
 * @param {number} value the value that was written
 */
export function parseWriteResponse(frame, transactionId, address, value) {
  if (frame.length < 9) {
    throw new ModbusError(`short response: ${frame.length} byte(s)`);
  }
  if (frame.readUInt16BE(0) !== transactionId) {
    throw new ModbusError('response transaction id mismatch');
  }
  const functionCode = frame.readUInt8(7);
  if (functionCode === (FUNCTION_WRITE_SINGLE | FUNCTION_EXCEPTION_FLAG)) {
    const code = frame.length >= 9 ? frame.readUInt8(8) : 0;
    // Huawei answers "illegal data address" on registers the inverter refuses
    // to write: this is often a PERMISSION problem (installer-level command),
    // not a wrong address. The name stays Modbus-accurate, the caller explains.
    throw new ModbusError(`Modbus exception ${code}: ${EXCEPTION_MESSAGES[code] ?? 'unknown exception'}`, { code });
  }
  if (functionCode !== FUNCTION_WRITE_SINGLE) {
    throw new ModbusError(`unexpected function code ${functionCode}`);
  }
  if (frame.readUInt16BE(8) !== address || frame.readUInt16BE(10) !== value) {
    throw new ModbusError('write echo mismatch: the inverter did not confirm the value');
  }
}

/**
 * Create a Modbus TCP client bound to one inverter.
 * @param {object} config normalized config (host, port, unit_id)
 * @param {object} [options] `connect` overrides the socket factory (tests)
 */
export function createModbusClient(config, { connect = net.connect } = {}) {
  const host = String(config.host ?? '').trim();
  if (!host) {
    throw new ModbusError('The inverter address is empty: fill in the IP address in the configuration.');
  }
  const port = Number(config.port) || 502;
  const unitId = Number(config.unit_id ?? 0);
  const timeoutMs = DEFAULT_TIMEOUT_MS;

  let socket = null;
  let rxBuffer = Buffer.alloc(0);
  let pending = null; // { transactionId, parse, resolve, reject }
  let idleTimer = null;
  let transactionId = 0;

  const nextTransactionId = () => {
    transactionId = (transactionId + 1) & 0xffff;
    return transactionId;
  };

  const disarmIdleTimer = () => {
    if (idleTimer !== null) {
      clearTimeout(idleTimer);
      idleTimer = null;
    }
  };

  // Drop the connection (error path, resync, idle close). Any in-flight
  // request must already have been rejected by its own handler.
  const dropSocket = () => {
    disarmIdleTimer();
    if (socket !== null) {
      socket.destroy();
      socket = null;
    }
    rxBuffer = Buffer.alloc(0);
  };

  const armIdleTimer = () => {
    disarmIdleTimer();
    idleTimer = setTimeout(() => dropSocket(), IDLE_CLOSE_MS);
    // An idle connection must never keep the container from exiting.
    idleTimer.unref?.();
  };

  const rejectPending = (error) => {
    if (pending !== null) {
      const { reject } = pending;
      pending = null;
      reject(error);
    }
  };

  function open() {
    return new Promise((resolve, reject) => {
      let settled = false;
      const s = connect({ host, port });
      s.on('connect', () => {
        if (settled) return;
        settled = true;
        socket = s;
        resolve();
      });
      s.on('data', onData);
      s.on('timeout', () => {
        if (pending === null) return;
        const error = new ModbusError(`timeout after ${timeoutMs} ms`, { host });
        dropSocket();
        rejectPending(error);
      });
      s.on('error', (error) => {
        if (!settled) {
          settled = true;
          reject(new ModbusError(`connection failed: ${error.message}`, { host }));
          return;
        }
        dropSocket();
        rejectPending(new ModbusError(`connection failed: ${error.message}`, { host }));
      });
      s.on('close', () => {
        if (socket === s) {
          socket = null;
        }
        disarmIdleTimer();
      });
    });
  }

  function onData(chunk) {
    rxBuffer = Buffer.concat([rxBuffer, chunk]);
    while (rxBuffer.length >= 6) {
      const expected = 6 + rxBuffer.readUInt16BE(4);
      if (rxBuffer.length < expected) break;
      const frame = Buffer.from(rxBuffer.subarray(0, expected));
      rxBuffer = rxBuffer.subarray(expected);
      if (pending !== null && frame.readUInt16BE(0) === pending.transactionId) {
        const { transactionId: sentId, parse, resolve, reject } = pending;
        pending = null;
        if (socket !== null) {
          socket.setTimeout(0); // the exchange is over: no per-exchange timeout
        }
        try {
          resolve(parse(frame, sentId));
        } catch (error) {
          reject(error);
        }
        armIdleTimer();
      } else {
        // A late or unexpected frame: the stream is out of sync (the answer to
        // a request we already timed out, garbage...). The only honest
        // recovery is to drop the connection and reopen a clean one.
        dropSocket();
        rejectPending(new ModbusError('response transaction id mismatch'));
      }
    }
  }

  /**
   * Send one request on the (persistent) connection. Every failure retries
   * once on a brand-new connection: a silent idle death is far more likely
   * than two consecutive server failures, and every write this client
   * performs is idempotent.
   * @param {(transactionId: number) => Buffer} buildFrame
   * @param {(frame: Buffer, transactionId: number) => any} parse
   */
  async function request(buildFrame, parse) {
    try {
      return await attempt(buildFrame, parse);
    } catch (firstError) {
      dropSocket();
      return attempt(buildFrame, parse);
    }
  }

  async function attempt(buildFrame, parse) {
    if (socket === null) {
      await open();
    }
    if (socket === null) {
      // Connected, then dropped before anything was sent (the inverter
      // released us): an ordinary retryable connection failure.
      throw new ModbusError('connection failed (closed before any exchange)', { host });
    }
    if (pending !== null) {
      // Strictly sequential usage (one await at a time) makes this a guard
      // against programming errors, not a concurrency feature.
      throw new ModbusError('another Modbus request is in flight', { host });
    }
    const sentId = nextTransactionId();
    try {
      return await new Promise((resolve, reject) => {
        pending = { transactionId: sentId, parse, resolve, reject };
        rxBuffer = Buffer.alloc(0); // discard stale bytes from a previous exchange
        socket.setTimeout(timeoutMs);
        socket.write(buildFrame(sentId));
      });
    } catch (error) {
      // A synchronous failure of the executor (socket.write throwing) would
      // leave the promise unsettled and `pending` leaked: clear it here.
      if (pending !== null && pending.transactionId === sentId) {
        pending = null;
      }
      throw error;
    }
  }

  /**
   * Read a block of holding registers. Huawei register numbers are wire
   * addresses (32064 is read as-is, not 32063).
   * @param {number} start first register address
   * @param {number} count register count (<= 125)
   * @returns {Promise<Uint16Array>}
   */
  async function readRegisters(start, count) {
    return request(
      (id) => buildReadFrame(id, unitId, start, count),
      (frame, id) => parseReadResponse(frame, id, count),
    );
  }

  /**
   * Write one holding register (function 0x06).
   * @param {number} address register address
   * @param {number} value 16-bit value
   */
  async function writeRegister(address, value) {
    return request(
      (id) => buildWriteFrame(id, unitId, address, value),
      (frame, id) => {
        parseWriteResponse(frame, id, address, value);
        return undefined;
      },
    );
  }

  return { host, port, unitId, readRegisters, writeRegister };
}
