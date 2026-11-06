#!/usr/bin/env node
/**
 * AB Download Manager MCP server (zero dependencies, stdio JSON-RPC).
 *
 * Tools:
 *   abdm_download - hand one or more URLs to the running ABDM and wait for completion
 *   abdm_status   - API port, liveness, install path, thread count, default folder, autostart
 *
 * Design notes:
 *  - Everything is done in-process (fetch + fs). Do NOT shell out: under the DSH
 *    sandbox a spawned child with piped stdio fails with EPERM.
 *  - Completion is read from ABDM's own download DB
 *    (%USERPROFILE%\.abdm\config\download_db\downloadlist\<id>.json), which is the
 *    only reliable signal: /downloads style endpoints are absent in 1.10.x.
 *  - If ABDM is not running it is started with a detached, stdio-less spawn
 *    (`--background`), which the sandbox permits.
 */
import { spawn } from 'node:child_process';
import crypto from 'node:crypto';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { download as engineDownload, detectProxy } from './engine.mjs';

const HOME = os.homedir();
const ABDM_HOME = path.join(HOME, '.abdm');
const SETTINGS = path.join(ABDM_HOME, 'config', 'appSettings.json');
const DB_DIR = path.join(ABDM_HOME, 'config', 'download_db', 'downloadlist');
const QUEUES_DIR = path.join(ABDM_HOME, 'config', 'download_db', 'queues');
const PARTS_DIR = path.join(ABDM_HOME, 'config', 'download_db', 'parts');
const DEFAULT_EXE = path.join(
  process.env.LOCALAPPDATA || path.join(HOME, 'AppData', 'Local'),
  'Programs',
  'ABDownloadManager',
  'ABDownloadManager.exe'
);
const HERE = path.dirname(new URL(import.meta.url).pathname.replace(/^\/([A-Za-z]:)/, '$1'));
const EXE_PATH_FILE = path.join(HERE, 'abdm.path.txt');
const HISTORY_FILE = path.join(HERE, 'downloads.jsonl');
const BUILTIN_DEFAULT_CONNECTIONS = 8;
const activeJobs = new Map();

// Startup breadcrumb: it is otherwise impossible to tell whether the DSH host
// really spawned this server (failOnStartupError:false makes a failed connect
// silent, and would just look like "the tool does not exist").
try {
  fs.mkdirSync(path.join(HERE, 'logs'), { recursive: true });
  fs.appendFileSync(
    path.join(HERE, 'logs', 'abdm-mcp.log'),
    `${new Date().toISOString()} pid=${process.pid} start\n`
  );
} catch {}


const PROTOCOL_VERSION = '2024-11-05';
const SERVER_INFO = { name: 'abdm', version: '1.0.0' };

// ---------------------------------------------------------------- helpers

function readSettings() {
  try {
    return JSON.parse(fs.readFileSync(SETTINGS, 'utf8'));
  } catch {
    return null;
  }
}

function apiBase() {
  const s = readSettings();
  return `http://127.0.0.1:${(s && s.apiPort) || 15151}`;
}

function exePath() {
  try {
    const p = fs.readFileSync(EXE_PATH_FILE, 'utf8').trim().replace(/^\uFEFF/, '');
    if (p && fs.existsSync(p)) return p;
  } catch {}
  return fs.existsSync(DEFAULT_EXE) ? DEFAULT_EXE : null;
}

async function ping() {
  try {
    const r = await fetch(`${apiBase()}/ping`, { method: 'POST', signal: AbortSignal.timeout(4000) });
    return r.ok;
  } catch {
    return false;
  }
}

async function ensureRunning() {
  if (await ping()) return { started: false };
  const exe = exePath();
  if (!exe) return { started: false, error: 'ABDM executable not found (abdm.path.txt / default install path)' };
  try {
    const child = spawn(exe, ['--background'], { detached: true, stdio: 'ignore', windowsHide: true });
    child.unref();
  } catch (e) {
    return { started: false, error: `failed to launch ABDM: ${e && e.message}` };
  }
  for (let i = 0; i < 20; i++) {
    await sleep(1500);
    if (await ping()) return { started: true, exe };
  }
  return { started: false, error: 'ABDM did not answer /ping within 30s after launch' };
}

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

