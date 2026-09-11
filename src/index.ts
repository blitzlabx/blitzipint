import Fastify, {
  FastifyInstance,
  FastifyRequest,
  FastifyReply,
  FastifyError,
} from 'fastify';
import cors from '@fastify/cors';
import { z } from 'zod';
import {
  Blitzipint,
  BlitzResult,
  BlitzUrlSchema,
  BlitzMedia,
} from './scraper.js';

const BLITZ_NAME = 'blitzipint';
const BLITZ_AUTHOR = 'Blitz';
const BLITZ_HANDLE = 'blitzlabx';
const BLITZ_TAG = 'blitzipint by Blitz';

type BlitzQuery = { url?: string };
type BlitzBody = { url?: string; urls?: string[]; concurrency?: number };

const engine = new Blitzipint({
  timeout: Number(process.env.BLITZ_TIMEOUT) || 22000,
});

const singleSchema = z.object({
  url: z.string().min(10, 'url too short'),
});

const batchSchema = z.object({
  urls: z
    .array(z.string().min(10))
    .min(1, 'at least one url required')
    .max(12, 'max 12 urls per batch'),
  concurrency: z.number().int().min(1).max(4).optional().default(2),
});

function blitzHeaders(reply: FastifyReply) {
  reply.header('X-Powered-By', BLITZ_NAME);
  reply.header('X-Author', BLITZ_AUTHOR);
  reply.header('X-Engine', BLITZ_NAME);
  reply.header('X-Handle', BLITZ_HANDLE);
  reply.header('Cache-Control', 'no-store');
}

function blitzSend(
  reply: FastifyReply,
  payload: Record<string, unknown> | BlitzResult,
  status = 200
) {
  blitzHeaders(reply);
  return reply.status(status).send(payload);
}

function blitzFail(
  reply: FastifyReply,
  message: string,
  code = 'BAD_REQUEST',
  status = 400,
  extra: Record<string, unknown> = {}
) {
  return blitzSend(
    reply,
    {
      ok: false,
      error: message,
      code,
      engine: BLITZ_NAME,
      author: BLITZ_AUTHOR,
      handle: BLITZ_HANDLE,
      ...extra,
    },
    status
  );
}

function blitzPickBest(medias: BlitzMedia[]): BlitzMedia | undefined {
  if (!medias.length) return undefined;
  return medias.reduce((a, b) => (b.score > a.score ? b : a));
}

function blitzFormatSummary(result: BlitzResult) {
  return {
    ok: result.ok,
    count: result.medias.length,
    bestType: result.best?.type,
    bestQuality: result.best?.quality,
    tookMs: result.tookMs,
  };
}

function blitzValidateUrlParam(raw: unknown): { ok: true; url: string } | { ok: false; msg: string } {
  if (typeof raw !== 'string' || raw.trim().length < 10) {
    return { ok: false, msg: 'url must be a non-empty string' };
  }
  const check = BlitzUrlSchema.safeParse(raw.trim());
  if (!check.success) {
    return { ok: false, msg: check.error.errors[0]?.message || 'invalid pinterest url' };
  }
  return { ok: true, url: check.data };
}

async function blitzHandleSingle(url: string, reply: FastifyReply) {
  const result = await engine.blitzResolve(url);
  const status = result.ok ? 200 : 422;
  return blitzSend(reply, result, status);
}

function createBlitzApp(): FastifyInstance {
  const app = Fastify({
    logger: {
      level: process.env.LOG_LEVEL || 'info',
      serializers: {
        req(req) {
          return {
            method: req.method,
            url: req.url,
            host: req.headers.host,
          };
        },
      },
    },
    trustProxy: true,
    bodyLimit: 64 * 1024,
    requestIdHeader: 'x-request-id',
    disableRequestLogging: false,
  });

  return app;
}

const app = createBlitzApp();

await app.register(cors, {
  origin: true,
  credentials: false,
  methods: ['GET', 'POST', 'OPTIONS'],
  allowedHeaders: [
    'Content-Type',
    'Authorization',
    'X-Blitz-Key',
    'X-Requested-With',
  ],
  maxAge: 86400,
});

