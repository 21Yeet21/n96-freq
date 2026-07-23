/* N96_freq — server.js
   Version: 19 — Phase 2 resource management: yt-dlp queue fix (max queue, timeout,
                 req.aborted check, proper error handling), rate limiting (YouTube 20/min,
                 Spotify 60/min, Spotify batch 10/min), async initial scan with loading
                 state, request logging.
   If you see "[N96] server v19 ready" in console, you have the latest version.

   Env vars (via .env file — copy .env.example to .env):
     PORT                  — Server port (default: 3001)
     MUSIC_DIR             — Path to your music folder
     YT_TIMEOUT            — yt-dlp process timeout in ms (default: 30000)
     SPOTIFY_CLIENT_ID     — Spotify app client ID
     SPOTIFY_CLIENT_SECRET — Spotify app client secret
   Spotify vars must be set for /api/spotify/* routes to function.
   Redirect URI must be set in Spotify Dashboard:
     http://127.0.0.1:3001/api/spotify/callback
*/
try { require('dotenv').config(); } catch(e) { /* .env file optional */ }
const express = require('express');
const path = require('path');
const fs = require('fs');
const crypto = require('crypto');
const { execFile } = require('child_process');
const yts = require('yt-search');
const rateLimit = require('express-rate-limit');

const app = express();
const PORT = process.env.PORT || 3001;
const HOST = process.env.HOST || '127.0.0.1';
const MUSIC_DIR = process.env.MUSIC_DIR || 'C:/Users/YourName/Music';

/* ── Resolve MUSIC_DIR to its real path once at startup ─────────
   This resolves symlinks, junction points, and volume mount points
   so that every /audio/ request can do a safe prefix comparison. */
let REAL_MUSIC_DIR = MUSIC_DIR;
try {
  REAL_MUSIC_DIR = fs.realpathSync(MUSIC_DIR);
} catch (e) {
  // Will be caught by startup validation below — dir may not exist yet
  console.warn('\x1b[33m[security] Could not resolve MUSIC_DIR realpath: ' + e.message + '\x1b[0m');
}
// Ensure trailing separator for strict prefix matching
// (Recomputed when REAL_MUSIC_DIR is re-resolved after startup validation)
function getMusicPrefix() {
  return REAL_MUSIC_DIR.endsWith(path.sep) ? REAL_MUSIC_DIR : REAL_MUSIC_DIR + path.sep;
}

/* ── Spotify config ─────────────────────────────────────────── */
const SPOTIFY_CLIENT_ID = process.env.SPOTIFY_CLIENT_ID || '';
const SPOTIFY_CLIENT_SECRET = process.env.SPOTIFY_CLIENT_SECRET || '';
const SPOTIFY_TOKEN_URL = 'https://accounts.spotify.com/api/token';
const SPOTIFY_API_BASE = 'https://api.spotify.com/v1';
const SPOTIFY_REDIRECT_URI = process.env.SPOTIFY_REDIRECT_URI || `http://127.0.0.1:${PORT}/api/spotify/callback`;

/* In-memory token stores.
   spotifyToken  — Client Credentials (fallback, no user context)
   userToken     — User OAuth via PKCE (full playlist access)
   pendingAuth   — Temporary PKCE state during auth flow (cleared after callback) */
let spotifyToken = null;       // { value: string, expiresAt: number(ms epoch) }
let userToken = null;          // { value: string, refreshToken: string, expiresAt: number }
let pendingAuth = null;        // { state: string, codeVerifier: string, createdAt: number }

function spotifyConfigured() {
  return !!(SPOTIFY_CLIENT_ID && SPOTIFY_CLIENT_SECRET);
}

/* ── PKCE helpers (v14) ─────────────────────────────────────── */
function generateCodeVerifier() {
  // 43-128 chars from [A-Za-z0-9-._~] — 32 random bytes → base64url = 43 chars
  return crypto.randomBytes(32).toString('base64url');
}

function generateCodeChallenge(verifier) {
  return crypto.createHash('sha256').update(verifier).digest('base64url');
}

/* ── Token acquisition ──────────────────────────────────────── */

/* Fetch a Client Credentials token (no user context).
   Returns { access_token, expires_in } on success. */
async function fetchSpotifyToken() {
  if (!spotifyConfigured()) {
    throw new Error('Spotify credentials not configured (SPOTIFY_CLIENT_ID / SPOTIFY_CLIENT_SECRET)');
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
    throw new Error('Spotify token response missing access_token: ' + JSON.stringify(data).slice(0, 200));
  }
  return data;
}

/* Refresh a user OAuth token using the refresh_token.
   Returns { access_token, refresh_token?, expires_in } on success.
   Spotify may rotate the refresh_token — we always use the newest one. */
async function refreshUserToken(refreshToken) {
  const res = await fetch(SPOTIFY_TOKEN_URL, {
    method: 'POST',
    headers: { 'Content-Type': 'application/x-www-form-urlencoded' },
    body: new URLSearchParams({
      grant_type: 'refresh_token',
      refresh_token: refreshToken,
      client_id: SPOTIFY_CLIENT_ID,
      client_secret: SPOTIFY_CLIENT_SECRET
    }).toString()
  });

  if (!res.ok) {
    const text = await res.text().catch(() => '');
    throw new Error('Refresh failed: HTTP ' + res.status + ' — ' + text.slice(0, 200));
  }

  return await res.json();
}

/* Return a valid access token, preferring user OAuth over Client Credentials.
   Priority:
     1. User token (not expired) → return it
     2. User token (expired) → refresh via refresh_token
     3. Client Credentials (not expired) → return it
     4. Client Credentials (expired) → fetch new one
   If user token refresh fails, clears userToken and falls back to CC. */
async function getSpotifyToken() {
  const now = Date.now();
  const safetyMarginMs = 5 * 60 * 1000;

   // 1. User token — still valid
  if (userToken && userToken.expiresAt - safetyMarginMs > now) {
    console.log('\x1b[35m[spotify] getSpotifyToken → user token (valid, expires in ' + Math.max(0, Math.floor((userToken.expiresAt - now) / 1000)) + 's)\x1b[0m');
    return userToken.value;
  }

  // 2. User token — expired, try refresh
  if (userToken && userToken.refreshToken) {
    try {
      const refreshed = await refreshUserToken(userToken.refreshToken);
      userToken = {
        value: refreshed.access_token,
        refreshToken: refreshed.refresh_token || userToken.refreshToken,
        expiresAt: now + (refreshed.expires_in || 3600) * 1000
      };
      console.log('\x1b[35m[spotify] getSpotifyToken → user token (refreshed, expires in ' + (refreshed.expires_in || 3600) + 's)\x1b[0m');
      return userToken.value;
    } catch (e) {
      console.warn('\x1b[33m[spotify] user token refresh failed, clearing — ' + e.message + '\x1b[0m');
      userToken = null;
      // Fall through to Client Credentials
    }
  }

  // 3. Client Credentials — still valid
  if (spotifyToken && spotifyToken.expiresAt - safetyMarginMs > now) {
    console.log('\x1b[33m[spotify] getSpotifyToken → CLIENT CREDENTIALS (cached, no user token)\x1b[0m');
    return spotifyToken.value;
  }

  // 4. Client Credentials — fetch new
  const fresh = await fetchSpotifyToken();
  spotifyToken = {
    value: fresh.access_token,
    expiresAt: now + (fresh.expires_in || 3600) * 1000
  };
  console.log('\x1b[33m[spotify] getSpotifyToken → CLIENT CREDENTIALS (fetched new, no user token)\x1b[0m');
  return spotifyToken.value;
}

/* Generic Spotify Web API request helper with token injection + 401 retry.
   - path: starts with '/' (e.g. '/playlists/abc/tracks')
   - query: object of query string params (or null)
   - Automatically retries ONCE on 401 by forcing a token refresh. */
