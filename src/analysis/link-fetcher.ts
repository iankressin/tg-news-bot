import * as cheerio from 'cheerio';
import dns from 'dns';
import { logger } from '../utils/logger.js';

const FETCH_TIMEOUT_MS = 5_000;
const MAX_CONTENT_LENGTH = 12_000; // ~3000 tokens at ~4 chars/token
const USER_AGENT = 'InkyMinajBot/1.0 (Telegram News Aggregator)';

/**
 * Check if an IP address belongs to a private/internal range (SSRF prevention).
 */
export function isPrivateIP(ip: string): boolean {
  // IPv6 loopback
  if (ip === '::1') return true;

  // IPv6 ULA (fc00::/7 covers fc00:: - fdff::)
  if (/^f[cd]/i.test(ip)) return true;

  // IPv6 link-local (fe80::/10)
  if (/^fe[89ab]/i.test(ip)) return true;

  // IPv4 checks
  const parts = ip.split('.').map(Number);
  if (parts.length !== 4) return false;

  // 127.0.0.0/8
  if (parts[0] === 127) return true;

  // 10.0.0.0/8
  if (parts[0] === 10) return true;

  // 172.16.0.0/12 (172.16.x.x through 172.31.x.x)
  if (parts[0] === 172 && parts[1] >= 16 && parts[1] <= 31) return true;

  // 192.168.0.0/16
  if (parts[0] === 192 && parts[1] === 168) return true;

  // 169.254.0.0/16 (link-local)
  if (parts[0] === 169 && parts[1] === 254) return true;

  return false;
}

/**
 * Validate a URL against SSRF by resolving its hostname and checking the IP.
 * Returns true if the URL is safe to fetch, false if it resolves to a private IP.
 */
async function validateUrlSafety(url: string): Promise<boolean> {
  try {
    const parsed = new URL(url);
    const hostname = parsed.hostname;

    // Resolve hostname to IP
    const { address } = await dns.promises.lookup(hostname);

    if (isPrivateIP(address)) {
      logger.warn('SSRF prevention: URL resolves to private IP, rejecting', {
        url,
        hostname,
        resolvedIP: address,
      });
      return false;
    }

    return true;
  } catch (error) {
    const message = error instanceof Error ? error.message : String(error);
    logger.warn('SSRF prevention: failed to validate URL', { url, error: message });
    return false;
  }
}

export interface FetchedLink {
  url: string;
  content: string;
}

/**
 * Extract URLs from Telegram message entities (MessageEntityUrl, MessageEntityTextUrl).
 * Uses entity types rather than regex to match only actual link entities.
 */
export function extractUrls(
  text: string,
  entities?: Array<{ className: string; offset: number; length: number; url?: string }>,
): string[] {
  if (!entities || entities.length === 0) return [];

  const urls: string[] = [];
  for (const entity of entities) {
    if (entity.className === 'MessageEntityUrl') {
      const url = text.slice(entity.offset, entity.offset + entity.length);
      urls.push(url);
    } else if (entity.className === 'MessageEntityTextUrl' && entity.url) {
      urls.push(entity.url);
    }
  }

  return urls;
}

/**
 * Fetch a URL and extract readable text content using cheerio.
 * Returns null if the fetch fails for any reason.
 */
async function fetchAndExtract(url: string): Promise<FetchedLink | null> {
  try {
    // SSRF prevention: validate URL resolves to a public IP before fetching
    const isSafe = await validateUrlSafety(url);
    if (!isSafe) {
      return null;
    }

    const controller = new AbortController();
    const timeout = setTimeout(() => controller.abort(), FETCH_TIMEOUT_MS);

    const response = await fetch(url, {
      signal: controller.signal,
      headers: { 'User-Agent': USER_AGENT },
      redirect: 'follow',
    });
    clearTimeout(timeout);

    if (!response.ok) {
      logger.warn('Link fetch HTTP error', { url, status: response.status });
      return null;
    }

    const html = await response.text();
    const $ = cheerio.load(html);

    // Remove non-content elements
    $('script, style, nav, footer, header, aside, iframe, noscript').remove();

    // Try to get article/main content first, fall back to body
    let content = $('article').text() || $('main').text() || $('body').text();
    // Normalize whitespace
    content = content.replace(/\s+/g, ' ').trim();

    if (!content) {
      logger.warn('Link fetch yielded no content', { url });
      return null;
    }

    // Truncate to ~3000 tokens
    const truncated = content.slice(0, MAX_CONTENT_LENGTH);

    logger.info('Link content fetched', {
      url,
      originalLength: content.length,
      truncatedLength: truncated.length,
    });

    return { url, content: truncated };
  } catch (error) {
    const message = error instanceof Error ? error.message : String(error);
    logger.warn('Link fetch failed', { url, error: message });
    return null;
  }
}

/**
 * Fetch all URLs and return their extracted content.
 * Failed fetches are silently skipped.
 */
export async function fetchLinks(urls: string[]): Promise<FetchedLink[]> {
  const results = await Promise.all(urls.map((url) => fetchAndExtract(url)));
  return results.filter((r): r is FetchedLink => r !== null);
}
