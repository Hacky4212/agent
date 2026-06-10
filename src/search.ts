import { getConfig } from './config.js';

export interface SearchResult {
  title: string;
  url: string;
  snippet: string;
}

export interface SearchOptions {
  maxResults?: number;
  signal?: AbortSignal;
}

export interface SearchProvider {
  name: string;
  search(query: string, opts: SearchOptions): Promise<SearchResult[]>;
}

// Thrown when the provider can't run (e.g. missing API key). The message is
// surfaced to the model so it can tell the user how to fix it.
export class SearchConfigError extends Error {}

// ── Tavily (primary) ──────────────────────────────────────────────────────
// https://docs.tavily.com — POST /search with { api_key, query, max_results }
const tavilyProvider: SearchProvider = {
  name: 'tavily',
  async search(query, opts) {
    const cfg = getConfig();
    if (!cfg.searchApiKey) {
      throw new SearchConfigError(
        'web_search needs a Tavily API key. Set it with: dsk config set search-api-key <key>',
      );
    }
    const res = await fetch('https://api.tavily.com/search', {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({
        api_key: cfg.searchApiKey,
        query,
        max_results: opts.maxResults ?? 5,
        search_depth: 'basic',
      }),
      signal: opts.signal,
    });
    if (!res.ok) {
      throw new Error(`Tavily API error ${res.status}: ${await res.text()}`);
    }
    const data = (await res.json()) as {
      results?: Array<{ title?: string; url?: string; content?: string }>;
    };
    return (data.results ?? []).map((r) => ({
      title: r.title ?? '',
      url: r.url ?? '',
      snippet: r.content ?? '',
    }));
  },
};

// ── Brave Search ────────────────────────────────────────────────────────────
// https://api.search.brave.com — GET /res/v1/web/search with X-Subscription-Token
const braveProvider: SearchProvider = {
  name: 'brave',
  async search(query, opts) {
    const cfg = getConfig();
    if (!cfg.searchApiKey) {
      throw new SearchConfigError(
        'web_search needs a Brave Search API key. Set it with: dsk config set search-api-key <key>',
      );
    }
    const url = new URL('https://api.search.brave.com/res/v1/web/search');
    url.searchParams.set('q', query);
    url.searchParams.set('count', String(opts.maxResults ?? 5));
    const res = await fetch(url, {
      headers: {
        accept: 'application/json',
        'X-Subscription-Token': cfg.searchApiKey,
      },
      signal: opts.signal,
    });
    if (!res.ok) {
      throw new Error(`Brave API error ${res.status}: ${await res.text()}`);
    }
    const data = (await res.json()) as {
      web?: { results?: Array<{ title?: string; url?: string; description?: string }> };
    };
    return (data.web?.results ?? []).map((r) => ({
      title: r.title ?? '',
      url: r.url ?? '',
      snippet: r.description ?? '',
    }));
  },
};

const PROVIDERS: Record<string, SearchProvider> = {
  tavily: tavilyProvider,
  brave: braveProvider,
};

// Pick the provider named in config (defaults to tavily).
export function getSearchProvider(): SearchProvider {
  const cfg = getConfig();
  return PROVIDERS[cfg.searchProvider] ?? tavilyProvider;
}