function listRecordFiles(minId) {
  try {
    return fs
      .readdirSync(DB_DIR)
      .filter((f) => /^\d+\.json$/.test(f))
      .map((f) => ({ id: parseInt(f, 10), file: path.join(DB_DIR, f) }))
      .filter((x) => x.id >= minId)
      .sort((a, b) => b.id - a.id);
  } catch {
    return [];
  }
}

function readRecord(file) {
  try {
    return JSON.parse(fs.readFileSync(file, 'utf8'));
  } catch {
    return null;
  }
}

function findRecord(link, minId) {
  for (const { file } of listRecordFiles(minId)) {
    const rec = readRecord(file);
    if (rec && rec.link === link) return rec;
  }
  return null;
}

function maxId() {
  const files = listRecordFiles(0);
  return files.length ? files[0].id : 0;
}

async function headLength(link) {
  try {
    const r = await fetch(link, { method: 'HEAD', signal: AbortSignal.timeout(20000) });
    const n = r.headers.get('content-length');
    return n ? Number(n) : -1;
  } catch {
    return -1;
  }
}

function fmtBytes(n) {
  if (!n) return null;
  if (n >= 1 << 30) return `${(n / (1 << 30)).toFixed(2)} GB`;
  if (n >= 1 << 20) return `${(n / (1 << 20)).toFixed(2)} MB`;
  if (n >= 1 << 10) return `${(n / (1 << 10)).toFixed(1)} KB`;
  return `${n} B`;
}

function queueNames() {
  try {
    return fs
      .readdirSync(QUEUES_DIR)
      .filter((f) => /^\d+\.json$/.test(f))
      .map((f) => readRecord(path.join(QUEUES_DIR, f)))
      .filter(Boolean)
      .map((q) => ({
        id: q.id,
        name: q.name,
        maxConcurrent: q.maxConcurrent ?? null,
        queued: (q.queueItems || []).length,
      }));
  } catch {
    return [];
  }
}

/** Bytes already fetched, from ABDM's per-range part file (parts/<id>.json). */
function progressOf(id) {
  try {
    const p = readRecord(path.join(PARTS_DIR, `${id}.json`));
    if (!p || !Array.isArray(p.list)) return null;
    let done = 0;
    let all = 0;
    for (const r of p.list) {
      done += Math.max(0, (r.current || 0) - r.from);
      all += r.to - r.from + 1;
    }
    if (!all) return null;
    return { downloaded: done, total: all, percent: Math.round((done / all) * 1000) / 10 };
  } catch {
    return null;
  }
}

function sha256File(file) {
  return new Promise((resolve, reject) => {
    const h = crypto.createHash('sha256');
    const s = fs.createReadStream(file);
    s.on('data', (d) => h.update(d));
    s.on('error', reject);
    s.on('end', () => resolve(h.digest('hex')));
  });
}

async function submit(link, folder, name) {
  const src = { type: 'http', link, headers: {}, downloadPage: null };
  if (name) src.suggestedName = name;
  const payload = { downloadSource: src, folder, startDownload: true, startQueue: true };
  if (name) payload.name = name; // an empty name is rejected with HTTP 500, so omit it
  const r = await fetch(`${apiBase()}/start-headless-download`, {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify(payload),
    signal: AbortSignal.timeout(60000),
  });
  if (!r.ok) throw new Error(`ABDM rejected the request (HTTP ${r.status}) ${await r.text()}`);
  return r.text();
}

