import { buildApp } from './app.js';
import { config } from './core/config.js';
import { closePool } from './core/db.js';
import { runMigrations } from './core/migrate.js';
import { startBackgroundJobs, stopBackgroundJobs } from './jobs/index.js';

async function main(): Promise<void> {
  if (process.env.AUTO_MIGRATE !== 'false') {
    await runMigrations((m) => console.log(m));
  }

  const app = await buildApp();
  await app.listen({ port: config.port, host: config.host });
  startBackgroundJobs(app.log);

  const shutdown = async (signal: string) => {
    app.log.info(`${signal} received, shutting down`);
    stopBackgroundJobs();
    await app.close();
    await closePool();
    process.exit(0);
  };
  process.on('SIGTERM', () => void shutdown('SIGTERM'));
  process.on('SIGINT', () => void shutdown('SIGINT'));
}

main().catch((err) => {
  console.error('Fatal startup error:', err);
  process.exit(1);
});