async function spotifyRequest(path, query) {
  if (!spotifyConfigured()) {
    throw new Error('Spotify credentials not configured');
  }

  let url = SPOTIFY_API_BASE + path;
  if (query && Object.keys(query).length > 0) {
    const qs = new URLSearchParams();
    for (const k in query) {
      if (query[k] !== undefined && query[k] !== null && query[k] !== '') qs.set(k, String(query[k]));
    }
    url += '?' + qs.toString();
  }

  for (let attempt = 0; attempt < 2; attempt++) {
    const token = await getSpotifyToken();
    console.log('[spotify] DEBUG: GET ' + url);
    const res = await fetch(url, {
      headers: { 'Authorization': 'Bearer ' + token }
    });
    console.log('[spotify] DEBUG: response status=' + res.status);

    // 401 → token may have been revoked early; force refresh and retry once.
    if (res.status === 401 && attempt === 0) {
      console.warn('\x1b[33m[spotify] got 401 — forcing token refresh and retrying\x1b[0m');
      // Clear whichever token was used so getSpotifyToken() fetches fresh
      if (userToken && userToken.value === token) {
        userToken = null;
      } else {
        spotifyToken = null;
      }
      continue;
    }

    if (!res.ok) {
      const text = await res.text().catch(() => '');
      let parsed;
      try { parsed = JSON.parse(text); } catch (_) { parsed = null; }
      console.error('[spotify] DEBUG: ' + res.status + ' on ' + path + ' | body=' + text.slice(0, 500));
      const msg = parsed && parsed.error && parsed.error.message
        ? parsed.error.message
        : ('HTTP ' + res.status + ': ' + text.slice(0, 200));
      const err = new Error(msg);
      err.status = res.status;
      err.spotifyError = parsed;
      throw err;
    }

    // Some endpoints (rare) return 204 No Content
    if (res.status === 204) return null;
    return await res.json();
  }
  throw new Error('Spotify request failed after retry: ' + path);
}

/* ── yt-dlp setup ───────────────────────────────────────────── */
const YT_DLP = fs.existsSync(path.join(__dirname, 'yt-dlp.exe'))
  ? path.join(__dirname, 'yt-dlp.exe')
  : 'yt-dlp';

console.log(`\x1b[90m[yt-dlp] Using: ${YT_DLP}\x1b[0m`);

/* ── yt-dlp concurrency control (v19 — hardened) ──────────────── */
const MAX_CONCURRENT_YTDLP = 3;
const MAX_QUEUE_SIZE = 20;
const YT_TIMEOUT_MS = parseInt(process.env.YT_TIMEOUT, 10) || 30000;
let activeYtDlpProcesses = 0;
const ytDlpQueue = [];

function executeYtDlp(args, timeoutMs, req) {
  timeoutMs = timeoutMs || YT_TIMEOUT_MS;
  return new Promise((resolve, reject) => {
    // Reject if queue is full
    if (ytDlpQueue.length >= MAX_QUEUE_SIZE) {
      return reject(new Error('yt-dlp queue full — too many concurrent requests. Try again later.'));
    }

    function run() {
      // v19: Check if client disconnected while queued
      if (req && req.aborted) {
        console.log('\x1b[33m[yt-dlp] skipping queued task — client already disconnected\x1b[0m');
        // Still process next in queue since we consumed a slot
        processNextInQueue();
        return reject(new Error('Client disconnected'));
      }

      activeYtDlpProcesses++;
      try {
        const child = execFile(YT_DLP, args, { timeout: timeoutMs, maxBuffer: 10 * 1024 * 1024 }, (err, stdout, stderr) => {
          activeYtDlpProcesses--;
          processNextInQueue();
          if (err) {
            reject(new Error((stderr || err.message || '').toString().trim().split('\n').pop() || 'yt-dlp failed'));
          } else {
            resolve(stdout.toString());
          }
        });
        // v19: Kill the child process if client disconnects mid-execution
        if (req) {
          req.on('close', () => {
            if (child && !child.killed) {
              child.kill('SIGTERM');
              console.log('\x1b[33m[yt-dlp] killed running process — client disconnected\x1b[0m');
            }
          });
        }
      } catch (syncErr) {
        // v19: Handle synchronous throw from execFile (e.g. ENOENT)
        activeYtDlpProcesses--;
        processNextInQueue();
        reject(syncErr);
      }
    }

    function processNextInQueue() {
      if (ytDlpQueue.length > 0) {
        const next = ytDlpQueue.shift();
        next.run();
      }
    }

    if (activeYtDlpProcesses >= MAX_CONCURRENT_YTDLP) {
      ytDlpQueue.push({ run, resolve, reject });
    } else {
      run();
    }
  });
}

/* ── Rate limiting (v19) ─────────────────────────────────────── */
const youtubeLimiter = rateLimit({
  windowMs: 60 * 1000,
  max: 100,  // v19: Increased from 20 to 100 — Spotify playlist prefetching triggers ~1 search per track
  message: { error: 'Too many YouTube requests — rate limit is 100 per minute.' },
  standardHeaders: true,
  legacyHeaders: false,
  handler: (req, res) => {
    console.log(`\x1b[33m[rate-limit] YouTube rate limit hit: ${req.ip} ${req.method} ${req.path}\x1b[0m`);
    res.status(429).json({ error: 'Too many YouTube requests — rate limit is 100 per minute.' });
  }
});

const spotifyLimiter = rateLimit({
  windowMs: 60 * 1000,
  max: 60,
  message: { error: 'Too many Spotify requests — rate limit is 60 per minute.' },
  standardHeaders: true,
  legacyHeaders: false,
  handler: (req, res) => {
    console.log(`\x1b[33m[rate-limit] Spotify rate limit hit: ${req.ip} ${req.method} ${req.path}\x1b[0m`);
    res.status(429).json({ error: 'Too many Spotify requests — rate limit is 60 per minute.' });
  }
});

const spotifyBatchLimiter = rateLimit({
  windowMs: 60 * 1000,
  max: 10,
  message: { error: 'Too many batch playlist requests — rate limit is 10 per minute.' },
  standardHeaders: true,
  legacyHeaders: false,
  handler: (req, res) => {
    console.log(`\x1b[33m[rate-limit] Spotify batch rate limit hit: ${req.ip} ${req.method} ${req.path}\x1b[0m`);
    res.status(429).json({ error: 'Too many batch playlist requests — rate limit is 10 per minute.' });
  }
});


/* ── Request logging (v19) ────────────────────────────────────── */
app.use((req, res, next) => {
  const start = Date.now();
  res.on('finish', () => {
    const ms = Date.now() - start;
    const ts = new Date().toLocaleTimeString('en-GB', { hour12: false });
    const method = req.method.padEnd(7);
    const statusColor = res.statusCode < 400 ? '\x1b[32m' : res.statusCode < 500 ? '\x1b[33m' : '\x1b[31m';
    // Skip logging for favicon and internal health checks to reduce noise
    if (req.path !== '/favicon.ico') {
      console.log(`\x1b[90m[${ts}]\x1b[0m ${method} ${req.path} ${statusColor}${res.statusCode}\x1b[0m \x1b[90m${ms}ms\x1b[0m`);
    }
  });
  next();
});

// CORS & Security headers — restricted to localhost for local-only use
app.use((req, res, next) => {
  // Only set Access-Control-Allow-Origin for requests from localhost / 127.0.0.1
  // Same-origin requests (no Origin header) don't need CORS headers at all
  const origin = req.headers.origin || '';
  if (origin && (origin.includes('127.0.0.1') || origin.includes('localhost'))) {
    res.header('Access-Control-Allow-Origin', origin);
  }
  res.header('Access-Control-Allow-Methods', 'GET, OPTIONS');
  res.header('Access-Control-Allow-Headers', 'Content-Type');
  // Security headers
  res.header('X-Content-Type-Options', 'nosniff');
  res.header('X-Frame-Options', 'SAMEORIGIN');
  if (req.method === 'OPTIONS') return res.status(204).end();
  next();
});

/* ── Static files — lockdown: serve ONLY whitelisted paths ──────
   v18: We no longer serve the entire __dirname as static.
   This prevents leaking server.js, .env, package.json, etc.
   Only index.html, assets/, manifest.json, sw.js, and icons/ are served. */
function serveWhitelistedStatic(req, res, next) {
  const reqPath = req.path;

  // Whitelist: specific files and directories only
  const allowed = (
    reqPath === '/' ||
    reqPath === '/index.html' ||
    reqPath.startsWith('/assets/') ||
    reqPath === '/manifest.json' ||
    reqPath === '/sw.js' ||
    reqPath.startsWith('/icons/') ||
    reqPath === '/favicon.ico'
  );

  if (!allowed) return next();

  // Map request path to filesystem
  let filePath = path.join(__dirname, reqPath);
  if (reqPath === '/') filePath = path.join(__dirname, 'index.html');

  // Resolve and verify it stays within __dirname
  try {
    const resolved = fs.realpathSync(filePath);
    const projectRoot = fs.realpathSync(__dirname);
    if (resolved !== projectRoot && !resolved.startsWith(projectRoot + path.sep)) {
      return res.status(403).end();
    }
  } catch {
    return res.status(404).end();
  }

  if (!fs.existsSync(filePath)) return next();

  // Set caching headers
  if (reqPath.endsWith('.js') || reqPath.endsWith('.css')) {
    res.setHeader('Cache-Control', 'public, max-age=300');
  } else if (reqPath === '/sw.js') {
    res.setHeader('Cache-Control', 'no-cache');
  } else {
    res.setHeader('Cache-Control', 'public, max-age=86400');
  }

  res.sendFile(filePath, err => { if (err && !res.headersSent) res.status(404).end(); });
}
app.use(serveWhitelistedStatic);

