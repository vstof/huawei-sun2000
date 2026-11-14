// -----------------------------------------------------------------------------
// Modbus TCP client tests: frame building, response parsing, block reads.
// The transport is stubbed: these tests never touch the network.
// -----------------------------------------------------------------------------

import { test } from 'node:test';
import assert from 'node:assert/strict';
import {
  ModbusError,
  buildReadFrame,
  createModbusClient,
  parseReadResponse,
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

test('readRegisters sends one frame per read and parses the answer', async () => {
  const sent = [];
  const client = createModbusClient(config, {
    transport: () => async ({ host, port, frame }) => {
      sent.push({ host, port, frame });
      return responseFrame({ transactionId: frame.readUInt16BE(0), registers: [32064] });
    },
  });
  const values = await client.readRegisters(30000, 1);
  assert.deepEqual([...values], [32064]);
  assert.equal(sent.length, 1);
  assert.equal(sent[0].host, '192.168.1.60');
  assert.equal(sent[0].port, 502);
  // The request asked for 1 register at 30000 on unit 0.
  assert.equal(sent[0].frame.readUInt16BE(8), 30000);
  assert.equal(sent[0].frame.readUInt16BE(10), 1);
  assert.equal(sent[0].frame.readUInt8(6), 0);
});

test('readRegisters increments the transaction id across reads', async () => {
  const ids = [];
  const client = createModbusClient(config, {
    transport: () => async ({ frame }) => {
      ids.push(frame.readUInt16BE(0));
      return responseFrame({ transactionId: frame.readUInt16BE(0), registers: [0] });
    },
  });
  await client.readRegisters(30000, 1);
  await client.readRegisters(30000, 1);
  assert.deepEqual(ids, [1, 2]);
});

test('a client without a host refuses to start with a readable error', () => {
  assert.throws(() => createModbusClient(normalizeConfig({}), {}), /address is empty/);
});
