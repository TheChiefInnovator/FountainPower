// Real HTTP + disposable SQLite integration; no infrastructure or credentials.
import assert from 'node:assert/strict';
import { execFileSync } from 'node:child_process';
import { createServer } from 'node:http';
import { createRequire } from 'node:module';
import { readFileSync, mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';
import ts from 'typescript';

const require = createRequire(import.meta.url);
const temp = mkdtempSync(path.join(tmpdir(), 'power-labels-'));
function loadDb(filename) {
  process.env.POWER_DB_PATH = filename;
  const code = ts.transpileModule(readFileSync('src/lib/db.ts', 'utf8'), {
    compilerOptions: { module: ts.ModuleKind.CommonJS, target: ts.ScriptTarget.ES2022, esModuleInterop: true },
  }).outputText;
  const loadedModule = { exports: {} };
  new Function('require', 'module', 'exports', code)(require, loadedModule, loadedModule.exports);
  return loadedModule.exports;
}
const rows = new Map();
const calls = [];
let fail = false;
let malformed = false;
const token = 'test-labels-token';
const server = createServer(async (request, response) => {
  const chunks = [];
  for await (const chunk of request) chunks.push(chunk);
  const raw = Buffer.concat(chunks);
  calls.push({ method: request.method, path: request.url, bytes: raw.length });
  response.setHeader('Content-Type', 'application/json');
  const reply = (status, body) => { response.writeHead(status); response.end(JSON.stringify(body)); };
  if (request.headers.authorization !== `Bearer ${token}`) return reply(401, { error: 'Unauthorized' });
  if (fail) return reply(503, { error: 'Unavailable' });
  if (raw.length > 4096) return reply(413, { error: 'Oversize' });
  if (request.method === 'GET' && request.url === '/v1/labels') {
    return reply(200, malformed ? { labels: [null] } : { labels: [...rows.values()].map((row) => ({
      unit: row.unit, outlet: row.outlet, label: row.label, server: row.server,
      sortOrder: row.sortOrder, updatedAt: row.updatedAt,
    })) });
  }
  const body = JSON.parse(raw);
  if (request.method === 'POST' && request.url === '/v1/labels/seed') {
    const counts = { inserted: 0, updated: 0, ignored: 0 };
    for (const row of body.labels) {
      assert.ok(row.updatedAt.endsWith('Z') || /[+-]\d\d:\d\d$/.test(row.updatedAt));
      const key = `${row.unit}:${row.outlet}`;
      const old = rows.get(key);
      if (!old || (old.source === 'seed' && Date.parse(row.updatedAt) > Date.parse(old.updatedAt))) {
        counts[old ? 'updated' : 'inserted']++;
        rows.set(key, { ...row, source: 'seed' });
      } else counts.ignored++;
    }
    return reply(200, counts);
  }
  const match = request.url.match(/^\/v1\/labels\/([12])\/([1-8])$/);
  if (request.method === 'PUT' && match) {
    const unit = Number(match[1]), outlet = Number(match[2]);
    const row = { unit, outlet, ...body, sortOrder: outlet, updatedAt: new Date().toISOString() };
    rows.set(`${unit}:${outlet}`, { ...row, source: 'put' });
    return reply(200, row);
  }
  reply(404, { error: 'Unknown route' });
});
await new Promise((resolve) => server.listen(0, '127.0.0.1', resolve));
const url = `http://127.0.0.1:${server.address().port}`;
const filename = path.join(temp, 'replica-one.sqlite');
const snapshot = () => execFileSync('sqlite3', [filename,
  "select json_group_array(json_object('outlet',outlet,'label',label,'server',server,'sort',sort_order,'at',updated_at)) from outlets;"], { encoding: 'utf8' });
try {
  delete process.env.POWER_LABELS_API_URL;
  delete process.env.POWER_LABELS_API_TOKEN;
  const db = loadDb(filename);
  assert.equal((await db.getOutletRecords(1)).length, 8);
  await db.updateOutlet(1, '  Legacy custom  ', '', 1);
  assert.equal((await db.getOutletRecords(1))[0].label, 'Legacy custom');
  assert.equal((await db.getOutletRecords(1))[0].server, '');
  assert.equal((await db.getOutletRecords(1))[0].readOnly, undefined);
  assert.equal(calls.length, 0);
  // Prepare valid migration data. Empty descriptions remain allowed in legacy mode.
  await db.updateOutlet(1, 'Replica local', 'Original description', 1);
  process.env.POWER_LABELS_API_URL = url;
  process.env.POWER_LABELS_API_TOKEN = token;
  for (let outlet = 1; outlet <= 8; outlet++) {
    rows.set(`1:${outlet}`, { unit: 1, outlet, label: `Shared ${outlet}`, server: 'Shared host',
      sortOrder: 9 - outlet, updatedAt: '2026-11-07T12:00:00Z', source: 'put' });
  }
  let result = await db.getOutletRecords(1);
  assert.equal(result.find((row) => row.outlet === 1).label, 'Shared 1');
  assert.equal(result[0].outlet, 8, 'shared sort order is respected');
  assert.equal(result.some((row) => row.readOnly), false);
  assert.match(snapshot(), /Shared 1/);
  assert.doesNotMatch(snapshot(), /Replica local/);
  console.log('PASS: shared reads override local rows, preserve ordering, and refresh SQLite cache.');

  fail = true;
  result = await db.getOutletRecords(1);
  assert.equal(result.find((row) => row.outlet === 1).label, 'Shared 1');
  assert.ok(result.every((row) => row.readOnly === true));
  const before = snapshot();
  await assert.rejects(db.updateOutlet(1, 'Lost edit', 'Do not save', 1), /shared store unavailable/);
  assert.equal(snapshot(), before, 'failed writes leave SQLite rows and timestamps untouched');
  fail = false;
  malformed = true;
  assert.ok((await db.getOutletRecords(1)).every((row) => row.readOnly));
  malformed = false;
  console.log('PASS: unavailable/malformed shared reads fall back with readOnly; unavailable writes leave SQLite unchanged.');

  const edited = await db.updateOutlet(1, "  Operator's 雪  ", '  Shared edit  ', 1);
  assert.equal(edited.label, "Operator's 雪");
  assert.equal(edited.server, 'Shared edit');
  assert.match(snapshot(), /Operator's 雪/);
  assert.equal((await db.getOutletRecords(1)).some((row) => row.readOnly), false);
  const writes = calls.length;
  for (const [label, description] of [['x'.repeat(65), 'ok'], ['ok', ''], ['bad\n', 'ok']]) {
    await assert.rejects(db.updateOutlet(1, label, description), /1\.\.64/);
  }
  assert.equal(calls.length, writes);
  console.log('PASS: shared PUT trims/encodes text, updates cache, and validates before sending.');

  result = await db.getOutletRecords(2);
  assert.equal(result.length, 8);
  assert.equal(rows.get('2:1').label, 'FountainSix');
  assert.equal(result.some((row) => row.readOnly), false);
  console.log('PASS: empty unit seeds from SQLite with timezone timestamps and rereads shared rows.');

  // A newly started second replica offers its snapshot even after the first seed.
  delete process.env.POWER_LABELS_API_URL;
  delete process.env.POWER_LABELS_API_TOKEN;
  const secondFile = path.join(temp, 'replica-two.sqlite');
  const second = loadDb(secondFile);
  await second.updateOutlet(5, 'Newest replica seed', 'Second replica', 2);
  execFileSync('sqlite3', [secondFile, "update outlets_unit2 set updated_at='2099-01-01 00:00:00' where outlet=5;"]);
  process.env.POWER_LABELS_API_URL = url;
  process.env.POWER_LABELS_API_TOKEN = token;
  assert.equal((await second.getOutletRecords(2)).find((row) => row.outlet === 5).label, 'Newest replica seed');
  await db.updateOutlet(5, 'Explicit operator edit', 'Protected from seeds', 2);
  rows.delete('2:8'); // Reconciliation still cannot overwrite an explicit edit.
  assert.equal((await second.getOutletRecords(2)).find((row) => row.outlet === 5).label, 'Explicit operator edit');
  console.log('PASS: replicas reconcile newer seed timestamps; explicit PUT survives later seed offers.');

  // Maximum-width Unicode seed rows must be split by UTF-8 bytes, not JS length.
  delete process.env.POWER_LABELS_API_URL;
  delete process.env.POWER_LABELS_API_TOKEN;
  const unicode = loadDb(path.join(temp, 'unicode.sqlite'));
  for (let outlet = 1; outlet <= 8; outlet++) await unicode.updateOutlet(outlet, '🌡'.repeat(64), '🔌'.repeat(64), 2);
  for (let outlet = 1; outlet <= 8; outlet++) rows.delete(`2:${outlet}`);
  process.env.POWER_LABELS_API_URL = url;
  process.env.POWER_LABELS_API_TOKEN = token;
  const seedsBefore = calls.filter((call) => call.path === '/v1/labels/seed').length;
  assert.equal((await unicode.getOutletRecords(2)).some((row) => row.readOnly), false);
  assert.ok(calls.filter((call) => call.path === '/v1/labels/seed').length > seedsBefore + 1);
  assert.ok(calls.every((call) => call.bytes <= 4096));
  console.log('PASS: Unicode migration batches stay within the collector 4 KiB body limit.');

  // Connection refusal, as distinct from an HTTP 503, must also fail closed.
  await new Promise((resolve) => server.close(resolve));
  assert.ok((await db.getOutletRecords(1)).every((row) => row.readOnly));
  const disconnected = snapshot();
  await assert.rejects(db.updateOutlet(1, 'No connection', 'Do not save'), /shared store unavailable/);
  assert.equal(snapshot(), disconnected);
  delete process.env.POWER_LABELS_API_URL;
  delete process.env.POWER_LABELS_API_TOKEN;
  await db.updateOutlet(1, 'Legacy again', '', 1);
  assert.equal((await db.getOutletRecords(1))[0].readOnly, undefined);
  assert.equal((await db.getOutletRecords(1)).find((row) => row.outlet === 1).label, 'Legacy again');
  console.log('PASS: connection refusal uses cache for reads only; env unset restores legacy behavior.');
} finally {
  server.closeAllConnections();
  if (server.listening) await new Promise((resolve) => server.close(resolve));
  rmSync(temp, { recursive: true, force: true });
}
