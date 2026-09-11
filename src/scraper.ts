import axios, { AxiosInstance, AxiosError } from 'axios';
import * as cheerio from 'cheerio';
import { z } from 'zod';

const BLITZ_UA =
  'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/129.0.0.0 Safari/537.36';

const PIN_HOST_RE =
  /pinterest\.(com|co\.uk|de|fr|it|es|nl|se|ch|co\.in|br|au|at|cl|jp|ru|ie|ca|mx|nz|pt|ph)|pin\.it/i;

export const BlitzUrlSchema = z
  .string()
  .min(12)
  .url()
  .refine((u) => PIN_HOST_RE.test(u), {
    message: 'blitzipint only accepts public Pinterest or pin.it links',
  });

export type BlitzMediaType = 'video' | 'image' | 'gif' | 'unknown';

export interface BlitzMedia {
  type: BlitzMediaType;
  url: string;
  quality: string;
  width?: number;
  height?: number;
  poster?: string;
  source: 'direct' | 'proxy' | 'meta' | 'regex' | 'video-tag';
  score: number;
}

export interface BlitzResult {
  ok: boolean;
  input: string;
  resolved?: string;
  title?: string;
  description?: string;
  medias: BlitzMedia[];
  best?: BlitzMedia;
  thumbnail?: string;
  tookMs: number;
  engine: 'blitzipint';
  author: 'Blitz';
  error?: string;
  code?: string;
}

interface BlitzInternalState {
  csrf: string | null;
  lastFetch: number;
  failCount: number;
}

const state: BlitzInternalState = {
  csrf: null,
  lastFetch: 0,
  failCount: 0,
};

function blitzNow() {
  return Date.now();
}

function blitzCleanUrl(raw: string): string {
  let u = raw.trim();
  u = u.replace(/&quot;/g, '"').replace(/\\u0026/g, '&').replace(/&amp;/g, '&');
  u = u.split('"')[0].split("'")[0].split(' ')[0];
  if (u.endsWith('\\')) u = u.slice(0, -1);
  return u;
}

function blitzIsVideo(url: string): boolean {
  return /\.(mp4|m3u8|webm)(\?|$)/i.test(url) || /v\d*\.pinimg\.com.*(?:video|videos)/i.test(url);
}

function blitzIsGif(url: string): boolean {
  return /\.gif(\?|$)/i.test(url);
}

function blitzIsImage(url: string): boolean {
  return /i\.pinimg\.com/i.test(url) && /\.(jpe?g|png|webp|gif)(\?|$)/i.test(url);
}

