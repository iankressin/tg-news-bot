import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import dns from 'dns';
import { extractUrls, fetchLinks, isPrivateIP } from '../src/analysis/link-fetcher.js';

// Mock logger to avoid noise
vi.mock('../src/utils/logger.js', () => ({
  logger: {
    info: vi.fn(),
    warn: vi.fn(),
    error: vi.fn(),
    debug: vi.fn(),
  },
}));

// Mock dns.promises.lookup
vi.mock('dns', () => ({
  default: {
    promises: {
      lookup: vi.fn(),
    },
  },
}));

describe('extractUrls', () => {
  it('returns empty array when no entities', () => {
    expect(extractUrls('no links here', undefined)).toEqual([]);
    expect(extractUrls('no links here', [])).toEqual([]);
  });

  it('extracts plain URL from MessageEntityUrl', () => {
    const text = 'Check out https://example.com/article for details';
    const entities = [
      { className: 'MessageEntityUrl', offset: 10, length: 27 },
    ];
    expect(extractUrls(text, entities)).toEqual(['https://example.com/article']);
  });

  it('extracts URL from MessageEntityTextUrl', () => {
    const text = 'Click here for details';
    const entities = [
      { className: 'MessageEntityTextUrl', offset: 6, length: 4, url: 'https://example.com/page' },
    ];
    expect(extractUrls(text, entities)).toEqual(['https://example.com/page']);
  });

  it('extracts multiple URLs of different types', () => {
    const text = 'Visit https://a.com and click here';
    const entities = [
      { className: 'MessageEntityUrl', offset: 6, length: 13 },
      { className: 'MessageEntityTextUrl', offset: 24, length: 10, url: 'https://b.com' },
    ];
    expect(extractUrls(text, entities)).toEqual(['https://a.com', 'https://b.com']);
  });

  it('ignores non-URL entities (bold, italic, etc.)', () => {
    const text = 'Some bold text with https://example.com';
    const entities = [
      { className: 'MessageEntityBold', offset: 5, length: 4 },
      { className: 'MessageEntityUrl', offset: 20, length: 19 },
    ];
    expect(extractUrls(text, entities)).toEqual(['https://example.com']);
  });

  it('ignores MessageEntityTextUrl without url field', () => {
    const text = 'Some text';
    const entities = [
      { className: 'MessageEntityTextUrl', offset: 0, length: 4 },
    ];
    expect(extractUrls(text, entities)).toEqual([]);
  });
});

describe('isPrivateIP', () => {
  it('detects 127.x.x.x as private (loopback)', () => {
    expect(isPrivateIP('127.0.0.1')).toBe(true);
    expect(isPrivateIP('127.255.255.255')).toBe(true);
  });

  it('detects 10.x.x.x as private', () => {
    expect(isPrivateIP('10.0.0.1')).toBe(true);
    expect(isPrivateIP('10.255.255.255')).toBe(true);
  });

  it('detects 172.16-31.x.x as private', () => {
    expect(isPrivateIP('172.16.0.1')).toBe(true);
    expect(isPrivateIP('172.31.255.255')).toBe(true);
    expect(isPrivateIP('172.15.0.1')).toBe(false);
    expect(isPrivateIP('172.32.0.1')).toBe(false);
  });

  it('detects 192.168.x.x as private', () => {
    expect(isPrivateIP('192.168.0.1')).toBe(true);
    expect(isPrivateIP('192.168.255.255')).toBe(true);
  });

  it('detects 169.254.x.x as private (link-local)', () => {
    expect(isPrivateIP('169.254.0.1')).toBe(true);
    expect(isPrivateIP('169.254.255.255')).toBe(true);
  });

  it('detects ::1 as private (IPv6 loopback)', () => {
    expect(isPrivateIP('::1')).toBe(true);
  });

  it('detects fc00::/7 as private (IPv6 ULA)', () => {
    expect(isPrivateIP('fc00::1')).toBe(true);
    expect(isPrivateIP('fdff::1')).toBe(true);
  });

  it('detects fe80::/10 as private (IPv6 link-local)', () => {
    expect(isPrivateIP('fe80::1')).toBe(true);
  });

  it('returns false for public IPs', () => {
    expect(isPrivateIP('8.8.8.8')).toBe(false);
    expect(isPrivateIP('93.184.216.34')).toBe(false);
    expect(isPrivateIP('1.1.1.1')).toBe(false);
  });
});