// Parse JSON request bodies (v75: needed for POST /api/config)
app.use(express.json({ limit: '10kb' }));

/* ═══════════════════════════════════════════════════════════════
   v75: Configuration API — Setup Wizard support
   GET /api/config  — read current config (no secrets exposed)
   POST /api/config — validate and save config to .env file
   ═══════════════════════════════════════════════════════════════ */

/* ── Auto-detect common music folders ── */
function detectMusicDir() {
  const home = require('os').homedir();
  const candidates = [
    path.join(home, 'Music'),
    path.join(home, 'music'),
    path.join(home, 'Musik'),
    path.join(home, 'Documents', 'Music'),
    // Windows paths
    process.env.USERPROFILE ? path.join(process.env.USERPROFILE, 'Music') : null,
    // Common Linux paths
    '/mnt/c/Users/' + (require('os').userInfo().username || 'Default') + '/Music',
  ].filter(Boolean);

  for (const dir of candidates) {
    try {
      if (fs.existsSync(dir) && fs.statSync(dir).isDirectory()) {
        return dir;
      }
    } catch (_) { /* skip inaccessible */ }
  }
  return '';
}

/* ── Auto-detect yt-dlp path ── */
function detectYtDlp() {
  // Already resolved at startup
  return YT_DLP;
}

/* ── Test yt-dlp is functional ── */
function testYtDlp(ytdlpPath) {
  return new Promise((resolve) => {
    execFile(ytdlpPath || 'yt-dlp', ['--version'], { timeout: 10000 }, (err, stdout) => {
      if (err) return resolve({ found: false, version: null, path: ytdlpPath || 'yt-dlp' });
      resolve({ found: true, version: stdout.trim(), path: ytdlpPath || 'yt-dlp' });
    });
  });
}

/* ── Test Spotify credentials ── */
async function testSpotifyCredentials(clientId, clientSecret) {
  if (!clientId || !clientSecret) return { valid: false, error: 'Missing credentials' };
  try {
    const basic = Buffer.from(clientId + ':' + clientSecret).toString('base64');
    const https = require('https');
    return new Promise((resolve) => {
      const postData = 'grant_type=client_credentials';
      const req = https.request('https://accounts.spotify.com/api/token', {
        method: 'POST',
        headers: {
          'Authorization': 'Basic ' + basic,
          'Content-Type': 'application/x-www-form-urlencoded',
          'Content-Length': Buffer.byteLength(postData)
        }
      }, (res) => {
        let body = '';
        res.on('data', (chunk) => body += chunk);
        res.on('end', () => {
          try {
            const data = JSON.parse(body);
            if (data.access_token) {
              resolve({ valid: true, error: null });
            } else {
              resolve({ valid: false, error: data.error_description || data.error || 'Invalid credentials' });
            }
          } catch (_) {
            resolve({ valid: false, error: 'Invalid response from Spotify' });
          }
        });
      });
      req.on('error', (e) => resolve({ valid: false, error: e.message }));
      req.write(postData);
      req.end();
    });
  } catch (e) {
    return { valid: false, error: e.message };
  }
}

/* ── Write .env file ── */
function writeEnvFile(config) {
  const envPath = path.join(__dirname, '.env');
  let lines = [];

  // Read existing .env if it exists, so we preserve unknown keys
  if (fs.existsSync(envPath)) {
    lines = fs.readFileSync(envPath, 'utf-8').split('\n');
  }

  // Map of keys to update
  const updates = {};
  if (config.musicDir !== undefined) updates['MUSIC_DIR'] = config.musicDir;
  if (config.spotifyClientId !== undefined) updates['SPOTIFY_CLIENT_ID'] = config.spotifyClientId;
  if (config.spotifyClientSecret !== undefined) updates['SPOTIFY_CLIENT_SECRET'] = config.spotifyClientSecret;
  if (config.port !== undefined) updates['PORT'] = config.port;
  if (config.ytDlpPath !== undefined) updates['YT_DLP_PATH'] = config.ytDlpPath;

  // Update or add each key
  const updatedKeys = new Set();
  for (let i = 0; i < lines.length; i++) {
    const match = lines[i].match(/^([A-Z_]+)=/);
    if (match && updates[match[1]] !== undefined) {
      // Quote values that contain spaces or special chars
      const val = String(updates[match[1]]);
      lines[i] = match[1] + '=' + (val.includes(' ') ? '"' + val + '"' : val);
      updatedKeys.add(match[1]);
    }
  }

  // Add any new keys that weren't in the file
  for (const [key, val] of Object.entries(updates)) {
    if (!updatedKeys.has(key)) {
      const v = String(val);
      lines.push(key + '=' + (v.includes(' ') ? '"' + v + '"' : v));
    }
  }

  // Ensure trailing newline
  if (lines.length > 0 && lines[lines.length - 1] !== '') {
    lines.push('');
  }

  fs.writeFileSync(envPath, lines.join('\n'), 'utf-8');
  console.log('[config] .env file updated');
}

/* GET /api/config — return current config status (no secrets) */
app.get('/api/config', (req, res) => {
  const envPath = path.join(__dirname, '.env');
  const envExists = fs.existsSync(envPath);

  // Check if music dir is the default (unconfigured) value
  const isDefaultMusicDir = (MUSIC_DIR === 'C:/Users/YourName/Music');
  const musicDirExists = fs.existsSync(MUSIC_DIR);

  res.json({
    musicDir: MUSIC_DIR,
    musicDirExists: musicDirExists,
    musicDirConfigured: !isDefaultMusicDir && musicDirExists,
    spotifyConfigured: spotifyConfigured(),
    spotifyHasClientId: !!(SPOTIFY_CLIENT_ID),
    // Don't expose the actual secret — just whether it's set
    spotifyHasClientSecret: !!(SPOTIFY_CLIENT_SECRET),
    ytdlpPath: YT_DLP,
    port: PORT,
    envFileExists: envExists,
    autoDetectedMusicDir: detectMusicDir(),
    // Overall "first run" detection
    needsSetup: isDefaultMusicDir || !musicDirExists
  });
});

/* POST /api/config — validate and save configuration */
app.post('/api/config', async (req, res) => {
  try {
    const config = req.body;
    if (!config || typeof config !== 'object') {
      return res.status(400).json({ error: 'Invalid request body' });
    }

    const results = { success: true, errors: [], warnings: [] };

    // Validate music directory
    if (config.musicDir) {
      const musicPath = path.resolve(config.musicDir);
      if (!fs.existsSync(musicPath)) {
        results.errors.push({ field: 'musicDir', message: 'Directory does not exist: ' + musicPath });
        results.success = false;
      } else if (!fs.statSync(musicPath).isDirectory()) {
        results.errors.push({ field: 'musicDir', message: 'Path is not a directory: ' + musicPath });
        results.success = false;
      } else {
        // Check if directory is readable
        try {
          fs.readdirSync(musicPath);
        } catch (e) {
          results.errors.push({ field: 'musicDir', message: 'Directory is not readable: ' + e.message });
          results.success = false;
        }
      }
    }

    // Validate Spotify credentials (optional, but if provided, test them)
    if (config.spotifyClientId && config.spotifyClientSecret) {
      const spotifyTest = await testSpotifyCredentials(config.spotifyClientId, config.spotifyClientSecret);
      if (!spotifyTest.valid) {
        results.warnings.push({ field: 'spotify', message: 'Spotify credentials test failed: ' + spotifyTest.error + '. They will be saved anyway — you can fix them later.' });
      }
    } else if (config.spotifyClientId && !config.spotifyClientSecret) {
      results.warnings.push({ field: 'spotify', message: 'Client Secret is missing — Spotify integration will not work.' });
    }

    // Validate yt-dlp
    if (config.ytDlpPath) {
      const ytdlpTest = await testYtDlp(config.ytDlpPath);
      if (!ytdlpTest.found) {
        results.warnings.push({ field: 'ytdlp', message: 'yt-dlp not found at specified path. YouTube features may not work.' });
      }
    }

    // If critical validation failed, don't save
    if (!results.success) {
      return res.status(400).json(results);
    }

    // Save to .env
    writeEnvFile(config);

    results.message = 'Configuration saved. Please restart the server for changes to take effect.';
    res.json(results);
  } catch (err) {
    console.error('[config] Error saving configuration:', err.message);
    res.status(500).json({ success: false, errors: [{ field: 'general', message: err.message }] });
  }
});