app.addHook('onRequest', async (req) => {
  (req as any).blitzStart = Date.now();
  req.headers['x-blitz-engine'] = BLITZ_NAME;
});

app.addHook('onResponse', async (req, reply) => {
  const start = (req as any).blitzStart as number | undefined;
  if (start) {
    const ms = Date.now() - start;
    reply.header('X-Blitz-Time', String(ms));
  }
});

app.get('/', async (_req, reply) => {
  return blitzSend(reply, {
    name: BLITZ_NAME,
    tag: BLITZ_TAG,
    version: engine.version,
    author: BLITZ_AUTHOR,
    handle: BLITZ_HANDLE,
    status: 'online',
    message: 'blitzipint media extractor is running',
    endpoints: {
      root: 'GET /',
      health: 'GET /health',
      info: 'GET /api/info',
      mediaGet: 'GET /api/media?url=<pinterest_url>',
      mediaPost: 'POST /api/media  { "url": "..." }',
      resolve: 'GET /api/resolve?url=...',
      batch: 'POST /api/batch  { "urls": ["..."], "concurrency": 2 }',
      best: 'GET /api/best?url=...',
    },
    socials: {
      x: `https://x.com/${BLITZ_HANDLE}`,
      github: `https://github.com/${BLITZ_HANDLE}`,
      contact: BLITZ_HANDLE,
    },
  });
});

app.get('/health', async (_req, reply) => {
  const h = engine.blitzHealth();
  return blitzSend(reply, {
    status: 'ok',
    service: BLITZ_NAME,
    ...h,
    uptimeSec: Math.floor(process.uptime()),
    memory: process.memoryUsage(),
    node: process.version,
    env: process.env.NODE_ENV || 'development',
  });
});

app.get('/api/info', async (_req, reply) => {
  return blitzSend(reply, {
    name: BLITZ_NAME,
    version: engine.version,
    author: BLITZ_AUTHOR,
    handle: BLITZ_HANDLE,
    description:
      'blitzipint resolves public Pinterest pins through klickpin and returns direct media URLs for videos, images and GIFs.',
    capabilities: [
      'single pin resolution',
      'batch processing (up to 12)',
      'quality scoring',
      'video / image / gif detection',
      'csrf rotation',
      'multiple extraction strategies',
    ],
    limits: {
      batchSize: 12,
      concurrency: 4,
      timeoutMs: Number(process.env.BLITZ_TIMEOUT) || 22000,
    },
    notes: [
      'Only publicly accessible pins work',
      'Private, restricted or deleted pins return NO_MEDIA or PRIVATE_OR_RESTRICTED',
      'Media quality is limited to what the upstream source provides',
      'This tool does not store any media files',
    ],
    socials: {
      x: `https://x.com/${BLITZ_HANDLE}`,
      github: `https://github.com/${BLITZ_HANDLE}`,
    },
  });
});

app.get('/api/media', async (req: FastifyRequest, reply: FastifyReply) => {
  const q = req.query as BlitzQuery;
  const check = blitzValidateUrlParam(q.url);
  if (!check.ok) {
    return blitzFail(reply, check.msg, 'MISSING_OR_INVALID_URL');
  }
  return blitzHandleSingle(check.url, reply);
});

app.post('/api/media', async (req: FastifyRequest, reply: FastifyReply) => {
  const body = (req.body || {}) as BlitzBody;
  const parsed = singleSchema.safeParse(body);
  if (!parsed.success) {
    return blitzFail(reply, 'body must contain { "url": "string" }', 'INVALID_BODY');
  }
  const check = blitzValidateUrlParam(parsed.data.url);
  if (!check.ok) {
    return blitzFail(reply, check.msg, 'INVALID_URL');
  }
  return blitzHandleSingle(check.url, reply);
});