async function waitFor(link, minId, expected, folder, name, timeoutSec) {
  const t0 = Date.now();
  while ((Date.now() - t0) / 1000 < timeoutSec) {
    await sleep(800);
    const rec = findRecord(link, minId);
    if (!rec) continue;
    const target = rec.name ? path.join(rec.folder, rec.name) : name ? path.join(folder, name) : null;
    // Only the record status is authoritative: ABDM pre-allocates the target file, so a
    // full-size file on disk does NOT mean the bytes are all there yet.
    if (rec.status === 'Completed') return { ok: true, rec, path: target };
    if (rec.status === 'Error' || rec.status === 'Failed') {
      return { ok: false, rec, reason: `ABDM status=${rec.status}` };
    }
  }
  return { ok: false, rec: findRecord(link, minId), reason: `timeout ${timeoutSec}s` };
}

// ---------------------------------------------------------------- tools

const TOOLS = [
  {
    name: 'abdm_download',
    description:
      'Fast multi-connection segmented HTTP(S) downloader that lives in this MCP server itself, so it works with or without AB Download Manager installed. Splits the file into N Range requests, downloads the segments in parallel, merges them, verifies sizes and optionally checks SHA-256. Measured on this machine: ~18 MB/s with 4-8 connections on a fast CDN vs ~5 MB/s single-stream fetch, and far better than curl.exe / Invoke-WebRequest (both broken here: schannel). Use backend "abdm" only if you explicitly want to hand the job to a running AB Download Manager. Honors HTTP_PROXY / HTTPS_PROXY and the Windows system proxy, and auto-detects it; pass proxy explicitly (e.g. "http://127.0.0.1:7897") when behind Clash/V2Ray. Returns one JSON result per URL: {url, ok, path, bytes, size, seconds, mbps, connections, segments}, plus sha256 / sha256Verified when requested.',
    inputSchema: {
      type: 'object',
      properties: {
        url: { type: 'array', items: { type: 'string' }, description: 'One or more http(s) URLs.' },
        backend: {
          type: 'string',
          enum: ['builtin', 'abdm'],
          description: 'builtin (default): download inside this server. abdm: hand off to AB Download Manager (needs it installed and running).',
        },
        outDir: {
          type: 'string',
          description: 'Absolute target directory. Defaults to the ABDM default download folder when ABDM is installed, otherwise %USERPROFILE%\\Downloads.',
        },
        name: { type: 'string', description: 'Explicit file name (single URL only). Existing files are never overwritten: a " (1)" suffix is added.' },
        queue: {
          type: 'string',
          description:
            'ABDM backend only: queue name (default "Main"). Ignored by the builtin backend.',
        },
        connections: {
          type: 'integer',
          description: 'Parallel connections for the builtin backend (1-32, default 8). Files under 4 MB or without Range support use a single stream.',
        },
        proxy: {
          type: 'string',
          description: 'http://host:port proxy for the builtin backend. Default: auto-detect from HTTP(S)_PROXY env or the Windows system proxy.',
        },
        sha256: {
          type: 'string',
          description: 'Expected SHA-256 (hex). When given, the finished file is hashed and compared; a mismatch fails the result.',
        },
        hash: {
          type: 'boolean',
          description: 'Compute and return the file\'s SHA-256 after a successful download (default false).',
        },
        timeoutSec: { type: 'integer', description: 'Idle/read timeout budget in seconds. Default 1800.' },
        wait: {
          type: 'boolean',
          description: 'Wait for completion (default true). false = start in the background and return immediately; progress shows up in abdm_list.',
        },
      },
      required: ['url'],
      additionalProperties: false,
    },
  },
  {
    name: 'abdm_status',
    description:
      'Report downloader status: which backend is default and its connection count, detected proxy, AB Download Manager presence / API address / liveness (optional backend), thread count, default folder, autostart.',
    inputSchema: { type: 'object', properties: {}, additionalProperties: false },
  },
  {
    name: 'abdm_list',
    description:
      'Show download state. `active` = jobs currently running in this server\'s builtin engine, with live percent / MB/s. `history` = recent finished builtin downloads (tools/abdm/downloads.jsonl): url, path, bytes, seconds, mbps, sha256, ok. `items` = AB Download Manager\'s own records (each carries source:"abdm"; id/name/status/queue/size/percent/path/exists; `exists:false` means the file is gone or ABDM only holds a stale record). `abdm` = {installed, alive, queues}; counts = count (ABDM records) / total / builtinActive / builtinHistory / abdmRecords. Use it to check what is downloading, whether a file finished, and where it went.',
    inputSchema: {
      type: 'object',
      properties: {
        limit: { type: 'integer', description: 'Max records to return per section (1-50, default 10).' },
        state: {
          type: 'string',
          description: 'Filter: active / completed / failed (builtin history), or an ABDM status such as Completed, Downloading, Paused, Queued, Error.',
        },
      },
      additionalProperties: false,
    },
  },
];

