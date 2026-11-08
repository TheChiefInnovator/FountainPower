import assert from 'node:assert/strict';
import { createRequire } from 'node:module';
import { readFileSync, mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';
import ts from 'typescript';
const require = createRequire(import.meta.url);
const temp = mkdtempSync(path.join(tmpdir(), 'power-units-'));
delete process.env.POWER_LABELS_API_URL;
delete process.env.POWER_LABELS_API_TOKEN;
process.env.POWER_DB_PATH = path.join(temp, 'test.sqlite');
const modules = new Map();
function load(name) {
  if (modules.has(name)) return modules.get(name);
  const filename = path.join(process.cwd(), 'src/lib', `${name}.ts`);
  const code = ts.transpileModule(readFileSync(filename, 'utf8'), {compilerOptions:{module:ts.ModuleKind.CommonJS,esModuleInterop:true}}).outputText;
  const loadedModule = { exports: {} };
  new Function('require', 'module', 'exports', code)((id) => id.startsWith('@/lib/') ? load(id.slice(6)) : require(id), loadedModule, loadedModule.exports);
  modules.set(name, loadedModule.exports);
  return loadedModule.exports;
}
try {
  const db = load('db');
  const {inputDisconnected} = load('input-supply');
  process.env.POWER_DISCONNECTED_INPUT_BANKS = '2:B';
  for (let outlet = 1; outlet <= 8; outlet++) {
    assert.equal(inputDisconnected(1, outlet), false);
    assert.equal(inputDisconnected(2, outlet), outlet >= 5);
  }
  process.env.POWER_DISCONNECTED_INPUT_BANKS = '';
  assert.equal(inputDisconnected(2, 5), false);
  process.env.POWER_DISCONNECTED_INPUT_BANKS = '2:C';
  assert.throws(() => inputDisconnected(2, 5), /Invalid/);
  delete process.env.POWER_DISCONNECTED_INPUT_BANKS;
  const {parseUnit} = load('units');
  assert.equal(parseUnit(null), 1);
  assert.equal(parseUnit('2'), 2);
  assert.throws(() => parseUnit('3'));
  assert.throws(() => parseUnit(''));
  await db.updateOutlet(1, 'Existing custom label', 'Keep this', 1);
  assert.equal((await db.getOutletRecords(2))[0].label, 'FountainSix');
  await db.updateOutlet(1, 'Second unit edit', 'Unit two only', 2);
  assert.equal((await db.getOutletRecords(1))[0].label, 'Existing custom label');
  assert.equal((await db.getOutletRecords(2))[0].label, 'Second unit edit');
  assert.equal((await db.getOutletRecords(1)).length + (await db.getOutletRecords(2)).length, 16);
  const power = load('power');
  await assert.rejects(power.setOutletPower(1, 'on', 3), /Invalid power unit/);
  await assert.rejects(power.setOutletPower(9, 'on', 2), /between 1 and 8/);
  await assert.rejects(power.setOutletPower(5, 'off', 1), /cannot be turned off/);
  const requests = [];
  const states = Object.fromEntries(Array.from({length:8},(_,i)=>[String(i+1),'on']));
  process.env.POWER_UNIT2_BRIDGE_URL = 'http://serial.test';
  process.env.POWER_UNIT2_BRIDGE_TOKEN = 'test-token';
  globalThis.fetch = async (url, options) => {
    requests.push([url,options]);
    return {ok:true,json:async()=>({states})};
  };
  assert.deepEqual(await power.readPowerStates(2), states);
  assert.equal(requests[0][0], 'http://serial.test/status');
  assert.equal(requests[0][1].headers.Authorization, 'Bearer test-token');
  console.log('PASS: legacy labels preserved, unit edits isolated, invalid units/outlets rejected, unit 1 protection retained, unit 2 routed to bridge.');
} finally { rmSync(temp,{recursive:true,force:true}); }
