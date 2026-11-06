// Built-in multi-connection HTTP download engine (no external downloader needed).
// Pure Node >= 18. HTTP Range based segmented download + merge + sha256.
import fs from 'node:fs';
import fsp from 'node:fs/promises';
import path from 'node:path';
import crypto from 'node:crypto';
import https from 'node:https';
import http from 'node:http';
import net from 'node:net';
import tls from 'node:tls';
import { execFileSync } from 'node:child_process';
import { once } from 'node:events';
import { PassThrough, Transform } from 'node:stream';

export const UA =
  'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/124 Safari/537.36';

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

function nameFromDisposition(cd) {
  if (!cd) return null;
  const m = /filename\*?=(?:UTF-8'')?["']?([^"';]+)/i.exec(String(cd));
  return m ? decodeURIComponent(m[1].trim()) : null;
}

/** Parse "http://user:pass@host:port", "host:port" or {host,port}. */
export function parseProxy(s) {
  if (!s) return null;
  if (typeof s === 'object') return s.host ? { host: s.host, port: Number(s.port || 8080), auth: s.auth || null } : null;
  const str = String(s).trim();
  if (!str) return null;
  const u = new URL(/^[a-z]+:\/\//i.test(str) ? str : `http://${str}`);
  return {
    host: u.hostname,
    port: Number(u.port || 80),
    auth: u.username ? `${decodeURIComponent(u.username)}:${decodeURIComponent(u.password)}` : null,
  };
}

/** Detect a proxy: explicit option > env vars > Windows system proxy (only when ProxyEnable=1). */
export function detectProxy(explicit) {
  if (explicit) return parseProxy(explicit);
  const env =
    process.env.HTTPS_PROXY || process.env.https_proxy || process.env.ALL_PROXY || process.env.all_proxy || process.env.HTTP_PROXY || process.env.http_proxy;
  if (env) return parseProxy(env);
  if (process.platform === 'win32') {
    try {
      const key = 'HKCU\\Software\\Microsoft\\Windows\\CurrentVersion\\Internet Settings';
      const out = execFileSync('reg', ['query', key], { encoding: 'utf8', windowsHide: true, timeout: 5000 });
      const en = /ProxyEnable\s+REG_DWORD\s+0x([0-9a-f]+)/i.exec(out);
      const sv = /ProxyServer\s+REG_SZ\s+(\S+)/i.exec(out);
      if (en && parseInt(en[1], 16) === 1 && sv) {
        const alt = /(?:https|http)=([^;\s]+)/i.exec(sv[1]);
        return parseProxy(alt ? alt[1] : sv[1]);
      }
    } catch {
      /* no registry proxy */
    }
  }
  return null;
}

/** Open a CONNECT tunnel through an HTTP proxy to host:port. */
function connectTunnel(proxy, target, timeoutMs) {
  return new Promise((resolve, reject) => {
    const sock = net.connect(proxy.port, proxy.host);
    const fail = (e) => {
      try {
        sock.destroy();
      } catch {}
      reject(e);
    };
    sock.setTimeout(timeoutMs || 20000, () => fail(new Error('proxy connect timeout')));
    sock.once('error', fail);
    sock.once('connect', () => {
      const auth = proxy.auth ? `Proxy-Authorization: Basic ${Buffer.from(proxy.auth).toString('base64')}\r\n` : '';
      sock.write(`CONNECT ${target.host}:${target.port} HTTP/1.1\r\nHost: ${target.host}:${target.port}\r\n${auth}\r\n`);
      let buf = Buffer.alloc(0);
      const onData = (c) => {
        buf = Buffer.concat([buf, c]);
        const idx = buf.indexOf('\r\n\r\n');
        if (idx < 0) return;
        sock.removeListener('data', onData);
        const head = buf.subarray(0, idx).toString('latin1');
        const rest = buf.subarray(idx + 4);
        if (!/^HTTP\/1\.[01] 200/i.test(head)) return fail(new Error(`proxy CONNECT failed: ${head.split('\r\n')[0]}`));
        if (rest.length) sock.unshift(rest);
        sock.setTimeout(0);
        sock.removeListener('error', fail);
        resolve(sock);
      };
      sock.on('data', onData);
    });
  });
}

/** Strip HTTP chunked transfer-encoding framing. */
class Dechunker extends Transform {
  constructor() {
    super();
    this.buf = Buffer.alloc(0);
    this.need = 0;
    this.inData = false;
  }
  _transform(chunk, _enc, cb) {
    this.buf = Buffer.concat([this.buf, chunk]);
    for (;;) {
      if (!this.inData) {
        const i = this.buf.indexOf('\r\n');
        if (i < 0) break;
        const size = parseInt(this.buf.subarray(0, i).toString('ascii').split(';')[0].trim(), 16);
        this.buf = this.buf.subarray(i + 2);
        if (!Number.isFinite(size)) return cb(new Error('bad chunk size'));
        if (size === 0) {
          this.buf = Buffer.alloc(0);
          this.need = 0;
          break;
        }
        this.need = size;
        this.inData = true;
      }
      if (this.buf.length < this.need + 2) {
        if (this.buf.length > 0) {
          this.push(this.buf.subarray(0, Math.min(this.need, this.buf.length)));
          const took = Math.min(this.need, this.buf.length);
          this.buf = this.buf.subarray(took);
          this.need -= took;
        }
        break;
      }
      this.push(this.buf.subarray(0, this.need));
      this.buf = this.buf.subarray(this.need + 2);
      this.need = 0;
      this.inData = false;
    }
    cb();
  }
}

/** Manual HTTP/1.1 GET over an established socket (used for the proxy path). */
async function proxyGet(urlStr, headers, opts) {
  const u = new URL(urlStr);
  const timeoutMs = opts.timeoutMs || 60000;
  let sock;
  if (u.protocol === 'https:') {
    const raw = await connectTunnel(opts.proxy, { host: u.hostname, port: Number(u.port || 443) }, timeoutMs);
    sock = tls.connect({ socket: raw, servername: u.hostname });
    try {
      await once(sock, 'secureConnect');
    } catch (e) {
      raw.destroy();
      throw e;
    }
  } else {
    sock = await connectTunnel(opts.proxy, { host: u.hostname, port: Number(u.port || 80) }, timeoutMs);
  }
  sock.setTimeout(timeoutMs, () => sock.destroy(new Error(`request timeout after ${timeoutMs}ms`)));
  const h = { ...headers, host: u.host, connection: 'close' };
  const text = [`GET ${u.pathname}${u.search} HTTP/1.1`, ...Object.entries(h).map(([k, v]) => `${k}: ${v}`)].join('\r\n') + '\r\n\r\n';
  let acc = Buffer.alloc(0);
  const onData = (c) => {
    acc = Buffer.concat([acc, c]);
  };
  sock.on('data', onData);
  sock.write(text);
  let idx = -1;
  while ((idx = acc.indexOf('\r\n\r\n')) < 0) {
    if (acc.length > 1 << 20) {
      sock.destroy();
      throw new Error('response header too large');
    }
    await once(sock, 'data');
  }
  sock.removeListener('data', onData);
  const head = acc.subarray(0, idx).toString('latin1');
  const leftover = acc.subarray(idx + 4);
  const [statusLine, ...lines] = head.split('\r\n');
  const statusCode = Number((/^HTTP\/1\.[01] (\d{3})/.exec(statusLine) || [])[1] || 0);
  const respHeaders = {};
  for (const l of lines) {
    const i = l.indexOf(':');
    if (i > 0) respHeaders[l.slice(0, i).trim().toLowerCase()] = l.slice(i + 1).trim();
  }
  const out = new PassThrough();
  out.statusCode = statusCode;
  out.headers = respHeaders;
  sock.removeAllListeners('data');
  sock.on('error', (e) => out.destroy(e));
  if (leftover.length) out.write(leftover);
  if (/chunked/i.test(respHeaders['transfer-encoding'] || '')) sock.pipe(new Dechunker()).pipe(out);
  else sock.pipe(out);
  return out;
}

/** One GET request (through a proxy when configured) with manual redirect following. */
async function getOnce(urlStr, headers, opts) {
  const u = new URL(urlStr);
  const proxy = opts.proxy;
  const mkHeaders = { ...headers, host: u.host };
  if (proxy) return { res: await proxyGet(urlStr, headers, { ...opts, proxy }), url: urlStr };
  const mod = u.protocol === 'http:' ? http : https;
  const req = mod.request({
    method: 'GET',
    hostname: u.hostname,
    port: u.port || (u.protocol === 'http:' ? 80 : 443),
    path: u.pathname + u.search,
    headers: mkHeaders,
    agent: opts.agent,
  });
  return new Promise((resolve, reject) => {
    req.on('response', (res) => resolve({ res, req, url: urlStr }));
    req.on('error', reject);
    if (opts.timeoutMs) req.setTimeout(opts.timeoutMs, () => req.destroy(new Error(`request timeout after ${opts.timeoutMs}ms`)));
    req.end();
  });
}

async function getFollow(urlStr, headers, opts = {}) {
  let cur = urlStr;
  for (let i = 0; i < 6; i++) {
    const r = await getOnce(cur, headers, opts);
    const st = r.res.statusCode || 0;
    if (st >= 300 && st < 400 && r.res.headers.location) {
      r.res.resume();
      cur = new URL(r.res.headers.location, cur).toString();
      continue;
    }
    return { ...r, finalUrl: cur };
  }
  throw new Error('too many redirects');
}

/** Resolve the proxy for one operation: explicit option > noProxy > auto-detect. */
function resolveProxy(opts = {}) {
  if (opts.noProxy) return null;
  if (opts.proxy !== undefined && opts.proxy !== null && opts.proxy !== 'auto') return parseProxy(opts.proxy);
  return detectProxy();
}

/** One Range: bytes=0-0 probe: 206 + Content-Range total means segmented download is possible. */
async function rangeProbe(url, { timeoutMs, proxy }) {
  const { res } = await getFollow(url, { 'user-agent': UA, accept: '*/*', range: 'bytes=0-0' }, { timeoutMs, proxy });
  const status = res.statusCode || 0;
  const cr = String(res.headers['content-range'] || '');
  const m = /\/(\d+)\s*$/.exec(cr);
  res.destroy(); // we only need the headers
  return {
    status,
    total: m ? Number(m[1]) : 0,
    ranges: status === 206 && !!m,
    etag: res.headers.etag || null,
    type: res.headers['content-type'] || null,
    name: nameFromDisposition(res.headers['content-disposition']),
  };
}

/** Probe size / range support. Some hosts reject HEAD, so fall back to Range: bytes=0-0. */
export async function probe(url, opts = {}) {
  const timeoutMs = opts.timeoutMs || 20000;
  const proxy = opts.proxy === undefined ? resolveProxy(opts) : opts.proxy;
  try {
    const { res } = await getFollow(url, { 'user-agent': UA, accept: '*/*' }, { timeoutMs, proxy });
    const len = Number(res.headers['content-length'] || 0);
    const ar = String(res.headers['accept-ranges'] || '').toLowerCase();
    res.destroy();
    if (res.statusCode === 200 && len > 0) {
      const base = {
        length: len,
        ranges: ar.includes('bytes'),
        etag: res.headers.etag || null,
        type: res.headers['content-type'] || null,
        name: nameFromDisposition(res.headers['content-disposition']),
      };
      // A missing Accept-Ranges header does not prove the host ignores ranges (GitHub release
      // assets after a redirect are a common case), so confirm with one cheap 1-byte request
      // before giving up on parallel segments.
      if (!base.ranges && len > 4 * 1024 * 1024) {
        try {
          const p = await rangeProbe(url, { timeoutMs, proxy });
          if (p.ranges) {
            base.ranges = true;
            base.etag = base.etag || p.etag;
          }
        } catch {
          /* ignore: stay single-connection */
        }
      }
      return base;
    }
  } catch {
    /* fall through to range probe */
  }
  const p = await rangeProbe(url, { timeoutMs, proxy });
  return { length: p.total, ranges: p.ranges, etag: p.etag, type: p.type, name: p.name };
}

async function sha256File(file) {
  return await new Promise((resolve, reject) => {
    const h = crypto.createHash('sha256');
    fs.createReadStream(file)
      .on('data', (c) => h.update(c))
      .on('end', () => resolve(h.digest('hex')))
      .on('error', reject);
  });
}

async function fileSize(f) {
  try {
    return (await fsp.stat(f)).size;
  } catch {
    return 0;
  }
}

/**
 * Download url -> destFile with N parallel Range connections.
 * opts: { connections=8, timeoutMs=60000, retries=3, onProgress(fn), expectedSha256, signal, minSegmentBytes }
 */
export async function download(url, destFile, opts = {}) {
  const started = Date.now();
  const timeoutMs = opts.timeoutMs || 60000;
  const retries = opts.retries ?? 3;
  const maxConn = Math.max(1, Math.min(32, opts.connections || 8));
  const minSeg = opts.minSegmentBytes || 2 * 1024 * 1024;
  const onProgress = opts.onProgress;
  const proxy = resolveProxy(opts);

  await fsp.mkdir(path.dirname(destFile), { recursive: true });

  const info = await probe(url, { timeoutMs, proxy });
  const total = info.length;
  const useRanges = info.ranges && total > 0 && total > 4 * 1024 * 1024;
  const conns = useRanges ? Math.max(1, Math.min(maxConn, Math.ceil(total / minSeg))) : 1;

  let downloaded = 0;
  let lastTick = 0;
  const tick = (force) => {
    const now = Date.now();
    if (!onProgress || (!force && now - lastTick < 400)) return;
    lastTick = now;
    const secs = Math.max(0.001, (now - started) / 1000);
    onProgress({
      downloaded,
      total: total || null,
      percent: total ? Math.round((downloaded / total) * 1000) / 10 : null,
      mbps: Math.round((downloaded / 1048576 / secs) * 100) / 100,
      seconds: Math.round(secs * 100) / 100,
    });
  };

  const parts = [];
  try {
    if (!total) {
      // Unknown length: single streaming connection straight into dest.
      const { res } = await getFollow(url, { 'user-agent': UA, accept: '*/*' }, { timeoutMs, proxy });
      if ((res.statusCode || 0) >= 400) throw new Error(`HTTP ${res.statusCode}`);
      const ws = fs.createWriteStream(destFile);
      await new Promise((resolve, reject) => {
        res.on('data', (c) => {
          downloaded += c.length;
          tick();
        });
        res.on('error', reject);
        ws.on('error', reject);
        ws.on('finish', resolve);
        res.pipe(ws);
      });
    } else {
      const chunk = Math.ceil(total / conns);
      // Part files carry a size+etag tag, so a leftover part from a different file version can never be merged in.
      const tag = `${total}-${String(info.etag || 'noetag').replace(/[^A-Za-z0-9]/g, '').slice(0, 16) || 'noetag'}`;
      for (let i = 0; i < conns; i++) {
        const start = i * chunk;
        const end = Math.min(total - 1, start + chunk - 1);
        if (start > end) break;
        parts.push({ i, start, end, need: end - start + 1, file: `${destFile}.${tag}.dshpart${i}` });
      }

      const fetchSeg = async (seg) => {
        let have = await fileSize(seg.file);
        if (have > seg.need) {
          await fsp.rm(seg.file, { force: true });
          have = 0;
        }
        for (let attempt = 0; have < seg.need; attempt++) {
          if (attempt > retries) throw new Error(`segment ${seg.i} failed after ${retries} retries`);
          const from = seg.start + have;
          let ws = null;
          try {
            const { res } = await getFollow(
              url,
              { 'user-agent': UA, accept: '*/*', range: `bytes=${from}-${seg.end}` },
              { timeoutMs, proxy }
            );
            const st = res.statusCode || 0;
            if (st !== 206 && !(st === 200 && conns === 1)) throw new Error(`segment ${seg.i}: HTTP ${st} for range ${from}-${seg.end}`);
            ws = fs.createWriteStream(seg.file, { flags: have > 0 ? 'a' : 'w' });
            const wsErr = new Promise((_, rej) => ws.on('error', rej));
            await Promise.race([
              new Promise((resolve, reject) => {
                res.on('data', (c) => {
                  if (!ws.write(c)) res.pause();
                  have += c.length;
                  downloaded += c.length;
                  tick();
                });
                ws.on('drain', () => res.resume());
                res.on('end', () => {
                  ws.end(() => resolve());
                });
                res.on('error', reject);
                ws.on('finish', resolve);
              }),
              wsErr,
            ]);
            ws = null;
          } catch (e) {
            if (ws) {
              try {
                ws.destroy();
              } catch {}
            }
            if (attempt >= retries) throw e;
            await sleep(300 * (attempt + 1));
            have = await fileSize(seg.file);
          }
        }
      };

      if (conns > 1) {
        await Promise.all(parts.map(fetchSeg));
      } else {
        await fetchSeg(parts[0]);
      }

      // Verify every segment on disk before merging.
      for (const seg of parts) {
        const got = await fileSize(seg.file);
        if (got !== seg.need) throw new Error(`segment ${seg.i} size mismatch: ${got}/${seg.need} bytes`);
      }

      // Merge in order (1 MiB buffer, sequential offsets).
      const out = fs.openSync(destFile, 'w');
      const buf = Buffer.alloc(1 << 20);
      try {
        for (const seg of parts) {
          const fd = fs.openSync(seg.file, 'r');
          try {
            let r;
            while ((r = fs.readSync(fd, buf, 0, buf.length, null)) > 0) fs.writeSync(out, buf, 0, r);
          } finally {
            fs.closeSync(fd);
          }
        }
      } finally {
        fs.closeSync(out);
      }
      for (const seg of parts) await fsp.rm(seg.file, { force: true });
    }

    tick(true);
    const bytes = await fileSize(destFile);
    if (total && bytes !== total) throw new Error(`final size mismatch: ${bytes}/${total} bytes`);
    const seconds = Math.round((Date.now() - started) / 10) / 100;
    let sha256 = null;
    if (opts.expectedSha256 || opts.hash) sha256 = await sha256File(destFile);
    if (opts.expectedSha256 && sha256 !== String(opts.expectedSha256).toLowerCase()) {
      throw new Error(`sha256 mismatch: expected ${opts.expectedSha256}, got ${sha256}`);
    }
    return {
      ok: true,
      path: destFile,
      bytes,
      seconds,
      mbps: Math.round((bytes / 1048576 / Math.max(0.001, seconds)) * 100) / 100,
      connections: conns,
      segments: parts.length,
      rangeSupported: useRanges,
      name: info.name || null,
      sha256,
    };
  } catch (e) {
    for (const seg of parts) {
      try {
        await fsp.rm(seg.file, { force: true });
      } catch {}
    }
    throw e;
  }
}
