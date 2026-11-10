/**
 * DEVELOPMENT ONLY: simulate a slow network for HLS video pieces.
 *
 * On localhost every piece downloads instantly, so the player always picks
 * 1080p and you can't see adaptive switching. When the browser has a cookie
 * `sim_kbps=<number>`, this middleware sends .ts pieces at that speed.
 * The /bandwidth-test.html page sets the cookie with its speed buttons.
 *
 * Mounted only when NODE_ENV !== 'production' (see server.js).
 */
const fs = require('fs');
const path = require('path');

const TICK_MS = 100;

module.exports = function devThrottle(hlsDir) {
  const root = path.resolve(hlsDir) + path.sep;

  return function throttleHls(req, res, next) {
    if (!req.path.endsWith('.ts')) return next();
    const m = /(?:^|;\s*)sim_kbps=(\d+)/.exec(req.headers.cookie || '');
    if (!m) return next(); // no simulation → normal fast static serving

    let file;
    try {
      file = path.resolve(path.join(root, decodeURIComponent(req.path)));
    } catch (_) {
      return next();
    }
    if (!file.startsWith(root) || !fs.existsSync(file)) return next();

    const kbps = Math.max(50, Number(m[1]));
    const bytesPerTick = Math.max(512, Math.round((kbps * 1000) / 8 / (1000 / TICK_MS)));

    res.setHeader('Content-Type', 'video/mp2t');
    res.setHeader('Content-Length', fs.statSync(file).size);
    res.setHeader('Cache-Control', 'no-store'); // never let the cache fake a fast network
    res.setHeader('Access-Control-Allow-Origin', '*');
    res.setHeader('X-Simulated-Kbps', String(kbps));

    const stream = fs.createReadStream(file, { highWaterMark: bytesPerTick });
    stream.on('data', (chunk) => {
      stream.pause();
      res.write(chunk);
      setTimeout(() => stream.resume(), (TICK_MS * chunk.length) / bytesPerTick);
    });
    stream.on('end', () => res.end());
    stream.on('error', () => res.destroy());
    req.on('close', () => stream.destroy());
  };
};