app.get('/api/resolve', async (req: FastifyRequest, reply: FastifyReply) => {
  const q = req.query as BlitzQuery;
  const check = blitzValidateUrlParam(q.url);
  if (!check.ok) {
    return blitzFail(reply, check.msg, 'INVALID_URL');
  }
  return blitzHandleSingle(check.url, reply);
});

app.get('/api/best', async (req: FastifyRequest, reply: FastifyReply) => {
  const q = req.query as BlitzQuery;
  const check = blitzValidateUrlParam(q.url);
  if (!check.ok) {
    return blitzFail(reply, check.msg, 'INVALID_URL');
  }

  const result = await engine.blitzResolve(check.url);
  if (!result.ok || !result.best) {
    return blitzSend(reply, result, 422);
  }

  return blitzSend(reply, {
    ok: true,
    input: result.input,
    best: result.best,
    title: result.title,
    thumbnail: result.thumbnail,
    tookMs: result.tookMs,
    engine: BLITZ_NAME,
    author: BLITZ_AUTHOR,
  });
});

app.post('/api/batch', async (req: FastifyRequest, reply: FastifyReply) => {
  const body = (req.body || {}) as BlitzBody;
  const parsed = batchSchema.safeParse(body);
  if (!parsed.success) {
    return blitzFail(
      reply,
      'expected { "urls": string[1..12], "concurrency"?: 1..4 }',
      'INVALID_BATCH'
    );
  }

  const { urls, concurrency } = parsed.data;
  const started = Date.now();
  const results = await engine.blitzBatch(urls, concurrency);
  const succeeded = results.filter((r) => r.ok).length;

  return blitzSend(reply, {
    ok: succeeded > 0,
    total: results.length,
    succeeded,
    failed: results.length - succeeded,
    tookMs: Date.now() - started,
    results,
    summary: results.map(blitzFormatSummary),
    engine: BLITZ_NAME,
    author: BLITZ_AUTHOR,
    handle: BLITZ_HANDLE,
  });
});

app.get('/api/ping', async (_req, reply) => {
  return blitzSend(reply, {
    pong: true,
    engine: BLITZ_NAME,
    author: BLITZ_AUTHOR,
    ts: Date.now(),
  });
});

app.get('/api/version', async (_req, reply) => {
  return blitzSend(reply, {
    name: BLITZ_NAME,
    version: engine.version,
    author: BLITZ_AUTHOR,
    handle: BLITZ_HANDLE,
  });
});

app.setNotFoundHandler(async (req, reply) => {
  return blitzFail(
    reply,
    `route ${req.method} ${req.url} not found`,
    'NOT_FOUND',
    404,
    { path: req.url }
  );
});

app.setErrorHandler(async (err: FastifyError, req, reply) => {
  req.log.error({ err, url: req.url }, 'blitzipint error');
  const status = err.statusCode && err.statusCode >= 400 ? err.statusCode : 500;
  return blitzFail(
    reply,
    err.message || 'internal server error',
    err.code || 'INTERNAL',
    status
  );
});

const PORT = Number(process.env.PORT) || 3000;
const HOST = process.env.HOST || '0.0.0.0';
const isServerless =
  process.env.VERCEL === '1' ||
  process.env.NOW_REGION ||
  process.env.AWS_LAMBDA_FUNCTION_NAME;

if (!isServerless) {
  try {
    await app.listen({ port: PORT, host: HOST });
    console.log(`[${BLITZ_NAME}] ${BLITZ_AUTHOR} (@${BLITZ_HANDLE})`);
    console.log(`[${BLITZ_NAME}] listening on http://${HOST}:${PORT}`);
    console.log(`[${BLITZ_NAME}] example: /api/media?url=https://www.pinterest.com/pin/664281013778109217/`);
  } catch (err) {
    app.log.error(err);
    process.exit(1);
  }
}

export default app;

// extra blitz helpers kept at bottom for clarity