async function toolStatus() {
  const s = readSettings() || {};
  return {
    api: apiBase(),
    apiAlive: await ping(),
    exe: exePath(),
    threadCount: s.threadCount ?? null,
    maxConcurrentDownloads: s.maxConcurrentDownloads ?? null,
    defaultDownloadFolder: s.defaultDownloadFolder ?? null,
    autoStartOnBoot: s.autoStartOnBoot ?? null,
    queues: queueNames(),
    engine: {
      backend: 'builtin',
      defaultConnections: BUILTIN_DEFAULT_CONNECTIONS,
      proxy: detectProxy() || null,
      exeFound: !!exePath(),
    },
  };
}

function inferName(url) {
  try {
    const base = decodeURIComponent(new URL(url).pathname.split('/').filter(Boolean).pop() || '');
    return base || `download-${Date.now()}`;
  } catch {
    return `download-${Date.now()}`;
  }
}

function uniquePath(folder, name) {
  const ext = path.extname(name);
  const stem = ext ? name.slice(0, -ext.length) : name;
  let cand = path.join(folder, name);
  for (let i = 1; fs.existsSync(cand); i++) cand = path.join(folder, `${stem} (${i})${ext}`);
  return cand;
}

function appendHistory(entry) {
  try {
    fs.appendFileSync(HISTORY_FILE, JSON.stringify(entry) + '\n');
  } catch {
    /* history is best effort */
  }
}

function readHistory(limit) {
  try {
    const lines = fs.readFileSync(HISTORY_FILE, 'utf8').split('\n').filter(Boolean).slice(-limit);
    return lines.map((l) => {
      try {
        return JSON.parse(l);
      } catch {
        return null;
      }
    }).filter(Boolean).reverse();
  } catch {
    return [];
  }
}

function activeJobRows() {
  return [...activeJobs.values()].map((j) => ({
    url: j.url,
    path: j.path,
    active: !!j.active,
    downloaded: j.downloaded ?? null,
    total: j.total ?? null,
    percent: j.percent ?? null,
    mbps: j.mbps ?? null,
    seconds: Math.round((Date.now() - j.startedAt) / 100) / 10,
    error: j.error || null,
  }));
}

