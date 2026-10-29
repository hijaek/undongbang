// Keep old shared links usable after moving to a custom domain. Service calls
// stay on their original endpoint so scheduled maintenance and MCP keep working.
export function canonicalRedirect(request: Request, appOrigin?: string): Response | null {
  if (!appOrigin || !['GET', 'HEAD'].includes(request.method)) return null;
  const current = new URL(request.url), target = new URL(appOrigin);
  if (current.origin === target.origin) return null;
  const path = current.pathname;
  if (path === '/mcp' || path === '/auth/callback' ||
      (path.startsWith('/api/') && !path.startsWith('/api/media/'))) return null;
  // Assign the path, rather than resolving it, so //example.com stays a path.
  target.pathname = path;
  target.search = current.search;
  return new Response(null, {status: 307, headers: {
    location: target.toString(), 'cache-control': 'no-store', 'referrer-policy': 'no-referrer',
  }});
}