function blitzGuessQuality(url: string): string {
  if (/originals/i.test(url)) return 'originals';
  if (/\/4k\/|2160|uhd/i.test(url)) return '4k';
  if (/1080|fullhd/i.test(url)) return '1080p';
  if (/720p|\/720\//i.test(url)) return '720p';
  if (/736x/i.test(url)) return '736x';
  if (/564x/i.test(url)) return '564x';
  if (/474x/i.test(url)) return '474x';
  if (/236x|170x|75x75/i.test(url)) return 'low';
  if (/mc\/h265|h264/i.test(url)) return 'adaptive';
  return 'standard';
}

function blitzScoreMedia(m: BlitzMedia): number {
  let s = 0;
  if (m.type === 'video') s += 40;
  if (m.type === 'gif') s += 25;
  if (m.type === 'image') s += 15;

  switch (m.quality) {
    case 'originals':
    case '4k':
      s += 50;
      break;
    case '1080p':
      s += 40;
      break;
    case '720p':
      s += 30;
      break;
    case '736x':
      s += 22;
      break;
    case '564x':
      s += 15;
      break;
    case '474x':
      s += 10;
      break;
    default:
      s += 5;
  }

  if (m.source === 'video-tag') s += 8;
  if (m.source === 'direct') s += 6;
  if (m.poster) s += 3;
  if (m.width && m.width > 1000) s += 5;
  return s;
}

function blitzExtractPinId(url: string): string | null {
  try {
    const m = new URL(url).pathname.match(/\/pin\/(?:[^/]*--)?(\d+)/);
    return m ? m[1] : null;
  } catch {
    return null;
  }
}

function blitzNormalizeInput(raw: string): string {
  let u = raw.trim();
  if (!u.startsWith('http')) u = 'https://' + u;
  u = u.replace(/\/+$/, '');
  return u;
}

function blitzCreateClient(): AxiosInstance {
  return axios.create({
    timeout: 22000,
    maxRedirects: 6,
    headers: {
      'User-Agent': BLITZ_UA,
      Accept: 'text/html,application/xhtml+xml,application/xml;q=0.9,image/avif,image/webp,*/*;q=0.8',
      'Accept-Language': 'en-US,en;q=0.9',
      'Cache-Control': 'no-cache',
      Pragma: 'no-cache',
    },
    validateStatus: (s) => s >= 200 && s < 500,
  });
}

async function blitzFetchCsrf(client: AxiosInstance, base: string): Promise<string> {
  const stamp = blitzNow();
  try {
    const res = await client.get(`${base}/get-csrf-token.php?t=${stamp}`, {
      headers: {
        Accept: 'application/json',
        Referer: `${base}/en2`,
        Origin: base,
      },
    });
    if (res.data && typeof res.data.csrf_token === 'string' && res.data.csrf_token.length > 10) {
      state.csrf = res.data.csrf_token;
      state.lastFetch = stamp;
      return res.data.csrf_token;
    }
  } catch (e) {
    // silent, try fallback
  }

  try {
    const page = await client.get(`${base}/en2`, {
      headers: { Referer: base },
    });
    const $ = cheerio.load(page.data);
    const tok =
      $('#csrf_token_field').attr('value') ||
      $('input[name="csrf_token"]').attr('value') ||
      $('input[name="csrf"]').attr('value');
    if (tok && tok.length > 8) {
      state.csrf = tok;
      state.lastFetch = stamp;
      return tok;
    }
  } catch {
    // ignore
  }

  if (state.csrf && blitzNow() - state.lastFetch < 120000) {
    return state.csrf;
  }

  throw new Error('blitzipint could not obtain a valid CSRF token');
}

function blitzUnwrapProxy(href: string): string {
  try {
    if (href.includes('dl2.klickpin.com') || href.includes('kpxy-dl') || href.includes('vasinvictory')) {
      const u = new URL(href);
      const real = u.searchParams.get('url') || u.searchParams.get('u');
      if (real) return decodeURIComponent(real);
    }
  } catch {
    // keep original
  }
  return href;
}

function blitzCollectFromVideoTags($: cheerio.CheerioAPI, bag: Map<string, BlitzMedia>) {
  $('video').each((_, el) => {
    const node = $(el);
    const dataSrc = node.attr('data-src') || node.attr('src');
    const poster = node.attr('poster') || undefined;

    if (dataSrc) {
      const clean = blitzCleanUrl(dataSrc);
      if (clean && !bag.has(clean)) {
        const type: BlitzMediaType = blitzIsVideo(clean) ? 'video' : 'unknown';
        const m: BlitzMedia = {
          type,
          url: clean,
          quality: blitzGuessQuality(clean),
          poster,
          source: 'video-tag',
          score: 0,
        };
        m.score = blitzScoreMedia(m);
        bag.set(clean, m);
      }
    }

    node.find('source').each((__, src) => {
      const s = $(src).attr('src');
      if (!s) return;
      const clean = blitzCleanUrl(s);
      if (!clean || bag.has(clean)) return;
      const m: BlitzMedia = {
        type: blitzIsVideo(clean) ? 'video' : 'unknown',
        url: clean,
        quality: blitzGuessQuality(clean),
        source: 'video-tag',
        score: 0,
      };
      m.score = blitzScoreMedia(m);
      bag.set(clean, m);
    });
  });
}

function blitzCollectFromAnchors($: cheerio.CheerioAPI, bag: Map<string, BlitzMedia>) {
  $('a[href]').each((_, el) => {
    let href = $(el).attr('href') || '';
    href = blitzUnwrapProxy(href);
    href = blitzCleanUrl(href);
    if (!href || bag.has(href)) return;

    if (blitzIsVideo(href)) {
      const m: BlitzMedia = {
        type: 'video',
        url: href,
        quality: blitzGuessQuality(href),
        source: 'direct',
        score: 0,
      };
      m.score = blitzScoreMedia(m);
      bag.set(href, m);
    } else if (blitzIsGif(href)) {
      const m: BlitzMedia = {
        type: 'gif',
        url: href,
        quality: blitzGuessQuality(href),
        source: 'direct',
        score: 0,
      };
      m.score = blitzScoreMedia(m);
      bag.set(href, m);
    } else if (blitzIsImage(href) && !/75x75|170x|236x/i.test(href)) {
      const m: BlitzMedia = {
        type: 'image',
        url: href,
        quality: blitzGuessQuality(href),
        source: 'direct',
        score: 0,
      };
      m.score = blitzScoreMedia(m);
      bag.set(href, m);
    }
  });
}

function blitzCollectFromImages($: cheerio.CheerioAPI, bag: Map<string, BlitzMedia>) {
  $('img[src], img[data-src]').each((_, el) => {
    const src = $(el).attr('src') || $(el).attr('data-src') || '';
    const clean = blitzCleanUrl(src);
    if (!clean || bag.has(clean)) return;
    if (!blitzIsImage(clean)) return;
    if (/75x75|170x|236x|avatar|profile/i.test(clean)) return;

    const type: BlitzMediaType = blitzIsGif(clean) ? 'gif' : 'image';
    const m: BlitzMedia = {
      type,
      url: clean,
      quality: blitzGuessQuality(clean),
      source: 'meta',
      score: 0,
    };
    m.score = blitzScoreMedia(m);
    bag.set(clean, m);
  });
}

function blitzRegexSweep(html: string, bag: Map<string, BlitzMedia>) {
  const videoRe = /https?:\/\/v\d*\.pinimg\.com\/[^"'\s<>\\]+?\.(?:mp4|m3u8)/gi;
  let match: RegExpExecArray | null;
  while ((match = videoRe.exec(html)) !== null) {
    const clean = blitzCleanUrl(match[0]);
    if (!clean || bag.has(clean)) continue;
    const m: BlitzMedia = {
      type: 'video',
      url: clean,
      quality: blitzGuessQuality(clean),
      source: 'regex',
      score: 0,
    };
    m.score = blitzScoreMedia(m);
    bag.set(clean, m);
  }

  const imgRe =
    /https?:\/\/i\.pinimg\.com\/(?:originals|736x|564x|474x|1200x)\/[^"'\s<>\\]+?\.(?:jpe?g|png|webp|gif)/gi;
  while ((match = imgRe.exec(html)) !== null) {
    const clean = blitzCleanUrl(match[0]);
    if (!clean || bag.has(clean)) continue;
    const type: BlitzMediaType = blitzIsGif(clean) ? 'gif' : 'image';
    const m: BlitzMedia = {
      type,
      url: clean,
      quality: blitzGuessQuality(clean),
      source: 'regex',
      score: 0,
    };
    m.score = blitzScoreMedia(m);
    bag.set(clean, m);
  }

  const genericPin = /https?:\/\/[a-z0-9.-]*pinimg\.com\/[^"'\s<>\\]+/gi;
  while ((match = genericPin.exec(html)) !== null) {
    const clean = blitzCleanUrl(match[0]);
    if (!clean || bag.has(clean)) continue;
    if (blitzIsVideo(clean)) {
      const m: BlitzMedia = {
        type: 'video',
        url: clean,
        quality: blitzGuessQuality(clean),
        source: 'regex',
        score: 0,
      };
      m.score = blitzScoreMedia(m);
      bag.set(clean, m);
    } else if (blitzIsImage(clean) && !/75x75|170x|236x/i.test(clean)) {
      const type: BlitzMediaType = blitzIsGif(clean) ? 'gif' : 'image';
      const m: BlitzMedia = {
        type,
        url: clean,
        quality: blitzGuessQuality(clean),
        source: 'regex',
        score: 0,
      };
      m.score = blitzScoreMedia(m);
      bag.set(clean, m);
    }
  }
}

function blitzPickTitle($: cheerio.CheerioAPI, html: string): string | undefined {
  const h1 = $('h1').first().text().trim();
  if (h1 && h1.length > 3 && !/klickpin|download/i.test(h1)) return h1.slice(0, 220);

  const og = $('meta[property="og:title"]').attr('content');
  if (og && og.length > 3) return og.slice(0, 220);

  const t = $('title').text().replace(/\s*[|\-–].*klickpin.*/i, '').trim();
  if (t && t.length > 3) return t.slice(0, 220);

  const m = html.match(/"title"\s*:\s*"([^"]{5,180})"/);
  if (m) return m[1].replace(/\\u0026/g, '&').slice(0, 220);

  return undefined;
}

function blitzPickDescription($: cheerio.CheerioAPI): string | undefined {
  const og = $('meta[property="og:description"]').attr('content');
  if (og && og.length > 8) return og.slice(0, 400);
  const desc = $('meta[name="description"]').attr('content');
  if (desc && desc.length > 8) return desc.slice(0, 400);
  return undefined;
}

function blitzSortMedias(list: BlitzMedia[]): BlitzMedia[] {
  return list.sort((a, b) => b.score - a.score);
}

function blitzBuildResult(
  input: string,
  medias: BlitzMedia[],
  title: string | undefined,
  description: string | undefined,
  started: number,
  error?: string,
  code?: string
): BlitzResult {
  const sorted = blitzSortMedias([...medias]);
  const best = sorted[0];
  const thumb =
    sorted.find((m) => m.poster)?.poster ||
    sorted.find((m) => m.type === 'image')?.url ||
    best?.url;

  return {
    ok: !error && sorted.length > 0,
    input,
    title,
    description,
    medias: sorted,
    best,
    thumbnail: thumb,
    tookMs: blitzNow() - started,
    engine: 'blitzipint',
    author: 'Blitz',
    error,
    code,
  };
}

export class Blitzipint {
  private client: AxiosInstance;
  private base = 'https://klickpin.com';
  private readonly blitzVersion = '1.2.4';

  constructor(opts?: { base?: string; timeout?: number }) {
    if (opts?.base) this.base = opts.base.replace(/\/+$/, '');
    this.client = blitzCreateClient();
    if (opts?.timeout) {
      this.client.defaults.timeout = opts.timeout;
    }
  }

  get version() {
    return this.blitzVersion;
  }

  async blitzResolve(inputUrl: string): Promise<BlitzResult> {
    const started = blitzNow();
    const normalized = blitzNormalizeInput(inputUrl);

    const parsed = BlitzUrlSchema.safeParse(normalized);
    if (!parsed.success) {
      return blitzBuildResult(
        normalized,
        [],
        undefined,
        undefined,
        started,
        parsed.error.errors.map((e) => e.message).join('; '),
        'INVALID_URL'
      );
    }

    const url = parsed.data;

    try {
      const csrf = await blitzFetchCsrf(this.client, this.base);

      const body = new URLSearchParams();
      body.append('url', url);
      body.append('csrf_token', csrf);

      const res = await this.client.post(`${this.base}/en2/download`, body.toString(), {
        headers: {
          'Content-Type': 'application/x-www-form-urlencoded',
          Origin: this.base,
          Referer: `${this.base}/en2`,
          'User-Agent': BLITZ_UA,
        },
      });

      if (res.status >= 400) {
        state.failCount += 1;
        return blitzBuildResult(
          url,
          [],
          undefined,
          undefined,
          started,
          `upstream returned ${res.status}`,
          'UPSTREAM_HTTP'
        );
      }

      const html = typeof res.data === 'string' ? res.data : String(res.data);
      if (html.length < 800) {
        return blitzBuildResult(
          url,
          [],
          undefined,
          undefined,
          started,
          'empty or blocked response from resolver',
          'EMPTY_RESPONSE'
        );
      }

      return this.blitzParsePage(html, url, started);
    } catch (err: unknown) {
      state.failCount += 1;
      const msg =
        err instanceof AxiosError
          ? err.message || `network error ${err.code || ''}`
          : err instanceof Error
            ? err.message
            : 'unknown failure';

      return blitzBuildResult(url, [], undefined, undefined, started, msg, 'REQUEST_FAILED');
    }
  }

  private blitzParsePage(html: string, original: string, started: number): BlitzResult {
    const $ = cheerio.load(html);
    const bag = new Map<string, BlitzMedia>();

    blitzCollectFromVideoTags($, bag);
    blitzCollectFromAnchors($, bag);
    blitzCollectFromImages($, bag);
    blitzRegexSweep(html, bag);

    const medias = Array.from(bag.values());
    const title = blitzPickTitle($, html);
    const description = blitzPickDescription($);

    if (medias.length === 0) {
      const lower = html.toLowerCase();
      let code = 'NO_MEDIA';
      let reason = 'no downloadable media found for this pin';

      if (lower.includes('private') || lower.includes('login')) {
        code = 'PRIVATE_OR_RESTRICTED';
        reason = 'pin appears private or restricted';
      } else if (lower.includes('not found') || lower.includes('unavailable')) {
        code = 'NOT_FOUND';
        reason = 'pin not found or no longer available';
      } else if (lower.includes('captcha') || lower.includes('challenge')) {
        code = 'CHALLENGE';
        reason = 'resolver hit a challenge page';
      }

      return blitzBuildResult(original, [], title, description, started, reason, code);
    }

    return blitzBuildResult(original, medias, title, description, started);
  }

  async blitzBatch(urls: string[], concurrency = 2): Promise<BlitzResult[]> {
    const results: BlitzResult[] = [];
    const queue = [...urls];
    const workers: Promise<void>[] = [];

    const runOne = async () => {
      while (queue.length) {
        const next = queue.shift();
        if (!next) break;
        const r = await this.blitzResolve(next);
        results.push(r);
        await new Promise((r) => setTimeout(r, 350 + Math.random() * 400));
      }
    };

    for (let i = 0; i < Math.min(concurrency, urls.length); i++) {
      workers.push(runOne());
    }
    await Promise.all(workers);
    return results;
  }

  blitzHealth(): { ok: boolean; version: string; author: string; fails: number } {
    return {
      ok: true,
      version: this.blitzVersion,
      author: 'Blitz',
      fails: state.failCount,
    };
  }
}

export function createBlitzipint(opts?: { base?: string; timeout?: number }) {
  return new Blitzipint(opts);
}

export default Blitzipint;