function blitzSanitizeFilename(name: string): string {
  return name
    .replace(/[<>:"/\\|?*\x00-\x1F]/g, '_')
    .replace(/\s+/g, '_')
    .slice(0, 120) || 'blitzipint_media';
}

function blitzGuessExt(url: string, type?: string): string {
  if (/\.mp4/i.test(url)) return 'mp4';
  if (/\.webm/i.test(url)) return 'webm';
  if (/\.gif/i.test(url)) return 'gif';
  if (/\.png/i.test(url)) return 'png';
  if (/\.webp/i.test(url)) return 'webp';
  if (type === 'video') return 'mp4';
  if (type === 'gif') return 'gif';
  return 'jpg';
}

function blitzBuildFilename(result: BlitzResult, media: BlitzMedia, index = 0): string {
  const pinId = result.input.match(/\/pin\/(?:[^/]*--)?(\d+)/)?.[1] || 'unknown';
  const titlePart = result.title ? blitzSanitizeFilename(result.title).slice(0, 40) : 'pin';
  const ext = blitzGuessExt(media.url, media.type);
  return `blitzipint_${pinId}_${titlePart}_${media.quality || 'std'}_${index}.${ext}`;
}

app.get('/api/filename', async (req: FastifyRequest, reply: FastifyReply) => {
  const q = req.query as BlitzQuery;
  const check = blitzValidateUrlParam(q.url);
  if (!check.ok) {
    return blitzFail(reply, check.msg, 'INVALID_URL');
  }

  const result = await engine.blitzResolve(check.url);
  if (!result.ok || !result.medias.length) {
    return blitzSend(reply, result, 422);
  }

  const files = result.medias.map((m, i) => ({
    media: m,
    suggested: blitzBuildFilename(result, m, i),
  }));

  return blitzSend(reply, {
    ok: true,
    input: result.input,
    files,
    engine: BLITZ_NAME,
    author: BLITZ_AUTHOR,
  });
});

function blitzSleep(ms: number) {
  return new Promise((r) => setTimeout(r, ms));
}

async function blitzSafeResolve(url: string, retries = 1): Promise<BlitzResult> {
  let last: BlitzResult | null = null;
  for (let i = 0; i <= retries; i++) {
    last = await engine.blitzResolve(url);
    if (last.ok) return last;
    if (i < retries) await blitzSleep(600 + Math.random() * 500);
  }
  return last!;
}

app.get('/api/retry', async (req: FastifyRequest, reply: FastifyReply) => {
  const q = req.query as BlitzQuery & { retries?: string };
  const check = blitzValidateUrlParam(q.url);
  if (!check.ok) {
    return blitzFail(reply, check.msg, 'INVALID_URL');
  }
  const retries = Math.min(3, Math.max(0, Number(q.retries) || 1));
  const result = await blitzSafeResolve(check.url, retries);
  return blitzSend(reply, result, result.ok ? 200 : 422);
});

app.get('/api/stats', async (_req, reply) => {
  const h = engine.blitzHealth();
  return blitzSend(reply, {
    engine: BLITZ_NAME,
    author: BLITZ_AUTHOR,
    handle: BLITZ_HANDLE,
    version: h.version,
    fails: h.fails,
    uptime: process.uptime(),
    memoryRss: process.memoryUsage().rss,
    pid: process.pid,
  });
});

// keep export at end
export { blitzSanitizeFilename, blitzGuessExt, blitzBuildFilename, blitzSafeResolve };

function blitzIsServerlessEnv(): boolean {
  return Boolean(
    process.env.VERCEL ||
      process.env.NOW_REGION ||
      process.env.AWS_LAMBDA_FUNCTION_NAME ||
      process.env.FUNCTION_NAME
  );
}

function blitzLogStartup() {
  console.log('----------------------------------------');
  console.log(`${BLITZ_NAME} v${engine.version}`);
  console.log(`author : ${BLITZ_AUTHOR}`);
  console.log(`handle : @${BLITZ_HANDLE}`);
  console.log(`mode   : ${blitzIsServerlessEnv() ? 'serverless' : 'standalone'}`);
  console.log('----------------------------------------');
}

if (!blitzIsServerlessEnv()) {
  blitzLogStartup();
}

// blitzipint ready

