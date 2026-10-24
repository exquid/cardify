/**
 * Browser-origin allow-list. Entries are forgiving about how they were typed
 * in a hosting dashboard: case and a trailing slash or path do not matter,
 * and `*` works as a wildcard inside the host (`https://cardify-*.vercel.app`).
 * An empty list, or a list containing a lone `*`, allows every origin.
 */
export function createOriginMatcher(entries: readonly string[]): (origin: string | undefined) => boolean {
  const patterns = entries.map(normalizeOrigin).filter((e): e is string => e !== null);
  if (patterns.length === 0 || patterns.includes('*')) return () => true;
  const exact = new Set(patterns.filter((p) => !p.includes('*')));
  const wildcards = patterns
    .filter((p) => p.includes('*'))
    .map((p) => new RegExp(`^${p.split('*').map(escapeRegExp).join('[a-z0-9-]*')}$`));
  return (origin) => {
    const normalized = normalizeOrigin(origin ?? '');
    if (!normalized) return false;
    return exact.has(normalized) || wildcards.some((re) => re.test(normalized));
  };
}

export function normalizeOrigin(value: string): string | null {
  const trimmed = value.trim().toLowerCase();
  if (!trimmed) return null;
  if (trimmed === '*') return '*';
  // Keep scheme://host[:port], drop any path, query or trailing slash.
  const match = /^([a-z][a-z0-9+.-]*:\/\/[^/?#]+)/.exec(trimmed);
  return match ? (match[1] as string) : trimmed.replace(/\/+$/, '');
}

function escapeRegExp(text: string): string {
  return text.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
}