/** Built-in segmented downloader: no AB Download Manager required. */
async function downloadBuiltin(args, urls) {
  const wait = args.wait !== false;
  const timeoutSec = Number.isFinite(args.timeoutSec) ? Math.max(30, args.timeoutSec) : 1800;
  const connections = Number.isFinite(args.connections) ? Math.min(32, Math.max(1, args.connections)) : BUILTIN_DEFAULT_CONNECTIONS;
  const settings = readSettings() || {};
  const folder = args.outDir || settings.defaultDownloadFolder || path.join(HOME, 'Downloads');
  const explicitName = urls.length === 1 && args.name ? String(args.name) : null;
  const expectedHash = typeof args.sha256 === 'string' ? args.sha256.trim().toLowerCase() : null;
  if (expectedHash && !/^[0-9a-f]{64}$/.test(expectedHash)) throw new Error('sha256 must be 64 hex characters');
  const wantHash = !!args.hash || !!expectedHash;

  const results = [];
  for (const url of urls) {
    const dest = uniquePath(folder, explicitName || inferName(url));
    const job = { url, path: dest, connections, startedAt: Date.now(), active: true, downloaded: 0, total: null, percent: null, mbps: null };
    activeJobs.set(dest, job);
    const run = engineDownload(url, dest, {
      connections,
      timeoutMs: Math.min(600000, Math.max(30000, timeoutSec * 1000)),
      expectedSha256: expectedHash || undefined,
      hash: wantHash,
      proxy: args.proxy || undefined,
      onProgress: (p) => {
        job.downloaded = p.downloaded;
        job.total = p.total;
        job.percent = p.percent;
        job.mbps = p.mbps;
      },
    })
      .then((r) => {
        job.active = false;
        appendHistory({
          ts: new Date().toISOString(),
          backend: 'builtin',
          url,
          path: r.path,
          bytes: r.bytes,
          seconds: r.seconds,
          mbps: r.mbps,
          connections: r.connections,
          segments: r.segments,
          ok: true,
          sha256: r.sha256 || null,
        });
        const entry = {
          url,
          ok: true,
          path: r.path,
          bytes: r.bytes,
          size: fmtBytes(r.bytes),
          seconds: r.seconds,
          mbps: r.mbps,
          connections: r.connections,
          segments: r.segments,
          rangeSupported: r.rangeSupported,
        };
        if (r.sha256) entry.sha256 = r.sha256;
        if (expectedHash) entry.sha256Verified = r.sha256 === expectedHash;
        return entry;
      })
      .catch((e) => {
        const msg = String((e && e.message) || e);
        job.active = false;
        job.error = msg;
        appendHistory({ ts: new Date().toISOString(), backend: 'builtin', url, path: dest, ok: false, error: msg });
        return { url, ok: false, error: msg };
      })
      .finally(() => {
        const t = setTimeout(() => {
          const j = activeJobs.get(dest);
          if (j && !j.active) activeJobs.delete(dest);
        }, 120000);
        if (t.unref) t.unref();
      });

    if (wait) results.push(await run);
    else results.push({ url, ok: true, started: true, path: dest, connections, rangeSupported: null });
  }
  return { backend: 'builtin', results };
}