describe('fetchLinks', () => {
  const originalFetch = globalThis.fetch;
  const mockDnsLookup = vi.mocked(dns.promises.lookup);

  beforeEach(() => {
    vi.restoreAllMocks();
    // Default: resolve to a public IP so existing tests pass
    mockDnsLookup.mockResolvedValue({ address: '93.184.216.34', family: 4 } as any);
  });

  afterEach(() => {
    globalThis.fetch = originalFetch;
  });

  it('fetches and extracts content from a page', async () => {
    const html = `
      <html>
        <head><title>Test</title></head>
        <body>
          <nav>Navigation</nav>
          <article><p>This is the main article content about blockchain.</p></article>
          <footer>Footer</footer>
        </body>
      </html>
    `;

    globalThis.fetch = vi.fn().mockResolvedValue({
      ok: true,
      text: () => Promise.resolve(html),
    });

    const results = await fetchLinks(['https://example.com/article']);

    expect(results).toHaveLength(1);
    expect(results[0].url).toBe('https://example.com/article');
    expect(results[0].content).toContain('main article content about blockchain');
    // nav and footer should be removed
    expect(results[0].content).not.toContain('Navigation');
    expect(results[0].content).not.toContain('Footer');
  });

  it('falls back to body text when no article element exists', async () => {
    const html = `
      <html>
        <body>
          <div><p>Some body content here.</p></div>
        </body>
      </html>
    `;

    globalThis.fetch = vi.fn().mockResolvedValue({
      ok: true,
      text: () => Promise.resolve(html),
    });

    const results = await fetchLinks(['https://example.com']);

    expect(results).toHaveLength(1);
    expect(results[0].content).toContain('Some body content here');
  });

  it('returns empty array on HTTP error', async () => {
    globalThis.fetch = vi.fn().mockResolvedValue({
      ok: false,
      status: 403,
    });

    const results = await fetchLinks(['https://example.com/forbidden']);
    expect(results).toEqual([]);
  });

  it('returns empty array on network error', async () => {
    globalThis.fetch = vi.fn().mockRejectedValue(new Error('ECONNREFUSED'));

    const results = await fetchLinks(['https://example.com/down']);
    expect(results).toEqual([]);
  });

  it('returns empty array on abort (timeout)', async () => {
    globalThis.fetch = vi.fn().mockRejectedValue(new DOMException('The operation was aborted', 'AbortError'));

    const results = await fetchLinks(['https://example.com/slow']);
    expect(results).toEqual([]);
  });

  it('truncates content to ~3000 tokens (12000 chars)', async () => {
    const longContent = 'A'.repeat(20_000);
    const html = `<html><body><p>${longContent}</p></body></html>`;

    globalThis.fetch = vi.fn().mockResolvedValue({
      ok: true,
      text: () => Promise.resolve(html),
    });

    const results = await fetchLinks(['https://example.com/long']);

    expect(results).toHaveLength(1);
    expect(results[0].content.length).toBeLessThanOrEqual(12_000);
  });

  it('skips failed fetches but returns successful ones', async () => {
    const goodHtml = '<html><body><p>Good content</p></body></html>';

    globalThis.fetch = vi.fn()
      .mockResolvedValueOnce({ ok: true, text: () => Promise.resolve(goodHtml) })
      .mockRejectedValueOnce(new Error('timeout'))
      .mockResolvedValueOnce({ ok: true, text: () => Promise.resolve(goodHtml) });

    const results = await fetchLinks([
      'https://a.com',
      'https://b.com',
      'https://c.com',
    ]);

    expect(results).toHaveLength(2);
    expect(results[0].url).toBe('https://a.com');
    expect(results[1].url).toBe('https://c.com');
  });

  it('returns empty when page has no text content', async () => {
    const html = '<html><body><script>console.log("only script")</script></body></html>';

    globalThis.fetch = vi.fn().mockResolvedValue({
      ok: true,
      text: () => Promise.resolve(html),
    });

    const results = await fetchLinks(['https://example.com/empty']);
    expect(results).toEqual([]);
  });

  it('sets User-Agent header on fetch requests', async () => {
    const html = '<html><body><p>Content</p></body></html>';
    const mockFetch = vi.fn().mockResolvedValue({
      ok: true,
      text: () => Promise.resolve(html),
    });
    globalThis.fetch = mockFetch;

    await fetchLinks(['https://example.com']);

    expect(mockFetch).toHaveBeenCalledWith(
      'https://example.com',
      expect.objectContaining({
        headers: expect.objectContaining({
          'User-Agent': expect.stringContaining('InkyMinajBot'),
        }),
      }),
    );
  });

  it('rejects URLs that resolve to 127.x.x.x (loopback)', async () => {
    mockDnsLookup.mockResolvedValue({ address: '127.0.0.1', family: 4 } as any);

    const results = await fetchLinks(['https://evil.com/ssrf']);
    expect(results).toEqual([]);
  });

  it('rejects URLs that resolve to 10.x.x.x (private)', async () => {
    mockDnsLookup.mockResolvedValue({ address: '10.0.0.5', family: 4 } as any);

    const results = await fetchLinks(['https://evil.com/internal']);
    expect(results).toEqual([]);
  });

  it('rejects URLs that resolve to 172.16-31.x.x (private)', async () => {
    mockDnsLookup.mockResolvedValue({ address: '172.16.0.1', family: 4 } as any);

    const results = await fetchLinks(['https://evil.com/internal']);
    expect(results).toEqual([]);
  });

  it('rejects URLs that resolve to 192.168.x.x (private)', async () => {
    mockDnsLookup.mockResolvedValue({ address: '192.168.1.1', family: 4 } as any);

    const results = await fetchLinks(['https://evil.com/home']);
    expect(results).toEqual([]);
  });

  it('rejects URLs that resolve to ::1 (IPv6 loopback)', async () => {
    mockDnsLookup.mockResolvedValue({ address: '::1', family: 6 } as any);

    const results = await fetchLinks(['https://evil.com/ipv6']);
    expect(results).toEqual([]);
  });

  it('allows URLs that resolve to public IPs', async () => {
    mockDnsLookup.mockResolvedValue({ address: '93.184.216.34', family: 4 } as any);

    const html = '<html><body><p>Public content</p></body></html>';
    globalThis.fetch = vi.fn().mockResolvedValue({
      ok: true,
      text: () => Promise.resolve(html),
    });

    const results = await fetchLinks(['https://example.com']);
    expect(results).toHaveLength(1);
    expect(results[0].content).toContain('Public content');
  });

  it('rejects URL when DNS resolution fails', async () => {
    mockDnsLookup.mockRejectedValue(new Error('ENOTFOUND'));

    const results = await fetchLinks(['https://doesnotexist.invalid']);
    expect(results).toEqual([]);
  });
});
