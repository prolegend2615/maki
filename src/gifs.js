import { config } from './config.js';

/**
 * Searches Tenor for `query` and returns one random candidate GIF URL.
 * Random over the top 8 so the same phrase never posts the same clip twice.
 * Returns null when GIFs are disabled or the search fails — the caller stays silent.
 */
export async function searchGif(query, signal) {
  if (!config.tenorKey) return null;
  const url = new URL('https://tenor.googleapis.com/v2/search');
  for (const [k, v] of Object.entries({
    q: query,
    key: config.tenorKey,
    client_key: 'mika-discord-bot',
    limit: '8',
    media_filter: 'mediumgif,tinygif', // mediumgif keeps uploads reasonable; tinygif as fallback
    contentfilter: config.tenorContentFilter,
  })) {
    url.searchParams.set(k, String(v));
  }
  const timeout = AbortSignal.timeout(8000);
  const combined = signal ? AbortSignal.any([signal, timeout]) : timeout;
  try {
    const res = await fetch(url, { signal: combined });
    if (!res.ok) throw new Error(`HTTP ${res.status}`);
    const data = await res.json();
    const urls = (data?.results ?? [])
      .map((r) => r.media_formats?.mediumgif?.url ?? r.media_formats?.tinygif?.url)
      .filter(Boolean);
    return urls.length ? urls[Math.floor(Math.random() * urls.length)] : null;
  } catch (error) {
    if (signal?.aborted) return null;
    console.error('[gif]', error.message);
    return null;
  }
}
