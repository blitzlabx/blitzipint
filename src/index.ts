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

function blitzValidateUrlParam(
  raw: unknown
): { ok: true; url: string } | { ok: false; msg: string } {
  if (typeof raw !== 'string' || raw.trim().length < 10) {
    return { ok: false, msg: 'url must be a non-empty string' };
  }
  const check = BlitzUrlSchema.safeParse(raw.trim());
  if (!check.success) {
    return {
      ok: false,
      msg: check.error.errors[0]?.message || 'invalid pinterest url',
    };
  }
  return { ok: true, url: check.data };
}

async function blitzHandleSingle(url: string, reply: FastifyReply) {
  const result = await engine.blitzResolve(url);
  const status = result.ok ? 200 : 422;
  return blitzSend(reply, result, status);
}

function blitzSanitizeFilename(name: string): string {
  return (
    name
      .replace(/[<>:"/\\|?*\x00-\x1F]/g, '_')
      .replace(/\s+/g, '_')
      .slice(0, 120) || 'blitzipint_media'
  );
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

function blitzBuildFilename(
  result: BlitzResult,
  media: BlitzMedia,
  index = 0
): string {
  const pinId =
    result.input.match(/\/pin\/(?:[^/]*--)?(\d+)/)?.[1] || 'unknown';
  const titlePart = result.title
    ? blitzSanitizeFilename(result.title).slice(0, 40)
    : 'pin';
  const ext = blitzGuessExt(media.url, media.type);
  return `blitzipint_${pinId}_${titlePart}_${media.quality || 'std'}_${index}.${ext}`;
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

function blitzIsServerlessEnv(): boolean {
  return Boolean(
    process.env.VERCEL ||
      process.env.NOW_REGION ||
      process.env.AWS_LAMBDA_FUNCTION_NAME ||
      process.env.FUNCTION_NAME
  );
}

const FRONTEND_HTML = `<!DOCTYPE html>
<html lang="en">
<head>
<meta charset="UTF-8">
<meta name="viewport" content="width=device-width, initial-scale=1.0">
<title>blitzipint — Pinterest Media Extractor</title>
<meta name="description" content="Extract videos, images and GIFs from public Pinterest pins. Built by Blitz.">
<link rel="preconnect" href="https://fonts.googleapis.com">
<link rel="preconnect" href="https://fonts.gstatic.com" crossorigin>
<link href="https://fonts.googleapis.com/css2?family=DM+Sans:ital,opsz,wght@0,9..40,400;0,9..40,500;0,9..40,600;0,9..40,700;1,9..40,400&family=JetBrains+Mono:wght@400;500&display=swap" rel="stylesheet">
<style>
:root {
  --bg: #0b0d10;
  --bg-elevated: #12151a;
  --bg-card: #161a21;
  --border: #252a33;
  --border-focus: #3d4654;
  --text: #e8eaed;
  --text-muted: #8b93a1;
  --text-dim: #5c6573;
  --accent: #e60023;
  --accent-hover: #ff1a3c;
  --accent-soft: rgba(230, 0, 35, 0.12);
  --success: #22c55e;
  --success-soft: rgba(34, 197, 94, 0.12);
  --error: #ef4444;
  --error-soft: rgba(239, 68, 68, 0.12);
  --radius: 12px;
  --radius-sm: 8px;
  --shadow: 0 8px 32px rgba(0,0,0,0.4);
  --font: 'DM Sans', system-ui, sans-serif;
  --mono: 'JetBrains Mono', ui-monospace, monospace;
}
*, *::before, *::after { box-sizing: border-box; margin: 0; padding: 0; }
html { scroll-behavior: smooth; }
body {
  font-family: var(--font);
  background: var(--bg);
  color: var(--text);
  min-height: 100vh;
  line-height: 1.5;
  -webkit-font-smoothing: antialiased;
}
.bg-grid {
  position: fixed;
  inset: 0;
  background-image:
    linear-gradient(rgba(255,255,255,0.02) 1px, transparent 1px),
    linear-gradient(90deg, rgba(255,255,255,0.02) 1px, transparent 1px);
  background-size: 48px 48px;
  pointer-events: none;
  z-index: 0;
}
.bg-glow {
  position: fixed;
  top: -20%;
  left: 50%;
  transform: translateX(-50%);
  width: 80vw;
  max-width: 900px;
  height: 50vh;
  background: radial-gradient(ellipse, rgba(230,0,35,0.08) 0%, transparent 70%);
  pointer-events: none;
  z-index: 0;
}
.wrap {
  position: relative;
  z-index: 1;
  max-width: 720px;
  margin: 0 auto;
  padding: 0 20px 80px;
}
header {
  padding: 28px 0 8px;
  display: flex;
  align-items: center;
  justify-content: space-between;
}
.logo {
  display: flex;
  align-items: center;
  gap: 10px;
  text-decoration: none;
  color: var(--text);
}
.logo-mark {
  width: 36px;
  height: 36px;
  background: var(--accent);
  border-radius: 10px;
  display: flex;
  align-items: center;
  justify-content: center;
  transition: transform 0.25s ease;
}
.logo:hover .logo-mark { transform: scale(1.05); }
.logo-mark svg { width: 20px; height: 20px; fill: #fff; }
.logo-text {
  font-weight: 700;
  font-size: 1.15rem;
  letter-spacing: -0.02em;
}
.logo-text span { color: var(--accent); }
.nav-links {
  display: flex;
  gap: 6px;
}
.nav-links a {
  color: var(--text-muted);
  text-decoration: none;
  font-size: 0.875rem;
  font-weight: 500;
  padding: 8px 12px;
  border-radius: var(--radius-sm);
  transition: color 0.2s, background 0.2s;
}
.nav-links a:hover {
  color: var(--text);
  background: var(--bg-elevated);
}
.hero {
  text-align: center;
  padding: 48px 0 40px;
  animation: fadeUp 0.6s ease both;
}
.hero h1 {
  font-size: clamp(1.75rem, 5vw, 2.35rem);
  font-weight: 700;
  letter-spacing: -0.03em;
  line-height: 1.2;
  margin-bottom: 12px;
}
.hero p {
  color: var(--text-muted);
  font-size: 1.05rem;
  max-width: 420px;
  margin: 0 auto;
}
.card {
  background: var(--bg-card);
  border: 1px solid var(--border);
  border-radius: var(--radius);
  padding: 24px;
  box-shadow: var(--shadow);
  animation: fadeUp 0.6s ease 0.1s both;
}
.input-row {
  display: flex;
  gap: 10px;
  flex-wrap: wrap;
}
.input-wrap {
  flex: 1;
  min-width: 200px;
  position: relative;
}
.input-wrap input {
  width: 100%;
  background: var(--bg);
  border: 1px solid var(--border);
  border-radius: var(--radius-sm);
  padding: 14px 16px 14px 44px;
  color: var(--text);
  font-family: var(--font);
  font-size: 0.95rem;
  outline: none;
  transition: border-color 0.2s, box-shadow 0.2s;
}
.input-wrap input::placeholder { color: var(--text-dim); }
.input-wrap input:focus {
  border-color: var(--accent);
  box-shadow: 0 0 0 3px var(--accent-soft);
}
.input-icon {
  position: absolute;
  left: 14px;
  top: 50%;
  transform: translateY(-50%);
  width: 18px;
  height: 18px;
  color: var(--text-dim);
  pointer-events: none;
}
.input-icon svg { width: 100%; height: 100%; fill: currentColor; }
.btn {
  display: inline-flex;
  align-items: center;
  justify-content: center;
  gap: 8px;
  background: var(--accent);
  color: #fff;
  border: none;
  border-radius: var(--radius-sm);
  padding: 14px 22px;
  font-family: var(--font);
  font-size: 0.95rem;
  font-weight: 600;
  cursor: pointer;
  transition: background 0.2s, transform 0.15s, box-shadow 0.2s;
  white-space: nowrap;
}
.btn:hover:not(:disabled) {
  background: var(--accent-hover);
  transform: translateY(-1px);
  box-shadow: 0 4px 16px rgba(230,0,35,0.35);
}
.btn:active:not(:disabled) { transform: translateY(0); }
.btn:disabled {
  opacity: 0.55;
  cursor: not-allowed;
}
.btn svg { width: 18px; height: 18px; fill: currentColor; }
.btn-ghost {
  background: transparent;
  color: var(--text-muted);
  border: 1px solid var(--border);
}
.btn-ghost:hover:not(:disabled) {
  background: var(--bg-elevated);
  color: var(--text);
  box-shadow: none;
  transform: none;
}
.status {
  margin-top: 16px;
  padding: 12px 14px;
  border-radius: var(--radius-sm);
  font-size: 0.875rem;
  display: none;
  align-items: center;
  gap: 10px;
  animation: fadeIn 0.3s ease;
}
.status.show { display: flex; }
.status.loading {
  background: var(--bg-elevated);
  color: var(--text-muted);
  border: 1px solid var(--border);
}
.status.error {
  background: var(--error-soft);
  color: #fca5a5;
  border: 1px solid rgba(239,68,68,0.25);
}
.status.success {
  background: var(--success-soft);
  color: #86efac;
  border: 1px solid rgba(34,197,94,0.25);
}
.spinner {
  width: 16px;
  height: 16px;
  border: 2px solid var(--border);
  border-top-color: var(--accent);
  border-radius: 50%;
  animation: spin 0.7s linear infinite;
  flex-shrink: 0;
}
.results {
  margin-top: 20px;
  display: none;
  animation: fadeUp 0.4s ease;
}
.results.show { display: block; }
.results-header {
  display: flex;
  align-items: center;
  justify-content: space-between;
  margin-bottom: 14px;
  flex-wrap: wrap;
  gap: 8px;
}
.results-header h2 {
  font-size: 0.95rem;
  font-weight: 600;
  color: var(--text-muted);
}
.meta-chip {
  font-family: var(--mono);
  font-size: 0.75rem;
  color: var(--text-dim);
  background: var(--bg);
  padding: 4px 8px;
  border-radius: 6px;
  border: 1px solid var(--border);
}
.media-list {
  display: flex;
  flex-direction: column;
  gap: 10px;
}
.media-item {
  background: var(--bg);
  border: 1px solid var(--border);
  border-radius: var(--radius-sm);
  padding: 14px;
  display: flex;
  align-items: center;
  gap: 14px;
  transition: border-color 0.2s, transform 0.15s;
  animation: fadeUp 0.35s ease both;
}
.media-item:hover {
  border-color: var(--border-focus);
  transform: translateX(2px);
}
.media-thumb {
  width: 56px;
  height: 56px;
  border-radius: 8px;
  background: var(--bg-elevated);
  object-fit: cover;
  flex-shrink: 0;
  border: 1px solid var(--border);
}
.media-thumb.placeholder {
  display: flex;
  align-items: center;
  justify-content: center;
  color: var(--text-dim);
}
.media-thumb.placeholder svg { width: 24px; height: 24px; fill: currentColor; }
.media-info { flex: 1; min-width: 0; }
.media-type {
  font-size: 0.7rem;
  font-weight: 600;
  text-transform: uppercase;
  letter-spacing: 0.04em;
  color: var(--accent);
  margin-bottom: 2px;
}
.media-quality {
  font-family: var(--mono);
  font-size: 0.8rem;
  color: var(--text-muted);
}
.media-url {
  font-family: var(--mono);
  font-size: 0.7rem;
  color: var(--text-dim);
  white-space: nowrap;
  overflow: hidden;
  text-overflow: ellipsis;
  margin-top: 2px;
}
.media-actions {
  display: flex;
  gap: 6px;
  flex-shrink: 0;
}
.icon-btn {
  width: 36px;
  height: 36px;
  border-radius: 8px;
  border: 1px solid var(--border);
  background: var(--bg-elevated);
  color: var(--text-muted);
  display: flex;
  align-items: center;
  justify-content: center;
  cursor: pointer;
  transition: color 0.2s, border-color 0.2s, background 0.2s;
  text-decoration: none;
}
.icon-btn:hover {
  color: var(--text);
  border-color: var(--border-focus);
  background: var(--bg-card);
}
.icon-btn svg { width: 16px; height: 16px; fill: currentColor; }
.icon-btn.primary {
  background: var(--accent);
  border-color: var(--accent);
  color: #fff;
}
.icon-btn.primary:hover {
  background: var(--accent-hover);
  border-color: var(--accent-hover);
}
.footer {
  margin-top: 48px;
  text-align: center;
  color: var(--text-dim);
  font-size: 0.8rem;
  animation: fadeUp 0.6s ease 0.2s both;
}
.footer a {
  color: var(--text-muted);
  text-decoration: none;
  transition: color 0.2s;
}
.footer a:hover { color: var(--accent); }
.footer-links {
  display: flex;
  justify-content: center;
  gap: 16px;
  margin-bottom: 10px;
}
.api-hint {
  margin-top: 32px;
  padding: 16px;
  background: var(--bg-elevated);
  border: 1px solid var(--border);
  border-radius: var(--radius-sm);
  font-size: 0.8rem;
  color: var(--text-dim);
  animation: fadeUp 0.6s ease 0.15s both;
}
.api-hint code {
  font-family: var(--mono);
  font-size: 0.75rem;
  color: var(--text-muted);
  background: var(--bg);
  padding: 2px 6px;
  border-radius: 4px;
}
@keyframes fadeUp {
  from { opacity: 0; transform: translateY(12px); }
  to { opacity: 1; transform: translateY(0); }
}
@keyframes fadeIn {
  from { opacity: 0; }
  to { opacity: 1; }
}
@keyframes spin {
  to { transform: rotate(360deg); }
}
@media (max-width: 560px) {
  .input-row { flex-direction: column; }
  .btn { width: 100%; }
  .hero { padding: 32px 0 28px; }
  .card { padding: 18px; }
  .media-item { flex-wrap: wrap; }
  .media-actions { width: 100%; justify-content: flex-end; }
  header { flex-wrap: wrap; gap: 12px; }
}
</style>
</head>
<body>
<div class="bg-grid"></div>
<div class="bg-glow"></div>
<div class="wrap">
  <header>
    <a class="logo" href="/">
      <div class="logo-mark">
        <svg viewBox="0 0 24 24"><path d="M12 2C6.48 2 2 6.48 2 12c0 4.28 2.69 7.92 6.44 9.34-.09-.78-.17-1.98.04-2.83.19-.78 1.22-5.16 1.22-5.16s-.31-.62-.31-1.54c0-1.44.83-2.52 1.87-2.52.88 0 1.31.66 1.31 1.46 0 .89-.57 2.22-.86 3.45-.24 1.02.52 1.85 1.52 1.85 1.83 0 3.24-1.93 3.24-4.71 0-2.46-1.77-4.18-4.3-4.18-2.93 0-4.65 2.2-4.65 4.47 0 .89.34 1.84.77 2.36.08.1.1.19.07.29l-.29 1.18c-.05.19-.15.23-.35.14-1.3-.61-2.11-2.51-2.11-4.04 0-3.29 2.39-6.31 6.89-6.31 3.62 0 6.43 2.58 6.43 6.03 0 3.6-2.27 6.49-5.42 6.49-1.06 0-2.05-.55-2.39-1.2l-.65 2.48c-.23.91-.87 2.05-1.29 2.75 1.14.34 2.34.53 3.59.53 5.52 0 10-4.48 10-10S17.52 2 12 2z"/></svg>
      </div>
      <div class="logo-text">blitz<span>ipint</span></div>
    </a>
    <nav class="nav-links">
      <a href="/api/info">API</a>
      <a href="https://x.com/blitzlabx" target="_blank" rel="noopener">X</a>
      <a href="https://github.com/blitzlabx" target="_blank" rel="noopener">GitHub</a>
    </nav>
  </header>

  <section class="hero">
    <h1>Extract Pinterest media</h1>
    <p>Paste a public pin link. Get direct video, image or GIF URLs in seconds.</p>
  </section>

  <div class="card">
    <form id="form" autocomplete="off">
      <div class="input-row">
        <div class="input-wrap">
          <span class="input-icon">
            <svg viewBox="0 0 24 24"><path d="M3.9 12c0-1.71 1.39-3.1 3.1-3.1h4V7H7c-2.76 0-5 2.24-5 5s2.24 5 5 5h4v-1.9H7c-1.71 0-3.1-1.39-3.1-3.1zM8 13h8v-2H8v2zm9-6h-4v1.9h4c1.71 0 3.1 1.39 3.1 3.1s-1.39 3.1-3.1 3.1h-4V17h4c2.76 0 5-2.24 5-5s-2.24-5-5-5z"/></svg>
          </span>
          <input id="url" type="url" placeholder="https://www.pinterest.com/pin/..." required>
        </div>
        <button type="submit" class="btn" id="submitBtn">
          <svg viewBox="0 0 24 24"><path d="M19 9h-4V3H9v6H5l7 7 7-7zM5 18v2h14v-2H5z"/></svg>
          Extract
        </button>
      </div>
    </form>
    <div class="status" id="status"></div>
    <div class="results" id="results">
      <div class="results-header">
        <h2 id="resultsTitle">Results</h2>
        <span class="meta-chip" id="metaChip"></span>
      </div>
      <div class="media-list" id="mediaList"></div>
    </div>
  </div>

  <div class="api-hint">
    API ready: <code>GET /api/media?url=...</code> · <code>POST /api/media</code> · <code>POST /api/batch</code>
  </div>

  <footer class="footer">
    <div class="footer-links">
      <a href="https://x.com/blitzlabx" target="_blank" rel="noopener">@blitzlabx</a>
      <a href="https://github.com/blitzlabx" target="_blank" rel="noopener">GitHub</a>
      <a href="/api/info">API docs</a>
    </div>
    <div>blitzipint by Blitz · MIT License</div>
  </footer>
</div>
<script>
(function () {
  const form = document.getElementById('form');
  const urlInput = document.getElementById('url');
  const submitBtn = document.getElementById('submitBtn');
  const statusEl = document.getElementById('status');
  const resultsEl = document.getElementById('results');
  const mediaList = document.getElementById('mediaList');
  const resultsTitle = document.getElementById('resultsTitle');
  const metaChip = document.getElementById('metaChip');

  const iconDownload = '<svg viewBox="0 0 24 24"><path d="M19 9h-4V3H9v6H5l7 7 7-7zM5 18v2h14v-2H5z"/></svg>';
  const iconCopy = '<svg viewBox="0 0 24 24"><path d="M16 1H4c-1.1 0-2 .9-2 2v14h2V3h12V1zm3 4H8c-1.1 0-2 .9-2 2v14c0 1.1.9 2 2 2h11c1.1 0 2-.9 2-2V7c0-1.1-.9-2-2-2zm0 16H8V7h11v14z"/></svg>';
  const iconVideo = '<svg viewBox="0 0 24 24"><path d="M17 10.5V7c0-.55-.45-1-1-1H4c-.55 0-1 .45-1 1v10c0 .55.45 1 1 1h12c.55 0 1-.45 1-1v-3.5l4 4v-11l-4 4z"/></svg>';
  const iconImage = '<svg viewBox="0 0 24 24"><path d="M21 19V5c0-1.1-.9-2-2-2H5c-1.1 0-2 .9-2 2v14c0 1.1.9 2 2 2h14c1.1 0 2-.9 2-2zM8.5 13.5l2.5 3.01L14.5 12l4.5 6H5l3.5-4.5z"/></svg>';

  function showStatus(type, msg) {
    statusEl.className = 'status show ' + type;
    if (type === 'loading') {
      statusEl.innerHTML = '<div class="spinner"></div><span>' + msg + '</span>';
    } else {
      statusEl.innerHTML = '<span>' + msg + '</span>';
    }
  }

  function hideStatus() {
    statusEl.className = 'status';
  }

  function copyText(text, btn) {
    navigator.clipboard.writeText(text).then(function () {
      btn.style.color = '#22c55e';
      setTimeout(function () { btn.style.color = ''; }, 1200);
    });
  }

  function renderResults(data) {
    mediaList.innerHTML = '';
    if (!data.ok || !data.medias || !data.medias.length) {
      showStatus('error', data.error || 'No media found');
      resultsEl.classList.remove('show');
      return;
    }
    hideStatus();
    resultsEl.classList.add('show');
    resultsTitle.textContent = data.medias.length + ' media item' + (data.medias.length > 1 ? 's' : '');
    metaChip.textContent = data.tookMs + ' ms';

    data.medias.forEach(function (m, i) {
      var item = document.createElement('div');
      item.className = 'media-item';
      item.style.animationDelay = (i * 0.05) + 's';

      var thumbHtml;
      if (m.poster || (m.type === 'image' || m.type === 'gif')) {
        var src = m.poster || m.url;
        thumbHtml = '<img class="media-thumb" src="' + src + '" alt="" loading="lazy" onerror="this.classList.add(\\'placeholder\\');this.outerHTML=\\'<div class=\\\\'media-thumb placeholder\\\\'>' + (m.type === 'video' ? iconVideo : iconImage) + '</div>\\'">';
      } else {
        thumbHtml = '<div class="media-thumb placeholder">' + (m.type === 'video' ? iconVideo : iconImage) + '</div>';
      }

      item.innerHTML =
        thumbHtml +
        '<div class="media-info">' +
          '<div class="media-type">' + m.type + '</div>' +
          '<div class="media-quality">' + (m.quality || 'standard') + (m.score ? ' · score ' + m.score : '') + '</div>' +
          '<div class="media-url">' + m.url + '</div>' +
        '</div>' +
        '<div class="media-actions">' +
          '<button type="button" class="icon-btn" title="Copy URL" data-copy="' + m.url.replace(/"/g, '&quot;') + '">' + iconCopy + '</button>' +
          '<a class="icon-btn primary" href="' + m.url + '" target="_blank" rel="noopener" download title="Download">' + iconDownload + '</a>' +
        '</div>';

      mediaList.appendChild(item);
    });

    mediaList.querySelectorAll('[data-copy]').forEach(function (btn) {
      btn.addEventListener('click', function () {
        copyText(btn.getAttribute('data-copy'), btn);
      });
    });
  }

  form.addEventListener('submit', async function (e) {
    e.preventDefault();
    var url = urlInput.value.trim();
    if (!url) return;

    submitBtn.disabled = true;
    resultsEl.classList.remove('show');
    showStatus('loading', 'Resolving pin...');

    try {
      var res = await fetch('/api/media?url=' + encodeURIComponent(url));
      var data = await res.json();
      renderResults(data);
      if (!data.ok) {
        showStatus('error', data.error || 'Extraction failed');
      }
    } catch (err) {
      showStatus('error', 'Network error. Please try again.');
      resultsEl.classList.remove('show');
    } finally {
      submitBtn.disabled = false;
    }
  });
})();
</script>
</body>
</html>`;

async function buildApp(): Promise<FastifyInstance> {
  const app = Fastify({
    logger: process.env.NODE_ENV === 'production' ? false : true,
    trustProxy: true,
    bodyLimit: 64 * 1024,
  });

  await app.register(cors, {
    origin: true,
    methods: ['GET', 'POST', 'OPTIONS'],
    allowedHeaders: ['Content-Type', 'Authorization', 'X-Blitz-Key'],
  });

  app.addHook('onRequest', async (req) => {
    (req as any).blitzStart = Date.now();
  });

  app.addHook('onResponse', async (req, reply) => {
    const start = (req as any).blitzStart as number | undefined;
    if (start) {
      reply.header('X-Blitz-Time', String(Date.now() - start));
    }
  });

  app.get('/', async (_req, reply) => {
    return reply
      .type('text/html; charset=utf-8')
      .header('Cache-Control', 'public, max-age=60')
      .send(FRONTEND_HTML);
  });

  app.get('/health', async (_req, reply) => {
    const h = engine.blitzHealth();
    return blitzSend(reply, {
      status: 'ok',
      service: BLITZ_NAME,
      ...h,
      uptimeSec: Math.floor(process.uptime()),
      node: process.version,
    });
  });

  app.get('/api/info', async (_req, reply) => {
    return blitzSend(reply, {
      name: BLITZ_NAME,
      version: engine.version,
      author: BLITZ_AUTHOR,
      handle: BLITZ_HANDLE,
      description:
        'blitzipint resolves public Pinterest pins and returns direct media URLs for videos, images and GIFs.',
      endpoints: {
        media: 'GET|POST /api/media',
        resolve: 'GET /api/resolve',
        best: 'GET /api/best',
        batch: 'POST /api/batch',
        filename: 'GET /api/filename',
        health: 'GET /health',
      },
      socials: {
        x: `https://x.com/${BLITZ_HANDLE}`,
        github: `https://github.com/${BLITZ_HANDLE}`,
      },
    });
  });

  app.get('/api/media', async (req: FastifyRequest, reply: FastifyReply) => {
    const q = req.query as BlitzQuery;
    const check = blitzValidateUrlParam(q.url);
    if (!check.ok) return blitzFail(reply, check.msg, 'MISSING_OR_INVALID_URL');
    return blitzHandleSingle(check.url, reply);
  });

  app.post('/api/media', async (req: FastifyRequest, reply: FastifyReply) => {
    const body = (req.body || {}) as BlitzBody;
    const parsed = singleSchema.safeParse(body);
    if (!parsed.success) {
      return blitzFail(reply, 'body must contain { "url": "string" }', 'INVALID_BODY');
    }
    const check = blitzValidateUrlParam(parsed.data.url);
    if (!check.ok) return blitzFail(reply, check.msg, 'INVALID_URL');
    return blitzHandleSingle(check.url, reply);
  });

  app.get('/api/resolve', async (req: FastifyRequest, reply: FastifyReply) => {
    const q = req.query as BlitzQuery;
    const check = blitzValidateUrlParam(q.url);
    if (!check.ok) return blitzFail(reply, check.msg, 'INVALID_URL');
    return blitzHandleSingle(check.url, reply);
  });

  app.get('/api/best', async (req: FastifyRequest, reply: FastifyReply) => {
    const q = req.query as BlitzQuery;
    const check = blitzValidateUrlParam(q.url);
    if (!check.ok) return blitzFail(reply, check.msg, 'INVALID_URL');
    const result = await engine.blitzResolve(check.url);
    if (!result.ok || !result.best) return blitzSend(reply, result, 422);
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
    });
  });

  app.get('/api/filename', async (req: FastifyRequest, reply: FastifyReply) => {
    const q = req.query as BlitzQuery;
    const check = blitzValidateUrlParam(q.url);
    if (!check.ok) return blitzFail(reply, check.msg, 'INVALID_URL');
    const result = await engine.blitzResolve(check.url);
    if (!result.ok || !result.medias.length) return blitzSend(reply, result, 422);
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
    if (req.headers.accept?.includes('text/html')) {
      return reply.redirect('/');
    }
    return blitzFail(reply, `route ${req.method} ${req.url} not found`, 'NOT_FOUND', 404);
  });

  app.setErrorHandler(async (err: FastifyError, req, reply) => {
    req.log?.error?.({ err }, 'blitzipint error');
    const status = err.statusCode && err.statusCode >= 400 ? err.statusCode : 500;
    return blitzFail(reply, err.message || 'internal server error', err.code || 'INTERNAL', status);
  });

  return app;
}


const appPromise = buildApp();

// Vercel / serverless entry
export default async function vercelHandler(req: any, res: any) {
  const app = await appPromise;
  await app.ready();
  app.server.emit("request", req, res);
}

// Also export the app for runtimes that expect it
export { appPromise as app };

if (!blitzIsServerlessEnv()) {
  const PORT = Number(process.env.PORT) || 3000;
  const HOST = process.env.HOST || "0.0.0.0";
  appPromise
    .then(async (app) => {
      await app.listen({ port: PORT, host: HOST });
      console.log(`[blitzipint] Blitz (@${BLITZ_HANDLE}) · http://${HOST}:${PORT}`);
    })
    .catch((err) => {
      console.error(err);
      process.exit(1);
    });
}
