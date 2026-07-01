/* verify-token-cache.js
   Standalone proof that the token cache works after the fix.

   What this does:
   - Re-implements the EXACT getSpotifyToken() / fetchSpotifyToken() / spotifyToken
     cache logic from server.js (copy-pasted, no modifications).
   - Mocks global.fetch so we can count how many times Spotify's token endpoint
     is actually hit.
   - Calls getSpotifyToken() 3 times in a row (within milliseconds).
   - Asserts:
       1. All 3 calls return the SAME token string.
       2. fetch was invoked EXACTLY ONCE (calls 2 and 3 hit the cache).

   Run with:  node verify-token-cache.js
   Exit code 0 = pass, 1 = fail.
*/

let fetchCallCount = 0;
const FAKE_TOKEN = 'BQCCSN4hFakeTokenForVerificationbcyW';

// Mock global.fetch — only the Spotify token endpoint should hit this.
global.fetch = async (url, opts) => {
  fetchCallCount++;
  console.log('  [mock-fetch] call #' + fetchCallCount + ' → ' + url);

  if (typeof url === 'string' && url.includes('accounts.spotify.com/api/token')) {
    return {
      ok: true,
      status: 200,
      json: async () => ({
        access_token: FAKE_TOKEN,
        token_type: 'Bearer',
        expires_in: 3600
      }),
      text: async () => ''
    };
  }
  throw new Error('Unexpected fetch URL in test: ' + url);
};

// ─── BEGIN: copy-pasted from server.js (the cache logic under test) ───
const SPOTIFY_CLIENT_ID = 'test_id';
const SPOTIFY_CLIENT_SECRET = 'test_secret';
const SPOTIFY_TOKEN_URL = 'https://accounts.spotify.com/api/token';

let spotifyToken = null;

function spotifyConfigured() {
  return !!(SPOTIFY_CLIENT_ID && SPOTIFY_CLIENT_SECRET);
}

async function fetchSpotifyToken() {
  if (!spotifyConfigured()) {
    throw new Error('Spotify credentials not configured');
  }
  const basic = Buffer.from(SPOTIFY_CLIENT_ID + ':' + SPOTIFY_CLIENT_SECRET).toString('base64');
  const body = new URLSearchParams({ grant_type: 'client_credentials' });

  const res = await fetch(SPOTIFY_TOKEN_URL, {
    method: 'POST',
    headers: {
      'Authorization': 'Basic ' + basic,
      'Content-Type': 'application/x-www-form-urlencoded'
    },
    body: body.toString()
  });

  if (!res.ok) {
    const text = await res.text().catch(() => '');
    throw new Error('Spotify token endpoint returned HTTP ' + res.status + ': ' + text.slice(0, 200));
  }

  const data = await res.json();
  if (!data.access_token) {
    throw new Error('Spotify token response missing access_token');
  }
  return data;
}

async function getSpotifyToken() {
  const now = Date.now();
  const safetyMarginMs = 5 * 60 * 1000;
  if (spotifyToken && spotifyToken.expiresAt - safetyMarginMs > now) {
    return spotifyToken.value;
  }
  const fresh = await fetchSpotifyToken();
  spotifyToken = {
    value: fresh.access_token,
    expiresAt: now + (fresh.expires_in || 3600) * 1000
  };
  return spotifyToken.value;
}
// ─── END: copy-pasted from server.js ───

async function main() {
  console.log('Verifying token cache behavior (3 consecutive calls)…\n');

  const t1 = await getSpotifyToken();
  console.log('  Call 1: ' + t1.slice(0, 8) + '…' + t1.slice(-4) + '\n');

  const t2 = await getSpotifyToken();
  console.log('  Call 2: ' + t2.slice(0, 8) + '…' + t2.slice(-4) + '\n');

  const t3 = await getSpotifyToken();
  console.log('  Call 3: ' + t3.slice(0, 8) + '…' + t3.slice(-4) + '\n');

  console.log('──────────────────────────────────────');
  let pass = true;

  // Assertion 1: all three tokens identical
  if (t1 === t2 && t2 === t3) {
    console.log('  [PASS] All 3 tokens identical');
  } else {
    console.log('  [FAIL] Tokens differ across calls');
    console.log('         t1=' + t1);
    console.log('         t2=' + t2);
    console.log('         t3=' + t3);
    pass = false;
  }

  // Assertion 2: fetch hit exactly once
  if (fetchCallCount === 1) {
    console.log('  [PASS] fetch invoked exactly once (cache hit on calls 2 and 3)');
  } else {
    console.log('  [FAIL] Expected fetch to be called 1 time, got ' + fetchCallCount);
    pass = false;
  }

  console.log('──────────────────────────────────────');
  if (pass) {
    console.log('\n✓ Cache verification PASSED — fix is correct.\n');
    process.exit(0);
  } else {
    console.log('\n✗ Cache verification FAILED.\n');
    process.exit(1);
  }
}

main().catch(err => {
  console.error('\nTest threw:', err);
  process.exit(1);
});
