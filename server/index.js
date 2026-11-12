import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import express from 'express';
import cookieParser from 'cookie-parser';
import { attachUser, purgeExpiredSessions } from './auth.js';
import { AiError } from './ai.js';
import { FertilizerError } from './fertilizer.js';
import apiRouter from './routes.js';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const app = express();
const PORT = Number(process.env.PORT || 3000);
const DIST_DIR = path.join(__dirname, '..', 'dist');

app.set('trust proxy', 1);
app.disable('x-powered-by');

app.use((req, res, next) => {
  res.setHeader('X-Content-Type-Options', 'nosniff');
  res.setHeader('X-Frame-Options', 'DENY');
  res.setHeader('Referrer-Policy', 'strict-origin-when-cross-origin');
  res.setHeader('Permissions-Policy', 'camera=(self), geolocation=(), microphone=()');
  res.setHeader(
    'Content-Security-Policy',
    [
      "default-src 'self'",
      "script-src 'self'",
      "style-src 'self' 'unsafe-inline' https://fonts.googleapis.com",
      "font-src 'self' data: https://fonts.gstatic.com",
      "img-src 'self' data: blob:",
      "connect-src 'self'",
      "manifest-src 'self'",
      "worker-src 'self'",
      "frame-ancestors 'none'",
      "base-uri 'self'",
      "form-action 'self'"
    ].join('; ')
  );
  next();
});

app.use(express.json({ limit: '12mb' }));
app.use(cookieParser());
app.use(attachUser);

app.get('/healthz', (_req, res) => res.json({ ok: true, uptime: process.uptime() }));

app.use('/api', apiRouter);

if (fs.existsSync(DIST_DIR)) {
  app.use(
    express.static(DIST_DIR, {
      index: false,
      setHeaders(res, filePath) {
        if (filePath.endsWith('sw.js') || filePath.endsWith('index.html') || filePath.endsWith('manifest.webmanifest')) {
          res.setHeader('Cache-Control', 'no-cache');
        } else if (filePath.includes(`${path.sep}assets${path.sep}`)) {
          res.setHeader('Cache-Control', 'public, max-age=31536000, immutable');
        }
      }
    })
  );
}

// SPA fallback for client-side (hash) routes and unknown paths.
app.use((req, res, next) => {
  if (req.method !== 'GET' || req.path.startsWith('/api')) return next();
  const indexFile = path.join(DIST_DIR, 'index.html');
  if (fs.existsSync(indexFile)) return res.sendFile(indexFile);
  return res
    .status(503)
    .type('text/plain')
    .send('Client build not found. Run "npm run build" first.');
});

app.use((req, res) => {
  res.status(404).json({ error: { code: 'not_found', message: 'આ સરનામું મળ્યું નહીં.' } });
});

app.use((error, _req, res, _next) => {
  if (error?.type === 'entity.too.large') {
    return res.status(413).json({ error: { code: 'payload_too_large', message: 'મોકલેલી માહિતી ખૂબ મોટી છે.' } });
  }
  if (error instanceof FertilizerError) {
    return res.status(400).json({ error: { code: error.code, message: error.message } });
  }
  if (error instanceof AiError) {
    return res.status(error.status || 502).json({ error: { code: error.code, message: error.message } });
  }
  if (error?.type === 'entity.parse.failed') {
    return res.status(400).json({ error: { code: 'invalid_json', message: 'વિનંતીનું સ્વરૂપ ખોટું છે.' } });
  }
  console.error('[server] unhandled error', error);
  res.status(500).json({ error: { code: 'server_error', message: 'સર્વરમાં ભૂલ થઈ. થોડી વાર પછી પ્રયત્ન કરો.' } });
});

purgeExpiredSessions();
const sessionSweep = setInterval(purgeExpiredSessions, 6 * 60 * 60 * 1000);
sessionSweep.unref?.();

const server = app.listen(PORT, '0.0.0.0', () => {
  console.log(`DESI AGRY GYAN listening on http://0.0.0.0:${PORT}`);
});

const shutdown = () => {
  server.close(() => process.exit(0));
  setTimeout(() => process.exit(0), 5000).unref();
};
process.on('SIGTERM', shutdown);
process.on('SIGINT', shutdown);

export default app;
