import { startServer } from './server';

/**
 * Entry point: `npm run server`.
 *   PORT             listening port (default 8787; hosting platforms set it)
 *   ALLOWED_ORIGINS  comma-separated browser origins allowed to connect,
 *                    e.g. https://cardify-blue.vercel.app (empty = any)
 */
const port = Number(process.env.PORT ?? 8787);
const allowedOrigins = (process.env.ALLOWED_ORIGINS ?? '')
  .split(',')
  .map((o) => o.trim())
  .filter(Boolean);

const server = await startServer({ port, allowedOrigins });

const shutdown = (): void => {
  void server.close().then(() => process.exit(0));
};
process.on('SIGTERM', shutdown);
process.on('SIGINT', shutdown);
