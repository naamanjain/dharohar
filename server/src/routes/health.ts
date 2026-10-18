import { Router, Request, Response } from 'express';
import { getDbHealth, checkDbReachable } from '../db/db';

export const healthRouter = Router();

healthRouter.get('/', (req: Request, res: Response) => {
  const health = getDbHealth();
  res.json({
    status: health.connected ? 'healthy' : 'degraded',
    service: 'DHAROHAR Revenue Backend',
    storageMode: health.storageMode,
    postgisAvailable: health.postgisAvailable,
    postgisVersion: health.postgisVersion || null,
    database: health.database,
    uptimeSeconds: health.uptimeSeconds,
    timestamp: new Date().toISOString(),
    message: health.storageMode === 'postgres-postgis'
      ? 'Connected to PostgreSQL with PostGIS spatial extension.'
      : 'Operating in EXPLICIT DEV-FALLBACK mode. Local in-memory repository active. Nothing is persisted.',
  });
});

/**
 * Readiness for orchestrators and reverse proxies: probes the database live rather than
 * reporting the mode captured at boot, so a database that dies later stops traffic here.
 */
healthRouter.get('/ready', async (req: Request, res: Response) => {
  const probe = await checkDbReachable();
  const health = getDbHealth();

  if (!probe.ok) {
    return res.status(503).json({
      status: 'not_ready',
      storageMode: health.storageMode,
      error: probe.error,
      message: 'The authoritative database is not reachable. Write operations are unavailable.',
    });
  }

  res.json({
    status: 'ready',
    storageMode: health.storageMode,
    postgisAvailable: health.postgisAvailable,
  });
});