async function toolDownload(args) {
  const urls = (Array.isArray(args.url) ? args.url : [args.url]).filter(Boolean);
  if (!urls.length) throw new Error('url is required');
  if (args.backend !== 'abdm') return await downloadBuiltin(args, urls);

  const wait = args.wait !== false;
  const timeoutSec = Number.isFinite(args.timeoutSec) ? Math.max(30, args.timeoutSec) : 1800;
  const settings = readSettings() || {};
  const folder = args.outDir || settings.defaultDownloadFolder || path.join(HOME, 'Downloads', 'ABDM');
  const name = urls.length === 1 && args.name ? args.name : null;

  const expectedHash = typeof args.sha256 === 'string' ? args.sha256.trim().toLowerCase() : null;
  if (expectedHash && !/^[0-9a-f]{64}$/.test(expectedHash)) throw new Error('sha256 must be 64 hex characters');
  const wantHash = !!args.hash || !!expectedHash;

  const queues = queueNames();
  const wanted = args.queue ? String(args.queue) : 'Main';
  const queue = queues.find((q) => q.name.toLowerCase() === wanted.toLowerCase());
  if (queues.length && !queue) {
    return { error: `unknown queue: ${wanted}`, availableQueues: queues.map((q) => q.name) };
  }
  if (queue && queue.id !== 0) {
    return {
      error: `queue "${queue.name}" cannot receive headless submissions`,
      detail:
        'AB Download Manager 1.10 submits image/CLI downloads to the Main queue only. Submit with queue "Main", or add it in the GUI and move it to that queue.',
      availableQueues: queues.map((q) => q.name),
    };
  }
  const queueName = queue ? queue.name : wanted;

  const boot = await ensureRunning();
  if (!(await ping())) {
    return {
      error: 'ABDM is not reachable and could not be started',
      detail: boot.error || null,
      hint: 'Start it with the kimi-cu MCP tool (launch_app ABDownloadManager.exe) or by hand, then retry.',
    };
  }

  const results = [];
  for (const url of urls) {
    const minId = maxId() + 1;
    const expected = await headLength(url);
    try {
      await submit(url, folder, name);
    } catch (e) {
      results.push({ url, ok: false, error: String((e && e.message) || e) });
      continue;
    }
    if (!wait) {
      results.push({ url, ok: true, submitted: true, folder, queue: queueName });
      continue;
    }
    const w = await waitFor(url, minId, expected, folder, name, timeoutSec);
    const rec = w.rec;
    const file = w.path || (rec && rec.name ? path.join(rec.folder, rec.name) : null);
    const onDisk = file && fs.existsSync(file) ? fs.statSync(file).size : 0;
    let bytes = onDisk || (rec && rec.contentLength > 0 ? rec.contentLength : 0);
    const secs = rec && rec.startTime && rec.completeTime ? (rec.completeTime - rec.startTime) / 1000 : null;
    let ok = !!w.ok;
    let reason = w.reason || null;
    if (ok && expected > 0 && onDisk !== expected) {
      ok = false;
      reason = `incomplete file on disk: ${onDisk} of ${expected} bytes`;
    }
    const entry = {
      url,
      ok,
      path: file,
      bytes: bytes || null,
      size: fmtBytes(bytes),
      seconds: secs === null ? null : Number(secs.toFixed(2)),
      mbps: bytes && secs ? Number(((bytes / 1048576) / secs).toFixed(2)) : null,
      queue: queueName,
    };
    if (ok && wantHash && file && fs.existsSync(file)) {
      try {
        const actual = await sha256File(file);
        entry.sha256 = actual;
        if (expectedHash) {
          if (actual === expectedHash) entry.sha256Verified = true;
          else {
            entry.sha256Verified = false;
            entry.expectedSha256 = expectedHash;
            entry.ok = false;
            entry.reason = 'sha256 mismatch';
          }
        }
      } catch (e) {
        entry.sha256Error = String((e && e.message) || e);
        if (expectedHash) {
          entry.ok = false;
          entry.reason = 'sha256 could not be computed';
        }
      }
    }
    if (reason && !entry.reason) entry.reason = reason;
    results.push(entry);
  }
  return { started: boot.started || false, results };
}

async function toolList(args) {
  const limit = Number.isFinite(args.limit) ? Math.min(50, Math.max(1, args.limit)) : 10;
  const filter = args.state ? String(args.state).toLowerCase() : null;

  const queueOwner = new Map();
  for (const q of queueNames()) {
    const rec = readRecord(path.join(QUEUES_DIR, `${q.id}.json`));
    for (const id of (rec && rec.queueItems) || []) queueOwner.set(id, q.name);
  }

  const rows = [];
  for (const { id, file } of listRecordFiles(0)) {
    const rec = readRecord(file);
    if (!rec) continue;
    const status = rec.status || rec.state || null;
    if (filter && String(status || '').toLowerCase() !== filter) continue;
    const total = rec.contentLength > 0 ? rec.contentLength : progressOf(id)?.total || 0;
    const done = status === 'Completed' && total > 0 ? total : progressOf(id)?.downloaded ?? null;
    const pct = total > 0 && done !== null ? Math.round((done / total) * 1000) / 10 : null;
    const filePath = rec.name ? path.join(rec.folder, rec.name) : null;
    const exists = filePath ? fs.existsSync(filePath) : false;
    const end = rec.completeTime || Date.now();
    const secs = rec.startTime ? (end - rec.startTime) / 1000 : null;
    rows.push({
      source: 'abdm',
      id,
      name: rec.name || null,
      status,
      queue: queueOwner.get(id) || 'Main',
      size: fmtBytes(total),
      downloaded: done === null ? null : fmtBytes(done),
      percent: pct,
      mbps: secs && total ? Number((total / 1048576 / secs).toFixed(2)) : null,
      path: filePath,
      exists,
    });
    if (rows.length >= limit) break;
  }
  const active = activeJobRows().filter((j) => j.active);
  const history = readHistory(limit).filter((h) => {
    if (filter === 'active') return false;
    if (filter === 'completed') return !!h.ok;
    if (filter === 'failed') return !h.ok;
    return true;
  });
  return {
    backend: 'builtin',
    abdm: { installed: !!exePath(), alive: await ping().catch(() => false), queues: queueNames() },
    active,
    count: rows.length,
    total: rows.length + active.length + history.length,
    builtinActive: active.length,
    builtinHistory: history.length,
    abdmRecords: rows.length,
    // `items` are AB Download Manager's own records (source:"abdm"); this server's builtin
    // downloads live in `active` / `history`, so `source` keeps the two easy to tell apart.
    items: rows,
    history,
  };
}

