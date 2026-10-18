import express, { Request, Response, NextFunction } from 'express';
import cors from 'cors';
import { ALLOWED_ORIGINS, IS_PRODUCTION, PORT, TRUST_PROXY } from './config/env';
import { initDbConnection, getDbHealth, pool } from './db/db';
import { healthRouter } from './routes/health';
import { authRouter } from './routes/auth';
import { parcelsRouter } from './routes/parcels';
import { documentsRouter } from './routes/documents';
import { verificationsRouter } from './routes/verifications';
import { adminRouter } from './routes/admin';

const app = express();

if (TRUST_PROXY) app.set('trust proxy', 1);

// CORS: the prototype computed an allowlist and then answered `true` on both branches, so
// credentialed cross-origin reads and writes were open to any site.
app.use(
  cors({
    origin: (origin, callback) => {
      if (ALLOWED_ORIGINS === 'any') return callback(null, true);
      // No origin: same-origin, native clients, curl and server-side tests.
      if (!origin) return callback(null, true);
      if (ALLOWED_ORIGINS.includes(origin)) return callback(null, true);
      return callback(null, false);
    },
    credentials: true,
  })
);

app.use(express.json({ limit: '15mb' }));
app.use(express.urlencoded({ extended: true, limit: '15mb' }));

// Request logger for API calls
app.use((req: Request, res: Response, next: NextFunction) => {
  const start = Date.now();
  res.on('finish', () => {
    const duration = Date.now() - start;
    if (req.path.startsWith('/api')) {
      console.log(`[API] ${req.method} ${req.path} -> ${res.statusCode} (${duration}ms)`);
    }
  });
  next();
});

// Mount API Routes
app.use('/api/health', healthRouter);
app.use('/api/auth', authRouter);
app.use('/api/parcels', parcelsRouter);
app.use('/api/documents', documentsRouter);
app.use('/api/verifications', verificationsRouter);
app.use('/api/admin', adminRouter);

// Root informational endpoint. The prototype enumerated the entire API surface here,
// including the mutating routes — that map belongs in the README, not in a public response.
app.get('/', (req: Request, res: Response) => {
  res.json({
    name: 'DHAROHAR Revenue System Backend',
    version: '1.0.0',
    status: 'ok',
    docs: '/api/health',
  });
});

// 404 handler for unknown routes
app.use((req: Request, res: Response) => {
  res.status(404).json({
    success: false,
    error: {
      code: 'ROUTE_NOT_FOUND',
      message: `Cannot ${req.method} ${req.path}`,
    },
  });
});

// Global error handler. Driver and internal messages stay in the server log: they name
// tables, columns and connection details that a caller has no business seeing.
app.use((err: any, req: Request, res: Response, next: NextFunction) => {
  console.error('[UNHANDLED ERROR]', err);
  const statusCode = err.status || err.statusCode || 500;
  res.status(statusCode).json({
    success: false,
    error: {
      code: IS_PRODUCTION ? 'INTERNAL_SERVER_ERROR' : err.code || 'INTERNAL_SERVER_ERROR',
      message: IS_PRODUCTION
        ? 'The request could not be completed.'
        : err.message || 'An unexpected error occurred on the server.',
    },
  });
});

// Startup lifecycle
async function startServer() {
  console.log('==================================================');
  console.log('  DHAROHAR Land Record Digitization Server       ');
  console.log('  Phase 4: Authoritative Backend + Security Engine ');
  console.log('==================================================');

  await initDbConnection();

  if (IS_PRODUCTION && getDbHealth().storageMode === 'postgres-postgis') {
    // Demo personas are disabled in production, so an unseeded database has nobody who can sign
    // in. Say so at boot instead of letting the operator discover it via a login wall.
    try {
      const users = await pool.query('SELECT count(*)::int AS n FROM users');
      if (users.rows[0].n === 0) {
        console.warn('[DHAROHAR] WARNING: production database has 0 officer accounts.');
        console.warn('[DHAROHAR] No one can sign in until you provision them: npm run db:seed');
      }
    } catch {
      // A read failure here must not block startup; /api/health/ready already reports DB state.
    }
  }

  const server = app.listen(PORT, () => {
    console.log(`[DHAROHAR SERVER] Running on port ${PORT}`);
    console.log(`[DHAROHAR SERVER] Health check: /api/health  Readiness: /api/health/ready`);
    console.log(`[DHAROHAR SERVER] Storage mode: ${getDbHealth().storageMode}`);
  });

  // Compose/containers send SIGTERM; without this the process dies mid-transaction.
  const shutdown = (signal: string) => {
    console.log(`[DHAROHAR SERVER] ${signal} received, closing connections...`);
    server.close(() => {
      pool.end().then(() => process.exit(0)).catch(() => process.exit(0));
    });
    setTimeout(() => process.exit(1), 10000).unref();
  };
  process.on('SIGTERM', () => shutdown('SIGTERM'));
  process.on('SIGINT', () => shutdown('SIGINT'));

  // Express 4 never surfaces rejected async handlers, and on Node 22 an unhandled rejection kills
  // the process. One unreachable database must degrade to a 503, not take the API down with it.
  process.on('unhandledRejection', (reason: any) => {
    console.error('[DHAROHAR SERVER] Unhandled promise rejection (kept running):', reason?.message || reason);
  });

  return server;
}

import { fileURLToPath } from 'url';
const isDirectRun = process.argv[1] && fileURLToPath(import.meta.url) === process.argv[1];
if (isDirectRun) {
  startServer().catch((err) => {
    // Exit non-zero so the container is marked failed rather than left "running" and useless.
    console.error('[DHAROHAR SERVER] Startup failed:', err.message);
    process.exit(1);
  });
}

export { app, startServer };