/* POST /api/config/test — test current configuration without saving */
app.post('/api/config/test', async (req, res) => {
  try {
    const results = { musicDir: false, spotify: false, ytdlp: false, details: {} };

    // Test music dir
    try {
      if (fs.existsSync(MUSIC_DIR) && fs.statSync(MUSIC_DIR).isDirectory()) {
        fs.readdirSync(MUSIC_DIR);
        results.musicDir = true;
        results.details.musicDir = 'OK — ' + MUSIC_DIR;
      } else {
        results.details.musicDir = 'Not found: ' + MUSIC_DIR;
      }
    } catch (e) {
      results.details.musicDir = 'Error: ' + e.message;
    }

    // Test Spotify
    if (spotifyConfigured()) {
      const spotifyTest = await testSpotifyCredentials(SPOTIFY_CLIENT_ID, SPOTIFY_CLIENT_SECRET);
      results.spotify = spotifyTest.valid;
      results.details.spotify = spotifyTest.valid ? 'Connected' : spotifyTest.error;
    } else {
      results.details.spotify = 'Not configured';
    }

    // Test yt-dlp
    const ytdlpTest = await testYtDlp(YT_DLP);
    results.ytdlp = ytdlpTest.found;
    results.details.ytdlp = ytdlpTest.found ? 'v' + ytdlpTest.version + ' @ ' + ytdlpTest.path : 'Not found';

    res.json(results);
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

// Fallback: check public/ directory for any additional static files
const PUBLIC_DIR = path.join(__dirname, 'public');
if (fs.existsSync(PUBLIC_DIR)) {
  app.use(express.static(PUBLIC_DIR, {
    setHeaders: res => res.setHeader('X-Content-Type-Options', 'nosniff')
  }));
}

/* ── Favicon — return empty 204 so browsers stop asking ── */
app.get('/favicon.ico', (req, res) => res.status(204).end());

/* ── Service Worker — needs special headers not set by the static middleware ── */
app.get('/sw.js', (req, res) => {
  const swPath = path.join(__dirname, 'sw.js');
  res.setHeader('Service-Worker-Allowed', '/');
  res.setHeader('Cache-Control', 'no-cache');
  res.setHeader('Content-Type', 'application/javascript');
  if (!fs.existsSync(swPath)) {
    res.end('/* N96_freq — minimal fallback Service Worker */\nself.addEventListener("fetch", e => e.respondWith(fetch(e.request)));');
    return;
  }
  res.sendFile(swPath);
});

// Audio extensions
const AUDIO_EXTS = new Set(['mp3', 'flac', 'wav', 'ogg', 'm4a', 'aac', 'webm', 'opus']);
const MIME_MAP = { mp3:'audio/mpeg', flac:'audio/flac', wav:'audio/wav', ogg:'audio/ogg', m4a:'audio/mp4', aac:'audio/aac', webm:'audio/webm', opus:'audio/opus' };

// Scan music directory
function scanMusic(dir, folder = '') {
  let tracks = [];
  try {
    const entries = fs.readdirSync(dir, { withFileTypes: true });
    for (const e of entries) {
      const fp = path.join(dir, e.name);
      if (e.isDirectory()) {
        const subFolder = folder ? folder + '/' + e.name : e.name;
        tracks.push(...scanMusic(fp, subFolder));
      } else {
        const ext = path.extname(e.name).slice(1).toLowerCase();
        if (AUDIO_EXTS.has(ext)) {
          try {
            const stat = fs.statSync(fp);
            const relPath = folder ? folder + '/' + e.name : e.name;
            tracks.push({
              path: relPath.replace(/\\\\/g, '/'),
              folder: folder || 'All Music',
              filename: e.name,
              ext: ext,
              size: stat.size,
              mtime: stat.mtime.getTime()
            });
          } catch (_) {}
        }
      }
    }
  } catch (_) {}
  return tracks;
}

/* ── Async initial scan (v19) ───────────────────────────────────
   Server starts immediately. ALL_TRACKS starts empty.
   scanMusic runs in setImmediate batches so the event loop isn't blocked.
   /api/tracks returns { loading: true } while scan is in progress. */
const ALL_TRACKS = [];
const FOLDERS_INDEX = {};
let libraryScanning = true;   // Flip to false when scan completes

function buildFolderIndex() {
  Object.keys(FOLDERS_INDEX).forEach(key => delete FOLDERS_INDEX[key]);
  ALL_TRACKS.forEach(t => {
    if (!FOLDERS_INDEX[t.folder]) FOLDERS_INDEX[t.folder] = [];
    FOLDERS_INDEX[t.folder].push(t);
  });
}

function asyncScanMusic() {
  console.log('\x1b[36m[scan] Starting library scan...\x1b[0m');
  const start = Date.now();
  // Run the synchronous scan in a setImmediate so the server can bind first
  setImmediate(() => {
    try {
      const tracks = scanMusic(MUSIC_DIR);
      ALL_TRACKS.length = 0;
      ALL_TRACKS.push(...tracks);
      buildFolderIndex();
      libraryScanning = false;
      const elapsed = Date.now() - start;
      console.log(`\x1b[36m[scan] Library scan complete: ${ALL_TRACKS.length} tracks (${elapsed}ms)\x1b[0m`);
    } catch (err) {
      console.error('\x1b[31m[scan] Library scan failed:\x1b[0m', err.message);
      libraryScanning = false;  // Allow UI to show empty state rather than spin forever
    }
  });
}

/* ── Live file watching with chokidar (optional) ────────────── */
let watcherDebounceTimer = null;

function updateLibrary() {
  const newTracks = scanMusic(MUSIC_DIR);
  const added = newTracks.filter(t => !ALL_TRACKS.find(existing => existing.path === t.path));
  const removed = ALL_TRACKS.filter(t => !newTracks.find(newT => newT.path === t.path));

  ALL_TRACKS.length = 0;
  ALL_TRACKS.push(...newTracks);
  buildFolderIndex();

  if (added.length > 0 || removed.length > 0) {
    console.log(`\x1b[36m[watcher] Library updated: +${added.length} added, -${removed.length} removed (${ALL_TRACKS.length} total)\x1b[0m`);
  }
}

try {
  const chokidar = require('chokidar');
  const watcher = chokidar.watch(MUSIC_DIR, {
    persistent: true,
    ignoreInitial: true,
    followSymlinks: false,        // v18: Don't follow symlinks — prevents traversal into /etc etc.
    awaitWriteFinish: { stabilityThreshold: 2000, pollInterval: 100 },
    ignored: [
      /(^|[/\\])\../,             // Ignore dotfiles
      /\.(crdownload|part|tmp|temp)$/,  // Ignore partial downloads
      /~$/,                       // Ignore temp files (Office, etc.)
      /\.ini$/,                   // Ignore Windows metadata
      /\.DS_Store$/               // Ignore macOS metadata
    ]
  });

  // v19: Proper debounce — cancel previous timer before setting new one
  function debouncedUpdate(delay) {
    if (watcherDebounceTimer) clearTimeout(watcherDebounceTimer);
    watcherDebounceTimer = setTimeout(() => {
      watcherDebounceTimer = null;
      updateLibrary();
    }, delay);
  }

  watcher
    .on('add', () => { debouncedUpdate(1000); })
    .on('unlink', () => { debouncedUpdate(1000); })
    .on('addDir', () => { debouncedUpdate(1500); })
    .on('unlinkDir', () => { debouncedUpdate(1500); })
    .on('error', (err) => {
      console.warn('\x1b[33m[watcher] Error: ' + err.message + '\x1b[0m');
    });

  console.log('\x1b[36m[watcher] Monitoring music directory for changes...\x1b[0m');
} catch(e) {
  console.log('\x1b[33m[watcher] chokidar not installed — live file watching disabled\x1b[0m');
  console.log('\x1b[33m[watcher] Run "npm install" to enable automatic library updates\x1b[0m');
}

// API: all tracks with search/filter
app.get('/api/tracks', (req, res) => {
  // v19: Return loading state while initial scan is in progress
  if (libraryScanning) {
    return res.json({ loading: true, total: 0, tracks: [] });
  }
  let tracks = [...ALL_TRACKS];
  if (req.query.folder) {
    tracks = tracks.filter(t => t.folder === req.query.folder);
  }
  if (req.query.format) {
    tracks = tracks.filter(t => t.ext === req.query.format);
  }
  if (req.query.q) {
    const q = req.query.q.toString().trim().toLowerCase();
    if (q) {
      const words = q.split(/[\s,]+/).filter(Boolean);
      tracks = tracks.filter(t => words.every(w =>
        t.filename.toLowerCase().includes(w) ||
        (t.folder || '').toLowerCase().includes(w) ||
        t.path.toLowerCase().includes(w)
      ));
    }
  }
  res.json({ total: ALL_TRACKS.length, tracks: tracks });
});

// Waterfall chart data
app.get('/api/waterfall', (req, res) => {
  const byFolder = Object.entries(FOLDERS_INDEX).map(([name, ts]) => ({
    folder: name,
    count: ts.length,
    formats: {
      flac: ts.filter(t => t.ext === 'flac').length,
      mp3: ts.filter(t => t.ext === 'mp3').length,
      wav: ts.filter(t => t.ext === 'wav').length,
      other: ts.length - ts.filter(t => ['flac','mp3','wav'].includes(t.ext)).length
    }
  })).sort((a,b) => b.count - a.count).slice(0, 40);
  res.json({ waterfall: byFolder });
});

// Suggested playlists
app.get('/api/suggestions', (req, res) => {
  const suggestions = [
    { name: 'New Arrivals', desc: 'Recently added to your collection', tracks: [...ALL_TRACKS].sort((a,b) => b.mtime - a.mtime).slice(0, 50) },
    { name: 'FLAC Archive', desc: 'Lossless quality tracks', tracks: ALL_TRACKS.filter(t => t.ext === 'flac').slice(0, 100) },
    { name: 'Electronic Waves', desc: 'Filtered beats & synth textures', tracks: ALL_TRACKS.filter(t => /electro|synth|techno|house/i.test(t.folder)).slice(0, 80) }
  ];
  res.json({ suggestions });
});

/* ═══════════════════════════════════════════════════════════════
   Spotify Integration — Authorization Code + PKCE flow (v14)
   Client Credentials kept as fallback for metadata/search only.
   Playlist tracks require user OAuth.
   ═══════════════════════════════════════════════════════════════ */

// /api/spotify/status — quick health check used by frontend at boot
app.get('/api/spotify/status', spotifyLimiter, (req, res) => {
  res.json({
    configured: spotifyConfigured(),
    hasToken: !!spotifyToken,
    tokenExpiresAt: spotifyToken ? spotifyToken.expiresAt : null,
    userLoggedIn: !!userToken,
    now: Date.now()
  });
});

// /api/spotify/login — no rate limit (needed for OAuth redirect)
app.get('/api/spotify/login', (req, res) => {
  if (!spotifyConfigured()) {
    return res.status(503).json({ error: 'Spotify not configured' });
  }

  const state = crypto.randomBytes(16).toString('hex');
  const codeVerifier = generateCodeVerifier();
  const codeChallenge = generateCodeChallenge(codeVerifier);

  // Store temporarily — cleared after callback or after 5 min TTL
  pendingAuth = { state, codeVerifier, createdAt: Date.now() };

  const params = new URLSearchParams({
    response_type: 'code',
    client_id: SPOTIFY_CLIENT_ID,
    scope: 'playlist-read-private playlist-read-collaborative',
    code_challenge_method: 'S256',
    code_challenge: codeChallenge,
    redirect_uri: SPOTIFY_REDIRECT_URI,
    state: state
  });

  console.log('\x1b[35m[spotify] initiating PKCE auth — state=' + state.slice(0, 8) + '...\x1b[0m');
  res.redirect('https://accounts.spotify.com/authorize?' + params.toString());
});

// /api/spotify/callback — no rate limit (needed for OAuth callback)
app.get('/api/spotify/callback', async (req, res) => {
  // User denied access
  if (req.query.error) {
    console.warn('\x1b[33m[spotify] auth denied: ' + req.query.error + '\x1b[0m');
    pendingAuth = null;
    return res.status(400).send(
      '<!DOCTYPE html><html><head><title>Authorization Denied</title></head><body style="font-family:sans-serif;display:flex;align-items:center;justify-content:center;height:100vh;margin:0;background:#0d1535;color:#c8d6e5;"><p>Authorization denied. You can close this window.</p></body></html>'
    );
  }

  const { code, state } = req.query;

  // Validate state
  if (!pendingAuth || pendingAuth.state !== state) {
    console.error('[spotify] callback state mismatch — possible CSRF');
    return res.status(400).send('Invalid state parameter. Close this window and try again.');
  }

  // TTL check — 5 minutes
  if (Date.now() - pendingAuth.createdAt > 5 * 60 * 1000) {
    pendingAuth = null;
    return res.status(400).send('Authorization expired. Close this window and try again.');
  }

  const { codeVerifier } = pendingAuth;
  pendingAuth = null; // Clear immediately — single-use

  // Exchange code + verifier for tokens
  try {
    const tokenRes = await fetch(SPOTIFY_TOKEN_URL, {
      method: 'POST',
      headers: { 'Content-Type': 'application/x-www-form-urlencoded' },
      body: new URLSearchParams({
        grant_type: 'authorization_code',
        code: code,
        redirect_uri: SPOTIFY_REDIRECT_URI,
        client_id: SPOTIFY_CLIENT_ID,
        client_secret: SPOTIFY_CLIENT_SECRET,
        code_verifier: codeVerifier
      }).toString()
    });

    if (!tokenRes.ok) {
      const text = await tokenRes.text();
      console.error('\x1b[31m[spotify] token exchange failed: ' + text.slice(0, 300) + '\x1b[0m');
      return res.status(500).send('Token exchange failed. Close this window and try again.');
    }

    const data = await tokenRes.json();
    userToken = {
      value: data.access_token,
      refreshToken: data.refresh_token,
      expiresAt: Date.now() + (data.expires_in || 3600) * 1000
    };

    console.log('\x1b[35m[spotify] user logged in via PKCE — token expires in ' + (data.expires_in || 3600) + 's\x1b[0m');

    // Serve HTML that posts message to opener and closes itself
    res.type('html').send(`<!DOCTYPE html>
<html><head><title>N96 — Spotify Connected</title>
<style>body{font-family:system-ui,sans-serif;display:flex;align-items:center;justify-content:center;height:100vh;margin:0;background:#0d1535;color:#c8d6e5;}p{font-size:16px;}a{color:#7fd1a4;}</style>
</head><body>
<p>&#10003; Spotify connected — you can close this window.</p>
<script>
try{window.opener.postMessage({type:'spotify-connected'},'*');window.close();}
catch(e){document.body.innerHTML='<p>Connected! <a href="http://localhost:3001">Return to N96</a></p>';}
setTimeout(function(){try{window.close();}catch(e){}},2000);
</script>
</body></html>`);
  } catch (err) {
    console.error('\x1b[31m[spotify] callback error:\x1b[0m', err);
    res.status(500).send('Internal error. Close this window and try again.');
  }
});

// /api/spotify/logout — clears user OAuth token
app.get('/api/spotify/logout', spotifyLimiter, (req, res) => {
  userToken = null;
  console.log('\x1b[33m[spotify] user logged out\x1b[0m');
  res.json({ ok: true });
});

// /api/spotify/token-test — DEBUG ONLY: gated behind NODE_ENV=development
app.get('/api/spotify/token-test', spotifyLimiter, async (req, res) => {
  if (process.env.NODE_ENV !== 'development') {
    return res.status(404).json({ error: 'Not found' });
  }
  try {
    if (!spotifyConfigured()) {
      return res.status(503).json({ ok: false, error: 'Spotify credentials not configured' });
    }
    const token = await getSpotifyToken();
    res.json({
      ok: true,
      access_token_preview: token.slice(0, 8) + '…' + token.slice(-4),
      token_type: 'Bearer',
      expires_in: (userToken && userToken.value === token)
        ? Math.max(0, Math.floor((userToken.expiresAt - Date.now()) / 1000))
        : (spotifyToken ? Math.max(0, Math.floor((spotifyToken.expiresAt - Date.now()) / 1000)) : 3600),
      cached_until: (userToken && userToken.value === token) ? userToken.expiresAt : (spotifyToken ? spotifyToken.expiresAt : null),
      source: (userToken && userToken.value === token) ? 'user_oauth' : 'client_credentials'
    });
  } catch (err) {
    console.error('[spotify] token-test failed:', err.message);
    res.status(500).json({ ok: false, error: err.message });
  }
});

// /api/spotify/validate — parses a Spotify playlist URL/URI and returns the canonical ID.
app.get('/api/spotify/validate', spotifyLimiter, (req, res) => {
  const raw = (req.query.url || req.query.id || '').toString().trim();
  if (!raw) return res.status(400).json({ ok: false, error: 'Missing url or id parameter' });

  let id = null;
  let m;
  if ((m = raw.match(/open\.spotify\.com\/playlist\/([A-Za-z0-9]{22})/))) id = m[1];
  else if ((m = raw.match(/open\.spotify\.com\/embed\/playlist\/([A-Za-z0-9]{22})/))) id = m[1];
  else if ((m = raw.match(/^spotify:playlist:([A-Za-z0-9]{22})$/))) id = m[1];
  else if (/^[A-Za-z0-9]{22}$/.test(raw)) id = raw;

  if (!id) {
    return res.status(400).json({ ok: false, error: 'Could not extract a valid 22-character Spotify playlist ID', input: raw });
  }
  res.json({ ok: true, id: id, canonical_url: 'https://open.spotify.com/playlist/' + id });
});

// /api/spotify/debug/:id - DEBUG ONLY: raw Spotify response, gated behind NODE_ENV=development
app.get('/api/spotify/debug/:id', spotifyLimiter, async (req, res) => {
  if (process.env.NODE_ENV !== 'development') {
    return res.status(404).json({ error: 'Not found' });
  }
  try {
    const id = req.params.id;
    if (!/^[A-Za-z0-9]{22}$/.test(id)) {
      return res.status(400).json({ error: 'Invalid ID' });
    }
    const token = await getSpotifyToken();
    const url = SPOTIFY_API_BASE + '/playlists/' + id;
    const r = await fetch(url, { headers: { 'Authorization': 'Bearer ' + token } });
    const text = await r.text();
    let parsed;
    try { parsed = JSON.parse(text); } catch(_) { parsed = null; }
    res.json({
      status: r.status,
      usingUserToken: !!(userToken),
      total_tracks: parsed && parsed.tracks ? parsed.tracks.total : null,
      name: parsed ? parsed.name : null,
      owner: parsed && parsed.owner ? parsed.owner.display_name : null,
      public: parsed ? parsed.public : null,
      collaborative: parsed ? parsed.collaborative : null,
raw_has_tracks: !!(parsed && parsed.tracks),
      raw_tracks_keys: parsed && parsed.tracks ? Object.keys(parsed.tracks) : null,
      raw_tracks_total: parsed && parsed.tracks ? parsed.tracks.total : null,
      raw_tracks_href: parsed && parsed.tracks ? parsed.tracks.href : null,
      raw_snippet: text.slice(0, 2000)
    });
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

// /api/spotify/playlists/:id — fetches a single playlist's metadata
app.get('/api/spotify/playlists/:id', spotifyLimiter, async (req, res) => {
  try {
    const id = req.params.id;
    if (!/^[A-Za-z0-9]{22}$/.test(id)) {
      return res.status(400).json({ error: 'Invalid playlist ID — must be 22 base62 chars' });
    }
    const query = { fields: 'id,name,description,owner(id,display_name),images(url),tracks(total),external_urls(spotify)' };
    const data = await spotifyRequest('/playlists/' + id, query);
    res.json({
      id: data.id,
      name: data.name,
      description: data.description || '',
      owner: data.owner ? (data.owner.display_name || data.owner.id) : '',
      image: data.images && data.images[0] ? data.images[0].url : '',
      total_tracks: data.tracks ? data.tracks.total : 0,
      spotify_url: data.external_urls ? data.external_urls.spotify : ''
    });
  } catch (err) {
    console.error('[spotify] playlists/:id failed:', err.message, err.status ? '(HTTP ' + err.status + ')' : '');
    if (err.status === 404) {
      return res.status(404).json({ error: 'Playlist not found. It may be private, deleted, or region-locked. Make sure you are connected to Spotify.' });
    }
    /* v82: Pass through 403 Premium errors with a clear message */
    if (err.status === 403) {
      const isPremium = err.message && err.message.toLowerCase().includes('premium');
      return res.status(403).json({
        error: isPremium ? 'premium_required' : 'access_denied',
        message: isPremium
          ? 'Spotify Premium is required for the app owner to access playlists. If you recently subscribed, it can take a few hours to activate.'
          : err.message
      });
    }
    res.status(err.status || 500).json({ error: err.message });
  }
});

// /api/spotify/playlists/:id/tracks — fetches full track listing.
// v14: Requires user OAuth. Returns 403 with error:'login_required' if not logged in.
app.get('/api/spotify/playlists/:id/tracks', spotifyLimiter, async (req, res) => {
  try {
    const id = req.params.id;
    if (!/^[A-Za-z0-9]{22}$/.test(id)) {
      return res.status(400).json({ error: 'Invalid playlist ID — must be 22 base62 chars' });
    }

    // v14: Playlist tracks require user OAuth — Client Credentials no longer works
    if (!userToken) {
      return res.status(403).json({
        error: 'login_required',
        message: 'Spotify login required to fetch playlist tracks. Click "Connect Spotify" to authorize.'
      });
    }

    // Pre-check: fetch metadata to see if playlist has tracks.
    // Some playlist types (Spotalike/algorithmic) use 'items' instead of 'tracks'.
    let metaTotal = 0;
    let useItemsEndpoint = false;
    try {
      const meta = await spotifyRequest('/playlists/' + id, { fields: 'tracks(total),items(total)' });
      if (meta && meta.tracks && meta.tracks.total) {
        metaTotal = meta.tracks.total;
      } else if (meta && meta.items && meta.items.total) {
        metaTotal = meta.items.total;
        useItemsEndpoint = true;
        console.log('[spotify] playlist uses items format (Spotalike/algorithmic)');
      }
      console.log('[spotify] playlist ' + id + ' has ' + metaTotal + ' tracks (pre-check)' + (useItemsEndpoint ? ' [items]' : ''));
    } catch (metaErr) {
      console.warn('[spotify] metadata pre-check failed:', metaErr.message);
      /* v82: If the pre-check fails with 403, pass the real error through.
         Previously we swallowed 403 "Premium subscription required" and
         returned an empty tracks list with a misleading "no tracks" warning.
         Now we detect the 403 and return it to the client with a clear message. */
      if (metaErr.status === 403) {
        const isPremium = metaErr.message && metaErr.message.toLowerCase().includes('premium');
        return res.status(403).json({
          error: isPremium ? 'premium_required' : 'access_denied',
          message: isPremium
            ? 'Spotify Premium is required for the app owner to access playlists. If you recently subscribed, it can take a few hours to activate.'
            : metaErr.message
        });
      }
    }
    if (metaTotal === 0) {
      console.log('[spotify] playlist is empty - returning empty tracks list');
      return res.json({
        playlist_id: id,
        total: 0,
        returned: 0,
        tracks: [],
        warning: 'This playlist has no tracks. Add songs in Spotify, then click Refresh.'
      });
    }

    // Use /items endpoint for Spotalike playlists, /tracks for normal ones
    const endpointPath = useItemsEndpoint ? '/items' : '/tracks';
    const fields = useItemsEndpoint
      ? 'total,limit,offset,next,items(item(id,name,artists(name),album(name),duration_ms,external_ids(isrc)))'
      : 'total,limit,offset,next,items(track(id,name,artists(name),album(name),duration_ms,external_ids(isrc)))';
    let offset = 0;
    const limit = 100;
    let allItems = [];
    let total = 0;
    let guardLoops = 0;

    do {
      guardLoops++;
      if (guardLoops > 50) {
        throw new Error('Pagination guard tripped - fetched more than 5000 tracks, aborting');
      }
      const page = await spotifyRequest('/playlists/' + id + endpointPath, {
        fields: fields,
        limit: limit,
        offset: offset
      });

      if (!page) break;
      total = page.total || total;
      const items = page.items || [];
      for (let i = 0; i < items.length; i++) {
        // Standard: items[i].track | Spotalike: items[i].item
        const t = items[i].track || items[i].item;
        if (!t || !t.id) continue;
        allItems.push({
          spotId: t.id,
          title: t.name || 'Unknown',
          artist: (t.artists && t.artists[0] && t.artists[0].name) || 'Unknown',
          album: (t.album && t.album.name) || '',
          duration_ms: t.duration_ms || 0,
          isrc: (t.external_ids && t.external_ids.isrc) || null
        });
      }
      offset += limit;
      if (!page.next) break;
    } while (allItems.length < total);

    res.json({
      playlist_id: id,
      total: total,
      returned: allItems.length,
      tracks: allItems
    });
  } catch (err) {
    console.error('[spotify] tracks fetch error:', err.message);
    if (err.stack) console.error('[spotify] tracks fetch stack:', err.stack);
    res.status(err.status || 500).json({ error: err.message });
  }
});

// /api/spotify/playlists — batch metadata, stricter rate limit
app.get('/api/spotify/playlists', spotifyBatchLimiter, async (req, res) => {
  if (!spotifyConfigured()) {
    return res.json({
      configured: false,
      message: 'Set SPOTIFY_CLIENT_ID and SPOTIFY_CLIENT_SECRET to enable Spotify integration',
      playlists: []
    });
  }
  const idsRaw = (req.query.ids || '').toString().trim();
  if (!idsRaw) {
    return res.json({ configured: true, playlists: [] });
  }
  const ids = idsRaw.split(',').map(s => s.trim()).filter(Boolean);
  for (let i = 0; i < ids.length; i++) {
    if (!/^[A-Za-z0-9]{22}$/.test(ids[i])) {
      return res.status(400).json({ error: 'Invalid playlist ID: ' + ids[i] });
    }
  }
  try {
    const out = [];
    for (let i = 0; i < ids.length; i++) {
      try {
        const data = await spotifyRequest('/playlists/' + ids[i], {
          fields: 'id,name,description,owner(id,display_name),images(url),tracks(total),external_urls(spotify)'
        });
        out.push({
          id: data.id,
          name: data.name,
          description: data.description || '',
          owner: data.owner ? (data.owner.display_name || data.owner.id) : '',
          image: data.images && data.images[0] ? data.images[0].url : '',
          total_tracks: data.tracks ? data.tracks.total : 0,
          spotify_url: data.external_urls ? data.external_urls.spotify : ''
        });
      } catch (err) {
        out.push({ id: ids[i], error: err.message, status: err.status || 500 });
      }
    }
    res.json({ configured: true, playlists: out });
  } catch (err) {
    console.error('[spotify] playlists batch failed:', err.message);
    res.status(500).json({ error: err.message });
  }
});

/* ═══════════════════════════════════════════════════════════════
   YouTube Integration — yt-dlp backed (bulletproof)
   ═══════════════════════════════════════════════════════════════ */

/* ytdlp wrapper — routes through the concurrency queue */
function ytdlp(args, timeoutMs, req) {
  return executeYtDlp(args, timeoutMs, req);
}

app.get('/api/youtube/search', youtubeLimiter, async (req, res) => {
  try {
    const query = req.query.q;
    if (!query) return res.status(400).json({ error: 'Missing query parameter' });
    console.log('[yt-dlp] searching for:', query);

    const out = await ytdlp([
      `ytsearch24:${query}`,
      '--flat-playlist',
      '--no-warnings',
      '--no-playlist-reverse',
      '--print', '%(id)s\t%(title)s\t%(duration)s\t%(uploader)s\t%(thumbnail)s'
    ], 30000, req);

    console.log('[yt-dlp] raw output (first 500 chars):', out.substring(0, 500));

    const videos = out
      .split('\n')
      .filter(line => line && line.trim() && !line.startsWith('['))
      .map(line => {
        const [id, title, duration, author, thumbnail] = line.split('\t');
        if (!id || id === 'NA') return null;
        let durStr = '';
        const secs = parseInt(duration, 10);
        if (!isNaN(secs) && secs > 0) {
          const m = Math.floor(secs / 60), s = secs % 60;
          durStr = m + ':' + String(s).padStart(2, '0');
        }
        // Filter NA thumbnails and use YouTube default thumbnail as fallback
        let thumb = thumbnail && thumbnail !== 'NA' ? thumbnail : '';
        if (!thumb && id) thumb = 'https://img.youtube.com/vi/' + id + '/mqdefault.jpg';
        return {
          id,
          title: title || 'Untitled',
          thumbnail: thumb,
          duration: durStr,
          author: author || ''
        };
      })
      .filter(Boolean);

    if (videos.length === 0) {
      console.log('[yt-dlp] empty results, falling back to yt-search');
      const results = await yts(query);
      return res.json(results.videos.map(v => ({
        id: v.videoId,
        title: v.title,
        thumbnail: v.thumbnail,
        duration: v.duration.timestamp,
        author: v.author.name
      })));
    }

    res.json(videos);
  } catch (err) {
    console.error('YouTube search error:', err.message);
    try {
      const results = await yts(req.query.q);
      return res.json(results.videos.map(v => ({
        id: v.videoId,
        title: v.title,
        thumbnail: v.thumbnail,
        duration: v.duration.timestamp,
        author: v.author.name
      })));
    } catch (e2) {
      res.status(500).json({ error: 'Search failed: ' + err.message });
    }
  }
});

app.get('/api/youtube/info', youtubeLimiter, async (req, res) => {
  try {
    const videoId = req.query.id;
    if (!videoId) return res.status(400).json({ error: 'Missing video ID' });

    const url = `https://www.youtube.com/watch?v=${videoId}`;
    const out = await ytdlp([
      '--no-warnings',
      '--no-download',
      '--print', '%(id)s\t%(title)s\t%(duration)s\t%(uploader)s\t%(thumbnail)s',
      url
    ], 15000, req);

    const lines = out.split('\n').filter(l => l && l.trim() && !l.startsWith('['));
    if (lines.length === 0) {
      return res.status(404).json({ error: 'Video not found or yt-dlp returned nothing' });
    }

    const [id, title, duration, author, thumbnail] = lines[0].split('\t');
    let durStr = '';
    const secs = parseInt(duration, 10);
    if (!isNaN(secs) && secs > 0) {
      const h = Math.floor(secs / 3600), m = Math.floor((secs % 3600) / 60), s = secs % 60;
      durStr = h > 0 ? h + ':' + String(m).padStart(2, '0') + ':' + String(s).padStart(2, '0')
                     : m + ':' + String(s).padStart(2, '0');
    }

    res.json({
      id: id || videoId,
      title: (title && title !== 'NA') ? title : 'Untitled',
      thumbnail: (thumbnail && thumbnail !== 'NA') ? thumbnail : ('https://img.youtube.com/vi/' + videoId + '/mqdefault.jpg'),
      duration: durStr,
      author: (author && author !== 'NA') ? author : ''
    });
  } catch (err) {
    console.error('YouTube info error:', err.message);
    res.status(500).json({ error: 'Failed to fetch video info: ' + err.message });
  }
});

/* ── YouTube Playlist endpoint (v74) ────────────────────────────
   GET /api/youtube/playlist?url=<playlist_url>
   Uses yt-dlp --flat-playlist for fast playlist enumeration.
   Results are cached for 1 hour (simple Map cache with TTL). */
const playlistCache = new Map();
const PLAYLIST_CACHE_TTL = 60 * 60 * 1000; // 1 hour

app.get('/api/youtube/playlist', youtubeLimiter, async (req, res) => {
  try {
    const playlistUrl = req.query.url;
    if (!playlistUrl) return res.status(400).json({ error: 'Missing url parameter' });

    // Check cache
    const cached = playlistCache.get(playlistUrl);
    if (cached && (Date.now() - cached.timestamp) < PLAYLIST_CACHE_TTL) {
      console.log('[playlist] cache hit:', playlistUrl);
      return res.json(cached.data);
    }

    console.log('[yt-dlp] fetching playlist:', playlistUrl);
    const out = await ytdlp([
      '--flat-playlist',
      '--dump-json',
      '--no-warnings',
      playlistUrl
    ], 60000, req);  // 60s timeout — large playlists take time

    // Parse the stream of JSON objects (one per video, separated by newlines)
    const videos = [];
    let playlistTitle = '';
    const lines = out.split('\n').filter(l => l && l.trim());

    for (const line of lines) {
      try {
        const obj = JSON.parse(line);
        if (!obj.id) continue;

        // Capture playlist title from the first entry if available
        if (!playlistTitle && obj.playlist_title) {
          playlistTitle = obj.playlist_title;
        }

        let durStr = '';
        const secs = parseInt(obj.duration, 10);
        if (!isNaN(secs) && secs > 0) {
          const h = Math.floor(secs / 3600), m = Math.floor((secs % 3600) / 60), s = secs % 60;
          durStr = h > 0
            ? h + ':' + String(m).padStart(2, '0') + ':' + String(s).padStart(2, '0')
            : m + ':' + String(s).padStart(2, '0');
        }

        let thumb = obj.thumbnail || '';
        if ((!thumb || thumb === 'NA') && obj.id) {
          thumb = 'https://img.youtube.com/vi/' + obj.id + '/mqdefault.jpg';
        }

        videos.push({
          id: obj.id,
          title: obj.title || 'Untitled',
          uploader: obj.uploader || obj.channel || '',
          duration: durStr,
          thumbnail: thumb
        });
      } catch (parseErr) {
        // Skip unparseable lines (e.g. warning messages from yt-dlp)
        continue;
      }
    }

    if (videos.length === 0) {
      return res.status(404).json({ error: 'No videos found. The playlist may be empty, private, or the URL may be invalid.' });
    }

    const result = { playlistTitle: playlistTitle || 'YouTube Playlist', videos };

    // Store in cache
    playlistCache.set(playlistUrl, { data: result, timestamp: Date.now() });

    // Prune expired entries periodically
    if (playlistCache.size > 50) {
      const now = Date.now();
      for (const [key, val] of playlistCache) {
        if (now - val.timestamp > PLAYLIST_CACHE_TTL) playlistCache.delete(key);
      }
    }

    console.log('[playlist] fetched ' + videos.length + ' videos from ' + playlistUrl);
    res.json(result);
  } catch (err) {
    console.error('YouTube playlist error:', err.message);
    const msg = err.message || '';
    if (msg.includes('403') || msg.includes('private')) {
      res.status(403).json({ error: 'This playlist is private or access is denied.' });
    } else if (msg.includes('404') || msg.includes('not found') || msg.includes('does not exist')) {
      res.status(404).json({ error: 'Playlist not found. Check the URL and try again.' });
    } else {
      res.status(500).json({ error: 'Failed to fetch playlist: ' + msg.split('\n').pop() });
    }
  }
});

/* /api/youtube/stream — REMOVED in v18 (security + resource risk).
   The frontend uses the YouTube IFrame API for playback, which doesn't
   require server-side streaming. This endpoint was an unthrottled,
   unvalidated yt-dlp spawn that could be abused for resource exhaustion. */

// Audio streaming with range support for seeking
/* ── Audio streaming with range support for seeking ──────────────
   v18: Path traversal fix — uses realpath + strict prefix with separator.
   1. Decode each path segment ONCE
   2. Resolve against MUSIC_DIR
   3. realpath both sides (resolves symlinks, junctions, mount points)
   4. Strict prefix match: realMusicDir + sep must be a prefix of realFilePath
   5. Whitelist audio extensions only */
app.get('/audio/:path(*)', (req, res) => {
  // Step 1: Decode path segments once, join against MUSIC_DIR
  const segments = req.params.path.split('/').map(segment => {
    try { return decodeURIComponent(segment); }
    catch { return segment; } // Malformed URI — leave as-is, will fail realpath
  });
  const rawPath = path.join(MUSIC_DIR, ...segments);

  // Step 2: Resolve to absolute path (collapses ../, normalizes separators)
  const resolvedPath = path.resolve(rawPath);

  // Step 3: realpath to resolve symlinks, junctions, and mount points
  let realFilePath;
  try {
    realFilePath = fs.realpathSync(resolvedPath);
  } catch {
    // File doesn't exist or is a broken symlink
    return res.status(404).json({ error: 'File not found' });
  }

  // Step 4: Strict prefix match with separator
  //   Prevents /home/user/MusicSecrets from matching /home/user/Music
  if (realFilePath !== REAL_MUSIC_DIR && !realFilePath.startsWith(getMusicPrefix())) {
    console.error('\x1b[31m[SECURITY] Path traversal attempt blocked:\x1b[0m');
    console.error('  Requested: ' + realFilePath);
    console.error('  MUSIC_DIR: ' + REAL_MUSIC_DIR);
    return res.status(403).json({ error: 'Access denied' });
  }

  // Step 5: Extension whitelist
  const ext = path.extname(realFilePath).slice(1).toLowerCase();
  if (!AUDIO_EXTS.has(ext)) return res.status(400).json({ error: 'Unsupported format' });

  // Step 6: Stream the file with range support
  const stat = fs.statSync(realFilePath);
  const mime = MIME_MAP[ext] || 'audio/mpeg';

  const range = req.headers.range;
  if (range) {
    // Parse Range header safely
    const match = range.match(/^bytes=(\d*)-(\d*)$/);
    if (!match) return res.status(416).json({ error: 'Invalid range' });

    const start = parseInt(match[1]) || 0;
    const end = match[2] ? Math.min(parseInt(match[2]), stat.size - 1) : stat.size - 1;

    if (start >= stat.size || end >= stat.size || start > end) {
      res.writeHead(416, { 'Content-Range': `bytes */${stat.size}` });
      return res.end();
    }

    res.writeHead(206, {
      'Content-Range': `bytes ${start}-${end}/${stat.size}`,
      'Accept-Ranges': 'bytes',
      'Content-Length': end - start + 1,
      'Content-Type': mime,
      'Cache-Control': 'public, max-age=3600'
    });
    fs.createReadStream(realFilePath, { start, end }).pipe(res);
    return;
  }

  res.writeHead(200, {
    'Accept-Ranges': 'bytes',
    'Content-Length': stat.size,
    'Content-Type': mime,
    'Cache-Control': 'public, max-age=3600'
  });
  fs.createReadStream(realFilePath).pipe(res);
});

// Start server

/* ── Startup validation ─────────────────────────────────────── */
if (!fs.existsSync(MUSIC_DIR)) {
  console.error('\x1b[31m[ERROR] MUSIC_DIR does not exist: ' + MUSIC_DIR + '\x1b[0m');
  console.error('\x1b[31m[ERROR] Please edit the .env file and set a valid MUSIC_DIR path\x1b[0m');
  console.error('\x1b[31m[ERROR] Copy .env.example to .env and configure it.\x1b[0m');
  process.exit(1);
}

// Re-resolve REAL_MUSIC_DIR now that we know the directory exists
try {
  REAL_MUSIC_DIR = fs.realpathSync(MUSIC_DIR);
} catch (e) {
  console.error('\x1b[31m[ERROR] Cannot resolve MUSIC_DIR realpath: ' + e.message + '\x1b[0m');
  process.exit(1);
}
console.log('\x1b[90m[security] MUSIC_DIR realpath: ' + REAL_MUSIC_DIR + '\x1b[0m');

app.listen(PORT, HOST, () => {
  console.log('\x1b[36m╔═════════════════════════════╗\x1b[0m');
  console.log('\x1b[36m║     N96_freq v2 · Ready     ║\x1b[0m');
  console.log(`\x1b[33m║      http://localhost:${PORT}      ║\x1b[0m`);
  console.log('\x1b[36m╚═════════════════════════════╝\x1b[0m');
  console.log(`\x1b[90mMusic dir: ${MUSIC_DIR}\x1b[0m`);
  console.log(`\x1b[90mYouTube engine: yt-dlp @ ${YT_DLP}\x1b[0m`);
  console.log(`\x1b[90m[yt-dlp] Concurrency: ${MAX_CONCURRENT_YTDLP}, Queue max: ${MAX_QUEUE_SIZE}, Timeout: ${YT_TIMEOUT_MS}ms\x1b[0m`);
  console.log('\x1b[90m[rate-limit] YouTube: 100/min, Spotify: 60/min, Spotify batch: 10/min\x1b[0m');
  if (spotifyConfigured()) {
    console.log('\x1b[35m[spotify] credentials detected — /api/spotify/* routes active (PKCE OAuth for tracks)\x1b[0m');
  } else {
    console.log('\x1b[33m[spotify] credentials MISSING — /api/spotify/* routes return 503/configured:false\x1b[0m');
  }
  console.log('\x1b[32m[N96] server v19 ready\x1b[0m\n');

  // v19: Start async library scan AFTER server is listening
  asyncScanMusic();

  // Validate yt-dlp is installed
  execFile(YT_DLP, ['--version'], (err, stdout) => {
    if (err) {
      console.error('\x1b[31m[yt-dlp] NOT FOUND or broken. YouTube will not work.\x1b[0m');
      console.error('\x1b[31m[yt-dlp] Resolved path: ' + YT_DLP + '\x1b[0m');
      console.error('\x1b[31m[yt-dlp] Install from: https://github.com/yt-dlp/yt-dlp#installation\x1b[0m');
    } else {
      console.log(`\x1b[32m[yt-dlp] OK — version ${stdout.trim()}\x1b[0m`);
      execFile(YT_DLP, ['-U'], { timeout: 20000 }, (uErr, uStdout) => {
        if (!uErr && /up\s*to\s*date|updated/i.test(uStdout.toString())) {
          console.log('\x1b[90m[yt-dlp] update check done\x1b[0m');
        }
      });
    }
  });
});