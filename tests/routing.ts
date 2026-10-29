import assert from 'node:assert/strict';
import {canonicalRedirect} from '../server/site-origin';
import {parseScreen} from '../lib/navigation';
assert.deepEqual(parseScreen('#post/post-00000000'),{screen:'post',id:'post-00000000'});
assert.deepEqual(parseScreen('#profile/member-00000000'),{screen:'profile',id:'member-00000000'});
assert.deepEqual(parseScreen('#me'),{screen:'me',id:''});
assert.equal(parseScreen('#post/../../api').screen,'feed');

const oldOrigin = 'https://old.workout.test', canonical = 'https://workout.test';
const request = (path: string, method = 'GET') => new Request(oldOrigin + path, {method});
const redirect = (path: string, method = 'GET') => canonicalRedirect(request(path, method), canonical);

for (const path of ['/', '/privacy?from=footer', '/auth/google', '/api/media/photo?room=club']) {
  const response = redirect(path)!;
  assert.equal(response.status, 307);
  assert.equal(response.headers.get('location'), canonical + path);
  assert.equal(response.headers.get('cache-control'), 'no-store');
}
assert.equal(redirect('/', 'HEAD')?.status, 307);
for (const path of ['/api/health', '/api/operations', '/api/bootstrap', '/mcp', '/auth/callback?code=private']) {
  assert.equal(redirect(path), null);
}
for (const method of ['POST', 'PUT', 'PATCH', 'DELETE']) {
  assert.equal(redirect('/api/upload', method), null);
}
assert.equal(canonicalRedirect(new Request(canonical + '/'), canonical), null);
assert.equal(canonicalRedirect(request('/')), null);
assert.equal(new URL(redirect('//untrusted.test/path')!.headers.get('location')!).origin, canonical);
console.log('PASS canonical redirects preserve old links, private media and login entry points');
console.log('PASS maintenance, MCP, health, OAuth callbacks and writes are not forwarded');
console.log('PASS canonical URLs and local previews do not loop; paths cannot change the target host');