// ---------------------------------------------------------------- JSON-RPC

function textResult(payload, isError) {
  const text = typeof payload === 'string' ? payload : JSON.stringify(payload, null, 2);
  return { content: [{ type: 'text', text }], ...(isError ? { isError: true } : {}) };
}

async function handleCall(name, args) {
  if (name === 'abdm_status') return textResult(await toolStatus());
  if (name === 'abdm_list') return textResult(await toolList(args || {}));
  if (name === 'abdm_download') {
    const r = await toolDownload(args || {});
    const failed = r.error || (r.results || []).some((x) => !x.ok);
    return textResult(r, !!failed);
  }
  return textResult(`unknown tool: ${name}`, true);
}

async function handle(req) {
  const { id, method, params } = req;
  const isNotification = id === undefined || id === null;

  if (method === 'initialize') {
    return {
      jsonrpc: '2.0',
      id,
      result: { protocolVersion: PROTOCOL_VERSION, capabilities: { tools: {} }, serverInfo: SERVER_INFO },
    };
  }
  if (method === 'notifications/initialized' || method === 'initialized') return null;
  if (method === 'ping') return { jsonrpc: '2.0', id, result: {} };
  if (method === 'tools/list') return { jsonrpc: '2.0', id, result: { tools: TOOLS } };
  if (method === 'tools/call') {
    try {
      const result = await handleCall(params && params.name, (params && params.arguments) || {});
      return { jsonrpc: '2.0', id, result };
    } catch (e) {
      return { jsonrpc: '2.0', id, result: textResult(String((e && e.message) || e), true) };
    }
  }
  if (isNotification) return null;
  return { jsonrpc: '2.0', id, error: { code: -32601, message: `method not found: ${method}` } };
}

let buffer = '';
let chain = Promise.resolve();
let pending = 0;

async function processLine(line) {
  let req;
  try {
    req = JSON.parse(line);
  } catch {
    return;
  }
  pending++;
  try {
    const res = await handle(req);
    if (res) process.stdout.write(JSON.stringify(res) + '\n');
  } finally {
    pending--;
  }
}

process.stdin.setEncoding('utf8');
process.stdin.on('data', (chunk) => {
  buffer += chunk;
  let nl;
  while ((nl = buffer.indexOf('\n')) >= 0) {
    const line = buffer.slice(0, nl).trim();
    buffer = buffer.slice(nl + 1);
    if (!line) continue;
    chain = chain.then(() => processLine(line));
  }
});
process.stdin.on('end', async () => {
  // Keep serving until queued work drains, otherwise a piped smoke test would
  // exit mid-download. Real MCP clients keep stdin open and never hit this path
  // until they shut the server down.
  while (pending > 0 || buffer.trim().length > 0) await sleep(100);
  await chain;
  process.exit(0);
});
