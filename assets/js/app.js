/* N96_freq — app.js
   Version: 79 (Fix inter-collection drag via addEventListener; theme-aware collection styles; button→div for collection items)
   If you see this exact string in DevTools Console, you have the latest version.
   If you don't see it, your browser is loading a STALE cached copy — do Ctrl+Shift+R. */
console.log("%c[N96] app.js v79 loaded", "color:#7fd1a4;font-weight:bold;");

const $ = function(s) { return document.querySelector(s); };
const $$ = function(s) { return Array.from(document.querySelectorAll(s)); };

/* User-interaction flag — set to true the moment user clicks or keys anything.
   Once true, the auto-show of the TRACKS panel on initial loadTracks() is disabled. */
var userHasInteracted = false;
function markUserInteraction() {
  if (userHasInteracted) return;
  userHasInteracted = true;
  console.log("[N96] user interaction detected — TRACKS auto-show disabled");
  document.removeEventListener('click', markUserInteraction, true);
  document.removeEventListener('keydown', markUserInteraction, true);
}
document.addEventListener('click', markUserInteraction, true);
document.addEventListener('keydown', markUserInteraction, true);

/* Page visibility — pause heavy animations when tab is hidden */
var isTabVisible = true;
document.addEventListener('visibilitychange', function() {
  isTabVisible = !document.hidden;
  if (!isTabVisible) {
    console.log('[N96] tab hidden — pausing animations');
  } else {
    console.log('[N96] tab visible — resuming animations');
  }
});

/* Mouse position for aurora parallax */
var mouseX = 0.5, mouseY = 0.5;
document.addEventListener('mousemove', function(e) {
  mouseX = e.clientX / window.innerWidth;
  mouseY = e.clientY / window.innerHeight;
});


const N96 = { tracks: [], nowPlaying: null, currentIdx: -1, isPlaying: false, volume: 0.7, shuffleOn: false, repeatMode: "none", activePlaylist: "All", ambientVolume: 0.25, ambientMuted: false, userPaused: false, _lastMediaSessionUpdate: 0, performanceMode: false, ultraMode: false, pomodoro: { isActive: false, currentSession: 1, totalSessions: 4, phase: 'work', timeLeft: 25 * 60, workDuration: 25 * 60, restDuration: 5 * 60, intervalId: null }, stats: { totalListeningTime: 0, tracksPlayed: 0, mostPlayed: {}, recentTracks: [], lastPlayed: null, sessionsToday: 0, _sessionDate: '' } };

/* v76: Debounce for onended — prevents double-fire causing premature advance */
var _lastEndedTime = 0;
var _trackStartTime = 0;

/* Theme palettes for the aurora background — each theme has its own
   gradient, wave hues, blob hue, and accent colour. */


/* ═══════════════════════════════════════════════════════════════
   v57: Persistent State — localStorage save/restore
   ═══════════════════════════════════════════════════════════════ */
var _stateSaveTimer = null;

function loadSavedState() {
  try {
    var saved = localStorage.getItem('n96_state');
    if (!saved) return;
    var state = JSON.parse(saved);

    // Restore settings
    if (state.volume !== undefined) { N96.volume = state.volume; player.volume = state.volume; }
    if (state.ambientVolume !== undefined) N96.ambientVolume = state.ambientVolume;
    if (state.shuffleOn !== undefined) N96.shuffleOn = state.shuffleOn;
    if (state.repeatMode !== undefined) N96.repeatMode = state.repeatMode;
    if (state.performanceMode !== undefined) N96.performanceMode = state.performanceMode;
    if (state.ultraMode !== undefined) N96.ultraMode = state.ultraMode;

    // Restore statistics
    if (state.stats) {
      N96.stats = Object.assign(N96.stats, state.stats);
    }

    // Check if today is a new session day
    var today = new Date().toDateString();
    if (N96.stats._sessionDate !== today) {
      N96.stats.sessionsToday = 0;
      N96.stats._sessionDate = today;
    }
    N96.stats.sessionsToday++;

    // Restore active playlist (album selection in sidebar)
    if (state.activePlaylist) {
      N96.activePlaylist = state.activePlaylist;
    }

    // Update UI to reflect restored state
    var shuffleBtn = document.getElementById('shuffle-btn');
    if (shuffleBtn) shuffleBtn.classList.toggle('active', N96.shuffleOn);
    var repeatBtn = document.getElementById('repeat-btn');
    if (repeatBtn) {
      repeatBtn.classList.toggle('active', N96.repeatMode !== 'none');
      repeatBtn.textContent = N96.repeatMode === 'one' ? '1' : 'REP';
    }

    // Restore volume slider if it exists
    var volSlider = document.getElementById('vol-slider');
    if (volSlider) volSlider.value = Math.round(N96.volume * 100);

    // Restore current track — MUST happen after loadTracks() has populated N96.tracks
    if (state.currentTrack) {
      restoreTrack(state.currentTrack, state);
    }

    // v74: Restore YouTube playlist state if it was active
    // We re-fetch the playlist from the server cache to rebuild the video list
    if (state.ytPlaylistActive && state.ytPlaylistUrl) {
      ytPlaylistState.url = state.ytPlaylistUrl;
      ytPlaylistState.title = state.ytPlaylistTitle || '';
      ytPlaylistState.currentIndex = state.ytPlaylistIndex >= 0 ? state.ytPlaylistIndex : 0;
      ytPlaylistState.isShuffle = state.ytPlaylistIsShuffle || false;
      // Mark as active once the videos array is populated (async restore below)
      fetch('/api/youtube/playlist?url=' + encodeURIComponent(state.ytPlaylistUrl))
        .then(function(r) { return r.json(); })
        .then(function(data) {
          if (data && data.videos && data.videos.length > 0) {
            ytPlaylistState.videos = data.videos;
            ytPlaylistState.active = true;
            console.log('[N96] YouTube playlist restored: ' + data.videos.length + ' videos');
            updateTrackCounter();
            updateUltraTrackInfo();
          }
        })
        .catch(function(e) {
          console.warn('[N96] Failed to restore YouTube playlist:', e);
        });
    }

    console.log('[N96] State restored from localStorage');
  } catch (e) {
    console.error('[N96] Failed to load saved state:', e);
  }
}

function saveState() {
  try {
    var currentTrack = null;
    if (N96.nowPlaying) {
      currentTrack = {
        title: N96.nowPlaying.filename || N96.nowPlaying.title || '',
        source: N96.nowPlaying.isSpotify ? 'spotify' : (N96.nowPlaying.isYouTube ? 'youtube' : 'local'),
        path: N96.nowPlaying.path || null,
        folder: N96.nowPlaying.folder || null,
        videoId: N96.nowPlaying.videoId || null,
        author: N96.nowPlaying.author || null,
        position: (N96.nowPlaying && N96.nowPlaying.isYouTube && ytPlayer && ytReady) ? (function() { try { return ytPlayer.getCurrentTime() || 0; } catch(e) { return 0; } })() : (player.currentTime || 0),
        playing: N96.isPlaying
      };
    }
    var state = {
      volume: N96.volume,
      ambientVolume: N96.ambientVolume,
      shuffleOn: N96.shuffleOn,
      repeatMode: N96.repeatMode,
      performanceMode: N96.performanceMode,
      ultraMode: N96.ultraMode,
      activePlaylist: N96.activePlaylist,
      currentTrack: currentTrack,
      stats: N96.stats,
      savedAt: Date.now(),
      // Save Spotify playlist info so we can re-highlight and restart on refresh
      spotifyPlaylistId: spotifyState.activePlaylistId || null,
      spotifyPlaylistName: spotifyState.activePlaylistName || '',
      // Save current Spotify track index + title so we can resume the exact song after reconnect
      spotifyTrackIndex: spotifyState.activePlaylistId ? spotifyState.currentIdx : -1,
      spotifyTrackTitle: (spotifyState.currentTrack && spotifyState.currentTrack.title) ? spotifyState.currentTrack.title : (currentTrack && currentTrack.source === 'spotify' ? currentTrack.title : ''),
      // v74: Save YouTube playlist info for restore on refresh
      ytPlaylistActive: ytPlaylistState.active || false,
      ytPlaylistUrl: ytPlaylistState.url || '',
      ytPlaylistTitle: ytPlaylistState.title || '',
      ytPlaylistIndex: ytPlaylistState.active ? ytPlaylistState.currentIndex : -1,
      ytPlaylistIsShuffle: ytPlaylistState.isShuffle || false
    };
    localStorage.setItem('n96_state', JSON.stringify(state));
  } catch (e) {
    console.error('[N96] Failed to save state:', e);
  }
}

function debouncedSaveState() {
  if (_stateSaveTimer) clearTimeout(_stateSaveTimer);
  _stateSaveTimer = setTimeout(saveState, 2000);
}

/* v69: Force immediate save — used before unload and for critical state changes */
function saveStateNow() {
  if (_stateSaveTimer) { clearTimeout(_stateSaveTimer); _stateSaveTimer = null; }
  saveState();
}

/* v69: Reset to Home — click N96_FREQ logo to stop everything and return to clean state */
function resetToHome() {
  // Stop any playback
  if (player && player.pause) { player.pause(); player.removeAttribute('src'); player.load(); }
  if (ytPlayer && ytReady && ytPlayer.pauseVideo) { try { ytPlayer.pauseVideo(); } catch(e) {} }

  // Clear current track
  N96.nowPlaying = null;
  N96.currentIdx = -1;
  N96.isPlaying = false;
  N96.userPaused = false;

  // Clear Spotify/YouTube active state
  if (spotifyState.activePlaylistId) {
    spotifyState.cancelToken++;
    spotifyState.activePlaylistId = null;
    spotifyState.activePlaylistName = '';
    spotifyState.tracks = [];
    spotifyState.currentIdx = -1;
    spotifyState.currentTrack = null;
    spotifyState.failedTracks = {};
    spotifyState.shuffleWindow = null;
    spotifyState.prefetching = false;
    spotifyState.prefetchAbort = true;
    spotifyState.youtubeCache = {};
    spotifyState.prefetchQueue = [];
  }
  // v74: Clear YouTube playlist state
  if (ytPlaylistState.active) {
    stopYtPlaylist();
  }

  // Return to All Music view
  N96.activePlaylist = 'All';
  renderPlaylistBar();

  // Close all views and show the local Now Playing area
  showCenterView("local");
  var extCard = document.getElementById('ext-source-card');
  if (extCard) extCard.classList.add('hidden');

  // Close any open modals/panels
  var modals = document.querySelectorAll(".modal-overlay.visible");
  modals.forEach(function(m) { m.classList.remove("visible"); m.classList.add("hidden"); });
  var pomoModal = $("#pomodoro-modal");
  if (pomoModal && !pomoModal.classList.contains("hidden")) { pomoModal.classList.add("hidden"); pomoModal.classList.remove("visible"); }
  closeStatsPanel();
  hidePanel();
  $("#yt-source-btn").classList.remove("active");
  $("#sp-source-btn").classList.remove("active");
  var sp = $("#spotify-progress");
  if (sp) sp.classList.add("hidden");

  // Collapse all accordion sidebar sections for a clean start
  ACCORDION_SECTIONS.forEach(function(id) {
    var el = document.getElementById(id);
    if (el && !el.classList.contains("collapsed")) {
      el.classList.add("collapsed");
      var header = el.querySelector(".collapsible-header");
      if (header) header.setAttribute("aria-expanded", "false");
    }
  });
  // Preserve independent section states (Collections stays open if user had it open)
  var savedIndependent = INDEPENDENT_SECTIONS.filter(function(id) {
    var el = document.getElementById(id);
    return el && el.classList.contains("collapsed");
  });
  setCollapsedSections(ACCORDION_SECTIONS.concat(savedIndependent));

  // Re-render sidebars to clear active highlights
  renderYtMixesSidebar();
  renderSpotifySidebar();

  // Show the "Select a track" home screen
  var npTitle = document.getElementById('np-title');
  var npMeta = document.getElementById('np-meta');
  if (npTitle) npTitle.textContent = 'SELECT A TRACK';
  if (npMeta) npMeta.textContent = 'Click a track below to start playback';

  // Update play/pause button
  updatePlayPauseUI();

  // Reset seek
  var seekFill = document.getElementById('seek-fill');
  if (seekFill) seekFill.style.width = '0%';
  var timerDisplay = document.getElementById('timer-display');
  if (timerDisplay) timerDisplay.textContent = '0:00';
  var durationDisplay = document.getElementById('duration-display');
  if (durationDisplay) durationDisplay.textContent = '';

  // Clear media session
  if ('mediaSession' in navigator) {
    navigator.mediaSession.playbackState = 'none';
    navigator.mediaSession.metadata = null;
  }

  // v73: Clear view history and update UI elements
  _viewHistory = [];
  updateUltraTrackInfo();
  updateTrackCounter();
  updateBackButtons();

  // Save this clean state
  saveStateNow();

  showToast('Returned to home');
}

function restoreTrack(track, savedState) {
  var state = savedState || {};
  if (track.source === 'local' && track.path) {
    var idx = -1;
    for (var i = 0; i < N96.tracks.length; i++) {
      if (N96.tracks[i].path === track.path) { idx = i; break; }
    }
    if (idx >= 0) {
      var tr = N96.tracks[idx];
      N96.currentIdx = idx;
      N96.nowPlaying = tr;
      _trackStartTime = Date.now();  /* v76: Set track start time on restore */
      player.src = "/audio/" + encodeURI(track.path.replace(/\\/g, "/"));
      player.load();
      /* v76: Always set onended handler on restore — the old handler may be
         stale or missing, and a restored track needs the same guards. */
      player.onended = function() {
        var now = Date.now();
        if (N96.userPaused) { return; }
        if (now - _lastEndedTime < 2000) { return; }
        if (now - _trackStartTime < 5000) { return; }
        if (player.duration && isFinite(player.duration) &&
            player.currentTime > 0 && player.currentTime < player.duration - 2) { return; }
        if (!player.duration || !isFinite(player.duration)) {
          if (now - _trackStartTime < 30000) { return; }
        }
        _lastEndedTime = now;
        if (N96.repeatMode === "one") {
          player.currentTime = 0;
          player.play();
        } else {
          playNext();
        }
      };
      // Update the Now Playing UI immediately so user sees what was playing
      updateNPUI(tr);
      if (track.position) {
        player.addEventListener('loadedmetadata', function onMeta() {
          player.currentTime = track.position;
          player.removeEventListener('loadedmetadata', onMeta);
          // Update seek bar after seeking
          if (player.duration) {
            var pct = (player.currentTime / player.duration) * 100;
            var fill = document.getElementById('seek-fill');
            if (fill) fill.style.width = pct + '%';
          }
        });
      }
      if (track.playing) {
        player.addEventListener('canplay', function onCanPlay() {
          player.play().then(function() {
            N96.isPlaying = true;
            updatePlayPauseUI();
            initAnalyser();
            startTimer();
            updateMediaSession();
          }).catch(function(e) {
            console.warn('[N96] Autoplay blocked on restore:', e);
            // Autoplay was blocked — show paused state, user can click play
            N96.isPlaying = false;
            N96.userPaused = true;
            updatePlayPauseUI();
          });
          player.removeEventListener('canplay', onCanPlay);
        });
      }
      // Select the album this track belongs to
      if (tr.folder) {
        var album = tr.folder.split("/")[0];
        if (album && N96.activePlaylist !== album) {
          N96.activePlaylist = album;
        }
      }
      renderPlaylistBar();

      // Show the track list with the correct album filter
      renderTrackList(getFilteredTracks());

      // Highlight the current track in the list
      $$(".track-item").forEach(function(el) {
        el.classList.remove("active");
        if (parseInt(el.dataset.idx) === N96.currentIdx) el.classList.add("active");
      });
      showToast('Restored: ' + track.title);
    } else {
      console.warn('[N96] Saved track not found in library:', track.path);
      showToast('Previously playing track not found', 'warning');
    }
  } else if (track.source === 'youtube' && track.videoId) {
    // Validate the video ID
    var vid = track.videoId;
    if (!vid || vid.length < 5) {
      console.warn('[N96] Invalid YouTube videoId in saved state:', vid);
      showToast('Could not restore YouTube track — invalid ID', 'warning');
      return;
    }
    console.log('[N96] Restoring YouTube track (info card): id=' + vid + ' title=' + track.title);

    // Set up N96 state so the sidebar highlights correctly
    N96.nowPlaying = {
      path: null,
      filename: track.title || 'YouTube Track',
      ext: "YT",
      isYouTube: true,
      isSpotify: false,
      videoId: vid,
      author: track.author || ''
    };
    N96.currentIdx = -1;
    N96.isPlaying = false;
    N96.userPaused = true;

    // Show the external source restore card instead of trying to embed
    // (embedded player often fails on refresh with autoplay/ID errors)
    hidePanel();
    showCenterView("ext-source");
    showExtSourceCard({
      type: 'youtube',
      title: track.title || 'YouTube Track',
      meta: "YOUTUBE" + (track.author ? " \u00B7 " + track.author : ""),
      url: "https://www.youtube.com/watch?v=" + vid,
      linkText: "Open on YouTube",
      videoId: vid,
      author: track.author || ''
    });

    // Highlight the mix in the sidebar and expand the YouTube section
    renderYtMixesSidebar();
    expandSidebarForSource('youtube');
    showToast('Restored: ' + (track.title || 'YouTube Track'));
  } else if (track.source === 'spotify') {
    // Spotify track restore — show info card with reconnect option
    console.log('[N96] Restoring Spotify track (info card): title=' + track.title);

    N96.nowPlaying = {
      path: null,
      filename: track.title || 'Spotify Track',
      ext: "SP",
      isYouTube: true,
      isSpotify: true,
      videoId: track.videoId || null,
      author: track.author || ''
    };
    N96.currentIdx = -1;
    N96.isPlaying = false;
    N96.userPaused = true;

    // Restore the active Spotify playlist ID for sidebar highlighting
    var savedSpotifyId = state.spotifyPlaylistId;
    if (savedSpotifyId) {
      spotifyState.activePlaylistId = savedSpotifyId;
      spotifyState.activePlaylistName = state.spotifyPlaylistName || '';
    }

    hidePanel();
    showCenterView("ext-source");
    showExtSourceCard({
      type: 'spotify',
      title: track.title || 'Spotify Track',
      meta: "SPOTIFY" + (track.author ? " \u00B7 " + track.author : ""),
      url: track.videoId ? ("https://www.youtube.com/watch?v=" + track.videoId) : '#',
      linkText: track.videoId ? "Open on YouTube" : null,
      videoId: track.videoId || null,
      author: track.author || '',
      playlistId: savedSpotifyId || null,
      playlistName: state.spotifyPlaylistName || '',
      // Pass the saved track index and title so resume can jump to the right track
      trackIndex: state.spotifyTrackIndex !== undefined ? state.spotifyTrackIndex : -1,
      trackTitle: state.spotifyTrackTitle || track.title || ''
    });

    renderSpotifySidebar();
    expandSidebarForSource('spotify');
    showToast('Restored: ' + (track.title || 'Spotify Track'));
  }
}

/* ── Show the external-source restore card (YouTube / Spotify on page refresh) ──
   Instead of trying to embed the video (which often errors on refresh),
   we show the track name and give the user two options:
   1. "Open on YouTube" — opens in a new tab
   2. "Play here" — tries to load it in the embedded player */
var _pendingExtRestore = null; // stores info for "Play here" button
var _pendingSpotifyResume = null; // stores { id, name, trackIndex, trackTitle } to auto-resume after Spotify reconnect

function showExtSourceCard(info) {
  _pendingExtRestore = info;
  var card = $("#ext-source-card");
  card.classList.remove("hidden");

  $("#ext-source-title").textContent = info.title;
  $("#ext-source-meta").textContent = info.meta;

  // Set up the link
  var linkEl = $("#ext-source-link");
  if (info.url && info.url !== '#') {
    linkEl.href = info.url;
    linkEl.style.display = '';
    $("#ext-source-link-text").textContent = info.linkText || 'Open on YouTube';
  } else {
    linkEl.style.display = 'none';
  }

  // Update the "Play here" button text based on type
  var playBtn = $("#ext-source-play-btn");
  if (info.type === 'spotify') {
    playBtn.textContent = info.playlistId ? 'Resume playlist' : 'Play here';
  } else {
    playBtn.textContent = 'Play here';
  }

  // Icon: YouTube-style or Spotify-style
  var iconEl = $("#ext-source-icon");
  if (info.type === 'youtube') {
    iconEl.innerHTML = '<svg width="48" height="48" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.5"><rect x="2" y="4" width="20" height="16" rx="3"/><polygon points="10 8 16 12 10 16" fill="currentColor" stroke="none"/></svg>';
  } else if (info.type === 'spotify') {
    iconEl.innerHTML = '<svg width="48" height="48" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.5"><circle cx="12" cy="12" r="10"/><path d="M8 15s1.5-1 4.5-.5 4.5 0 4.5 0"/><path d="M8.5 12.5s1.5-1 4-.5 3.5 0 3.5 0"/><path d="M9 10s1.5-1 3.5-.5 3 0 3 0"/></svg>';
  }

  // Play/pause button shows ▶ since nothing is playing yet
  $("#play-pause-btn").textContent = "\u25B6";
}

/* ── "Play here" / "Resume playlist" button on the restore card ── */
function playRestoredExternal() {
  if (!_pendingExtRestore) return;
  var info = _pendingExtRestore;
  _pendingExtRestore = null;

  // Hide the restore card
  $("#ext-source-card").classList.add("hidden");

  if (info.type === 'youtube') {
    // Use the normal playYouTube path
    playYouTube({ id: info.videoId, title: info.title, author: info.author });
  } else if (info.type === 'spotify') {
    if (info.playlistId) {
      // Try to resume the Spotify playlist directly, jumping to the specific track
      resumeSpotifyPlaylist(info.playlistId, info.playlistName, info.trackIndex, info.trackTitle);
    } else if (info.videoId) {
      // No playlist — just play the video
      playYouTube({ id: info.videoId, title: info.title, author: info.author });
    } else {
      // No playlist or video — open Spotify connect
      connectSpotify();
    }
  }
}

/* ── Resume a Spotify playlist after page refresh ──
   Check if user is logged in, then start the playlist.
   If not logged in, show the reconnect dialog first.
   trackIndex/trackTitle: used to jump to the specific song that was playing. */
async function resumeSpotifyPlaylist(playlistId, playlistName, trackIndex, trackTitle) {
  // Check if user is already logged in
  try {
    var res = await fetch('/api/spotify/status');
    var data = await res.json();
    if (data.userLoggedIn) {
      // Already logged in — find the playlist and start it
      var playlists = loadSpotifyPlaylists();
      var pl = playlists.find(function(p) { return p.id === playlistId; });
      if (pl) {
        console.log('[N96] Resuming Spotify playlist:', playlistName, 'track:', trackTitle, 'idx:', trackIndex);
        playSpotifyPlaylist(pl, trackIndex, trackTitle);
        return;
      }
    }
  } catch(e) {
    console.warn('[N96] Could not check Spotify status:', e);
  }

  // Not logged in — show reconnect dialog, then auto-resume after auth
  showSpotifyReconnectDialog({
    title: trackTitle || playlistName || 'Spotify Playlist',
    playlistId: playlistId,
    playlistName: playlistName,
    trackIndex: trackIndex !== undefined ? trackIndex : -1,
    trackTitle: trackTitle || ''
  });
}

function showSpotifyReconnectDialog(track) {
  var overlay = document.createElement('div');
  overlay.className = 'modal-overlay visible';
  overlay.id = 'spotify-reconnect-modal';
  var playlistName = track.playlistName || '';
  overlay.innerHTML =
    '<div class="modal-content reconnect-modal">' +
      '<h3>Spotify Session Expired</h3>' +
      '<p style="color:var(--text-secondary);font-size:12px;margin-bottom:16px;">You were playing from Spotify: <strong style="color:var(--text-primary);">' + esc(track.title) + '</strong></p>' +
      (playlistName ? '<p style="color:var(--text-muted);font-size:11px;margin-bottom:12px;">Playlist: ' + esc(playlistName) + '</p>' : '') +
      '<div class="modal-buttons">' +
        '<button class="btn-primary" id="reconnect-spotify-btn">Reconnect Spotify</button>' +
        '<button class="btn-secondary" id="abandon-restore-btn">Start Fresh</button>' +
      '</div>' +
    '</div>';
  document.querySelector('.app-surface').appendChild(overlay);

  var playlistId = track.playlistId || null;
  var trackIndex = track.trackIndex !== undefined ? track.trackIndex : -1;
  var trackTitle = track.trackTitle || '';

  document.getElementById('reconnect-spotify-btn').addEventListener('click', function() {
    overlay.remove();
    // Store the playlist ID + track info so we can auto-resume after auth
    if (playlistId) {
      _pendingSpotifyResume = { id: playlistId, name: playlistName, trackIndex: trackIndex, trackTitle: trackTitle };
      // Also persist to localStorage in case the page somehow refreshes during OAuth
      try {
        localStorage.setItem('n96_pending_spotify_resume', JSON.stringify(_pendingSpotifyResume));
      } catch(_) {}
    }
    connectSpotify();
    showToast('Reconnecting to Spotify...', 'info');
  });

  document.getElementById('abandon-restore-btn').addEventListener('click', function() {
    overlay.remove();
    // Clear the restore card and reset state
    $('#ext-source-card').classList.add('hidden');
    showCenterView('local');
    N96.nowPlaying = null;
    N96.isPlaying = false;
    spotifyState.activePlaylistId = null;
    spotifyState.activePlaylistName = '';
    renderSpotifySidebar();
    localStorage.removeItem('n96_state');
    localStorage.removeItem('n96_pending_spotify_resume');
    _pendingSpotifyResume = null;
    showToast('Starting fresh', 'info');
  });
}

/* v57: Statistics tracking */
function updateStats(track) {
  if (!track) return;
  var now = Date.now();

  if (N96.stats.lastPlayed) {
    var duration = (now - N96.stats.lastPlayed) / 1000;
    if (duration > 0 && duration < 3600) {
      N96.stats.totalListeningTime += duration;
    }
  }

  N96.stats.tracksPlayed++;
  N96.stats.lastPlayed = now;

  /* v78: Determine source type for the key */
  var sourceType = "local";
  var key, displayName;
  if (track.isYouTube && track.isSpotify) {
    sourceType = "spotify";
    key = "sp_" + (track.videoId || track.spotId || 'unknown');
    displayName = track.filename || track.title || key;
  } else if (track.isYouTube) {
    sourceType = "youtube";
    key = "yt_" + (track.videoId || 'unknown');
    displayName = track.filename || track.title || key;
  } else if (track.path) {
    sourceType = "local";
    key = track.path;
    displayName = track.filename || track.title || key;
  } else {
    key = track.videoId || track.filename || 'unknown';
    displayName = track.filename || track.title || key;
  }

  // Track most played
  N96.stats.mostPlayed[key] = (N96.stats.mostPlayed[key] || 0) + 1;
  N96.stats.mostPlayed._names = N96.stats.mostPlayed._names || {};
  N96.stats.mostPlayed._names[key] = displayName;
  N96.stats.mostPlayed._sources = N96.stats.mostPlayed._sources || {};
  N96.stats.mostPlayed._sources[key] = sourceType;

  // Recent tracks (keep last 50)
  N96.stats.recentTracks.unshift({
    title: track.filename || track.title || 'Unknown',
    artist: track.author || track.folder || '',
    source: sourceType,
    time: now
  });
  N96.stats.recentTracks = N96.stats.recentTracks.slice(0, 50);

  debouncedSaveState();
}

/* v58: Export stats (kept from removed settings panel) */
function exportStats() {
  var dataStr = JSON.stringify(N96.stats, null, 2);
  var blob = new Blob([dataStr], {type: 'application/json'});
  var url = URL.createObjectURL(blob);
  var a = document.createElement('a');
  a.href = url;
  a.download = 'n96_stats_' + Date.now() + '.json';
  a.click();
  URL.revokeObjectURL(url);
  showToast('Statistics exported', 'success');
}

/* v57: Statistics panel */
function openStatsPanel() {
  var modal = document.getElementById('stats-modal');
  if (!modal) return;

  // Format total listening time
  var totalSec = Math.floor(N96.stats.totalListeningTime);
  var hours = Math.floor(totalSec / 3600);
  var mins = Math.floor((totalSec % 3600) / 60);

  // Top played tracks
  var mp = N96.stats.mostPlayed || {};
  var names = mp._names || {};
  var sources = mp._sources || {};
  var sorted = Object.keys(mp).filter(function(k) { return k !== '_names' && k !== '_sources'; })
    .map(function(k) { return { key: k, count: mp[k], name: names[k] || k, source: sources[k] || 'local' }; })
    .sort(function(a, b) { return b.count - a.count; })
    .slice(0, 10);

  var topHtml = '';
  if (sorted.length === 0) {
    topHtml = '<p style="color:var(--text-muted);font-size:12px;">No tracks played yet</p>';
  } else {
    for (var i = 0; i < sorted.length; i++) {
      /* v78: Source type icon */
      var srcIcon = '';
      if (sorted[i].source === 'youtube') {
        srcIcon = '<span class="stats-source-icon src-yt" title="YouTube">&#9654;</span>';
      } else if (sorted[i].source === 'spotify') {
        srcIcon = '<span class="stats-source-icon src-spotify" title="Spotify">&#9835;</span>';
      } else {
        srcIcon = '<span class="stats-source-icon src-local" title="Local">&#9834;</span>';
      }
      topHtml += '<div class="stats-row">' + srcIcon + '<span class="stats-rank">' + (i+1) + '.</span><span class="stats-name">' + esc(sorted[i].name) + '</span><span class="stats-count">' + sorted[i].count + 'x</span></div>';
    }
  }

  // Recent tracks
  var recentHtml = '';
  var recent = (N96.stats.recentTracks || []).slice(0, 10);
  if (recent.length === 0) {
    recentHtml = '<p style="color:var(--text-muted);font-size:12px;">No recent tracks</p>';
  } else {
    for (var i = 0; i < recent.length; i++) {
      var ago = formatTimeAgo(recent[i].time);
      /* v78: Source type icon */
      var srcIcon = '';
      if (recent[i].source === 'youtube') {
        srcIcon = '<span class="stats-source-icon src-yt" title="YouTube">&#9654;</span>';
      } else if (recent[i].source === 'spotify') {
        srcIcon = '<span class="stats-source-icon src-spotify" title="Spotify">&#9835;</span>';
      } else {
        srcIcon = '<span class="stats-source-icon src-local" title="Local">&#9834;</span>';
      }
      recentHtml += '<div class="stats-row">' + srcIcon + '<span class="stats-name">' + esc(recent[i].title) + '</span><span class="stats-time">' + ago + '</span></div>';
    }
  }

  document.getElementById('stats-listening-time').textContent = hours > 0 ? hours + 'h ' + mins + 'm' : mins + 'm';
  document.getElementById('stats-tracks-played').textContent = N96.stats.tracksPlayed;
  document.getElementById('stats-sessions-today').textContent = N96.stats.sessionsToday;
  document.getElementById('stats-top-tracks').innerHTML = topHtml;
  document.getElementById('stats-recent').innerHTML = recentHtml;

  modal.classList.remove('hidden');
  modal.classList.add('visible');
}

function closeStatsPanel() {
  var modal = document.getElementById('stats-modal');
  if (modal) { modal.classList.add('hidden'); modal.classList.remove('visible'); }
}

function resetStats() {
  N96.stats = {
    totalListeningTime: 0,
    tracksPlayed: 0,
    mostPlayed: {},
    recentTracks: [],
    lastPlayed: null,
    sessionsToday: 0,
    _sessionDate: ''
  };
  debouncedSaveState();
  showToast('Statistics reset');
  // Re-render the panel if it's open
  openStatsPanel();
}

function formatTimeAgo(timestamp) {
  var diff = Date.now() - timestamp;
  if (diff < 60000) return 'just now';
  if (diff < 3600000) return Math.floor(diff / 60000) + 'm ago';
  if (diff < 86400000) return Math.floor(diff / 3600000) + 'h ago';
  return Math.floor(diff / 86400000) + 'd ago';
}


var THEME_PALETTES = {
  twilight: {
    bgGradient: ["#060b1a", "#0d1535", "#0c1230"],
    waveHues: [162, 178, 148],
    blobHueBase: 175,
    accentColor: "#7fd1a4"
  },
  dark: {
    bgGradient: ["#0a0514", "#150a2e", "#0f0824"],
    waveHues: [250, 270, 280],
    blobHueBase: 260,
    accentColor: "#a78bfa"
  },
  light: {
    bgGradient: ["#1e293b", "#334155", "#0f172a"],
    waveHues: [190, 200, 210],
    blobHueBase: 195,
    accentColor: "#38bdf8"
  }
};
var currentAuroraPalette = THEME_PALETTES.twilight;
var analyser = null, audioCtx = null, seekDragging = false;
var _auroraRAF = null, _spectrumRAF = null;  // v70: animation frame IDs for pause/resume
var _auroraRunning = false, _spectrumRunning = false;  // v70: track animation state
var ambientGains = {};
var player = $("#player"), vizCanvas = $("#viz-canvas"), auroraCanvas = $("#aurora-canvas");
var timerInterval = null, elapsedSeconds = 0;

function getPlaylists() {
  if (!N96.tracks || N96.tracks.length === 0) return ["All"];
  var p = new Set(["All"]);
  for (var i = 0; i < N96.tracks.length; i++) {
    if (N96.tracks[i].folder) p.add(N96.tracks[i].folder.split("/")[0]);
  }
  return Array.from(p).sort();
}

function getFilteredTracks() {
  return N96.activePlaylist === "All" ? N96.tracks : N96.tracks.filter(function(t) { return t.folder && t.folder.split("/")[0] === N96.activePlaylist; });
}

function selectPlaylist(name) {
  console.log("[N96] selectPlaylist('" + name + "') called. Caller stack:\n" + new Error().stack);
  // If we were in Spotify mode, fully exit it (mirrors stopYouTubeCompletely behavior).
  if (spotifyState.activePlaylistId) {
    stopSpotifyCompletely();
  }
  if (N96.activePlaylist === name) {
    showPanel(true);
    return;
  }
  N96.activePlaylist = name;
  if (!$("#youtube-view").classList.contains("hidden") || !$("#yt-player-container").classList.contains("hidden")) {
    stopYouTubeCompletely();
  }
  renderPlaylistBar();
  showPanel(true);
  renderTrackList(getFilteredTracks());
  scrollToCurrentTrack();
}

function renderPlaylistBar() {
  var bar = $("#playlist-list");
  if (!bar) return;
  var p = getPlaylists();
  if (!p || p.length === 0) return;
  var html = "";
  for (var i = 0; i < p.length; i++) {
    var a = p[i] === N96.activePlaylist ? "active" : "";
    var c = a ? "var(--accent)" : "var(--text-secondary)";
    var b = a ? "var(--accent)" : "transparent";
    html += '<button class="sidebar-btn ' + a + '" data-playlist="' + p[i] + '" style="display:block;width:100%;text-align:left;padding:8px 14px;background:none;border:none;color:' + c + ';cursor:pointer;font-size:11px;border-left:3px solid ' + b + '">' + esc(p[i]) + '</button>';
  }
  bar.innerHTML = html;
  // IMPORTANT: only attach selectPlaylist handlers to buttons that have a
  // data-playlist attribute. The .sidebar-btn class is shared across many
  // sidebar buttons (Search YouTube, Spotify Playlists, Add Mix, Add Playlist,
  // Refresh All, etc.) — attaching to all of them caused a stray
  // selectPlaylist(null) call when those buttons were clicked, which popped
  // the TRACKS panel up over the YouTube search view after the 1.5s guard
  // expired. See "stray selectPlaylist('null')" bug report.
  var btns = $$(".sidebar-btn");
  for (var i = 0; i < btns.length; i++) {
    var pl = btns[i].getAttribute("data-playlist");
    if (!pl) continue; // skip non-playlist buttons (search, spotify, add-mix, etc.)
    (function(el, playlist) {
      el.addEventListener("click", function() { selectPlaylist(playlist); });
    })(btns[i], pl);
  }
}

var lastYouTubeSearchOpen = 0;

function showPanel(show) {
  var panel = $("#track-panel"), overlay = $("#panel-overlay"); if (!panel) return;
  if (show) {
    var timeSinceYtSearch = Date.now() - lastYouTubeSearchOpen;
    if (lastYouTubeSearchOpen > 0 && timeSinceYtSearch < 1500) {
      console.warn("[N96] showPanel(true) BLOCKED — YouTube search was opened " + timeSinceYtSearch + "ms ago.\nCaller stack:\n" + new Error().stack);
      return;
    }
    panel.classList.add("visible");
    panel.classList.remove("hidden");
    panel.style.display = '';
    overlay.classList.remove("hidden");
    overlay.classList.add("visible");
    renderTrackList(getFilteredTracks());
    scrollToCurrentTrack();
    console.log("[N96] showPanel(true) — panel opened. Caller stack:\n" + new Error().stack);
  } else {
    panel.classList.remove("visible");
    panel.classList.add("hidden");
    panel.style.display = 'none';
    overlay.classList.add("hidden");
    overlay.classList.remove("visible");
    console.log("[N96] showPanel(false) — panel closed");
  }
}
function hidePanel() { showPanel(false); }
function scrollToCurrentTrack() { var a = $(".track-item.active"); if (a) a.scrollIntoView({ behavior: "smooth", block: "center" }); }

var si = $("#track-search-input");
if (si) si.addEventListener("input", function(e) {
  var q = e.target.value.trim().toLowerCase(); if (!q) { renderTrackList(getFilteredTracks()); return; }
  renderTrackList(getFilteredTracks().filter(function(t) { return (t.filename||"").toLowerCase().includes(q) || (t.folder||"").toLowerCase().includes(q); }));
});

async function loadTracks() {
  try {
    var res = await fetch("/api/tracks?force=1");
    if (!res.ok) throw new Error("HTTP " + res.status);
    var data = await res.json();
    // v68: Handle server's async scan loading state
    if (data.loading) {
      console.log("[N96] Library scan in progress — will retry in 2s");
      setTimeout(loadTracks, 2000);
      return;
    }
    N96.tracks = data.tracks || [];
    console.log("[N96] Tracks loaded:", N96.tracks.length);
    setTimeout(function() {
      renderPlaylistBar();
      console.log("[N96] playlist bar rendered — TRACKS panel stays closed (user opens on demand)");
    }, 300);
  } catch (e) {
    // v68: Graceful offline handling
    if (!navigator.onLine) {
      showToast('You are offline — library will load when reconnected', 'warning');
    } else {
      showErrorModal("Failed to load tracks: " + e.message);
    }
    $("#track-list").innerHTML = "";
    console.error(e);
  }
}

function esc(s) { if (!s) return ""; var d = document.createElement("div"); d.textContent = s; return d.innerHTML; }

function renderTrackList(tracks) {
  var list = $("#track-list"); if (!list) return;
  if (!tracks || tracks.length === 0) {
    list.innerHTML = '<div class="empty-state"><svg width="48" height="48" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.5" stroke-linecap="round" stroke-linejoin="round"><path d="M9 18V5l12-2v13"></path><circle cx="6" cy="18" r="3"></circle><circle cx="18" cy="16" r="3"></circle></svg><h4>No Tracks Found</h4><p>Add music to your library folder or check your MUSIC_DIR setting.</p></div>';
    return;
  }
  var html = "";
  for (var i = 0; i < tracks.length; i++) {
    var t = tracks[i], gi = N96.tracks.indexOf(t);
    var active = N96.nowPlaying && N96.nowPlaying.path === t.path ? "active" : "";
    var name = (t.filename || "").replace(/\.(mp3|flac|wav|ogg|m4a)$/i, "").replace(/[-_]/g, " ");
    var folder = t.folder || "";
    html += '<div class="track-item ' + active + '" data-idx="' + gi + '"><span class="track-item-play"><svg width="12" height="12" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><path d="M9 18V5l12-2v13"></path><circle cx="6" cy="18" r="3"></circle><circle cx="18" cy="16" r="3"></circle></svg></span><div class="track-info"><span class="track-name">' + esc(name) + '</span><span style="font-size:10px;color:var(--text-muted);margin-top:2px;">' + esc(folder) + ' \u00B7 ' + (t.ext||"").toUpperCase() + '</span></div></div>';
  }
  list.innerHTML = html;
  staggerAnimate(".track-item", $("#track-list"));
  var items = $$(".track-item");
  for (var i = 0; i < items.length; i++) {
    (function(el, idx) { el.addEventListener("click", function() { if (idx >= 0 && idx < N96.tracks.length) playNow(N96.tracks[idx], idx); }); })(items[i], parseInt(items[i].getAttribute("data-idx")));
  }
}

function playNow(trackObj, idx) {
  var tr = trackObj; if (!tr) return;
  if (!$("#yt-player-container").classList.contains("hidden")) {
    stopYouTubeCompletely();
  }
  N96.currentIdx = idx;
  N96.userPaused = false;  /* New track = clear pause flag */
  _trackStartTime = Date.now();  /* v76: Track when playback started */
  player.src = "/audio/" + encodeURI(tr.path.replace(/\\/g, "/"));
  player.load();
  var seekFill = document.getElementById("seek-fill");
  if (seekFill) seekFill.style.width = "0%";
  player.play().then(function() {
    N96.nowPlaying = tr; N96.isPlaying = true; updateNPUI(tr); updateStats(tr); $("#play-pause-btn").textContent = "\u23F8"; showPanel(true); initAnalyser(); startTimer(); updateMediaSession();
    $$(".track-item").forEach(function(el) { el.classList.remove("active"); if (parseInt(el.dataset.idx) === N96.currentIdx) { el.classList.add("active"); setTimeout(function() { el.scrollIntoView({ behavior: "smooth", block: "center" }); }, 50); } });
  }).catch(function(e) { showErrorModal("Failed to play track: " + e.message, tr.filename || tr.path); });
  player.onloadedmetadata = function() { N96.duration = player.duration || 0; setTimeout(updateMediaSessionPosition, 300); };
  player.onended = function() {
    /* v76: Multi-layer guard against premature auto-advance.
       Browsers can fire spurious 'ended' events when suspending audio
       on tab hide, during resource management, or due to encodeURI issues. */
    var now = Date.now();

    /* Guard 1: if user explicitly paused, don't auto-advance */
    if (N96.userPaused) { return; }

    /* Guard 2: Debounce — if onended fired less than 2s ago, ignore duplicate */
    if (now - _lastEndedTime < 2000) { return; }

    /* Guard 3: Track must have been playing for at least 5 seconds.
       Prevents spurious ended events that fire immediately after load(). */
    if (now - _trackStartTime < 5000) { return; }

    /* Guard 4: if track didn't actually reach the end, ignore spurious event.
       Use a 2-second window (was 1s) for more robustness. */
    if (player.duration && isFinite(player.duration) &&
        player.currentTime > 0 && player.currentTime < player.duration - 2) { return; }

    /* Guard 5: If we have no duration info, check that we've been playing
       long enough — at least 30s before allowing auto-advance. */
    if (!player.duration || !isFinite(player.duration)) {
      if (now - _trackStartTime < 30000) { return; }
    }

    _lastEndedTime = now;

    if (N96.repeatMode === "one") {
      player.currentTime = 0;
      player.play();
    } else {
      playNext();
    }
  };
  player.onerror = function() {
    /* Don't auto-advance on error — just show the user and let them decide */
    console.warn("[N96] audio error on track:", tr.filename, "error:", player.error);
    N96.isPlaying = false;
    N96.userPaused = false;
    updatePlayPauseUI();
  };

  player.ontimeupdate = function() {
    if (player.duration) {
      var pct = (player.currentTime / player.duration) * 100;
      var fill = document.getElementById("seek-fill");
      if (fill) fill.style.width = pct + "%";
      var ss=document.getElementById("seek-slider");if(ss)ss.setAttribute("aria-valuenow",Math.round(pct));
    }
    /* Keep MediaSession position in sync for OS mini-player — throttle to once per second */
    if (Date.now() - N96._lastMediaSessionUpdate > 1000) {
      updateMediaSessionPosition();
      N96._lastMediaSessionUpdate = Date.now();
    }
  };
}

function startTimer() { if (timerInterval) clearInterval(timerInterval); /* Don't reset elapsedSeconds — preserve it for resume */ updateTimerDisplay(); timerInterval = setInterval(function() { if (N96.isPlaying) { elapsedSeconds++; updateTimerDisplay(); } }, 1000); }
function stopTimer() { if (timerInterval) { clearInterval(timerInterval); timerInterval = null; } }

function pad(n) { return String(n).padStart(2, "0"); }

function updateTimerDisplay() {
  // v73: Don't update timer from local player when YouTube/Spotify is active
  // (updateYouTubeSeekBar handles the timer for external sources)
  if (N96.nowPlaying && (N96.nowPlaying.isYouTube || N96.nowPlaying.isSpotify)) return;
  var td = $("#timer-display"); if (!td) return;
  var ct = Math.floor(player.currentTime);
  var h = Math.floor(ct / 3600), m = Math.floor((ct % 3600) / 60), s = ct % 60;
  td.textContent = "\u23F1 " + (h > 0 ? h+":"+pad(m)+":"+pad(s) : pad(m)+":"+pad(s));
  var dd = $("#duration-display"); if(dd && player.duration){var dm=Math.floor(player.duration/60),ds=Math.floor(player.duration%60);dd.textContent=pad(dm)+":"+pad(ds);}
}

function updateNPUI(tr) {
  var label = (tr.filename || "").replace(/\.(mp3|flac|wav|ogg|m4a)$/i, "").replace(/[-_]/g, " ");
  if ($("#np-title")) $("#np-title").textContent = label;
  if ($("#np-meta")) $("#np-meta").textContent = (tr.ext||"").toUpperCase() + (tr.size ? " \u00B7 "+(tr.size/1024/1024).toFixed(1)+" MB" : "") + " \u00B7 #" + (N96.currentIdx+1) + "/" + N96.tracks.length;
  // v73: Update ultra mode track info and track counter whenever NP UI updates
  updateUltraTrackInfo();
  updateTrackCounter();
}

/* ═══════════════════════════════════════════════════════════════
   v73: Ultra Mode Track Info — prominent centered display
   Shows song title + artist when Ultra Mode is active and a track
   is playing. Replaces the hidden video/visualizer with text.
   ═══════════════════════════════════════════════════════════════ */
function updateUltraTrackInfo() {
  var ultraTitle = document.getElementById('ultra-track-title');
  var ultraArtist = document.getElementById('ultra-track-artist');
  var ultraOverlay = document.getElementById('ultra-track-overlay');
  if (!ultraTitle || !ultraArtist || !ultraOverlay) return;

  if (!N96.ultraMode || !N96.nowPlaying || !N96.isPlaying) {
    ultraOverlay.classList.add('hidden');
    return;
  }

  var tr = N96.nowPlaying;
  var title = '';
  var artist = '';

  if (tr.isYouTube && !tr.isSpotify) {
    title = tr.filename || tr.title || 'Unknown Track';
    artist = tr.author || 'YouTube';
    // v74: Show playlist position if in YouTube playlist mode
    if (ytPlaylistState.active && ytPlaylistState.videos.length > 0) {
      artist = 'YOUTUBE PLAYLIST \u00B7 ' + (ytPlaylistState.currentIndex + 1) + '/' + ytPlaylistState.videos.length;
    }
  } else if (tr.isSpotify) {
    title = tr.filename || tr.title || 'Unknown Track';
    artist = tr.author || (spotifyState.currentTrack ? spotifyState.currentTrack.artist : 'Spotify');
  } else {
    title = (tr.filename || '').replace(/\.(mp3|flac|wav|ogg|m4a)$/i, '').replace(/[-_]/g, " ");
    artist = (tr.ext || 'local').toUpperCase();
    if (tr.folder) artist += ' \u00B7 ' + tr.folder.split('/')[0];
  }

  ultraTitle.textContent = title;
  ultraArtist.textContent = artist;
  ultraOverlay.classList.remove('hidden');
}

/* ═══════════════════════════════════════════════════════════════
   v73: Track Counter — shows "X / Y" in the controls bar
   Works for local playlists, YouTube mixes, and Spotify playlists.
   ═══════════════════════════════════════════════════════════════ */
function updateTrackCounter() {
  var counterEl = document.getElementById('track-counter');
  if (!counterEl) return;

  var current = -1;
  var total = 0;

  if (spotifyState.activePlaylistId && spotifyState.tracks.length > 0) {
    // Spotify playlist
    current = spotifyState.currentIdx + 1;
    total = spotifyState.tracks.length;
  } else if (ytPlaylistState.active && ytPlaylistState.videos.length > 0) {
    // v74: YouTube playlist
    current = ytPlaylistState.currentIndex + 1;
    total = ytPlaylistState.videos.length;
  } else if (N96.nowPlaying && N96.nowPlaying.isYouTube && !N96.nowPlaying.isSpotify) {
    // Single YouTube video — show 1/1
    current = 1;
    total = 1;
  } else if (N96.nowPlaying) {
    // Local track
    var filtered = getFilteredTracks();
    current = N96.currentIdx + 1;
    total = filtered.length;
  }

  if (current > 0 && total > 0) {
    counterEl.textContent = current + ' / ' + total;
    counterEl.classList.remove('hidden');
  } else {
    counterEl.classList.add('hidden');
  }
}

/* ═══════════════════════════════════════════════════════════════
   v73: View History — track navigation for back buttons
   Remembers which view the user came from so back buttons work
   correctly (e.g. YouTube player → back to local, not to search).
   ═══════════════════════════════════════════════════════════════ */
var _viewHistory = [];  // stack of previous view names

/* ═══════════════════════════════════════════════════════════════
   v74: YouTube Playlist State — tracks an active YouTube playlist
   for sequential/shuffled playback with auto-advance.
   ═══════════════════════════════════════════════════════════════ */
var ytPlaylistState = {
  active: false,
  title: '',
  videos: [],         // [{id, title, uploader, duration, thumbnail}]
  currentIndex: -1,
  isShuffle: false,
  url: ''             // original playlist URL (for caching reference)
};

/* Wrap showCenterView to track view history */
var _origShowCenterView = showCenterView;
showCenterView = function(view) {
  // Push the current view onto history stack (skip duplicates)
  var currentView = _getCurrentView();
  if (currentView && currentView !== view) {
    _viewHistory.push(currentView);
  }
  // Call the original function
  _origShowCenterView(view);
  // Update back button visibility
  updateBackButtons();
  // v73: In Ultra Mode with YouTube/Spotify playing, show local view
  // so track info is visible (the video iframe is 1x1px anyway)
  if (N96.ultraMode && view === 'yt-player') {
    var np = document.getElementById('now-playing');
    if (np) np.classList.remove('hidden');
  }
  // Update track counter and ultra info on view change
  updateTrackCounter();
  updateUltraTrackInfo();
};

/* Determine which center view is currently active */
function _getCurrentView() {
  if (!document.getElementById('youtube-view').classList.contains('hidden')) return 'yt-search';
  if (!document.getElementById('yt-player-container').classList.contains('hidden')) return 'yt-player';
  if (!document.getElementById('ext-source-card').classList.contains('hidden')) return 'ext-source';
  if (!document.getElementById('now-playing').classList.contains('hidden')) return 'local';
  return null;
}

/* Go back to the previous view in the history stack */
function goBackView() {
  var currentView = _getCurrentView();

  // If we're leaving the YouTube player view, stop playback (like closeYouTubePlayer)
  if (currentView === 'yt-player') {
    if (ytPlayer && ytReady) {
      try { ytPlayer.pauseVideo(); } catch(_) {}
    }
    // If Spotify was active, fully exit it
    if (spotifyState.activePlaylistId) {
      stopSpotifyCompletely();
      _viewHistory = [];  // clear history after full stop
      _origShowCenterView('local');
      updateBackButtons();
      updateTrackCounter();
      updateUltraTrackInfo();
      return;
    }
    // v74: If YouTube playlist was active, stop it
    if (ytPlaylistState.active) {
      stopYtPlaylist();
    }
    // For regular YouTube, clear the now playing state
    N96.nowPlaying = null;
    N96.isPlaying = false;
    renderYtMixesSidebar();
    updateUltraTrackInfo();
    updateTrackCounter();
  }

  if (_viewHistory.length === 0) {
    // No history — just go to local/home
    _origShowCenterView('local');
    updateBackButtons();
    updateTrackCounter();
    updateUltraTrackInfo();
    return;
  }
  var prevView = _viewHistory.pop();
  // Don't use the wrapped version to avoid re-pushing
  _origShowCenterView(prevView);
  updateBackButtons();
  updateTrackCounter();
  updateUltraTrackInfo();
}

/* Show/hide back buttons based on current view */
function updateBackButtons() {
  var ytBackBtn = document.getElementById('yt-view-back-btn');
  var spBackBtn = document.getElementById('sp-view-back-btn');

  var currentView = _getCurrentView();
  // In Ultra Mode, the local now-playing view is shown even when yt-player is active
  var isYTActive = (currentView === 'yt-player') || (N96.ultraMode && N96.nowPlaying && N96.nowPlaying.isYouTube && !N96.nowPlaying.isSpotify);
  var isSPActive = (currentView === 'yt-player') || (N96.ultraMode && N96.nowPlaying && N96.nowPlaying.isSpotify);
  var isYT = N96.nowPlaying && N96.nowPlaying.isYouTube && !N96.nowPlaying.isSpotify;
  var isSP = N96.nowPlaying && N96.nowPlaying.isSpotify;

  if (ytBackBtn) {
    ytBackBtn.classList.toggle('hidden', !(isYTActive && isYT));
  }
  if (spBackBtn) {
    spBackBtn.classList.toggle('hidden', !(isSPActive && isSP));
  }
}

function showErrorModal(msg, trackName) {
  $("#error-message").textContent = msg + (trackName ? "\nNow playing: "+trackName : "");
  $("#error-modal").classList.add("visible");
  $("#error-search-btn").onclick = function() { hidePanel(); showPanel(true); renderTrackList(getFilteredTracks().filter(function(t){return (t.filename||"").toLowerCase().includes((trackName||"").toLowerCase());})); };
  $("#error-close-btn").onclick = function() { $("#error-modal").classList.remove("visible"); };
}

var prevMusicVol = 1, prevAmbientVol = 0.25;
var _pausePosition = 0;  /* saved position when user pauses */

function togglePlayPause() {
  // v19: Handle YouTube/Spotify mode
  if (spotifyState.activePlaylistId || (N96.nowPlaying && N96.nowPlaying.isYouTube)) {
    if (ytPlayer && ytReady) {
      var state = ytPlayer.getPlayerState();
      if (state === 1) { // playing
        ytPlayer.pauseVideo();
        N96.isPlaying = false;
        N96.userPaused = true;
        updatePlayPauseUI();
      } else {
        ytPlayer.playVideo();
        N96.isPlaying = true;
        N96.userPaused = false;
        updatePlayPauseUI();
      }
    }
    if ("mediaSession" in navigator) {
      navigator.mediaSession.playbackState = N96.isPlaying ? "playing" : "paused";
    }
    updateMediaSession();
    // v73: Update ultra track info when play state changes
    updateUltraTrackInfo();
    return;
  }
  // Local audio mode
  if (!player.src) return;
  if (N96.isPlaying) {
    _pausePosition = player.currentTime || 0;  /* save where we are */
    N96.userPaused = true;  /* MUST set BEFORE player.pause() — pause() can fire onended synchronously */
    player.pause();
    N96.isPlaying = false;
    updatePlayPauseUI();
  } else {
    N96.userPaused = false;
    /* If the player is stuck in 'ended' state (browser spurious ended event),
       seek back to the saved position before playing */
    if (player.ended && _pausePosition > 0) {
      player.currentTime = _pausePosition;
    }
    player.play().then(function(){
      N96.isPlaying=true;
      updatePlayPauseUI();
      startTimer();
    }).catch(function(e){
      console.log("Play error:",e);
      /* If play still fails, try forcing a seek+play */
      if (_pausePosition > 0 && player.duration) {
        player.currentTime = _pausePosition;
        player.play().catch(function(){});
      }
    });
  }
  if ("mediaSession" in navigator) {
    navigator.mediaSession.playbackState = N96.isPlaying ? "playing" : "paused";
  }
  updateMediaSession();
  // v73: Update ultra track info when play state changes
  updateUltraTrackInfo();
}

function playPrev() {
  if (spotifyState.activePlaylistId) { spotifyAdvance(-1); return; }
  // v74: YouTube Playlist previous
  if (ytPlaylistState.active) {
    var prevIdx = Math.max(0, ytPlaylistState.currentIndex - 1);
    ytPlaylistState.currentIndex = prevIdx;
    playYtPlaylistVideo(prevIdx);
    updatePlaylistModalHighlight();
    return;
  }
  if (N96.nowPlaying && N96.nowPlaying.isYouTube && !N96.nowPlaying.isSpotify) {
    var mixes = loadMixes();
    if (mixes.length <= 1) { showToast("Only one mix saved"); return; }
    var curIdx = -1;
    for (var j = 0; j < mixes.length; j++) {
      if (mixes[j].id === N96.nowPlaying.videoId) { curIdx = j; break; }
    }
    if (curIdx === -1) { showToast("Mix not found in saved list"); return; }
    var prevIdx = (curIdx - 1 + mixes.length) % mixes.length;
    var m = mixes[prevIdx];
    playYouTube({ id: m.id, title: mixDisplayName(m), author: m.author || "", duration: m.duration || "" });
    return;
  }
  var i = Math.max(0, N96.currentIdx - 1);
  if (N96.nowPlaying && player.currentTime > 0 && player.currentTime < 3) { player.currentTime = 0; return; }
  var filtered = getFilteredTracks();
  var cfi = -1, ngi = -1, pfi = -1;
  var curPath = (N96.tracks[N96.currentIdx] && N96.tracks[N96.currentIdx].path) || null;
  for (var j = 0; j < N96.tracks.length; j++) { if (N96.tracks[j] && N96.tracks[j].path === curPath) { cfi = filtered.indexOf(N96.tracks[j]); break; } }
  if (cfi === -1) { playNow(N96.tracks[i], i); return; }
  pfi = Math.max(0, cfi - 1);
  for (var j = 0; j < N96.tracks.length; j++) { if (N96.tracks[j].path === filtered[pfi].path) { ngi = j; break; } }
  if (ngi !== -1) playNow(N96.tracks[ngi], ngi);
}

function playNext() {
  /* Guard: never auto-advance right after user paused — browser may fire
     spurious onended during/after pause(). Also guard if track hasn't ended. */
  if (N96.userPaused) { return; }
  /* v76: Extra guard — if called from a non-ended context (e.g. keyboard shortcut
     clicking next), userPaused is false, so check if the track actually played
     enough before advancing from a potentially spurious trigger. */
  if (!N96.isPlaying && player.duration && isFinite(player.duration) && player.currentTime < player.duration - 2) { return; }
  if (spotifyState.activePlaylistId) { spotifyAdvance(1); return; }
  // v74: YouTube Playlist next
  if (ytPlaylistState.active) {
    var nextIdx = ytPlaylistState.currentIndex + 1;
    if (nextIdx < ytPlaylistState.videos.length) {
      ytPlaylistState.currentIndex = nextIdx;
      playYtPlaylistVideo(nextIdx);
      updatePlaylistModalHighlight();
    } else {
      showToast('Playlist finished');
      ytPlaylistState.active = false;
      updateTrackCounter();
      updateUltraTrackInfo();
    }
    return;
  }

  /* v69: Queue removed — go straight to normal advance logic */
  if (N96.nowPlaying && N96.nowPlaying.isYouTube && !N96.nowPlaying.isSpotify) {
    var mixes = loadMixes();
    if (mixes.length <= 1) { showToast("Only one mix saved"); return; }
    var curIdx = -1;
    for (var j = 0; j < mixes.length; j++) {
      if (mixes[j].id === N96.nowPlaying.videoId) { curIdx = j; break; }
    }
    if (curIdx === -1) { showToast("Mix not found in saved list"); return; }
    var nextIdx;
    if (N96.shuffleOn) {
      // Random pick, avoid same mix twice in a row
      do { nextIdx = Math.floor(Math.random() * mixes.length); } while (nextIdx === curIdx && mixes.length > 1);
    } else {
      nextIdx = (curIdx + 1) % mixes.length;
    }
    var m = mixes[nextIdx];
    playYouTube({ id: m.id, title: mixDisplayName(m), author: m.author || "", duration: m.duration || "" });
    return;
  }
  if (N96.shuffleOn) {
    var filtered = getFilteredTracks(), cfi = -1, ma = filtered.length*2, i;
    var curPath = (N96.tracks[N96.currentIdx] && N96.tracks[N96.currentIdx].path) || null;
    for (var j = 0; j < N96.tracks.length; j++) { if (N96.tracks[j] && N96.tracks[j].path === curPath) { cfi = filtered.indexOf(N96.tracks[j]); break; } }
    do { i = Math.floor(Math.random()*filtered.length); } while(i===cfi&&filtered.length>1&&--ma>0);
    var ngi2 = -1; for (var j = 0; j < N96.tracks.length; j++) { if (N96.tracks[j].path === filtered[i].path) { ngi2 = j; break; } }
    if (ngi2 !== -1) playNow(N96.tracks[ngi2], ngi2);
  } else {
    var nextI = N96.currentIdx + 1;
    if (nextI >= N96.tracks.length) {
      if (N96.repeatMode === "all") {
        nextI = 0; /* wrap around */
      } else {
        /* repeatMode === "none" — stop at end */
        N96.isPlaying = false;
        updatePlayPauseUI();
        if ("mediaSession" in navigator) navigator.mediaSession.playbackState = "paused";
        return;
      }
    }
    playNow(N96.tracks[nextI], nextI);
  }
}

function toggleShuffle() {
  N96.shuffleOn=!N96.shuffleOn;
  var b=$("#shuffle-btn"); if(b) b.classList.toggle("active",N96.shuffleOn);
  if (spotifyState.activePlaylistId) {
    if (N96.shuffleOn) {
      spotifyState.shuffleWindow = buildShuffleWindow(spotifyState.tracks.length);
      console.log("[spotify] shuffle ON - window: " + spotifyState.shuffleWindow.length + " tracks");
    } else {
      spotifyState.shuffleWindow = null;
      console.log("[spotify] shuffle OFF");
    }
  }
  var sb=document.getElementById("shuffle-btn");if(sb&&N96.shuffleOn){sb.style.transform="rotate(360deg)";setTimeout(function(){sb.style.transform="";},350);}
}

function toggleLayer(name) {
  if (ambientGains[name]) { 
    /* v70: Properly stop source + disconnect gain */
    if (ambientGains[name]._source) { try { ambientGains[name]._source.stop(); } catch(_) {} }
    ambientGains[name].disconnect(); 
    delete ambientGains[name]; 
    var btn = document.querySelector('.layer-btn[onclick*="'+name+'"]'); if(btn) btn.classList.remove("active"); 
    return; 
  }
  var ctx = audioCtx || new (window.AudioContext||webkitAudioContext)(); audioCtx = ctx;
  var bv=name==="rain"?0.15:name==="wind"?0.2:name==="pink"?0.3:name==="brown"?0.4:name==="thunder"?0.5:0.3;

  if (name === 'pink') {
    // Pink noise (1/f noise) using Voss-McCartney algorithm
    var len = ctx.sampleRate * 2;
    var buf = ctx.createBuffer(1, len, ctx.sampleRate);
    var d = buf.getChannelData(0);
    var b0, b1, b2, b3, b4, b5, b6;
    b0 = b1 = b2 = b3 = b4 = b5 = b6 = 0.0;
    for (var i = 0; i < len; i++) {
      var white = Math.random() * 2 - 1;
      b0 = 0.99886 * b0 + white * 0.0555179;
      b1 = 0.99332 * b1 + white * 0.0750759;
      b2 = 0.96900 * b2 + white * 0.1538520;
      b3 = 0.86650 * b3 + white * 0.3104856;
      b4 = 0.55000 * b4 + white * 0.5329522;
      b5 = -0.7616 * b5 - white * 0.0168980;
      d[i] = b0 + b1 + b2 + b3 + b4 + b5 + b6 + white * 0.5362;
      d[i] *= 0.11;
      b6 = white * 0.115926;
    }
    var src = ctx.createBufferSource();
    src.buffer = buf;
    src.loop = true;
    var gain = ctx.createGain();
    gain.gain.value = N96.ambientVolume * bv;
    src.connect(gain);
    gain.connect(ctx.destination);
    src.start();
    gain._source = src;  // v70: store source reference for proper cleanup
    ambientGains[name] = gain;
  }
  else if (name === 'brown') {
    // Brown noise (1/f² noise) — deeper than pink
    var len = ctx.sampleRate * 2;
    var buf = ctx.createBuffer(1, len, ctx.sampleRate);
    var d = buf.getChannelData(0);
    var lastOut = 0.0;
    for (var i = 0; i < len; i++) {
      var white = Math.random() * 2 - 1;
      d[i] = (lastOut + (0.02 * white)) / 1.02;
      lastOut = d[i];
      d[i] *= 3.5;
    }
    var src = ctx.createBufferSource();
    src.buffer = buf;
    src.loop = true;
    var gain = ctx.createGain();
    gain.gain.value = N96.ambientVolume * bv;
    src.connect(gain);
    gain.connect(ctx.destination);
    src.start();
    gain._source = src;  // v70: store source reference for proper cleanup
    ambientGains[name] = gain;
  }
  else if (name === 'thunder') {
    // Thunder — low-frequency rumble using filtered noise
    var len = ctx.sampleRate * 3;
    var buf = ctx.createBuffer(1, len, ctx.sampleRate);
    var d = buf.getChannelData(0);
    for (var i = 0; i < len; i++) {
      d[i] = Math.random() * 2 - 1;
    }
    var src = ctx.createBufferSource();
    src.buffer = buf;
    src.loop = true;
    var filter = ctx.createBiquadFilter();
    filter.type = 'lowpass';
    filter.frequency.value = 120;
    var gain = ctx.createGain();
    gain.gain.value = N96.ambientVolume * bv;
    src.connect(filter);
    filter.connect(gain);
    gain.connect(ctx.destination);
    src.start();
    gain._source = src;  // v70: store source reference for proper cleanup
    ambientGains[name] = gain;
  }
  else {
    // Original sounds: rain, wind, static
    var len = ctx.sampleRate * 2, buf = ctx.createBuffer(1, len, ctx.sampleRate), d = buf.getChannelData(0);
    for (var i = 0; i < len; i++) d[i] = Math.random() * 2 - 1;
    var src = ctx.createBufferSource(); src.buffer = buf; src.loop = true; var gain = ctx.createGain();
    gain.gain.value = N96.ambientVolume * bv;
    if (name === "rain") { var hp = ctx.createBiquadFilter(); hp.type = "highpass"; hp.frequency.value = 800; var lp = ctx.createBiquadFilter(); lp.type = "lowpass"; lp.frequency.value = 4000; src.connect(hp); hp.connect(gain); gain.connect(lp); lp.connect(ctx.destination); }
    else if (name === "wind") { var bp = ctx.createBiquadFilter(); bp.type = "bandpass"; bp.frequency.value = 300; src.connect(bp); bp.connect(gain); gain.connect(ctx.destination); }
    else { src.connect(gain); gain.connect(ctx.destination); }
    src.start();
    gain._source = src;  // v70: store source reference for proper cleanup
    ambientGains[name] = gain;
  }
  var btn2 = document.querySelector('.layer-btn[onclick*="'+name+'"]'); if(btn2) btn2.classList.add("active");
}

var avol = $("#ambient-vol-slider");
if (avol) avol.addEventListener("input",function(e){var vol=parseFloat(e.target.value); N96.ambientVolume=vol; Object.keys(ambientGains).forEach(function(name){var gain=ambientGains[name];if(gain){var bv=name==="rain"?0.15:name==="wind"?0.2:name==="pink"?0.3:name==="brown"?0.4:name==="thunder"?0.5:0.3;gain.gain.value=vol*bv;}});});

function setupSeekSlider() {
  var slider=$("#seek-slider"); if(!slider) return;
  function getPct(e) {
    var r = slider.getBoundingClientRect();
    var cx = 0;
    if (e.clientX !== undefined) { cx = e.clientX; }
    else if (e.touches && e.touches.length > 0) { cx = e.touches[0].clientX; }
    else if (e.changedTouches && e.changedTouches.length > 0) { cx = e.changedTouches[0].clientX; }
    return Math.max(0, Math.min(100, ((cx - r.left) / r.width) * 100));
  }
  function updateSeekUI(pct){if($("#seek-fill"))$("#seek-fill").style.width=pct+"%";slider.style.setProperty("--seek-pct",pct+"%");}
  function doSeek(pct){
    if(spotifyState.activePlaylistId||(N96.nowPlaying&&N96.nowPlaying.isYouTube)){if(ytPlayer&&ytReady){var dur=ytPlayer.getDuration();if(dur>0)ytPlayer.seekTo((pct/100)*dur,true);}}
    else if(player.src&&N96.duration>0){player.currentTime=(pct/100)*N96.duration;}
    updateSeekUI(pct);
  }
  slider.addEventListener("pointerdown",function(e){seekDragging=true;doSeek(getPct(e));var onMove=function(ev){if(seekDragging){ev.preventDefault();updateSeekUI(getPct(ev));}};var onUp=function(){seekDragging=false;document.removeEventListener("pointermove",onMove);document.removeEventListener("pointerup",onUp);};document.addEventListener("pointermove",onMove);document.addEventListener("pointerup",onUp);});
}

function initAurora() {
  var canvas=auroraCanvas; if(!canvas)return;var ctx=canvas.getContext("2d");
  var stars=[];var starCount=180;
  /* Regenerate stars to fill the current viewport */
  function regenerateStars(){
    var W=window.innerWidth,H=window.innerHeight;
    stars=[];
    for(var i=0;i<starCount;i++){
      stars.push({x:Math.random()*W,y:Math.random()*H*0.75,r:Math.random()+0.3,a:Math.random()*0.5+0.12,ts:0.002+Math.random()*0.007,p2:Math.random()*Math.PI*2});
    }
  }
  function resize(){
    var dpr=Math.min(window.devicePixelRatio||1,1.5);
    canvas.width=window.innerWidth*dpr;
    canvas.height=window.innerHeight*dpr;
    canvas.style.width=window.innerWidth+'px';
    canvas.style.height=window.innerHeight+'px';
    ctx.setTransform(dpr,0,0,dpr,0,0);
    /* CRITICAL: Regenerate stars with new positions for new canvas size */
    regenerateStars();
  }
  resize();
  /* Debounced resize listener to prevent performance issues */
  var resizeTimeout;
  window.addEventListener("resize",function(){clearTimeout(resizeTimeout);resizeTimeout=setTimeout(resize,150);});
  var waves=[{y:0.38,a:42,f:0.0026,s:0.00024,hue:currentAuroraPalette.waveHues[0]},{y:0.415,a:32,f:0.0032,s:-0.00018,hue:currentAuroraPalette.waveHues[1]},{y:0.35,a:58,f:0.0019,s:0.00032,hue:currentAuroraPalette.waveHues[2]}];
  var W0=window.innerWidth,H0=window.innerHeight;
  var blobs=[],i;for(i=0;i<6;i++){blobs.push({x:Math.random()*W0,y:H0*(0.25+Math.random()*0.3),r:90+Math.random()*130,hue:currentAuroraPalette.blobHueBase+Math.random()*44,vx:(Math.random()-0.5)*0.25,vy:-0.04-Math.random()*0.06,phase:Math.random()*Math.PI*2,ps:0.001+Math.random()*0.003});}
  var frame=0;
  function draw(timestamp){
    frame++;var W=window.innerWidth,H=window.innerHeight;var sg=ctx.createLinearGradient(0,0,0,H);sg.addColorStop(0,currentAuroraPalette.bgGradient[0]);sg.addColorStop(0.45,currentAuroraPalette.bgGradient[1]);sg.addColorStop(1,currentAuroraPalette.bgGradient[2]);ctx.fillStyle=sg;ctx.fillRect(0,0,W,H);for(i=0;i<blobs.length;i++){var b=blobs[i];b.x+=b.vx;b.y+=b.vy;var px=(mouseX-0.5)*20,py=(mouseY-0.5)*12;if(b.y<-80)b.vy=Math.abs(b.vy);if(b.x<-b.r*1.5)b.x=W+b.r*1.5;if(b.x>W+b.r*1.5)b.x=-b.r*1.5;var p=0.85+Math.sin(frame*b.ps+b.phase)*0.15;var g=ctx.createRadialGradient(b.x+px,b.y+py,0,b.x+px,b.y+py,b.r*p);g.addColorStop(0,"hsla("+b.hue+",60%,52%,0.1)");g.addColorStop(1,"rgba(0,0,0,0)");ctx.fillStyle=g;ctx.fillRect(b.x-b.r+px,b.y-b.r+py,b.r*2,b.r*2);}
    for(i=0;i<waves.length;i++){var w=waves[i],baseY=H*w.y;ctx.beginPath();for(var x=0;x<=W;x+=3){var dy=Math.sin(x*w.f+frame*w.s*60)*w.a+Math.sin(x*w.f*2.1+frame*w.s*1.6)*w.a*0.3;if(x===0)ctx.moveTo(x,baseY+dy);else ctx.lineTo(x,baseY+dy);}ctx.strokeStyle="hsla("+w.hue+",55%,48%,0.07)";ctx.lineWidth=26+Math.sin(frame*0.01+w.y*8)*10;ctx.shadowColor="hsla("+w.hue+",55%,45%,0.35)";ctx.shadowBlur=40;ctx.stroke();ctx.shadowBlur=0;}
    for(i=0;i<stars.length;i++){var s=stars[i],twk=Math.sin(frame*s.ts+s.p2)*0.5+0.5;ctx.beginPath();ctx.arc(s.x,s.y,s.r*(0.75+twk*0.3),0,Math.PI*2);ctx.fillStyle="rgba(215,228,245,"+(s.a+twk*0.25).toFixed(3)+")";ctx.fill();}
    /* v70: Use named RAF so we can cancel it */
    _auroraRAF = window.requestAnimationFrame(draw);
    _auroraRunning = true;
  }
  _auroraRAF = window.requestAnimationFrame(draw);
  _auroraRunning = true;
}

function initAnalyser() { if(analyser)return; try{if(!audioCtx)audioCtx=new(window.AudioContext||webkitAudioContext)();var src=audioCtx.createMediaElementSource(player);analyser=audioCtx.createAnalyser();analyser.fftSize=512;src.connect(analyser);analyser.connect(audioCtx.destination);drawSpectrum();}catch(e){} }
function drawSpectrum() { if(!analyser||!vizCanvas)return;var ctx=vizCanvas.getContext("2d");
  function render(timestamp){
    if(!analyser)return;
    var dpr=window.devicePixelRatio||1,rect=vizCanvas.getBoundingClientRect();vizCanvas.width=rect.width*dpr;vizCanvas.height=rect.height*dpr;ctx.setTransform(dpr,0,0,dpr,0,0);var W=rect.width,H=rect.height,bl=analyser.frequencyBinCount,da=new Uint8Array(bl);analyser.getByteFrequencyData(da);if(!window._vizSmooth)window._vizSmooth=new Float32Array(64);for(var si=0;si<64;si++){var raw=da[si*Math.floor(bl/64)]/255;window._vizSmooth[si]+=(raw-window._vizSmooth[si])*0.3;}var cx=W/2,cy=H/2,mr=Math.min(W,H)*0.4;ctx.clearRect(0,0,W,H);for(var i=0;i<64;i++){var v=window._vizSmooth[i],a=i*2*Math.PI/64-Math.PI/2,ir=mr*0.7,er=ir+v*mr*0.5;ctx.beginPath();ctx.moveTo(cx+Math.cos(a)*ir,cy+Math.sin(a)*ir);ctx.lineTo(cx+Math.cos(a)*er,cy+Math.sin(a)*er);var hue=200+v*200;if(hue>360)hue-=360;ctx.strokeStyle="hsla("+hue.toFixed(0)+","+(50+v*30)+"%,"+(40+v*35)+"%,0."+((0.6+v*0.4).toFixed(1))+")";ctx.lineWidth=Math.max(2,(W/64)*0.8);ctx.lineCap="round";ctx.shadowBlur=15;ctx.shadowColor="hsla("+hue.toFixed(0)+",80%,60%,0.8)";ctx.stroke();ctx.shadowBlur=0;}
    /* v70: Use named RAF so we can cancel it */
    _spectrumRAF = requestAnimationFrame(render);
    _spectrumRunning = true;
  }
  _spectrumRAF = requestAnimationFrame(render);
  _spectrumRunning = true;
 }

/* Update aurora palette to match the current data-theme.
   Called by toggleTheme() and on initial load. */
function updateAuroraTheme() {
  var theme = document.documentElement.getAttribute("data-theme") || "twilight";
  var newPalette = THEME_PALETTES[theme] || THEME_PALETTES.twilight;
  /* Smooth crossfade: lerp palette values over 500ms */
  if (!window._auroraTransition) {
    currentAuroraPalette = newPalette;
  } else {
    var startPalette = Object.assign({}, currentAuroraPalette);
    var startTime = performance.now();
    var duration = 500;
    function lerpPalette(now) {
      var t = Math.min((now - startTime) / duration, 1);
      var ease = 1 - Math.pow(1 - t, 3); /* ease-out cubic */
      currentAuroraPalette = {
        bgGradient: startPalette.bgGradient, /* gradient crossfade handled by canvas draw */
        waveHues: startPalette.waveHues.map(function(h, i) { return h + (newPalette.waveHues[i] - h) * ease; }),
        blobHueBase: startPalette.blobHueBase + (newPalette.blobHueBase - startPalette.blobHueBase) * ease,
        accentColor: t < 0.5 ? startPalette.accentColor : newPalette.accentColor
      };
      if (t < 1) requestAnimationFrame(lerpPalette);
      else currentAuroraPalette = newPalette;
    }
    requestAnimationFrame(lerpPalette);
  }
  window._auroraTransition = true;
  document.documentElement.style.setProperty("--accent", newPalette.accentColor);
}

function toggleTheme() { var h=document.documentElement,c=h.getAttribute("data-theme"),n=c==="twilight"?"dark":c==="dark"?"light":"twilight";h.setAttribute("data-theme",n);localStorage.setItem("n96-theme",n);updateAuroraTheme(); }

/* ═══════════════════════════════════════════════════════════════
   v70: Performance Mode (Minimal Mode) + Idle Optimization
   ═══════════════════════════════════════════════════════════════ */

/* Pause the aurora canvas animation loop */
function pauseAurora() {
  if (_auroraRAF) { cancelAnimationFrame(_auroraRAF); _auroraRAF = null; }
  _auroraRunning = false;
}

/* Resume the aurora canvas animation loop by re-initializing */
function resumeAurora() {
  if (_auroraRunning || N96.performanceMode) return;
  initAurora();
}

/* Pause the spectrum analyzer animation loop */
function pauseSpectrum() {
  if (_spectrumRAF) { cancelAnimationFrame(_spectrumRAF); _spectrumRAF = null; }
  _spectrumRunning = false;
}

/* Resume the spectrum analyzer animation loop */
function resumeSpectrum() {
  if (_spectrumRunning || N96.performanceMode) return;
  if (analyser && vizCanvas) drawSpectrum();
}

/* Stop and disconnect all active ambient sound generators */
function stopAllAmbient() {
  Object.keys(ambientGains).forEach(function(name) {
    var gain = ambientGains[name];
    if (gain) {
      try { gain.disconnect(); } catch(_) {}
      // Also try to stop the source node
      if (gain._source) { try { gain._source.stop(); } catch(_) {} }
    }
    var btn = document.querySelector('.layer-btn[onclick*="' + name + '"]');
    if (btn) btn.classList.remove("active");
  });
  ambientGains = {};
}

/* Apply or remove Performance Mode dynamically */
function applyPerformanceMode() {
  var perfBtn = document.getElementById('perf-mode-btn');
  if (N96.performanceMode) {
    // === PERFORMANCE MODE ON ===
    // Stop aurora background
    pauseAurora();
    if (auroraCanvas) auroraCanvas.style.display = 'none';

    // Stop spectrum analyzer
    pauseSpectrum();
    if (vizCanvas) vizCanvas.style.display = 'none';

    // Disconnect analyser node
    if (analyser) {
      try { analyser.disconnect(); } catch(_) {}
      analyser = null;
    }

    // Stop ambient sounds
    stopAllAmbient();

    if (perfBtn) perfBtn.classList.add('active');
    console.log('[N96] Performance Mode enabled — animations and ambient stopped');
  } else {
    // === PERFORMANCE MODE OFF ===
    // Restore aurora background
    if (auroraCanvas) auroraCanvas.style.display = '';
    initAurora();

    // Restore spectrum (will re-init analyser on next playback)
    if (vizCanvas) vizCanvas.style.display = '';

    // If currently playing local audio, re-init the spectrum analyzer
    if (N96.isPlaying && N96.nowPlaying && !N96.nowPlaying.isYouTube && !N96.nowPlaying.isSpotify) {
      initAnalyser();
    }

    if (perfBtn) perfBtn.classList.remove('active');
    console.log('[N96] Performance Mode disabled — animations restored');
  }
}

/* Toggle Performance Mode */
function togglePerformanceMode() {
  N96.performanceMode = !N96.performanceMode;
  // v71: If Ultra Mode is on, Performance Mode must stay on (Ultra is a superset)
  if (N96.ultraMode && !N96.performanceMode) {
    N96.performanceMode = true;
    showToast('Performance Mode stays on while Ultra Mode is active');
    return;
  }
  applyPerformanceMode();
  saveStateNow();
  showToast(N96.performanceMode ? 'Performance Mode on' : 'Performance Mode off');
}

/* ═══════════════════════════════════════════════════════════════
   v71: Ultra Mode (Audio Only) — maximum resource optimization
   Forces Performance Mode, shrinks video iframes to 1x1px via CSS
   (not display:none which breaks the YT IFrame API), kills all
   CSS animations/transitions, and reduces UI update frequency.
   ═══════════════════════════════════════════════════════════════ */

/* Normal seek bar update interval (ms) */
var SEEK_UPDATE_INTERVAL_NORMAL = 500;
/* Ultra Mode seek bar update interval (ms) — slower to save CPU */
var SEEK_UPDATE_INTERVAL_ULTRA = 2000;

/* Apply or remove Ultra Mode dynamically */
function applyUltraMode() {
  var ultraBtn = document.getElementById('ultra-mode-btn');
  var perfBtn = document.getElementById('perf-mode-btn');

  if (N96.ultraMode) {
    // === ULTRA MODE ON ===

    // Force Performance Mode on as well (Ultra is a superset)
    if (!N96.performanceMode) {
      N96.performanceMode = true;
      applyPerformanceMode();
      if (perfBtn) perfBtn.classList.add('active');
    }

    // Add .ultra-mode class to <body> for CSS rules
    document.body.classList.add('ultra-mode');

    // Ensure aurora and spectrum are fully stopped
    pauseAurora();
    if (auroraCanvas) auroraCanvas.style.display = 'none';
    pauseSpectrum();
    if (vizCanvas) vizCanvas.style.display = 'none';

    // Disconnect analyser node completely
    if (analyser) {
      try { analyser.disconnect(); } catch(_) {}
      analyser = null;
    }

    // Stop all ambient sounds
    stopAllAmbient();

    // Slow down the YouTube seek bar interval to save CPU
    if (spotifyState.ytSeekInterval) {
      clearInterval(spotifyState.ytSeekInterval);
      spotifyState.ytSeekInterval = setInterval(updateYouTubeSeekBar, SEEK_UPDATE_INTERVAL_ULTRA);
    }

    if (ultraBtn) ultraBtn.classList.add('active');
    console.log('[N96] Ultra Mode enabled — audio-only, all animations killed, UI updates reduced');
    // v73: Show track info in Ultra Mode, update counter
    updateUltraTrackInfo();
    updateTrackCounter();
    // v73: If currently in yt-player view, also show local now-playing for track info
    if (_getCurrentView() === 'yt-player') {
      var np = document.getElementById('now-playing');
      if (np) np.classList.remove('hidden');
    }
  } else {
    // === ULTRA MODE OFF ===

    // Remove .ultra-mode class from <body> — restores CSS animations/transitions
    document.body.classList.remove('ultra-mode');

    // Restore aurora canvas
    if (auroraCanvas) auroraCanvas.style.display = '';
    // Restore spectrum canvas
    if (vizCanvas) vizCanvas.style.display = '';

    // Restore normal seek bar interval
    if (spotifyState.ytSeekInterval) {
      clearInterval(spotifyState.ytSeekInterval);
      spotifyState.ytSeekInterval = setInterval(updateYouTubeSeekBar, SEEK_UPDATE_INTERVAL_NORMAL);
    }

    // If Performance Mode is still on, keep things minimal
    // (user may have toggled Ultra off but still want Performance Mode)
    if (N96.performanceMode) {
      applyPerformanceMode(); // re-apply perf mode styling without re-initializing
    } else {
      // Performance Mode is off — fully restore animations
      initAurora();
      if (N96.isPlaying && N96.nowPlaying && !N96.nowPlaying.isYouTube && !N96.nowPlaying.isSpotify) {
        initAnalyser();
      }
    }

    if (ultraBtn) ultraBtn.classList.remove('active');
    console.log('[N96] Ultra Mode disabled — full UI restored');
    // v73: Hide ultra track info overlay, restore view system
    updateUltraTrackInfo();
    updateTrackCounter();
    // Re-apply the correct center view (hide local if we were in yt-player)
    if (_getCurrentView() === 'yt-player') {
      var np = document.getElementById('now-playing');
      if (np) np.classList.add('hidden');
    }
  }
}

/* Toggle Ultra Mode */
function toggleUltraMode() {
  N96.ultraMode = !N96.ultraMode;
  applyUltraMode();
  saveStateNow();
  showToast(N96.ultraMode ? 'Ultra Mode on — audio only' : 'Ultra Mode off — full UI restored');
}

/* v70: Idle optimization — pause animations when music is paused */
function handlePlaybackAnimationState() {
  if (N96.performanceMode || N96.ultraMode) return;  // Already all paused
  if (N96.isPlaying) {
    // Resume animations
    if (!_auroraRunning) resumeAurora();
    if (!_spectrumRunning && analyser) resumeSpectrum();
  } else {
    // Pause animations when not playing (save CPU/GPU)
    if (_auroraRunning) pauseAurora();
    if (_spectrumRunning) pauseSpectrum();
  }
}

/* v70: Pause animations when tab is hidden, resume when visible */
function handleVisibilityChange() {
  if (N96.performanceMode || N96.ultraMode) return;
  if (document.hidden) {
    // Tab is hidden — pause all canvas animations
    if (_auroraRunning) pauseAurora();
    if (_spectrumRunning) pauseSpectrum();
  } else {
    // Tab is visible again — resume if playing
    if (N96.isPlaying) {
      if (!_auroraRunning) resumeAurora();
      if (!_spectrumRunning && analyser) resumeSpectrum();
    }
  }
}

document.addEventListener("DOMContentLoaded", function() {
  var saved = localStorage.getItem("n96-theme"); if(saved) document.documentElement.setAttribute("data-theme",saved);
  updateAuroraTheme(); initAurora(); setupSeekSlider(); loadTracks().then(function() { loadSavedState(); applyPerformanceMode(); applyUltraMode(); });
  applySidebarCollapseState(); renderCollectionsSidebar(); renderYtMixesSidebar(); initSpotify();
  // v75: Check if first run — auto-show Setup Wizard
  checkFirstRun();

  /* Sleep timer modal wiring */
  document.querySelectorAll(".sleep-preset").forEach(function(btn) {
    btn.addEventListener("click", function() {
      var mins = parseInt(btn.getAttribute("data-minutes"), 10);
      startSleepTimer(mins);
    });
  });
  var sleepStartBtn = $("#sleep-start-btn");
  if (sleepStartBtn) sleepStartBtn.addEventListener("click", function() {
    var input = $("#sleep-custom-input");
    var mins = parseInt(input ? input.value : "30", 10);
    if (mins > 0) startSleepTimer(mins);
  });
  var sleepCancelBtn = $("#sleep-cancel-btn");
  if (sleepCancelBtn) sleepCancelBtn.addEventListener("click", function() {
    cancelSleepTimer();
  });
  var sleepCloseBtn = $("#sleep-close-btn");
  if (sleepCloseBtn) sleepCloseBtn.addEventListener("click", closeSleepTimer);

  /* Pomodoro modal close button */
  var pomoCloseBtn = $("#pomo-close-btn");
  if (pomoCloseBtn) pomoCloseBtn.addEventListener("click", function() { var m = $("#pomodoro-modal"); if (m) { m.classList.add("hidden"); m.classList.remove("visible"); } });

  /* v57: Load saved state */
  /* MediaSession handlers */
  setupMediaSessionHandlers();

  /* Volume OSD */
  initVolumeOSD();

  /* v57: Hook state saving into playback events */
  player.addEventListener("timeupdate", function() {
    if (N96.isPlaying && player.currentTime > 0) {
      debouncedSaveState();
    }
  });
  player.addEventListener("play", function() { debouncedSaveState(); handlePlaybackAnimationState(); });
  player.addEventListener("pause", function() { debouncedSaveState(); handlePlaybackAnimationState(); });

  /* v57: Auto-save state periodically */
  setInterval(saveState, 30000);

  /* v69: Save state before leaving — flush any pending debounce */
  window.addEventListener("beforeunload", saveStateNow);

  /* v70: Pause animations when tab is hidden (idle optimization) */
  document.addEventListener("visibilitychange", handleVisibilityChange);

  /* v57: Global error handlers */
  window.addEventListener("error", function(e) {
    if (e.message && e.message.indexOf('ResizeObserver') === -1) {
      showToast('Error: ' + e.message, 'error');
    }
  });
  window.addEventListener("unhandledrejection", function(e) {
    // v68: Detect offline/network errors and show friendly message instead of generic error
    var msg = (e.reason && e.reason.message) || '';
    if (!navigator.onLine || msg.indexOf('Failed to fetch') !== -1 || msg.indexOf('NetworkError') !== -1 || msg.indexOf('Network request failed') !== -1) {
      e.preventDefault();  // Suppress the unhandled rejection
      showToast('Network error — you may be offline', 'warning');
      return;
    }
    showToast('Promise error', 'error');
  });
  window.addEventListener("online", function() { showToast('Back online', 'success'); });
  window.addEventListener("offline", function() { showToast('You are offline — some features may not work', 'warning'); });
});


/* ── Keyboard Shortcuts (v50) ── */
document.addEventListener("keydown", function(e) {
  /* Skip if user is typing in an input */
  var activeTag = document.activeElement ? document.activeElement.tagName : "";
  if (activeTag === "INPUT" || activeTag === "TEXTAREA" || document.activeElement.isContentEditable) return;
  
  switch(e.key) {
    case " ":
      e.preventDefault();
      togglePlayPause();
      break;
    case "ArrowLeft":
      e.preventDefault();
      seekRelative(-10);
      break;
    case "ArrowRight":
      e.preventDefault();
      seekRelative(10);
      break;
    case "ArrowUp":
      e.preventDefault();
      setVolume(N96.volume + 0.05);
      break;
    case "ArrowDown":
      e.preventDefault();
      setVolume(N96.volume - 0.05);
      break;
    case "s":
    case "S":
      toggleShuffle();
      showToast("Shuffle " + (N96.shuffleOn ? "ON" : "OFF"));
      break;
    case "r":
    case "R":
      toggleRepeat();
      break;
    case "m":
    case "M":
      toggleMuteAmbient();
      break;
    case "f":
    case "F":
      toggleFullscreen();
      break;
    case "t":
    case "T":
      openSleepTimer();
      break;
    case "p":
    case "P":
      togglePomodoroModal();
      break;
    case "Escape":
      closeAllOverlays();
      break;
    case "/":
      e.preventDefault();
      focusSearch();
      break;
  }
});

function seekRelative(seconds) {
  if (spotifyState.activePlaylistId && spotifyState.ytPlayer) {
    var yt = spotifyState.ytPlayer;
    if (yt && yt.seekTo) {
      var cur = yt.getCurrentTime ? yt.getCurrentTime() : 0;
      yt.seekTo(Math.max(0, cur + seconds), true);
    }
  } else if (ytPlayer && ytReady && ytPlayer.seekTo) {
    var cur = ytPlayer.getCurrentTime ? ytPlayer.getCurrentTime() : 0;
    ytPlayer.seekTo(Math.max(0, cur + seconds), true);
  } else if (player && player.duration) {
    player.currentTime = Math.max(0, Math.min(player.duration, player.currentTime + seconds));
  }
}

function setVolume(v) {
  v = Math.max(0, Math.min(1, v));
  N96.volume = v;
  if (player) player.volume = v;
  if (ytPlayer && ytReady) ytPlayer.setVolume(Math.round(v * 100));
  showVolumeOSD(v);
}

/* ── Volume OSD (GNOME-style) ──────────────────────────────────── */
var _volOsdTimer = null;

function showVolumeOSD(v) {
  var osd = document.getElementById("vol-osd");
  var fill = document.getElementById("vol-osd-fill");
  var slider = document.getElementById("vol-osd-slider");
  var pct = document.getElementById("vol-osd-pct");
  var icon = document.getElementById("vol-osd-icon");
  if (!osd) return;

  var p = Math.round(v * 100);
  if (fill) fill.style.width = p + "%";
  if (slider) slider.value = p;
  if (pct) pct.textContent = p;

  /* Update icon based on volume level */
  if (icon) {
    var svg;
    if (p === 0) {
      svg = '<svg width="22" height="22" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><polygon points="11 5 6 9 2 9 2 15 6 15 11 19 11 5"></polygon><line x1="23" y1="9" x2="17" y2="15"></line><line x1="17" y1="9" x2="23" y2="15"></line></svg>';
    } else if (p < 50) {
      svg = '<svg width="22" height="22" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><polygon points="11 5 6 9 2 9 2 15 6 15 11 19 11 5"></polygon><path d="M15.54 8.46a5 5 0 0 1 0 7.07"></path></svg>';
    } else {
      svg = '<svg width="22" height="22" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><polygon points="11 5 6 9 2 9 2 15 6 15 11 19 11 5"></polygon><path d="M19.07 4.93a10 10 0 0 1 0 14.14M15.54 8.46a5 5 0 0 1 0 7.07"></path></svg>';
    }
    icon.innerHTML = svg;
  }

  osd.classList.add("visible");
  osd.setAttribute("aria-hidden", "false");

  /* Auto-hide after 2 seconds */
  if (_volOsdTimer) clearTimeout(_volOsdTimer);
  _volOsdTimer = setTimeout(function() {
    osd.classList.remove("visible");
    osd.setAttribute("aria-hidden", "true");
  }, 2000);
}

/* Wire up the OSD slider once the DOM is ready */
function initVolumeOSD() {
  var slider = document.getElementById("vol-osd-slider");
  if (!slider) return;

  slider.value = Math.round(N96.volume * 100);

  slider.addEventListener("input", function() {
    var v = parseInt(this.value, 10) / 100;
    setVolume(v);
    /* Keep OSD visible while dragging — cancel auto-hide */
    if (_volOsdTimer) clearTimeout(_volOsdTimer);
  });

  slider.addEventListener("change", function() {
    /* Restart auto-hide timer when user releases */
    var osd = document.getElementById("vol-osd");
    if (_volOsdTimer) clearTimeout(_volOsdTimer);
    _volOsdTimer = setTimeout(function() {
      if (osd) { osd.classList.remove("visible"); osd.setAttribute("aria-hidden", "true"); }
    }, 1500);
  });

  /* Touch the OSD to keep it open longer */
  var osd = document.getElementById("vol-osd");
  if (osd) {
    osd.addEventListener("pointerenter", function() {
      if (_volOsdTimer) clearTimeout(_volOsdTimer);
    });
    osd.addEventListener("pointerleave", function() {
      if (_volOsdTimer) clearTimeout(_volOsdTimer);
      _volOsdTimer = setTimeout(function() {
        osd.classList.remove("visible");
        osd.setAttribute("aria-hidden", "true");
      }, 1200);
    });
  }
}

function toggleRepeat() {
  var modes = ["none", "all", "one"];
  var idx = modes.indexOf(N96.repeatMode);
  N96.repeatMode = modes[(idx + 1) % modes.length];
  var repeatBtn = document.getElementById("repeat-btn");
  if (repeatBtn) {
    repeatBtn.classList.toggle("active", N96.repeatMode !== "none");
    repeatBtn.textContent = N96.repeatMode === "one" ? "1" : "REP";
    repeatBtn.title = "Repeat: " + N96.repeatMode.toUpperCase();
  }
  showToast("Repeat: " + N96.repeatMode);
}

function toggleMuteAmbient() {
  N96.ambientMuted = !N96.ambientMuted;
  /* Iterate through ALL ambient gain nodes (rain, wind, static, pink, brown, thunder) */
  Object.keys(ambientGains).forEach(function(key) {
    var gain = ambientGains[key];
    if (gain && gain.gain) {
      if (N96.ambientMuted) {
        /* Save current value for restore, then mute */
        if (!gain._savedValue) gain._savedValue = gain.gain.value;
        gain.gain.value = 0;
      } else {
        /* Restore saved value or recalculate from ambientVolume */
        gain.gain.value = gain._savedValue || N96.ambientVolume * 0.3;
        delete gain._savedValue;
      }
    }
  });
  /* Also update ambient layer button visuals */
  document.querySelectorAll(".layer-btn").forEach(function(btn) {
    if (N96.ambientMuted) btn.style.opacity = "0.3";
    else btn.style.opacity = "";
  });
  showToast(N96.ambientMuted ? "Ambient sounds muted" : "Ambient sounds restored");
}

/* ── Sleep Timer (v52) ── */
var sleepTimerId = null;
var sleepEndTime = 0;
var sleepCountdownId = null;

function openSleepTimer() {
  var modal = $("#sleep-modal");
  if (!modal) return;
  modal.classList.add("visible");
  var status = $("#sleep-status");
  var cancelBtn = $("#sleep-cancel-btn");
  if (sleepTimerId) {
    if (status) status.style.display = "block";
    if (cancelBtn) cancelBtn.style.display = "";
    updateSleepCountdown();
  } else {
    if (status) status.style.display = "none";
    if (cancelBtn) cancelBtn.style.display = "none";
  }
}

function closeSleepTimer() {
  var modal = $("#sleep-modal");
  if (modal) modal.classList.remove("visible");
}

function startSleepTimer(minutes) {
  if (sleepTimerId) cancelSleepTimer();
  var ms = minutes * 60 * 1000;
  sleepEndTime = Date.now() + ms;
  showToast("Sleep timer: " + minutes + " min");
  
  /* Start countdown display */
  sleepCountdownId = setInterval(updateSleepCountdown, 1000);
  updateSleepCountdown();
  var status = $("#sleep-status");
  var cancelBtn = $("#sleep-cancel-btn");
  if (status) status.style.display = "block";
  if (cancelBtn) cancelBtn.style.display = "";
  
  /* Set the actual timer — fade out in the last 5 seconds */
  sleepTimerId = setTimeout(function() {
    fadeOutAndPause();
  }, ms - 5000);
  
  /* Update sleep button visual */
  var sleepBtn = document.getElementById("sleep-btn");
  if (sleepBtn) sleepBtn.classList.add("active");
}

function updateSleepCountdown() {
  var el = $("#sleep-countdown");
  if (!el) return;
  var remaining = Math.max(0, sleepEndTime - Date.now());
  var totalSec = Math.ceil(remaining / 1000);
  var h = Math.floor(totalSec / 3600);
  var m = Math.floor((totalSec % 3600) / 60);
  var s = totalSec % 60;
  if (h > 0) {
    el.textContent = h + ":" + pad(m) + ":" + pad(s);
  } else {
    el.textContent = pad(m) + ":" + pad(s);
  }
  if (remaining <= 0) {
    clearInterval(sleepCountdownId);
    sleepCountdownId = null;
  }
}

function cancelSleepTimer() {
  if (sleepTimerId) { clearTimeout(sleepTimerId); sleepTimerId = null; }
  if (sleepCountdownId) { clearInterval(sleepCountdownId); sleepCountdownId = null; }
  sleepEndTime = 0;
  var status = $("#sleep-status");
  var cancelBtn = $("#sleep-cancel-btn");
  if (status) status.style.display = "none";
  if (cancelBtn) cancelBtn.style.display = "none";
  var sleepBtn = document.getElementById("sleep-btn");
  if (sleepBtn) sleepBtn.classList.remove("active");
  showToast("Sleep timer cancelled");
}

function fadeOutAndPause() {
  /* Gradually reduce volume over 5 seconds, then pause */
  var steps = 50;
  var stepMs = 100;
  var originalVol = player.volume;
  var originalAmbientVol = N96.ambientVolume;
  var ytVol = (ytPlayer && ytReady) ? ytPlayer.getVolume() : 100;
  var i = 0;
  
  function fadeStep() {
    i++;
    var progress = i / steps;
    var factor = 1 - progress;
    
    /* Fade local audio */
    player.volume = originalVol * factor;
    
    /* Fade YouTube/Spotify */
    if (ytPlayer && ytReady && (N96.nowPlaying && N96.nowPlaying.isYouTube)) {
      ytPlayer.setVolume(Math.round(ytVol * factor));
    }
    
    /* Fade ambient */
    var newAmbientVol = originalAmbientVol * factor;
    Object.keys(ambientGains).forEach(function(key) {
      var gain = ambientGains[key];
      if (gain && gain.gain) {
        var bv = key === "rain" ? 0.15 : key === "wind" ? 0.2 : key === "pink" ? 0.3 : key === "brown" ? 0.4 : key === "thunder" ? 0.5 : 0.3;
        gain.gain.value = newAmbientVol * bv;
      }
    });
    
    if (i < steps) {
      setTimeout(fadeStep, stepMs);
    } else {
      /* Fully faded — pause everything */
      togglePlayPause();
      /* Restore volumes */
      player.volume = originalVol;
      N96.ambientVolume = originalAmbientVol;
      if (ytPlayer && ytReady) ytPlayer.setVolume(ytVol);
      Object.keys(ambientGains).forEach(function(key) {
        var gain = ambientGains[key];
        if (gain && gain.gain) {
          var bv = key === "rain" ? 0.15 : key === "wind" ? 0.2 : key === "pink" ? 0.3 : key === "brown" ? 0.4 : key === "thunder" ? 0.5 : 0.3;
          gain.gain.value = originalAmbientVol * bv;
        }
      });
      cancelSleepTimer();
      showToast("Sleep timer — paused");
    }
  }
  fadeStep();
}

function toggleFullscreen() {
  if (!document.fullscreenElement) {
    document.documentElement.requestFullscreen().catch(function(){});
  } else {
    document.exitFullscreen().catch(function(){});
  }
}

function closeAllOverlays() {
  /* Close modals */
  var modals = document.querySelectorAll(".modal-overlay.visible");
  modals.forEach(function(m) { m.classList.remove("visible"); m.classList.add("hidden"); });
  /* Also close pomodoro modal */
  var pomoModal = $("#pomodoro-modal");
  if (pomoModal && !pomoModal.classList.contains("hidden")) { pomoModal.classList.add("hidden"); pomoModal.classList.remove("visible"); }
  /* Close v57 panels */
  closeStatsPanel();
  /* Close panels */
  hidePanel();
  /* Close YouTube views if open */
  if (!$("#youtube-view").classList.contains("hidden")) closeYouTubeView();
  if (!$("#yt-player-container").classList.contains("hidden")) closeYouTubePlayer();
}

function focusSearch() {
  /* Focus the YouTube search if visible, else track search */
  var ytInput = $("#yt-search-input");
  var trackInput = $("#track-search-input");
  if (ytInput && !$("#youtube-view").classList.contains("hidden")) {
    ytInput.focus();
  } else if (trackInput) {
    showPanel(true);
    trackInput.focus();
  }
}


/* ── View Transition Helper (v50) ── */
function transitionView(showEl, hideEl, callback) {
  if (hideEl) {
    hideEl.classList.add("view-exit");
    setTimeout(function() {
      hideEl.classList.add("hidden");
      hideEl.classList.remove("view-exit", "view-active");
    }, 150);
  }
  if (showEl) {
    showEl.classList.remove("hidden");
    showEl.classList.add("view-enter");
    requestAnimationFrame(function() {
      requestAnimationFrame(function() {
        showEl.classList.remove("view-enter");
        showEl.classList.add("view-active");
      });
    });
  }
  if (callback) setTimeout(callback, 300);
}


/* ── Staggered List Animation (v50) ── */
function staggerAnimate(selector, container) {
  var parent = container || document;
  var items = parent.querySelectorAll(selector);
  items.forEach(function(item, i) {
    item.classList.remove("stagger-in");
    item.style.animationDelay = (i * 30) + "ms";
    requestAnimationFrame(function() {
      item.classList.add("stagger-in");
    });
  });
}


/* ═══════════════════════════════════════════════════════════════
   EXTERNAL SOURCES — YouTube IFrame Player + Search
   Three center-area views, only one visible at a time:
     #now-playing          → local Now Playing (visualizer + controls)
     #youtube-view         → YouTube search grid
     #yt-player-container  → YouTube embedded iframe player (also used by Spotify)
   ═══════════════════════════════════════════════════════════════ */
var ytSearchTimer = null;
var ytSearchInput = null;
var ytPlayer = null;       // YT.Player instance (created when API loads)
var ytReady = false;       // becomes true after YT.Player fires onReady
var ytPendingVideo = null; // queued video if user clicks before API is ready
var ytVideoLoaded = false; // tracks whether a video has been explicitly loaded (not just player init)

/* Called automatically by the YouTube IFrame API when it finishes loading. */
function onYouTubeIframeAPIReady() {
  if (typeof YT === "undefined" || !YT.Player) {
    setTimeout(onYouTubeIframeAPIReady, 200);
    return;
  }
  ytPlayer = new YT.Player("yt-player", {
    height: "100%",
    width: "100%",
    playerVars: {
      autoplay: 0,
      controls: 1,
      rel: 0,
      modestbranding: 1,
      playsinline: 1,
      iv_load_policy: 3
    },
    events: {
      onReady: onYTReady,
      onStateChange: onYTStateChange,
      onError: onYTError
    }
  });
}

function onYTReady() {
  ytReady = true;
  if (ytPendingVideo) {
    var v = ytPendingVideo;
    ytPendingVideo = null;
    ytPlayer.loadVideoById(v.id);
    ytVideoLoaded = true;
  }
}

/* State change handler — forks behavior based on whether we're in
   Spotify mode (auto-advance on ENDED) or regular YouTube mix mode (manual). */
function onYTStateChange(e) {
  var container = document.getElementById('yt-player-container');
  if (e.data === YT.PlayerState.PLAYING) {
    N96.isPlaying = true;
    if (container) container.classList.add('video-active');
  } else if (e.data === YT.PlayerState.PAUSED) {
    N96.isPlaying = false;
    if (container) container.classList.remove('video-active');
  } else if (e.data === YT.PlayerState.ENDED) {
    N96.isPlaying = false;
    if (container) container.classList.remove('video-active');
    // AUTO-ADVANCE: Spotify mode > YouTube Playlist mode > regular mix
    if (spotifyState.activePlaylistId) {
      console.log("[spotify] track ended — auto-advancing");
      spotifyAdvance(1);
    } else if (ytPlaylistState.active) {
      // v74: YouTube Playlist auto-advance
      console.log("[yt-playlist] video ended — auto-advancing to next");
      ytPlaylistAdvance();
    } else {
      console.log("[youtube] mix ended - auto-advancing to next mix");
      playNext();
    }
  }
  // v73: Update ultra track info when YT state changes (play/pause/end)
  updateUltraTrackInfo();
  updateTrackCounter();
}

/* Error handler — forks based on Spotify mode / YouTube Playlist mode.
   In Spotify mode: 101/150 (embedding disabled) is treated as a missing
   track. We mark it failed, toast the user, and auto-advance. NO error modal.
   In YouTube Playlist mode: similar — skip and advance to next video.
   Outside both: show the error modal as before. */
function onYTError(e) {
  // Ignore error code 2 (Invalid video ID) if no video has been explicitly
  // loaded yet — this fires when the player is first initialized without a
  // video and is harmless. We use ytVideoLoaded flag because N96.nowPlaying
  // may already be set during state restore before the video is actually loaded.
  // Check BEFORE console.error so the init noise doesn't pollute the console.
  if (e.data === 2 && !ytVideoLoaded) {
    // Silently ignore — the player fires this when created with no videoId
    return;
  }

  console.error("YouTube player error:", e.data);
  var inSpotifyMode = !!spotifyState.activePlaylistId;
  var inYtPlaylistMode = ytPlaylistState.active;
  var isEmbeddingError = (e.data === 101 || e.data === 150);

  if (inSpotifyMode) {
    // Spotify mode — never show error modal, always skip+advance
    var spotId = spotifyState.currentTrack && spotifyState.currentTrack.spotId;
    var title = spotifyState.currentTrack ? (spotifyState.currentTrack.title + " — " + spotifyState.currentTrack.artist) : "current track";
    if (spotId) {
      spotifyState.failedTracks[spotId] = true;
      console.warn("[spotify] marking failed (YT err " + e.data + "):", spotId);
    }
    var reason = isEmbeddingError ? "embedding disabled" : ("YT error " + e.data);
    showToast("Skipped — " + title + " (" + reason + ")");
    spotifyAdvance(1);
    return;
  }

  // v74: YouTube Playlist mode — skip and auto-advance (like Spotify)
  if (inYtPlaylistMode) {
    var currentVideo = ytPlaylistState.videos[ytPlaylistState.currentIndex];
    var ytTitle = currentVideo ? currentVideo.title : "current video";
    var ytReason = isEmbeddingError ? "embedding disabled" : ("YT error " + e.data);
    showToast("Skipped — " + ytTitle + " (" + ytReason + ")");
    ytPlaylistAdvance();
    return;
  }

  // Regular YouTube mix mode — show modal
  var msg = "YouTube video could not be played.";
  if (e.data === 2) msg = "Invalid video ID.";
  else if (e.data === 5) msg = "HTML5 player error.";
  else if (e.data === 100) msg = "Video not found or private.";
  else if (e.data === 101 || e.data === 150) msg = "Video owner does not allow embedded playback.";
  showErrorModal(msg);
}

/* ── View switching helper ── */
function showCenterView(view) {
  // v21: Theater Mode — controls-bar is a sibling, toggled independently
  var np = $("#now-playing");
  np.classList.toggle("hidden", view !== "local");

  // Controls bar visible in yt-player and local views, hidden during yt-search
  var cb = $("#controls-bar");
  if (cb) cb.classList.toggle("hidden", view === "yt-search");

  $("#youtube-view").classList.toggle("hidden", view !== "yt-search");
  $("#yt-player-container").classList.toggle("hidden", view !== "yt-player");
  // External source restore card (shown on refresh instead of embedding)
  $("#ext-source-card").classList.toggle("hidden", view !== "ext-source");
  // Spotify progress indicator only shows in yt-player view AND in Spotify mode
  var sp = $("#spotify-progress");
  if (sp) sp.classList.toggle("hidden", !(view === "yt-player" && spotifyState.activePlaylistId));
}

/* ═══════════════════════════════════════════════════════════════
   SIDEBAR — strict 3-way accordion (PLAYLISTS / YOUTUBE MIXES / SPOTIFY)
   Expanding any one of the three collapsibles collapses the other two.
   MY COLLECTIONS is independent — it toggles on its own, never auto-collapsed
   by the accordion. This lets users keep it open as a drop target.
   EXTERNAL SOURCES is always expanded (not part of the accordion).
   Collapse state persisted in localStorage key: n96-sidebar-collapsed
   ═══════════════════════════════════════════════════════════════ */
var SIDEBAR_COLLAPSED_KEY = "n96-sidebar-collapsed";
/* Accordion sections — only these three auto-collapse each other.
   Collections is separate so it stays open as a drag-drop target. */
var ACCORDION_SECTIONS = ["playlists-section", "yt-mixes-section", "spotify-section"];
/* Independent section — toggles on its own, not part of the accordion. */
var INDEPENDENT_SECTIONS = ["collections-section"];

function getCollapsedSections() {
  try {
    var raw = localStorage.getItem(SIDEBAR_COLLAPSED_KEY);
    return raw ? JSON.parse(raw) : [];
  } catch(_) { return []; }
}

function setCollapsedSections(arr) {
  try { localStorage.setItem(SIDEBAR_COLLAPSED_KEY, JSON.stringify(arr)); } catch(_) {}
}

/* Toggle a sidebar section. Accordion sections auto-collapse each other.
   Independent sections (like Collections) simply toggle without affecting others. */
function toggleSidebarSection(sectionId) {
  var isAccordion = ACCORDION_SECTIONS.indexOf(sectionId) !== -1;
  var isIndependent = INDEPENDENT_SECTIONS.indexOf(sectionId) !== -1;
  if (!isAccordion && !isIndependent) return;
  var el = document.getElementById(sectionId);
  if (!el) return;
  var collapsed = getCollapsedSections();
  var isCurrentlyCollapsed = collapsed.indexOf(sectionId) !== -1;

  if (isIndependent) {
    /* Independent sections just toggle themselves — no accordion effect */
    if (isCurrentlyCollapsed) {
      collapsed.splice(collapsed.indexOf(sectionId), 1);
      el.classList.remove("collapsed");
    } else {
      collapsed.push(sectionId);
      el.classList.add("collapsed");
    }
  } else if (isCurrentlyCollapsed) {
    // Expanding an accordion section → collapse the other accordion sections
    collapsed.splice(collapsed.indexOf(sectionId), 1);
    el.classList.remove("collapsed");
    for (var i = 0; i < ACCORDION_SECTIONS.length; i++) {
      var other = ACCORDION_SECTIONS[i];
      if (other === sectionId) continue;
      var otherEl = document.getElementById(other);
      if (otherEl && collapsed.indexOf(other) === -1) {
        collapsed.push(other);
        otherEl.classList.add("collapsed");
      }
    }
  } else {
    // Collapsing this one — leave the others as they are
    collapsed.push(sectionId);
    el.classList.add("collapsed");
  }
  setCollapsedSections(collapsed);
  var header=el.querySelector(".collapsible-header");if(header)header.setAttribute("aria-expanded",el.classList.contains("collapsed")?"false":"true");
}

function applySidebarCollapseState() {
  var collapsed = getCollapsedSections();
  ACCORDION_SECTIONS.forEach(function(id) {
    var el = document.getElementById(id);
    if (!el) return;
    if (collapsed.indexOf(id) !== -1) el.classList.add("collapsed");
    else el.classList.remove("collapsed");
  });
  INDEPENDENT_SECTIONS.forEach(function(id) {
    var el = document.getElementById(id);
    if (!el) return;
    if (collapsed.indexOf(id) !== -1) el.classList.add("collapsed");
    else el.classList.remove("collapsed");
  });
}

/* ── Expand the correct sidebar section for the restored source type ──
   Called on page refresh so the user can see which playlist the song belongs to. */
function expandSidebarForSource(sourceType) {
  var sectionId;
  if (sourceType === 'youtube') {
    sectionId = 'yt-mixes-section';
  } else if (sourceType === 'spotify') {
    sectionId = 'spotify-section';
  } else {
    return;
  }
  var el = document.getElementById(sectionId);
  if (!el) return;
  var collapsed = getCollapsedSections();
  // If the section is collapsed, expand it (which collapses others via accordion)
  if (collapsed.indexOf(sectionId) !== -1) {
    toggleSidebarSection(sectionId);
  }
  // Scroll the active item into view after a short delay
  setTimeout(function() {
    var activeItem = el.querySelector('.mix-item.active, .spotify-playlist-item.active');
    if (activeItem) {
      activeItem.scrollIntoView({ behavior: 'smooth', block: 'nearest' });
    }
  }, 300);
}

/* ═══════════════════════════════════════════════════════════════
   MY YOUTUBE MIXES — localStorage-backed collection
   Storage key: "n96-yt-mixes"
   ═══════════════════════════════════════════════════════════════ */
var YT_MIXES_KEY = "n96-yt-mixes";

var YT_MIXES_SEED = [
  { id: "yHATVnUSH1E", name: "", title: "", author: "" },
  { id: "Vp1grPbjmac", name: "", title: "", author: "" },
  { id: "5IfuDxHEWr8", name: "", title: "", author: "" },
  { id: "sWOrd50HYa4", name: "", title: "", author: "" },
  { id: "e6JqYyFJEn8", name: "", title: "", author: "" },
  { id: "xpvjPsme8_k", name: "", title: "", author: "" },
  { id: "ewTak16HTHs", name: "", title: "", author: "" },
  { id: "WjPUgEDQ4yE", name: "", title: "", author: "" },
  { id: "62riS_LbX0k", name: "", title: "", author: "" },
  { id: "HRCfnvxpYP8", name: "", title: "Nervous System Regulation (999 Hz)", author: "Malte Marten" },
  { id: "j_3C0z96GE0", name: "", title: "Healing Frequency Meditation (1111 Hz)", author: "Malte Marten & Lynxk" },
  { id: "FtukH_bCDHg", name: "", title: "Binaural / Gamma Focus", author: "" },
  { id: "tAIiXRZNh9E", name: "", title: "Binaural / Gamma Focus", author: "" },
  { id: "Pl9yZpL_-wA", name: "", title: "Effortless Flow State | Deep Tech House", author: "Jason Lewis - Mind Amend" },
  { id: "0D2WnhG-KmA", name: "", title: "Left-Brain Focus for ADHD Brains | Deep House", author: "Jason Lewis - Mind Amend" },
  { id: "zgltlEF-csA", name: "", title: "Peak Focus for Complex Tasks | Deep House + Isochronic Tones", author: "Jason Lewis - Mind Amend" },
  { id: "wELOA2U7FPQ", name: "", title: "Upbeat Study Music - Deep Focus for Complex Tasks", author: "Jason Lewis - Mind Amend" },
  { id: "A6dzSX62gEY", name: "", title: "Mind Amend Focus Track", author: "Jason Lewis - Mind Amend" },
  { id: "z76q-aENBTg", name: "", title: "Mind Amend Focus Track", author: "Jason Lewis - Mind Amend" },
  { id: "6W3AfU2X8Vw", name: "", title: "Mind Amend Focus Track", author: "Jason Lewis - Mind Amend" }
];

function loadMixes() {
  try {
    var raw = localStorage.getItem(YT_MIXES_KEY);
    if (raw) {
      var parsed = JSON.parse(raw);
      for (var i = 0; i < parsed.length; i++) {
        if (!parsed[i].hasOwnProperty("name")) parsed[i].name = "";
      }
      return parsed;
    }
  } catch(_) {}
  var seed = YT_MIXES_SEED.map(function(m, i) {
    return Object.assign({ addedAt: Date.now() + i, thumbnail: "", duration: "" }, m);
  });
  saveMixes(seed);
  return seed;
}

function saveMixes(mixes) {
  try { localStorage.setItem(YT_MIXES_KEY, JSON.stringify(mixes)); } catch(_) {}
}

function isMixSaved(id) {
  return loadMixes().some(function(m) { return m.id === id; });
}

function mixDisplayName(m) {
  if (m.name && m.name.trim()) return m.name.trim();
  if (m.title && m.title.trim()) return m.title.trim();
  return "Loading…";
}

function renderYtMixesSidebar() {
  var list = document.getElementById("yt-mixes-list");
  if (!list) {
    console.error("[N96] renderYtMixesSidebar: #yt-mixes-list element not found in DOM");
    return;
  }
  var mixes = loadMixes();
  console.log("[N96] renderYtMixesSidebar: rendering " + mixes.length + " mixes");
  // v74: Preserve all .mix-add-btn elements (Add Mix + Load Playlist)
  var addBtns = list.querySelectorAll(".mix-add-btn");
  list.innerHTML = "";
  for (var a = 0; a < addBtns.length; a++) {
    list.appendChild(addBtns[a]);
  }
  if (addBtns.length === 0) console.warn("[N96] .mix-add-btn not found — sidebar buttons may be missing");

  for (var i = 0; i < mixes.length; i++) {
    var m = mixes[i];
    var isActive = (N96.nowPlaying && N96.nowPlaying.isYouTube && !N96.nowPlaying.isSpotify && N96.nowPlaying.videoId === m.id) ? "active" : "";
    var item = document.createElement("button");
    item.className = "mix-item " + isActive;
    item.setAttribute("data-id", m.id);
    item.innerHTML =
      '<span class="mix-icon"><svg width="12" height="12" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><path d="M9 18V5l12-2v13"></path><circle cx="6" cy="18" r="3"></circle><circle cx="18" cy="16" r="3"></circle></svg></span>' +
      '<span class="mix-name">' + esc(mixDisplayName(m)) + '</span>' +
      '<span class="mix-delete" title="Remove this mix"><svg width="12" height="12" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><line x1="18" y1="6" x2="6" y2="18"></line><line x1="6" y1="6" x2="18" y2="18"></line></svg></span>';
    (function(mix){
      item.addEventListener("click", function(e){
        // Use closest() to handle clicks on SVG children inside .mix-delete
        if (e.target.closest(".mix-delete")) {
          e.stopPropagation();
          deleteMix(mix.id);
          return;
        }
        playYouTube({
          id: mix.id,
          title: mixDisplayName(mix),
          author: mix.author || "",
          duration: mix.duration || ""
        });
      });
    })(m);
    list.appendChild(item);
  }
  refreshMissingMixMetadata();
  makeSidebarItemsDraggable();
}

function refreshMissingMixMetadata() {
  var mixes = loadMixes();
  var needsUpdate = mixes.filter(function(m) { return (!m.title || !m.thumbnail) && !m._fetching; });
  for (var i = 0; i < needsUpdate.length; i++) {
    (function(m){
      // v68: Re-check the mix still exists before marking as fetching
      var all = loadMixes();
      var found = false;
      for (var j = 0; j < all.length; j++) {
        if (all[j].id === m.id) { all[j]._fetching = true; found = true; break; }
      }
      if (!found) return;  // Mix was deleted while this function was queued
      saveMixes(all);

      fetch("/api/youtube/info?id=" + encodeURIComponent(m.id))
        .then(function(r){ return r.json(); })
        .then(function(info){
          if (!info || info.error) return;
          var current = loadMixes();
          // v68: Check the mix still exists before updating (may have been deleted)
          var stillExists = false;
          for (var k = 0; k < current.length; k++) {
            if (current[k].id === m.id) {
              if (!current[k].title)    current[k].title    = info.title;
              if (!current[k].thumbnail) current[k].thumbnail = info.thumbnail;
              if (!current[k].duration) current[k].duration = info.duration;
              if (!current[k].author)   current[k].author   = info.author;
              current[k]._fetching = false;
              stillExists = true;
              break;
            }
          }
          saveMixes(current);
          // v68: Only re-render if the mix still exists (avoids re-adding deleted mixes)
          if (stillExists) renderYtMixesSidebar();
        })
        .catch(function(e){
          console.log("[mixes] metadata fetch failed for", m.id, e);
          var cur = loadMixes();
          for (var k = 0; k < cur.length; k++) {
            if (cur[k].id === m.id) { cur[k]._fetching = false; break; }
          }
          saveMixes(cur);
        });
    })(needsUpdate[i]);
  }
}

function extractYouTubeId(input) {
  input = (input || "").trim();
  if (!input) return null;
  var m;
  if ((m = input.match(/youtu\.be\/([a-zA-Z0-9_-]{11})/))) return m[1];
  if ((m = input.match(/[?&]v=([a-zA-Z0-9_-]{11})/))) return m[1];
  if ((m = input.match(/youtube\.com\/embed\/([a-zA-Z0-9_-]{11})/))) return m[1];
  if ((m = input.match(/youtube\.com\/shorts\/([a-zA-Z0-9_-]{11})/))) return m[1];
  if (/^[a-zA-Z0-9_-]{11}$/.test(input)) return input;
  return null;
}

function addMixFromUrl(name, url) {
  var id = extractYouTubeId(url);
  if (!id) {
    var err = $("#yt-add-error");
    if (err) err.textContent = "Could not find a valid YouTube link. Please paste a full YouTube URL.";
    return false;
  }
  if (isMixSaved(id)) {
    var err2 = $("#yt-add-error");
    if (err2) err2.textContent = "This mix is already in your collection.";
    return false;
  }
  var mixes = loadMixes();
  mixes.push({
    id: id,
    name: (name || "").trim(),
    title: "",
    author: "",
    thumbnail: "",
    duration: "",
    addedAt: Date.now()
  });
  saveMixes(mixes);
  renderYtMixesSidebar();
  return true;
}

function deleteMix(id) {
  var mixes = loadMixes().filter(function(m) { return m.id !== id; });
  saveMixes(mixes);
  renderYtMixesSidebar();
  // v68: Save state too so the mix list persists across page refreshes
  saveStateNow();
}

function openAddMixModal() {
  console.log("[N96] openAddMixModal called");
  var modal = $("#yt-add-modal");
  if (!modal) { console.error("[N96] #yt-add-modal not found in DOM"); return; }
  modal.classList.add("visible");
  var name = $("#yt-add-name");
  var input = $("#yt-add-input");
  var err = $("#yt-add-error");
  if (name)  { name.value  = ""; }
  if (input) { input.value = ""; }
  if (err)   { err.textContent = ""; }
  setTimeout(function(){ if (name) name.focus(); }, 100);
}

function closeAddMixModal() {
  $("#yt-add-modal").classList.remove("visible");
}

function toggleMixFromCard(btn) {
  var card = btn.closest(".yt-card");
  if (!card) return;
  var id = card.getAttribute("data-id");
  if (isMixSaved(id)) {
    deleteMix(id);
    btn.classList.remove("saved");
    btn.innerHTML = "+";
    btn.title = "Add to My Mixes";
  } else {
    var mixes = loadMixes();
    mixes.push({
      id: id,
      name: "",
      title: card.getAttribute("data-title") || "",
      author: card.getAttribute("data-author") || "",
      duration: card.getAttribute("data-duration") || "",
      thumbnail: card.getAttribute("data-thumb") || "",
      addedAt: Date.now()
    });
    saveMixes(mixes);
    renderYtMixesSidebar();
    btn.classList.add("saved");
    btn.innerHTML = '<svg width="12" height="12" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><polyline points="20 6 9 17 4 12"></polyline></svg>';
    btn.title = "Saved — click to remove";
  }
}

function openYouTubeSearch() {
  console.log("[N96] openYouTubeSearch() called — hiding panel + showing YouTube search");
  lastYouTubeSearchOpen = Date.now();
  hidePanel();
  showCenterView("yt-search");
  $$(".source-btn").forEach(function(b){ b.classList.remove("active"); });
  $("#yt-source-btn").classList.add("active");
  setTimeout(function(){ if (ytSearchInput) ytSearchInput.focus(); }, 100);
}

function openYouTubeView() { openYouTubeSearch(); }

function closeYouTubeView() {
  showCenterView("local");
  $("#yt-source-btn").classList.remove("active");
}

function closeYouTubePlayer() {
  if (ytPlayer && ytReady) {
    try { ytPlayer.pauseVideo(); } catch(_) {}
  }
  // If we were in Spotify mode, fully exit it
  if (spotifyState.activePlaylistId) {
    stopSpotifyCompletely();
    // v73: update UI after Spotify exit
    updateUltraTrackInfo();
    updateTrackCounter();
    return;
  }
  // v74: Clear YouTube playlist state if active
  if (ytPlaylistState.active) {
    stopYtPlaylist();
  }
  showCenterView("local");
  $("#yt-source-btn").classList.remove("active");
  N96.nowPlaying = null;
  N96.isPlaying = false;
  renderYtMixesSidebar();
  // v73: update UI after YouTube exit
  updateUltraTrackInfo();
  updateTrackCounter();
}

/* ── Fully stop YouTube and return to local mode ──
   Called when user clicks a local track or playlist while YT is active. */
function stopYouTubeCompletely() {
  if (ytPlayer && ytReady) { try { ytPlayer.stopVideo(); } catch(_) {} }
  stopYTSeekBar();
  // v74: Clear YouTube playlist state if active
  if (ytPlaylistState.active) {
    stopYtPlaylist();
  }
  showCenterView("local");
  $("#yt-source-btn").classList.remove("active");
  N96.nowPlaying = null;
  N96.isPlaying = false;
  N96.currentIdx = -1;
  renderYtMixesSidebar();
  // v73: update UI after YouTube stop
  updateUltraTrackInfo();
  updateTrackCounter();
}

function openSpotifyView() {
  // If creds aren't configured, show the error modal explaining how to set them.
  // Otherwise, expand the Spotify sidebar section (accordion: collapses the other two).
  if (!spotifyState.configured) {
    showErrorModal(
      "Spotify integration is not configured.\n" +
      "Set SPOTIFY_CLIENT_ID and SPOTIFY_CLIENT_SECRET environment variables on the server, then restart."
    );
    return;
  }
  // Make sure the section is visible by expanding it (collapses the other two).
  var el = document.getElementById("spotify-section");
  if (el && el.classList.contains("collapsed")) {
    toggleSidebarSection("spotify-section");
  }
  // Highlight the source button briefly so the user sees the connection
  $$(".source-btn").forEach(function(b){ b.classList.remove("active"); });
  $("#sp-source-btn").classList.add("active");
  setTimeout(function(){ $("#sp-source-btn").classList.remove("active"); }, 1200);
}

/* ── YouTube search (debounced) ── */
async function ytSearch(q) {
  q = (q || "").trim();
  console.log("[N96] ytSearch: '" + q + "'");
  if (!q) {
    $("#yt-grid").innerHTML = '<div class="yt-empty">Type to search YouTube.</div>';
    return;
  }
  var skelHtml="";for(var si=0;si<8;si++){skelHtml+='<div class="yt-skeleton-card"><div class="yt-skeleton-thumb"></div><div class="yt-skeleton-text"><div class="yt-skeleton-line w80"></div><div class="yt-skeleton-line w60"></div><div class="yt-skeleton-line w40"></div></div></div>';}$("#yt-grid").innerHTML=skelHtml;
  try {
    var res = await fetch("/api/youtube/search?q=" + encodeURIComponent(q));
    console.log("[N96] ytSearch: HTTP " + res.status);
    if (!res.ok) throw new Error("HTTP " + res.status);
    var videos = await res.json();
    console.log("[N96] ytSearch: got " + (videos ? videos.length : 0) + " results");
    if (!videos || videos.length === 0) {
      $("#yt-grid").innerHTML = '<div class="yt-empty">No results found for "' + esc(q) + '".</div>';
      return;
    }
    renderYtGrid(videos);
  } catch (e) {
    $("#yt-grid").innerHTML = '<div class="yt-empty">Search failed: ' + esc(e.message) + '</div>';
    console.error("[N96] YouTube search error:", e);
  }
}

function renderYtGrid(videos) {
  if (!videos || videos.length === 0) {
    $("#yt-grid").innerHTML = '<div class="empty-state"><svg width="48" height="48" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.5" stroke-linecap="round" stroke-linejoin="round"><circle cx="11" cy="11" r="8"></circle><line x1="21" y1="21" x2="16.65" y2="16.65"></line></svg><h4>No Results</h4><p>Try a different search term.</p></div>';
    return;
  }
  console.log('[N96] renderYtGrid: received', videos.length, 'videos');
  if (videos.length > 0) console.log('[N96] first video thumbnail:', videos[0].thumbnail);
  var thumbPlaceholder = "data:image/svg+xml,%3Csvg xmlns='http://www.w3.org/2000/svg' width='320' height='180'%3E%3Crect fill='%231a1f2e' width='320' height='180'/%3E%3Ctext fill='%237fd1a4' x='50%25' y='50%25' dominant-baseline='middle' text-anchor='middle' font-size='14'%3ENo Thumbnail%3C/text%3E%3C/svg%3E";
  var html = "";
  for (var i = 0; i < videos.length; i++) {
    var v = videos[i] || {};
    var saved = isMixSaved(v.id) ? "saved" : "";
    var saveIcon = saved ? '<svg width="12" height="12" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><polyline points="20 6 9 17 4 12"></polyline></svg>' : "+";
    var saveTitle = saved ? "Saved — click to remove" : "Add to My Mixes";
    var thumbSrc = v.thumbnail || '';
    // Fallback: use YouTube's default thumbnail if empty or broken
    if (!thumbSrc || thumbSrc === 'NA') thumbSrc = 'https://img.youtube.com/vi/' + v.id + '/mqdefault.jpg';
    html +=
      '<div class="yt-card" ' +
        'data-id="'       + esc(v.id)       + '" ' +
        'data-title="'    + esc(v.title)    + '" ' +
        'data-author="'   + esc(v.author||"") + '" ' +
        'data-duration="' + esc(v.duration||"") + '" ' +
        'data-thumb="'    + esc(v.thumbnail||"") + '">' +
        '<button class="yt-card-save ' + saved + '" onclick="event.stopPropagation();toggleMixFromCard(this)" title="' + saveTitle + '">' + saveIcon + '</button>' +
        (thumbSrc
          ? '<img class="yt-thumb" src="' + esc(thumbSrc) + '" alt="" loading="lazy" onerror="this.onerror=null;this.src=\''+thumbPlaceholder+'\'">'
          : '<div class="yt-thumb-placeholder">No Thumbnail</div>') +
        '<div class="yt-info">' +
          '<div class="yt-title">' + esc(v.title||"Untitled") + '</div>' +
          '<div class="yt-meta">' +
            (v.duration ? '<span class="yt-duration">' + esc(v.duration) + '</span>' : '') +
            '<span>' + esc(v.author||"") + '</span>' +
          '</div>' +
        '</div>' +
      '</div>';
  }
  $("#yt-grid").innerHTML = html;
  staggerAnimate(".yt-card", $("#yt-grid"));

  var cards = $$(".yt-card");
  for (var i = 0; i < cards.length; i++) {
    (function(card){
      card.addEventListener("click", function(){
        playYouTube({
          id:       card.getAttribute("data-id"),
          title:    card.getAttribute("data-title"),
          author:   card.getAttribute("data-author"),
          duration: card.getAttribute("data-duration")
        });
      });
    })(cards[i]);
  }
}

/* ── Play a YouTube video in the embedded iframe player ──
   If a regular YouTube mix is clicked while Spotify mode is active,
   fully exit Spotify mode first (mirrors stopSpotifyCompletely). */
function playYouTube(video) {
  if (!video || !video.id) return;

  // If we were in Spotify mode, fully exit it (user is leaving for a YT mix)
  if (spotifyState.activePlaylistId) {
    stopSpotifyCompletely();
  }
  // v74: If we were in YouTube playlist mode, exit it (user clicked a single mix)
  if (ytPlaylistState.active) {
    stopYtPlaylist();
  }

  if (player.src) {
    player.pause();
  }
  hidePanel();
  // Hide the restore card if visible
  $("#ext-source-card").classList.add("hidden");
  showCenterView("yt-player");

  $("#yt-now-title").textContent = video.title || "Untitled";
  $("#yt-now-meta").textContent =
    "YOUTUBE" +
    (video.author   ? " \u00B7 " + video.author   : "") +
    (video.duration ? " \u00B7 " + video.duration : "");

  N96.nowPlaying = {
    path: null,
    filename: video.title,
    ext: "YT",
    isYouTube: true,
    isSpotify: false,
    videoId: video.id,
    author: video.author
  };
  updateMediaSession();
  /* v78: Track YouTube plays in statistics */
  updateStats(N96.nowPlaying);
  N96.currentIdx = -1;
  N96.duration = 0;
  // v73: Update ultra track info and track counter for YouTube
  updateUltraTrackInfo();
  updateTrackCounter();

  $$(".track-item").forEach(function(el){ el.classList.remove("active"); });

  if (ytReady && ytPlayer) {
    ytPlayer.loadVideoById(video.id);
    ytVideoLoaded = true;
  } else {
    ytPendingVideo = video;
    console.log("[YouTube] API not ready yet, video queued.");
  }

  // v19: Start seek bar updates for YouTube mixes
  startYTSeekBar();

  // Update play/pause button to show pause icon
  $("#play-pause-btn").textContent = "\u23F8";

  // v20: Re-render sidebar to highlight the active mix
  renderYtMixesSidebar();
  /* v78: Also update collections sidebar to highlight the active item */
  renderCollectionsSidebar();
}


/* Optional performance monitoring (v36) */
setInterval(function() {
  if (performance && performance.memory) {
    console.log('[N96] Memory usage:', (performance.memory.usedJSHeapSize / 1048576).toFixed(1) + 'MB');
  }
}, 30000);
/* Wire up the YouTube search input + Add Mix modal on DOM ready */
  ytSearchInput = $("#yt-search-input");
  if (ytSearchInput) {
    ytSearchInput.addEventListener("input", function(e){
      if (ytSearchTimer) clearTimeout(ytSearchTimer);
      var q = e.target.value;
      ytSearchTimer = setTimeout(function(){ ytSearch(q); }, 400);
    });
    ytSearchInput.addEventListener("keydown", function(e){
      if (e.key === "Enter") {
        e.preventDefault();
        if (ytSearchTimer) clearTimeout(ytSearchTimer);
        ytSearch(ytSearchInput.value);
      } else if (e.key === "Escape") {
        closeYouTubeView();
      }
    });
  }

  // Add Mix modal
  var addName = $("#yt-add-name");
  var addInput = $("#yt-add-input");
  var addConfirm = $("#yt-add-confirm");
  var addCancel = $("#yt-add-cancel");

  if (addConfirm) addConfirm.addEventListener("click", function(){
    var name = addName ? addName.value : "";
    var url  = addInput ? addInput.value : "";
    if (!url) { $("#yt-add-error").textContent = "Please enter a YouTube URL or video ID."; return; }
    if (addMixFromUrl(name, url)) {
      closeAddMixModal();
    }
  });
  if (addCancel) addCancel.addEventListener("click", closeAddMixModal);

  // Enter key on URL field = click Add
  if (addInput) addInput.addEventListener("keydown", function(e){
    if (e.key === "Enter") { e.preventDefault(); if (addConfirm) addConfirm.click(); }
  });
  if (addName) addName.addEventListener("keydown", function(e){
    if (e.key === "Enter") { e.preventDefault(); if (addInput) addInput.focus(); }
  });

  // v74: Playlist modal — Enter key on URL field = click Fetch
  var playlistUrlInput = document.getElementById('yt-playlist-url-input');
  if (playlistUrlInput) {
    playlistUrlInput.addEventListener('keydown', function(e) {
      if (e.key === 'Enter') { e.preventDefault(); fetchYouTubePlaylist(); }
    });
  }

/* ── Accessibility: ARIA attributes (v50) ── */
(function addAriaLabels() {
  /* Seek bar */
  var seekSlider = document.getElementById("seek-slider");
  if (seekSlider) {
    seekSlider.setAttribute("role", "slider");
    seekSlider.setAttribute("aria-label", "Seek");
    seekSlider.setAttribute("aria-valuemin", "0");
    seekSlider.setAttribute("aria-valuemax", "100");
    seekSlider.setAttribute("aria-valuenow", "0");
  }
  /* Play button */
  var playBtn = document.getElementById("play-pause-btn");
  if (playBtn) playBtn.setAttribute("aria-label", "Play/Pause");
  /* Shuffle button */
  var shufBtn = document.getElementById("shuffle-btn");
  if (shufBtn) shufBtn.setAttribute("aria-label", "Toggle shuffle");
  /* Collapsible sections */
  document.querySelectorAll(".collapsible-header").forEach(function(h) {
    h.setAttribute("role", "button");
    h.setAttribute("aria-expanded", "true");
    var section = h.parentElement;
    if (section && section.classList.contains("collapsed")) {
      h.setAttribute("aria-expanded", "false");
    }
  });
  /* Ambient layer buttons */
  document.querySelectorAll(".layer-btn").forEach(function(btn) {
    var title = btn.getAttribute("title");
    if (title) btn.setAttribute("aria-label", "Toggle " + title);
  });
  /* Decorative SVGs */
  document.querySelectorAll("svg").forEach(function(svg) {
    if (!svg.getAttribute("aria-label") && !svg.closest("button")) {
      svg.setAttribute("aria-hidden", "true");
    }
  });
})();


/* ── PWA: Register Service Worker (v50) ── */
if ("serviceWorker" in navigator) {
  window.addEventListener("load", function() {
    navigator.serviceWorker.register("/sw.js").then(function(reg) {
      console.log("[N96] Service Worker registered:", reg.scope);
    }).catch(function(err) {
      console.log("[N96] Service Worker registration failed:", err);
    });
  });
}

/* ── PWA: Install Prompt ── */
var deferredInstallPrompt = null;
window.addEventListener("beforeinstallprompt", function(e) {
  e.preventDefault();
  deferredInstallPrompt = e;
  console.log("[N96] PWA install prompt captured");
  /* Could show a custom install button here */
});


/* ── Performance: Debounced Resize (v50) ── */
var resizeTimer = null;
window.addEventListener("resize", function() {
  clearTimeout(resizeTimer);
  resizeTimer = setTimeout(function() {
    /* Trigger aurora resize */
    if (typeof initAurora === "function") {
      var canvas = document.getElementById("aurora-canvas");
      if (canvas) {
        var ctx = canvas.getContext("2d");
        var dpr = window.devicePixelRatio || 1;
        canvas.width = window.innerWidth * dpr;
        canvas.height = window.innerHeight * dpr;
        ctx.setTransform(dpr, 0, 0, dpr, 0, 0);
      }
    }
  }, 150);
});

/* ── MediaSession API (v52) — browser media controls ── */
function updateMediaSession() {
  if (!("mediaSession" in navigator)) return;
  
  var title = "N96_freq";
  var artist = "";
  var artwork = [];
  
  if (N96.nowPlaying) {
    if (N96.nowPlaying.isYouTube) {
      title = N96.nowPlaying.filename || "YouTube";
      artist = N96.nowPlaying.author || "YouTube";
    } else {
      title = (N96.nowPlaying.filename || "").replace(/\.(mp3|flac|wav|ogg|m4a)$/i, "").replace(/[-_]/g, " ");
      artist = N96.nowPlaying.folder || "Local";
    }
  }
  
  navigator.mediaSession.metadata = new MediaMetadata({
    title: title,
    artist: artist,
    album: "N96_freq — your quiet room",
    artwork: artwork.length > 0 ? artwork : [
      { src: "data:image/svg+xml,%3Csvg xmlns='http://www.w3.org/2000/svg' width='512' height='512'%3E%3Crect fill='%230d1535' width='512' height='512'/%3E%3Ctext fill='%237fd1a4' x='50%25' y='45%25' dominant-baseline='middle' text-anchor='middle' font-size='64' font-family='sans-serif'%3EN96%3C/text%3E%3Ctext fill='%237fd1a4' x='50%25' y='60%25' dominant-baseline='middle' text-anchor='middle' font-size='24' font-family='sans-serif'%3Efreq%3C/text%3E%3C/svg%3E", sizes: "512x512", type: "image/svg+xml" }
    ]
  });
}

/* ── MediaSession position sync ── */
function updateMediaSessionPosition() {
  if (!("mediaSession" in navigator)) return;

  var currentTime = 0;
  var duration = 0;
  var playbackRate = 1.0;

  if (N96.nowPlaying && N96.nowPlaying.isYouTube && ytPlayer && ytReady) {
    try { currentTime = ytPlayer.getCurrentTime() || 0; } catch(e) {}
    try { duration = ytPlayer.getDuration() || 0; } catch(e) {}
  } else {
    currentTime = player.currentTime || 0;
    duration = player.duration || 0;
    playbackRate = player.playbackRate || 1.0;
  }

  // v68: Guard — skip entirely if duration is invalid (before track loads)
  if (!duration || !isFinite(duration) || !isFinite(currentTime)) return;

  try {
    navigator.mediaSession.setPositionState({
      duration: duration,
      playbackRate: playbackRate,
      position: Math.min(currentTime, duration)
    });
  } catch (e) {
    // Silently ignore — some browsers reject position > duration edge cases
  }
}

function setupMediaSessionHandlers() {
  if (!("mediaSession" in navigator)) return;
  
  navigator.mediaSession.setActionHandler("play", function() {
    console.log("[MediaSession] play handler triggered");

    if (N96.nowPlaying && N96.nowPlaying.isYouTube) {
      if (ytPlayer && ytReady) {
        /* If YouTube video ended, seek back to start */
        try { if (ytPlayer.getPlayerState() === 0) { ytPlayer.seekTo(_pausePosition || 0, true); } } catch(e) {}
        ytPlayer.playVideo();
      }
    } else {
      /* If local audio ended, seek back to saved position */
      if (player.ended) { player.currentTime = _pausePosition || 0; }
      player.play().then(function() {
        N96.isPlaying = true;
        updatePlayPauseUI();
        startTimer();
      }).catch(function(){});
    }
    N96.isPlaying = true;
    N96.userPaused = false;
    updatePlayPauseUI();
    navigator.mediaSession.playbackState = "playing";

    /* Update position after play starts — delay to let currentTime stabilize */
    setTimeout(function() {
      console.log("[MediaSession] updating position after play");
      updateMediaSessionPosition();
    }, 300);
  });
  
  navigator.mediaSession.setActionHandler("pause", function() {
    console.log("[MediaSession] pause handler triggered");

    var positionBeforePause = 0;

    if (N96.nowPlaying && N96.nowPlaying.isYouTube) {
      if (ytPlayer && ytReady) {
        try { positionBeforePause = ytPlayer.getCurrentTime(); } catch(e) {}
        console.log("[MediaSession] youtube paused at:", positionBeforePause.toFixed(2));
        _pausePosition = positionBeforePause;
        N96.userPaused = true;
        ytPlayer.pauseVideo();
      }
    } else {
      positionBeforePause = player.currentTime;
      console.log("[MediaSession] local paused at:", positionBeforePause.toFixed(2));
      _pausePosition = positionBeforePause;
      N96.userPaused = true;   /* Set BEFORE pause() — it fires onended synchronously */
      player.pause();
    }

    N96.isPlaying = false;
    updatePlayPauseUI();
    navigator.mediaSession.playbackState = "paused";

    /* Update position AFTER a delay to ensure it's stable */
    setTimeout(function() {
      console.log("[MediaSession] updating position after pause");
      updateMediaSessionPosition();
    }, 300);
  });
  
  navigator.mediaSession.setActionHandler("previoustrack", function() {
    playPrev();
  });
  
  navigator.mediaSession.setActionHandler("nexttrack", function() {
    playNext();
  });
  
  navigator.mediaSession.setActionHandler("seekto", function(details) {
    if (details.seekTime !== undefined) {
      console.log("[MediaSession] seekto:", details.seekTime.toFixed(2));
      if (N96.nowPlaying && N96.nowPlaying.isYouTube) {
        if (ytPlayer && ytReady) ytPlayer.seekTo(details.seekTime, true);
      } else {
        if (player.duration) player.currentTime = details.seekTime;
      }
      _pausePosition = details.seekTime;
      setTimeout(function() {
        console.log("[MediaSession] updating position after seek");
        updateMediaSessionPosition();
      }, 200);
    }
  });
}

function updatePlayPauseUI() {
  var btn = $("#play-pause-btn");
  if (btn) {
    btn.textContent = N96.isPlaying ? "\u23F8" : "\u25B6";
    if (N96.isPlaying) btn.classList.add("playing");
    else btn.classList.remove("playing");
  }
}


  // ── Spotify modal wiring (new in v11) ──
  var spName = $("#sp-add-name");
  var spInput = $("#sp-add-input");
  var spConfirm = $("#sp-add-confirm");
  var spCancel = $("#sp-add-cancel");

  if (spConfirm) spConfirm.addEventListener("click", function(){
    var name = spName ? spName.value : "";
    var url  = spInput ? spInput.value : "";
    if (!url) { $("#sp-add-error").textContent = "Please enter a Spotify playlist URL or ID."; return; }
    if (addSpotifyPlaylistFromUrl(name, url)) {
      closeAddSpotifyModal();
    }
  });
  if (spCancel) spCancel.addEventListener("click", closeAddSpotifyModal);
  if (spInput) spInput.addEventListener("keydown", function(e){
    if (e.key === "Enter") { e.preventDefault(); if (spConfirm) spConfirm.click(); }
  });
  if (spName) spName.addEventListener("keydown", function(e){
    if (e.key === "Enter") { e.preventDefault(); if (spInput) spInput.focus(); }
  });

/* ═══════════════════════════════════════════════════════════════
   SPOTIFY SUBSYSTEM — localStorage-backed playlist collection +
   YouTube-backed playback (Spotify has no preview URL anymore, so
   we search YouTube for each track and play it back through the
   existing IFrame player).

   Design:
   - All Spotify playlists saved by the user live in localStorage
     under SPOTIFY_PLAYLISTS_KEY.
   - When user clicks a saved Spotify playlist, we fetch its tracks
     from /api/spotify/playlists/:id/tracks (server paginates).
   - We then iterate the track list, searching YouTube for
     "<title> <artist>" via /api/youtube/search, taking the first hit.
   - Each track plays through the existing YT.Player instance.
   - On ENDED (only when spotifyState.activePlaylistId is set), we
     auto-advance to the next track. Failed lookups (no YouTube
     result, or YT error 101/150) are marked in failedTracks[] and
     skipped silently with a toast.
   ═══════════════════════════════════════════════════════════════ */
var SPOTIFY_PLAYLISTS_KEY = "n96-spotify-playlists";

/* Single source of truth for Spotify playback state. */
var spotifyState = {
  configured: false,         // set by initSpotify() after /api/spotify/status
  userLoggedIn: false,       // v14 — set by initSpotify() + postMessage listener
  activePlaylistId: null,    // non-null = we're in Spotify playback mode
  activePlaylistName: "",
  tracks: [],                // array of { spotId, title, artist, album, duration_ms, isrc }
  currentIdx: -1,            // index into spotifyState.tracks
  failedTracks: {},          // { spotId: true } — skip these on advance
  shuffleWindow: null,       // when shuffle is on, a permuted index array
  prefetching: false,        // true while a /api/youtube/search is in-flight
  cancelToken: 0,            // bumped on stopSpotifyCompletely() to cancel pending callbacks
  youtubeCache: {},          // { spotId: { videoId, title, status: 'resolved'|'failed'|'pending' } }
  prefetchQueue: [],         // array of spotIds waiting to be searched
  prefetchAbort: false,      // set true to abort in-flight batch prefetch
  ytSeekInterval: null       // interval ID for YouTube seek bar updates
};

/* ── localStorage helpers ── */
function loadSpotifyPlaylists() {
  try {
    var raw = localStorage.getItem(SPOTIFY_PLAYLISTS_KEY);
    if (raw) return JSON.parse(raw);
  } catch(_) {}
  saveSpotifyPlaylists([]);
  return [];
}

function saveSpotifyPlaylists(playlists) {
  try { localStorage.setItem(SPOTIFY_PLAYLISTS_KEY, JSON.stringify(playlists)); } catch(_) {}
}

function isSpotifyPlaylistSaved(id) {
  return loadSpotifyPlaylists().some(function(p) { return p.id === id; });
}

function spotifyPlaylistDisplayName(p) {
  if (p.name && p.name.trim()) return p.name.trim();
  if (p.title && p.title.trim()) return p.title.trim();
  return "Loading…";
}

/* ── v14: Spotify OAuth helpers ── */

/* Open the Spotify PKCE auth popup. */
function connectSpotify() {
  if (!spotifyState.configured) {
    showErrorModal("Spotify not configured. Set SPOTIFY_CLIENT_ID and SPOTIFY_CLIENT_SECRET on the server.");
    return;
  }
  var w = window.open("/api/spotify/login", "spotify-auth", "width=500,height=700,left=200,top=100");
  if (!w) {
    showErrorModal("Popup blocked. Please allow popups for this site and try again.");
  }
}

/* Disconnect Spotify — clears server-side user token. */
async function disconnectSpotify() {
  try {
    var res = await fetch("/api/spotify/logout");
    if (!res.ok) throw new Error("HTTP " + res.status);
    spotifyState.userLoggedIn = false;
    updateSpotifyButton();
    renderSpotifyDisconnectLink();
    renderSpotifySidebar();
    showToast("Spotify disconnected");
    if (spotifyState.activePlaylistId) {
      stopSpotifyCompletely();
    }
  } catch (e) {
    console.error("[spotify] logout failed:", e);
    showErrorModal("Failed to disconnect: " + e.message);
  }
}

/* Update the EXTERNAL SOURCES button text based on login state. */
function updateSpotifyButton() {
  var btn = $("#sp-source-btn");
  var label = $("#sp-source-btn-label");
  if (!btn || !label) return;
  if (!spotifyState.configured) {
    btn.classList.add("disabled");
    label.textContent = "Spotify Playlists";
    return;
  }
  btn.classList.remove("disabled");
  if (spotifyState.userLoggedIn) {
    label.textContent = "Spotify Playlists";
  } else {
    label.textContent = "Connect Spotify";
  }
}

/* Show/hide the Disconnect link in the Spotify section header. */
function renderSpotifyDisconnectLink() {
  var el = $("#spotify-disconnect-btn");
  if (!el) return;
  if (spotifyState.userLoggedIn) {
    el.classList.remove("hidden");
  } else {
    el.classList.add("hidden");
  }
}

/* ── Initialization ── */
async function initSpotify() {
  try {
    var res = await fetch("/api/spotify/status");
    if (!res.ok) throw new Error("HTTP " + res.status);
    var data = await res.json();
    spotifyState.configured = !!data.configured;
    spotifyState.userLoggedIn = !!data.userLoggedIn;
    console.log("[spotify] configured:", spotifyState.configured, "loggedIn:", spotifyState.userLoggedIn);
    updateSpotifyButton();
    renderSpotifyDisconnectLink();
  } catch (e) {
    console.warn("[spotify] status check failed:", e.message);
    spotifyState.configured = false;
  }
  renderSpotifySidebar();
}

/* ── Render saved Spotify playlists into #spotify-list ── */
function renderSpotifySidebar() {
  var list = document.getElementById("spotify-list");
  if (!list) {
    console.error("[N96] renderSpotifySidebar: #spotify-list element not found in DOM");
    return;
  }
  var playlists = loadSpotifyPlaylists();
  console.log("[N96] renderSpotifySidebar: rendering " + playlists.length + " playlists");

  var addBtn = list.querySelector(".spotify-add-btn");
  var refreshBtn = list.querySelector(".spotify-refresh-btn");

  list.innerHTML = "";
  if (addBtn) list.appendChild(addBtn);
  if (refreshBtn) list.appendChild(refreshBtn);

  for (var i = 0; i < playlists.length; i++) {
    var p = playlists[i];
    var isActive = (spotifyState.activePlaylistId === p.id) ? "active" : "";
    var isFailed = p.error ? "failed" : "";
    var item = document.createElement("button");
    item.className = "spotify-item " + isActive + " " + isFailed;
    item.setAttribute("data-id", p.id);
    var countLabel = p.total_tracks ? ("(" + p.total_tracks + ")") : "";
    item.innerHTML =
      '<span class="spotify-icon">' + (p.error ? '<svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><path d="M10.29 3.86L1.82 18a2 2 0 0 0 1.71 3h16.94a2 2 0 0 0 1.71-3L13.71 3.86a2 2 0 0 0-3.42 0z"></path><line x1="12" y1="9" x2="12" y2="13"></line><line x1="12" y1="17" x2="12.01" y2="17"></line></svg>' : '<svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><path d="M9 18V5l12-2v13"></path><circle cx="6" cy="18" r="3"></circle><circle cx="18" cy="16" r="3"></circle></svg>') + '</span>' +
      '<span class="spotify-name">' + esc(spotifyPlaylistDisplayName(p)) + '</span>' +
      (countLabel ? '<span class="spotify-count">' + countLabel + '</span>' : '') +
      '<span class="spotify-delete" title="Remove this playlist"><svg width="12" height="12" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><line x1="18" y1="6" x2="6" y2="18"></line><line x1="6" y1="6" x2="18" y2="18"></line></svg></span>';
    (function(pl){
      item.addEventListener("click", function(e){
        // v68: Use closest() to handle clicks on SVG children inside .spotify-delete
        if (e.target.closest(".spotify-delete")) {
          e.stopPropagation();
          deleteSpotifyPlaylist(pl.id);
          return;
        }
        playSpotifyPlaylist(pl);
      });
    })(p);
    list.appendChild(item);
  }
  makeSidebarItemsDraggable();
}

/* ── Refresh-all metadata ── */
async function refreshAllSpotifyPlaylists() {
  if (!spotifyState.configured) {
    showErrorModal("Spotify not configured. Set SPOTIFY_CLIENT_ID and SPOTIFY_CLIENT_SECRET on the server.");
    return;
  }
  var playlists = loadSpotifyPlaylists();
  if (playlists.length === 0) {
    showToast("No Spotify playlists to refresh.");
    return;
  }

  var icon = $("#spotify-refresh-icon");
  if (icon) icon.classList.add("spinning");

  var ids = playlists.map(function(p) { return p.id; }).join(",");
  try {
    var res = await fetch("/api/spotify/playlists?ids=" + encodeURIComponent(ids));
    if (!res.ok) throw new Error("HTTP " + res.status);
    var data = await res.json();
    var fetched = data.playlists || [];

    var byId = {};
    for (var i = 0; i < fetched.length; i++) byId[fetched[i].id] = fetched[i];
    for (var j = 0; j < playlists.length; j++) {
      var p = playlists[j];
      var f = byId[p.id];
      if (!f) continue;
      if (f.error) {
        p.error = f.error;
      } else {
        delete p.error;
        p.title = f.name;
        p.owner = f.owner;
        p.image = f.image;
        p.total_tracks = f.total_tracks;
        p.spotify_url = f.spotify_url;
      }
    }
    saveSpotifyPlaylists(playlists);
    renderSpotifySidebar();
    showToast("Refreshed " + playlists.length + " playlist(s).");
  } catch (e) {
    console.error("[spotify] refresh failed:", e);
    showErrorModal("Refresh failed: " + e.message);
  } finally {
    if (icon) icon.classList.remove("spinning");
  }
}

/* ── Add Spotify playlist modal ── */
function openAddSpotifyModal() {
  console.log("[N96] openAddSpotifyModal called");
  var modal = $("#spotify-add-modal");
  if (!modal) { console.error("[N96] #spotify-add-modal not found in DOM"); return; }
  if (!spotifyState.configured) {
    showErrorModal(
      "Spotify integration is not configured.\n" +
      "Set SPOTIFY_CLIENT_ID and SPOTIFY_CLIENT_SECRET environment variables on the server, then restart."
    );
    return;
  }
  modal.classList.add("visible");
  var name = $("#sp-add-name");
  var input = $("#sp-add-input");
  var err = $("#sp-add-error");
  if (name)  { name.value  = ""; }
  if (input) { input.value = ""; }
  if (err)   { err.textContent = ""; }
  setTimeout(function(){ if (name) name.focus(); }, 100);
}

function closeAddSpotifyModal() {
  var modal = $("#spotify-add-modal");
  if (modal) modal.classList.remove("visible");
}

/* ── Extract Spotify playlist ID from URL ── */
function extractSpotifyId(input) {
  input = (input || "").trim();
  if (!input) return null;
  var m;
  if ((m = input.match(/open\.spotify\.com\/playlist\/([A-Za-z0-9]{22})/))) return m[1];
  if ((m = input.match(/open\.spotify\.com\/embed\/playlist\/([A-Za-z0-9]{22})/))) return m[1];
  if ((m = input.match(/^spotify:playlist:([A-Za-z0-9]{22})$/))) return m[1];
  if (/^[A-Za-z0-9]{22}$/.test(input)) return input;
  return null;
}

/* ── Add a Spotify playlist by URL or ID ── */
function addSpotifyPlaylistFromUrl(name, url) {
  var id = extractSpotifyId(url);
  if (!id) {
    var err = $("#sp-add-error");
    if (err) err.textContent = "Could not find a valid Spotify link. Please paste a full Spotify playlist URL.";
    return false;
  }
  if (isSpotifyPlaylistSaved(id)) {
    var err2 = $("#sp-add-error");
    if (err2) err2.textContent = "This playlist is already in your collection.";
    return false;
  }
  var playlists = loadSpotifyPlaylists();
  playlists.push({
    id: id,
    name: (name || "").trim(),
    title: "",
    owner: "",
    image: "",
    total_tracks: 0,
    spotify_url: "https://open.spotify.com/playlist/" + id,
    addedAt: Date.now()
  });
  saveSpotifyPlaylists(playlists);
  renderSpotifySidebar();
  refreshSpotifyPlaylistMetadata(id);
  return true;
}

/* Fetch metadata for a single playlist and merge into storage. */
async function refreshSpotifyPlaylistMetadata(id) {
  try {
    var res = await fetch("/api/spotify/playlists/" + encodeURIComponent(id));
    if (!res.ok) throw new Error("HTTP " + res.status);
    var data = await res.json();
    var playlists = loadSpotifyPlaylists();
    for (var i = 0; i < playlists.length; i++) {
      if (playlists[i].id === id) {
        if (data.error) {
          playlists[i].error = data.error;
        } else {
          delete playlists[i].error;
          playlists[i].title = data.name;
          playlists[i].owner = data.owner;
          playlists[i].image = data.image;
          playlists[i].total_tracks = data.total_tracks;
          playlists[i].spotify_url = data.spotify_url;
        }
        break;
      }
    }
    saveSpotifyPlaylists(playlists);
    renderSpotifySidebar();
  } catch (e) {
    console.error("[spotify] metadata fetch failed for", id, e);
    // If 404, mark playlist as failed so user sees the error
    if (e.message.includes("404")) {
      var playlists = loadSpotifyPlaylists();
      for (var j = 0; j < playlists.length; j++) {
        if (playlists[j].id === id) {
          playlists[j].error = "Not found (deleted, private, or region-locked)";
          break;
        }
      }
      saveSpotifyPlaylists(playlists);
      renderSpotifySidebar();
    }
  }
}

function deleteSpotifyPlaylist(id) {
  var playlists = loadSpotifyPlaylists().filter(function(p) { return p.id !== id; });
  saveSpotifyPlaylists(playlists);
  if (spotifyState.activePlaylistId === id) {
    stopSpotifyCompletely();
  }
  renderSpotifySidebar();
}

/* ── Mark a playlist as failed in localStorage ── */
function markSpotifyPlaylistFailed(id, errorMsg) {
  var playlists = loadSpotifyPlaylists();
  for (var i = 0; i < playlists.length; i++) {
    if (playlists[i].id === id) {
      playlists[i].error = errorMsg || "Failed to load";
      break;
    }
  }
  saveSpotifyPlaylists(playlists);
  renderSpotifySidebar();
}

/* ── v14: Open Spotify view — forks on login state ── */
function openSpotifyView() {
  if (!spotifyState.configured) {
    showErrorModal(
      "Spotify integration is not configured.\n" +
      "Set SPOTIFY_CLIENT_ID and SPOTIFY_CLIENT_SECRET environment variables on the server, then restart."
    );
    return;
  }
  // v14: Not logged in → open OAuth popup instead of expanding section
  if (!spotifyState.userLoggedIn) {
    connectSpotify();
    return;
  }
  // Logged in — expand the Spotify section
  var el = document.getElementById("spotify-section");
  if (el && el.classList.contains("collapsed")) {
    toggleSidebarSection("spotify-section");
  }
  $$(".source-btn").forEach(function(b){ b.classList.remove("active"); });
  $("#sp-source-btn").classList.add("active");
  setTimeout(function(){ $("#sp-source-btn").classList.remove("active"); }, 1200);
}

/* ── Play a Spotify playlist ──
   v14: 403 handler now distinguishes login_required vs private playlist.
   v67: startTrackIndex/startTrackTitle — resume specific track after reconnect. */
async function playSpotifyPlaylist(pl, startTrackIndex, startTrackTitle) {
  if (!spotifyState.configured) {
    showErrorModal("Spotify not configured.");
    return;
  }

  if (spotifyState.activePlaylistId === pl.id) {
    console.log("[spotify] restarting playlist");
  } else {
    spotifyState.activePlaylistId = pl.id;
    spotifyState.activePlaylistName = spotifyPlaylistDisplayName(pl);
    spotifyState.tracks = [];
    spotifyState.currentIdx = -1;
    spotifyState.failedTracks = {};
    spotifyState.shuffleWindow = null;
    spotifyState.cancelToken++;
  }

  if (player.src) player.pause();
  if (ytPlayer && ytReady) {
    try { ytPlayer.stopVideo(); } catch(_) {}
  }
  // v74: Stop YouTube playlist if active
  if (ytPlaylistState.active) {
    stopYtPlaylist();
  }

  hidePanel();
  showCenterView("yt-player");
  renderSpotifySidebar();

  $("#yt-now-title").textContent = spotifyState.activePlaylistName;
  $("#yt-now-meta").textContent = "SPOTIFY \u00B7 loading tracks\u2026";
  updateSpotifyProgress("loading tracks\u2026");

  try {
    var res = await fetch("/api/spotify/playlists/" + encodeURIComponent(pl.id) + "/tracks");

    /* ── v14: 403 — distinguish login_required vs private playlist ── */
    if (res.status === 403) {
      var errBody403 = {};
      try { errBody403 = await res.json(); } catch(_) {}

      if (errBody403.error === 'login_required') {
        // Not logged in — don't mark playlist as failed
        console.warn("[spotify] 403 login_required — user not authenticated");
        showErrorModal(
          "Spotify login required to play playlists.\n\n" +
          'Click "Connect Spotify" in the sidebar to\n' +
          "authorize N96 to access your playlists."
        );
        $("#error-search-btn").style.display = "none";
        $("#error-close-btn").textContent = "Got it";
        $("#error-close-btn").onclick = function() {
          $("#error-modal").classList.remove("visible");
          $("#error-search-btn").style.display = "";
          $("#error-search-btn").textContent = "Search in Tracks";
          $("#error-close-btn").textContent = "Close";
          stopSpotifyCompletely();
        };
        stopSpotifyCompletely();
        return;
      }

      // Genuine 403 — private playlist or no access
      console.warn("[spotify] 403 on tracks —", errBody403.message || "access denied", "— playlist:", pl.id);
      markSpotifyPlaylistFailed(pl.id, "Private or no access");
      showErrorModal(
        "This playlist is private or you don't have access.\n\n" +
        "Either make it public in Spotify, or ask the\n" +
        "owner to add you as a collaborator."
      );
      $("#error-search-btn").style.display = "none";
      $("#error-close-btn").textContent = "Got it";
      $("#error-close-btn").onclick = function() {
        $("#error-modal").classList.remove("visible");
        $("#error-search-btn").style.display = "";
        $("#error-search-btn").textContent = "Search in Tracks";
        $("#error-close-btn").textContent = "Close";
        stopSpotifyCompletely();
      };
      stopSpotifyCompletely();
      return;
    }

    /* ── 404 — deleted or region-locked playlist ── */
    if (res.status === 404) {
      var errBody404 = {};
      try { errBody404 = await res.json(); } catch(_) {}
      console.warn("[spotify] 404 on tracks —", errBody404.error || "not found", "— playlist:", pl.id);
      var plName = spotifyPlaylistDisplayName(pl);
      showErrorModal(
        "Playlist not found (404): " + plName + "\n\n" +
        "It may have been deleted or set to private,\n" +
        "or it may be region-locked."
      );
      $("#error-search-btn").textContent = "Remove from list";
      $("#error-search-btn").onclick = function() {
        deleteSpotifyPlaylist(pl.id);
        $("#error-modal").classList.remove("visible");
        $("#error-search-btn").textContent = "Search in Tracks";
      };
      $("#error-close-btn").onclick = function() {
        $("#error-modal").classList.remove("visible");
        $("#error-search-btn").textContent = "Search in Tracks";
        stopSpotifyCompletely();
      };
      stopSpotifyCompletely();
      return;
    }

    if (!res.ok) throw new Error("HTTP " + res.status);
    var data = await res.json();
    if (!data.tracks || data.tracks.length === 0) {
      showErrorModal("This Spotify playlist has no tracks.\\n\\n1. Open Spotify (app or open.spotify.com)\\n2. Find your playlist\\n3. Add songs (search, click the + button)\\n4. Click Refresh All in the sidebar\\n5. Try again");
      stopSpotifyCompletely();
      return;
    }
    spotifyState.tracks = data.tracks;
    spotifyState.currentIdx = -1;
    spotifyState.failedTracks = {};
    spotifyState.youtubeCache = {};
    spotifyState.prefetchAbort = false;
    if (N96.shuffleOn) spotifyState.shuffleWindow = buildShuffleWindow(spotifyState.tracks.length);
    console.log("[spotify] loaded " + data.tracks.length + " tracks");
    startBatchPrefetch();

    // v67: If we have a startTrackIndex or startTrackTitle, jump to that specific track
    var targetIdx = -1;
    if (typeof startTrackIndex === 'number' && startTrackIndex >= 0 && startTrackIndex < data.tracks.length) {
      targetIdx = startTrackIndex;
      console.log("[spotify] resuming at saved index:", targetIdx);
    } else if (startTrackTitle) {
      // Fallback: find by title match (case-insensitive, partial match)
      var lowerTitle = startTrackTitle.toLowerCase();
      for (var ti = 0; ti < data.tracks.length; ti++) {
        if (data.tracks[ti].title && data.tracks[ti].title.toLowerCase().indexOf(lowerTitle) !== -1) {
          targetIdx = ti;
          break;
        }
      }
      if (targetIdx >= 0) {
        console.log("[spotify] found track by title at index:", targetIdx);
      } else {
        console.log("[spotify] could not find track by title, starting from beginning");
      }
    }

    if (targetIdx >= 0) {
      spotifyState.currentIdx = targetIdx;
      spotifyState.currentTrack = data.tracks[targetIdx];
      playSpotifyTrack(data.tracks[targetIdx], spotifyState.cancelToken);
    } else {
      spotifyAdvance(1);
    }
  } catch (e) {
    console.error("[spotify] track fetch failed:", e);
    showErrorModal("Failed to load Spotify tracks: " + e.message);
    stopSpotifyCompletely();
  }
}

/* ── Shuffle window ── */
function buildShuffleWindow(n) {
  var arr = [];
  for (var i = 0; i < n; i++) arr.push(i);
  for (var j = arr.length - 1; j > 0; j--) {
    var k = Math.floor(Math.random() * (j + 1));
    var tmp = arr[j]; arr[j] = arr[k]; arr[k] = tmp;
  }
  return arr;
}

/* ── Advance to next/prev Spotify track ── */
function spotifyAdvance(dir) {
  if (!spotifyState.activePlaylistId) return;
  if (spotifyState.tracks.length === 0) return;

  var myToken = spotifyState.cancelToken;
  var n = spotifyState.tracks.length;
  var attempts = 0;
  var nextIdx = spotifyState.currentIdx;

  while (attempts < n) {
    attempts++;
    if (N96.shuffleOn && spotifyState.shuffleWindow) {
      if (spotifyState.currentIdx < 0) {
        nextIdx = spotifyState.shuffleWindow[0];
        spotifyState.currentIdx = 0;
      }
      var posInWindow = spotifyState.shuffleWindow.indexOf(spotifyState.currentIdx);
      if (posInWindow === -1) posInWindow = 0;
      var nextPos = (posInWindow + dir + spotifyState.shuffleWindow.length) % spotifyState.shuffleWindow.length;
      nextIdx = spotifyState.shuffleWindow[nextPos];
    } else {
      if (spotifyState.currentIdx < 0) {
        nextIdx = 0;
      } else {
        nextIdx = (spotifyState.currentIdx + dir + n) % n;
      }
    }
    var track = spotifyState.tracks[nextIdx];
    if (track && spotifyState.failedTracks[track.spotId]) {
      console.log("[spotify] skipping failed track at idx " + nextIdx + " (" + track.title + ")");
      spotifyState.currentIdx = nextIdx;
      continue;
    }
    break;
  }

  if (!track || spotifyState.failedTracks[track.spotId]) {
    console.log("[spotify] all tracks failed — stopping");
    showToast("All tracks in this playlist failed — stopping.");
    stopSpotifyCompletely();
    return;
  }

  spotifyState.currentIdx = nextIdx;
  spotifyState.currentTrack = track;
  playSpotifyTrack(track, myToken);
}


/* ── Play a single Spotify track via YouTube search ── */
/* v16/v32: Batch YouTube prefetch - cache video IDs for all tracks upfront */
async function startBatchPrefetch() {
  spotifyState.prefetchAbort = false;
  var tracks = spotifyState.tracks;
  var token = spotifyState.cancelToken;
  console.log("[spotify] starting batch prefetch for " + tracks.length + " tracks");

  var CONCURRENCY = 3;
  // Build queue, skipping tracks already resolved in cache
  spotifyState.prefetchQueue = tracks
    .filter(function(t) { return !spotifyState.youtubeCache[t.spotId] || spotifyState.youtubeCache[t.spotId].status === 'pending'; })
    .map(function(t) { return t.spotId; });
  var queue = spotifyState.prefetchQueue;
  var active = 0;
  var idx = 0;

  return new Promise(function(resolve) {
    function runNext() {
      if (spotifyState.prefetchAbort || token !== spotifyState.cancelToken) {
        console.log("[spotify] batch prefetch aborted");
        return resolve();
      }
      if (idx >= queue.length && active === 0) {
        var resolved = Object.keys(spotifyState.youtubeCache).filter(function(k) {
          return spotifyState.youtubeCache[k] && spotifyState.youtubeCache[k].status === 'resolved';
        }).length;
        console.log("[spotify] batch prefetch done - " + resolved + "/" + tracks.length + " resolved");
        return resolve();
      }
      while (active < CONCURRENCY && idx < queue.length) {
        var spotId = queue[idx++];
        var track = tracks.find(function(t) { return t.spotId === spotId; });
        if (!track) continue;
        if (spotifyState.youtubeCache[spotId] && spotifyState.youtubeCache[spotId].status !== 'pending') continue;

        spotifyState.youtubeCache[spotId] = { videoId: null, title: null, status: 'pending' };
        active++;

        var query = track.title + " " + track.artist;
        (function(sid, q) {
          fetch("/api/youtube/search?q=" + encodeURIComponent(q))
            .then(function(r) { return r.ok ? r.json() : []; })
            .then(function(videos) {
              if (spotifyState.prefetchAbort || token !== spotifyState.cancelToken) return;
              if (videos && videos.length > 0) {
                spotifyState.youtubeCache[sid] = { videoId: videos[0].id, title: videos[0].title, status: 'resolved' };
              } else {
                spotifyState.youtubeCache[sid] = { videoId: null, title: null, status: 'failed' };
              }
            })
            .catch(function() {
              if (spotifyState.prefetchAbort || token !== spotifyState.cancelToken) return;
              spotifyState.youtubeCache[sid] = { videoId: null, title: null, status: 'failed' };
            })
            .finally(function() {
              active--;
              runNext();
            });
        })(spotId, query);
      }
    }
    runNext();
  });
}

/* v16: Prioritize prefetching the next N tracks */
function prefetchNextTracks(currentIdx) {
  var tracks = spotifyState.tracks;
  var n = Math.min(3, tracks.length);
  for (var i = 1; i <= n; i++) {
    var idx = (currentIdx + i) % tracks.length;
    var t = tracks[idx];
    if (!t || !t.spotId) continue;
    if (!spotifyState.youtubeCache[t.spotId]) {
      spotifyState.youtubeCache[t.spotId] = { videoId: null, title: null, status: 'pending' };
      (function(track) {
        var query = track.title + " " + track.artist;
        fetch("/api/youtube/search?q=" + encodeURIComponent(query))
          .then(function(r) { return r.ok ? r.json() : []; })
          .then(function(videos) {
            if (spotifyState.prefetchAbort) return;
            if (videos && videos.length > 0) {
              spotifyState.youtubeCache[track.spotId] = { videoId: videos[0].id, title: videos[0].title, status: 'resolved' };
            } else {
              spotifyState.youtubeCache[track.spotId] = { videoId: null, title: null, status: 'failed' };
            }
          })
          .catch(function() {
            spotifyState.youtubeCache[track.spotId] = { videoId: null, title: null, status: 'failed' };
          });
      })(t);
    }
  }
}

/* v16: YouTube seek bar updater */
function updateYouTubeSeekBar() {
  if (!ytPlayer || !ytReady) return;
  var isYT = (N96.nowPlaying && N96.nowPlaying.isYouTube) || spotifyState.activePlaylistId;
  if (!isYT) return;
  try {
    var ct = ytPlayer.getCurrentTime();
    var dur = ytPlayer.getDuration();
    if (dur && dur > 0) {
      var pct = (ct / dur) * 100;
      var fill = document.getElementById("seek-fill");
      if (fill) fill.style.width = pct + "%";
      var ss=document.getElementById("seek-slider");if(ss)ss.setAttribute("aria-valuenow",Math.round(pct));
      var slider = document.getElementById("seek-slider");
      if (slider) slider.style.setProperty("--seek-pct", pct + "%");
    }
    var td = document.getElementById("timer-display");
    if (td) {
      var h = Math.floor(ct / 3600), m = Math.floor((ct % 3600) / 60), s = Math.floor(ct % 60);
      td.textContent = "\u23F1 " + (h > 0 ? h + ":" + pad(m) + ":" + pad(s) : pad(m) + ":" + pad(s));
    }
    var dd = document.getElementById("duration-display");
    if (dd && dur) {
      var dm = Math.floor(dur / 60), ds = Math.floor(dur % 60);
      dd.textContent = pad(dm) + ":" + pad(ds);
    }
  } catch(e) {}
  /* Keep MediaSession position in sync for OS mini-player */
  updateMediaSessionPosition();
}

function startYTSeekBar() {
  if (spotifyState.ytSeekInterval) clearInterval(spotifyState.ytSeekInterval);
  var interval = N96.ultraMode ? SEEK_UPDATE_INTERVAL_ULTRA : SEEK_UPDATE_INTERVAL_NORMAL;
  spotifyState.ytSeekInterval = setInterval(updateYouTubeSeekBar, interval);
}

function stopYTSeekBar() {
  if (spotifyState.ytSeekInterval) {
    clearInterval(spotifyState.ytSeekInterval);
    spotifyState.ytSeekInterval = null;
  }
}

async function playSpotifyTrack(track, myToken) {
  if (!track) return;

  var titleStr = track.title + " \u2014 " + track.artist;
  $("#yt-now-title").textContent = titleStr;
  var pos = spotifyState.currentIdx + 1;
  var total = spotifyState.tracks.length;
  var failedCount = Object.keys(spotifyState.failedTracks).length;
  $("#yt-now-meta").textContent =
    "SPOTIFY" +
    (track.album ? " \u00B7 " + track.album : "") +
    " \u00B7 " + pos + "/" + total +
    (failedCount > 0 ? " \u00B7 " + failedCount + " skipped" : "");

  var videoId = null;

  // v16: Check cache first
  var cached = spotifyState.youtubeCache[track.spotId];
  if (cached) {
    if (cached.status === 'resolved' && cached.videoId) {
      videoId = cached.videoId;
      console.log("[spotify] cache hit:", videoId, "for", track.title);
    } else if (cached.status === 'failed') {
      console.warn("[spotify] cache says failed:", track.title);
      spotifyState.failedTracks[track.spotId] = true;
      showToast("Skipped \u2014 no YouTube result for: " + track.title);
      spotifyAdvance(1);
      return;
    } else if (cached.status === 'pending') {
      updateSpotifyProgress("loading track\u2026");
      var waitStart = Date.now();
      while (spotifyState.youtubeCache[track.spotId] &&
             spotifyState.youtubeCache[track.spotId].status === 'pending' &&
             Date.now() - waitStart < 10000) {
        await new Promise(function(r) { setTimeout(r, 200); });
      }
      if (myToken !== spotifyState.cancelToken) return;
      cached = spotifyState.youtubeCache[track.spotId];
      if (cached && cached.status === 'resolved' && cached.videoId) {
        videoId = cached.videoId;
        console.log("[spotify] cache resolved after wait:", videoId);
      } else {
        console.warn("[spotify] cache timed out or failed:", track.title);
        spotifyState.failedTracks[track.spotId] = true;
        spotifyAdvance(1);
        return;
      }
    }
  }

  // Fallback: on-demand search if not in cache
  if (!videoId) {
    var query = track.title + " " + track.artist;
    console.log("[spotify] searching YouTube for:", query);
    updateSpotifyProgress("searching YouTube\u2026");
    spotifyState.prefetching = true;
    try {
      var res = await fetch("/api/youtube/search?q=" + encodeURIComponent(query));
      if (myToken !== spotifyState.cancelToken) return;
      if (!res.ok) throw new Error("HTTP " + res.status);
      var videos = await res.json();
      if (myToken !== spotifyState.cancelToken) return;

      if (!videos || videos.length === 0) {
        console.warn("[spotify] no YouTube results for:", query);
        spotifyState.youtubeCache[track.spotId] = { videoId: null, title: null, status: 'failed' };
        spotifyState.failedTracks[track.spotId] = true;
        showToast("Skipped \u2014 no YouTube result for: " + track.title);
        spotifyAdvance(1);
        return;
      }
      videoId = videos[0].id;
      spotifyState.youtubeCache[track.spotId] = { videoId: videoId, title: videos[0].title, status: 'resolved' };
    } catch (e) {
      if (myToken !== spotifyState.cancelToken) return;
      // v68: Detect offline/network errors and show friendly message
      var isOffline = !navigator.onLine || (e.message && (
        e.message.indexOf('Failed to fetch') !== -1 ||
        e.message.indexOf('NetworkError') !== -1 ||
        e.message.indexOf('Network request failed') !== -1
      ));
      if (isOffline) {
        console.warn("[spotify] offline — stopping playlist");
        showToast("You appear to be offline — Spotify playback stopped", 'warning');
        stopSpotifyCompletely();
        return;
      }
      console.error("[spotify] track lookup failed:", e);
      spotifyState.youtubeCache[track.spotId] = { videoId: null, title: null, status: 'failed' };
      spotifyState.failedTracks[track.spotId] = true;
      showToast("Skipped \u2014 search error: " + e.message);
      spotifyAdvance(1);
      return;
    } finally {
      if (myToken === spotifyState.cancelToken) spotifyState.prefetching = false;
    }
  }

  // Play the video
  console.log("[spotify] \u2192 playing YT video:", videoId);
  N96.nowPlaying = {
    path: null,
    filename: titleStr,
    ext: "SP",
    isYouTube: true,
    isSpotify: true,
    videoId: videoId,
    spotId: track.spotId,
    author: track.artist
  };
  updateMediaSession();
  /* v78: Track Spotify plays in statistics */
  updateStats(N96.nowPlaying);
  updateSpotifyProgress("Track " + pos + "/" + total);
  // v73: Update ultra track info and track counter for Spotify
  updateUltraTrackInfo();
  updateTrackCounter();

  if (ytReady && ytPlayer) {
    ytPlayer.loadVideoById(videoId);
    ytVideoLoaded = true;
  } else {
    ytPendingVideo = { id: videoId };
    console.log("[YouTube] API not ready yet, video queued.");
  }

  // Start YouTube seek bar updates
  startYTSeekBar();

  // Prefetch next 3 tracks (prioritize upcoming)
  prefetchNextTracks(spotifyState.currentIdx);

  /* v78: Update collections sidebar to highlight the active Spotify playlist */
  renderCollectionsSidebar();
}

/* ── Update Spotify progress badge ── */
function updateSpotifyProgress(text) {
  var el = $("#spotify-progress-text");
  if (el) el.textContent = text;
}

/* ── Fully stop Spotify mode ── */
function stopSpotifyCompletely() {
  spotifyState.cancelToken++;
  spotifyState.activePlaylistId = null;
  spotifyState.activePlaylistName = "";
  spotifyState.tracks = [];
  spotifyState.currentIdx = -1;
  spotifyState.failedTracks = {};
  spotifyState.shuffleWindow = null;
  spotifyState.prefetching = false;
  spotifyState.currentTrack = null;
  spotifyState.prefetchAbort = true;
  spotifyState.youtubeCache = {};
  spotifyState.prefetchQueue = [];
  stopYTSeekBar();

  if (ytPlayer && ytReady) {
    try { ytPlayer.stopVideo(); } catch(_) {}
  }

  var sp = $("#spotify-progress");
  if (sp) sp.classList.add("hidden");

  showCenterView("local");
  $("#sp-source-btn").classList.remove("active");
  N96.nowPlaying = null;
  N96.isPlaying = false;
  N96.currentIdx = -1;

  renderSpotifySidebar();
  renderYtMixesSidebar();
  // v73: update UI after Spotify stop
  updateUltraTrackInfo();
  updateTrackCounter();
}

/* ── Toast helper ── */
var toastTimer = null;
function showToast(msg, type) {
  type = type || 'info';
  var el = $("#toast");
  if (!el) return;
  el.textContent = msg;
  el.className = 'toast toast-' + type;
  void el.offsetWidth;
  el.classList.add('visible');
  if (toastTimer) clearTimeout(toastTimer);
  toastTimer = setTimeout(function(){
    el.classList.remove("visible");
    setTimeout(function(){ el.classList.add("hidden"); }, 250);
  }, 3500);
  console.log("[toast]", msg);
}

/* ── v14: Listen for postMessage from OAuth popup ── */
window.addEventListener("message", function(e) {
  if (e.data && e.data.type === "spotify-connected") {
    console.log("[spotify] received postMessage \u2014 user connected");
    spotifyState.userLoggedIn = true;
    updateSpotifyButton();
    renderSpotifyDisconnectLink();
    renderSpotifySidebar();
    showToast("Spotify connected successfully");

    // Check for pending resume — from memory or localStorage (in case page refreshed mid-OAuth)
    if (!_pendingSpotifyResume) {
      try {
        var saved = localStorage.getItem('n96_pending_spotify_resume');
        if (saved) {
          _pendingSpotifyResume = JSON.parse(saved);
          console.log('[N96] Restored pending Spotify resume from localStorage');
        }
      } catch(_) {}
    }

    // Auto-resume playlist if we were waiting for reconnect
    if (_pendingSpotifyResume) {
      var pending = _pendingSpotifyResume;
      _pendingSpotifyResume = null;
      // Clear the persisted pending resume
      try { localStorage.removeItem('n96_pending_spotify_resume'); } catch(_) {}
      // Hide the ext-source-card if it's still showing
      var extCard = document.getElementById('ext-source-card');
      if (extCard) extCard.classList.add('hidden');
      // Small delay to let the server token settle
      setTimeout(function() {
        var playlists = loadSpotifyPlaylists();
        var pl = playlists.find(function(p) { return p.id === pending.id; });
        if (pl) {
          console.log('[N96] Auto-resuming Spotify playlist after reconnect:', pending.name, 'track:', pending.trackTitle, 'idx:', pending.trackIndex);
          playSpotifyPlaylist(pl, pending.trackIndex, pending.trackTitle);
        } else {
          showToast('Playlist not found — click it in the sidebar', 'warning');
        }
      }, 500);
    }
    // Re-fetch status from server to confirm token is set
    fetch("/api/spotify/status").then(function(r) { return r.json(); }).then(function(d) {
      console.log("[spotify] server status after reconnect: userLoggedIn=" + d.userLoggedIn);
      if (!d.userLoggedIn) {
        console.warn("[spotify] server says not logged in - token may not be set");
        showToast("Warning: Server may not have your Spotify token. Try refreshing the page.");
      }
    }).catch(function(e) {
      console.warn("[spotify] could not verify server status after reconnect:", e);
    });
  }
});


/* ── Easter Egg: Console Help (v50) ── */
console.log("%c[N96] Type n96.help() for keyboard shortcuts", "color:var(--accent,#7fd1a4);font-size:11px;");
window.n96 = window.n96 || {};
window.n96.help = function() {
  console.log(
    "%c N96_freq Keyboard Shortcuts %c\n" +
    "  Space       — Play/Pause\n" +
    "  ← / →       — Seek ±10s\n" +
    "  ↑ / ↓       — Volume ±5%\n" +
    "  S           — Toggle Shuffle\n" +
    "  R           — Toggle Repeat\n" +
    "  T           — Sleep Timer\n" +
    "  P           — Pomodoro Timer\n" +
    "  M           — Mute/Unmute Ambient\n" +
    "  F           — Toggle Fullscreen\n" +
    "  Esc         — Close Overlays\n" +
    "  /           — Focus Search",
    "background:#0d1535;color:#7fd1a4;padding:4px 8px;border-radius:4px;font-weight:bold", ""
  );
};
window.n96.version = "v79";

/* ── Pomodoro Timer (v54) ─────────────────────────────────── */

function playPomodoroBeep(type) {
  if (!window.N96_AudioCtx) {
    try { window.N96_AudioCtx = new (window.AudioContext || window.webkitAudioContext)(); } catch(e) { return; }
  }
  var ctx = window.N96_AudioCtx;
  var osc = ctx.createOscillator();
  var gain = ctx.createGain();

  osc.connect(gain);
  gain.connect(ctx.destination);

  if (type === 'start') {
    /* Rising tone — session begins */
    osc.type = 'sine';
    osc.frequency.setValueAtTime(660, ctx.currentTime);
    osc.frequency.linearRampToValueAtTime(880, ctx.currentTime + 0.15);
    gain.gain.setValueAtTime(0.25, ctx.currentTime);
    gain.gain.exponentialRampToValueAtTime(0.01, ctx.currentTime + 0.5);
    osc.start(ctx.currentTime);
    osc.stop(ctx.currentTime + 0.5);
  } else if (type === 'end') {
    /* Falling tone — session phase ends */
    osc.type = 'triangle';
    osc.frequency.setValueAtTime(523, ctx.currentTime);
    osc.frequency.linearRampToValueAtTime(392, ctx.currentTime + 0.4);
    gain.gain.setValueAtTime(0.25, ctx.currentTime);
    gain.gain.exponentialRampToValueAtTime(0.01, ctx.currentTime + 1);
    osc.start(ctx.currentTime);
    osc.stop(ctx.currentTime + 1);
  } else if (type === 'complete') {
    /* Double ascending chime — all sessions done */
    osc.type = 'sine';
    osc.frequency.setValueAtTime(660, ctx.currentTime);
    gain.gain.setValueAtTime(0.25, ctx.currentTime);
    gain.gain.exponentialRampToValueAtTime(0.01, ctx.currentTime + 0.3);
    osc.start(ctx.currentTime);
    osc.stop(ctx.currentTime + 0.3);

    var osc2 = ctx.createOscillator();
    var gain2 = ctx.createGain();
    osc2.connect(gain2); gain2.connect(ctx.destination);
    osc2.type = 'sine';
    osc2.frequency.setValueAtTime(880, ctx.currentTime + 0.4);
    gain2.gain.setValueAtTime(0, ctx.currentTime);
    gain2.gain.setValueAtTime(0.25, ctx.currentTime + 0.4);
    gain2.gain.exponentialRampToValueAtTime(0.01, ctx.currentTime + 0.8);
    osc2.start(ctx.currentTime + 0.4);
    osc2.stop(ctx.currentTime + 0.8);
  }
}

function togglePomodoro() {
  var p = N96.pomodoro;
  if (p.isActive) {
    /* Pause the timer */
    clearInterval(p.intervalId);
    p.intervalId = null;
    p.isActive = false;
    updatePomodoroUI();
  } else {
    /* Start / resume the timer */
    p.isActive = true;
    p.intervalId = setInterval(pomodoroTick, 1000);
    playPomodoroBeep('start');
    updatePomodoroUI();
  }
}

function pomodoroTick() {
  var p = N96.pomodoro;
  p.timeLeft--;

  if (p.timeLeft <= 0) {
    playPomodoroBeep('end');

    if (p.phase === 'work') {
      /* Switch from work to rest */
      p.phase = 'rest';
      p.timeLeft = p.restDuration;
      setTimeout(function() { playPomodoroBeep('start'); }, 1000);
    } else {
      /* Rest phase ended — advance session counter */
      p.currentSession++;
      if (p.currentSession > p.totalSessions) {
        /* ALL SESSIONS COMPLETE */
        clearInterval(p.intervalId);
        p.intervalId = null;
        p.isActive = false;
        p.phase = 'work';
        p.timeLeft = p.workDuration;
        p.currentSession = 1;
        playPomodoroBeep('complete');
        pomodoroStopMusic();
      } else {
        /* Next work session */
        p.phase = 'work';
        p.timeLeft = p.workDuration;
        setTimeout(function() { playPomodoroBeep('start'); }, 1000);
      }
    }
  }
  updatePomodoroUI();
}

function pomodoroStopMusic() {
  /* Stop whatever is playing — local or YouTube */
  N96.userPaused = true;
  if (N96.nowPlaying && N96.nowPlaying.isYouTube && ytPlayer && ytReady) {
    ytPlayer.pauseVideo();
  } else {
    player.pause();
  }
  N96.isPlaying = false;
  updatePlayPauseUI();
  if ("mediaSession" in navigator) navigator.mediaSession.playbackState = "paused";
  console.log("[Pomodoro] All sessions complete — music stopped.");
}

function togglePomodoroModal() {
  var modal = document.getElementById('pomodoro-modal');
  if (!modal) return;
  if (modal.classList.contains('hidden')) {
    modal.classList.remove('hidden');
    modal.classList.add('visible');
    updatePomodoroUI();
  } else {
    modal.classList.add('hidden');
    modal.classList.remove('visible');
  }
}

function applyPomodoroSettings() {
  var p = N96.pomodoro;
  var sessionsEl = document.getElementById('pomo-sessions');
  var workEl = document.getElementById('pomo-work');
  var restEl = document.getElementById('pomo-rest');

  p.totalSessions = parseInt(sessionsEl ? sessionsEl.value : 4) || 4;
  p.workDuration = (parseInt(workEl ? workEl.value : 25) || 25) * 60;
  p.restDuration = (parseInt(restEl ? restEl.value : 5) || 5) * 60;

  /* Reset to start of session 1 */
  if (!p.isActive) {
    p.currentSession = 1;
    p.phase = 'work';
    p.timeLeft = p.workDuration;
  }
  updatePomodoroUI();
}

function updatePomodoroUI() {
  var p = N96.pomodoro;
  var phaseEl = document.getElementById('pomo-phase-text');
  var timeEl = document.getElementById('pomo-time-text');
  var sessionEl = document.getElementById('pomo-session-text');
  var startBtn = document.getElementById('pomo-start-btn');

  var mins = Math.floor(p.timeLeft / 60).toString().padStart(2, '0');
  var secs = (p.timeLeft % 60).toString().padStart(2, '0');

  if (phaseEl) {
    phaseEl.innerText = p.phase.toUpperCase();
    phaseEl.style.color = p.phase === 'work' ? 'var(--accent, #7fd1a4)' : '#f0a050';
  }
  if (timeEl) timeEl.innerText = mins + ':' + secs;
  if (sessionEl) sessionEl.innerText = 'Session ' + p.currentSession + ' of ' + p.totalSessions;
  if (startBtn) startBtn.innerText = p.isActive ? 'Pause' : 'Start';
}

/* ═══════════════════════════════════════════════════════════════
   v74: YouTube Playlist — Modal, Fetch, Play, Auto-Advance
   ═══════════════════════════════════════════════════════════════ */

/* ── Playlist Modal ── */
function openPlaylistModal() {
  var modal = document.getElementById('yt-playlist-modal');
  if (!modal) return;
  modal.classList.remove('hidden');
  modal.classList.add('visible');
  // Clear previous state
  var errEl = document.getElementById('yt-playlist-error');
  if (errEl) errEl.textContent = '';
  var resultEl = document.getElementById('yt-playlist-result');
  if (resultEl) resultEl.classList.add('hidden');
  var loadingEl = document.getElementById('yt-playlist-loading');
  if (loadingEl) loadingEl.classList.add('hidden');
  // If we have an active playlist, show it
  if (ytPlaylistState.active && ytPlaylistState.videos.length > 0) {
    renderPlaylistResult();
  }
  var input = document.getElementById('yt-playlist-url-input');
  if (input) setTimeout(function() { input.focus(); }, 100);
}

function closePlaylistModal() {
  var modal = document.getElementById('yt-playlist-modal');
  if (!modal) return;
  modal.classList.remove('visible');
  setTimeout(function() { modal.classList.add('hidden'); }, 300);
}

/* ── Fetch YouTube Playlist from backend ── */
async function fetchYouTubePlaylist() {
  var input = document.getElementById('yt-playlist-url-input');
  var errEl = document.getElementById('yt-playlist-error');
  var loadingEl = document.getElementById('yt-playlist-loading');
  var resultEl = document.getElementById('yt-playlist-result');
  var fetchBtn = document.getElementById('yt-playlist-fetch-btn');

  if (!input) return;
  var url = (input.value || '').trim();
  if (!url) {
    if (errEl) errEl.textContent = 'Please enter a YouTube playlist URL.';
    return;
  }

  // Basic validation — must contain playlist indicator
  if (!url.match(/[?&]list=|youtube\.com\/playlist/)) {
    if (errEl) errEl.textContent = 'This doesn\'t look like a YouTube playlist URL. It should contain "list=" parameter.';
    return;
  }

  // Clear errors, show loading
  if (errEl) errEl.textContent = '';
  if (loadingEl) loadingEl.classList.remove('hidden');
  if (resultEl) resultEl.classList.add('hidden');
  if (fetchBtn) fetchBtn.disabled = true;

  try {
    var res = await fetch('/api/youtube/playlist?url=' + encodeURIComponent(url));
    var data = await res.json();

    if (!res.ok || data.error) {
      if (errEl) errEl.textContent = data.error || ('Error: HTTP ' + res.status);
      if (loadingEl) loadingEl.classList.add('hidden');
      if (fetchBtn) fetchBtn.disabled = false;
      return;
    }

    // Store in state
    ytPlaylistState.title = data.playlistTitle || 'YouTube Playlist';
    ytPlaylistState.videos = data.videos || [];
    ytPlaylistState.url = url;
    // Don't set active yet — user must click Play All / Shuffle Play
    ytPlaylistState.active = false;
    ytPlaylistState.currentIndex = -1;
    ytPlaylistState.isShuffle = false;

    if (loadingEl) loadingEl.classList.add('hidden');
    renderPlaylistResult();
  } catch (e) {
    if (errEl) errEl.textContent = 'Failed to fetch playlist: ' + e.message;
    if (loadingEl) loadingEl.classList.add('hidden');
  }
  if (fetchBtn) fetchBtn.disabled = false;
}

/* ── Render playlist results in the modal ── */
function renderPlaylistResult() {
  var resultEl = document.getElementById('yt-playlist-result');
  var titleEl = document.getElementById('yt-playlist-result-title');
  var countEl = document.getElementById('yt-playlist-result-count');
  var listEl = document.getElementById('yt-playlist-video-list');

  if (!resultEl || !ytPlaylistState.videos.length) return;

  if (titleEl) titleEl.textContent = ytPlaylistState.title;
  if (countEl) countEl.textContent = ytPlaylistState.videos.length + ' video' + (ytPlaylistState.videos.length !== 1 ? 's' : '');

  var html = '';
  for (var i = 0; i < ytPlaylistState.videos.length; i++) {
    var v = ytPlaylistState.videos[i];
    var isActive = (ytPlaylistState.active && ytPlaylistState.currentIndex === i) ? ' active' : '';
    var thumbSrc = v.thumbnail || ('https://img.youtube.com/vi/' + v.id + '/mqdefault.jpg');
    html += '<div class="yt-playlist-video-item' + isActive + '" data-index="' + i + '" role="listitem">' +
      '<img class="yt-playlist-video-thumb" src="' + esc(thumbSrc) + '" alt="" loading="lazy" onerror="this.style.display=\'none\'">' +
      '<div class="yt-playlist-video-info">' +
        '<div class="yt-playlist-video-title">' + esc(v.title || 'Untitled') + '</div>' +
        '<div class="yt-playlist-video-meta">' +
          (v.uploader ? '<span>' + esc(v.uploader) + '</span>' : '') +
          (v.duration ? '<span class="yt-playlist-video-dur">' + esc(v.duration) + '</span>' : '') +
        '</div>' +
      '</div>' +
    '</div>';
  }
  listEl.innerHTML = html;
  resultEl.classList.remove('hidden');

  // Click handler — play a specific video from the list
  var items = listEl.querySelectorAll('.yt-playlist-video-item');
  for (var i = 0; i < items.length; i++) {
    (function(item) {
      item.addEventListener('click', function() {
        var idx = parseInt(item.getAttribute('data-index'), 10);
        if (isNaN(idx) || idx < 0 || idx >= ytPlaylistState.videos.length) return;
        ytPlaylistState.active = true;
        ytPlaylistState.currentIndex = idx;
        playYtPlaylistVideo(idx);
        renderPlaylistResult(); // update highlight
      });
    })(items[i]);
  }
}

/* ── Start playlist playback (Play All / Shuffle Play) ── */
function playYtPlaylist(shuffle) {
  if (!ytPlaylistState.videos.length) {
    showToast('No videos in the playlist.', 'error');
    return;
  }

  // If Spotify is active, exit it
  if (spotifyState.activePlaylistId) {
    stopSpotifyCompletely();
  }

  // If a local track is playing, pause it
  if (player.src) { player.pause(); }

  ytPlaylistState.active = true;
  ytPlaylistState.isShuffle = !!shuffle;

  if (shuffle) {
    // Fisher-Yates shuffle
    var arr = ytPlaylistState.videos.slice();
    for (var i = arr.length - 1; i > 0; i--) {
      var j = Math.floor(Math.random() * (i + 1));
      var temp = arr[i]; arr[i] = arr[j]; arr[j] = temp;
    }
    ytPlaylistState.videos = arr;
    showToast('Shuffled — ' + arr.length + ' videos', 'info');
  }

  ytPlaylistState.currentIndex = 0;
  playYtPlaylistVideo(0);

  // Update the modal list to show highlights
  renderPlaylistResult();

  // Close the modal so the player view is visible
  closePlaylistModal();

  // Update track counter
  updateTrackCounter();
  updateUltraTrackInfo();
}

/* ── Play a specific video from the YouTube playlist ── */
function playYtPlaylistVideo(index) {
  if (index < 0 || index >= ytPlaylistState.videos.length) return;
  var video = ytPlaylistState.videos[index];

  hidePanel();
  document.getElementById('ext-source-card').classList.add('hidden');
  showCenterView('yt-player');

  document.getElementById('yt-now-title').textContent = video.title || 'Untitled';
  document.getElementById('yt-now-meta').textContent =
    'YOUTUBE PLAYLIST' +
    (video.uploader ? ' \u00B7 ' + video.uploader : '') +
    (video.duration ? ' \u00B7 ' + video.duration : '') +
    ' \u00B7 ' + (index + 1) + '/' + ytPlaylistState.videos.length;

  N96.nowPlaying = {
    path: null,
    filename: video.title,
    ext: 'YT',
    isYouTube: true,
    isSpotify: false,
    videoId: video.id,
    author: video.uploader || ''
  };
  updateMediaSession();
  N96.currentIdx = -1;
  N96.duration = 0;

  updateUltraTrackInfo();
  updateTrackCounter();

  $$('.track-item').forEach(function(el) { el.classList.remove('active'); });

  if (ytReady && ytPlayer) {
    ytPlayer.loadVideoById(video.id);
    ytVideoLoaded = true;
  } else {
    ytPendingVideo = video;
    console.log('[yt-playlist] API not ready yet, video queued.');
  }

  startYTSeekBar();
  document.getElementById('play-pause-btn').textContent = '\u23F8';
  renderYtMixesSidebar();
  debouncedSaveState();
}

/* ── Auto-advance: called from onYTStateChange when a video ends ── */
function ytPlaylistAdvance() {
  if (!ytPlaylistState.active) return false;

  var nextIdx = ytPlaylistState.currentIndex + 1;
  if (nextIdx < ytPlaylistState.videos.length) {
    ytPlaylistState.currentIndex = nextIdx;
    playYtPlaylistVideo(nextIdx);
    // Update the modal list if it's open
    var modal = document.getElementById('yt-playlist-modal');
    if (modal && modal.classList.contains('visible')) {
      renderPlaylistResult();
    }
    return true;
  } else {
    // Playlist finished
    console.log('[yt-playlist] playlist finished');
    showToast('Playlist finished — ' + ytPlaylistState.title, 'info');
    ytPlaylistState.active = false;
    ytPlaylistState.currentIndex = -1;
    updateTrackCounter();
    updateUltraTrackInfo();
    debouncedSaveState();
    return false;
  }
}

/* ── Stop YouTube playlist playback ── */
function stopYtPlaylist() {
  ytPlaylistState.active = false;
  ytPlaylistState.title = '';
  ytPlaylistState.videos = [];
  ytPlaylistState.currentIndex = -1;
  ytPlaylistState.isShuffle = false;
  ytPlaylistState.url = '';
  updateTrackCounter();
  updateUltraTrackInfo();
}

/* ── Update the playlist modal highlights (called when playback state changes) ── */
function updatePlaylistModalHighlight() {
  var listEl = document.getElementById('yt-playlist-video-list');
  if (!listEl || !ytPlaylistState.active) return;
  var items = listEl.querySelectorAll('.yt-playlist-video-item');
  for (var i = 0; i < items.length; i++) {
    if (i === ytPlaylistState.currentIndex) {
      items[i].classList.add('active');
    } else {
      items[i].classList.remove('active');
    }
  }
}


/* ═══════════════════════════════════════════════════════════════
   v76: My Collections — virtual folders for organizing mixes & playlists
   v77: Inter-collection drag & drop, rename, restore-to-playlists button
   Drag & Drop from YouTube Mixes / Spotify Playlists into custom groups.
   Also supports dragging items BETWEEN collections.
   Persisted in localStorage under N96_COLLECTIONS_KEY.
   ═══════════════════════════════════════════════════════════════ */
var N96_COLLECTIONS_KEY = "n96-collections";

/* Collection data structure:
   { id: "col_<timestamp>", name: "Chill Vibes", items: [
     { type: "youtube", id: "dQw4w9WgXcQ", title: "Rick Astley - Never..." },
     { type: "spotify", id: "37i9dQZF1DXcBWIGoYBM5M", title: "Today's Top Hits" }
   ]}

   v77 additions:
   - Inter-collection drag: collection items are draggable to other collections
   - Rename: inline rename via edit icon on collection header
   - Restore: per-collection button that re-adds items to their original
     playlist sections (YouTube Mixes / Spotify Playlists)
*/

function loadCollections() {
  try {
    var raw = localStorage.getItem(N96_COLLECTIONS_KEY);
    return raw ? JSON.parse(raw) : [];
  } catch(_) { return []; }
}

function saveCollections(collections) {
  try { localStorage.setItem(N96_COLLECTIONS_KEY, JSON.stringify(collections)); } catch(_) {}
}

function createCollectionPrompt() {
  /* Inline prompt — no alert/prompt allowed. Create a temporary input. */
  var list = document.getElementById("collections-list");
  if (!list) return;

  /* Check if there's already an open input */
  if (list.querySelector(".collection-create-input")) return;

  var wrapper = document.createElement("div");
  wrapper.className = "collection-create-row";
  wrapper.innerHTML =
    '<input type="text" class="collection-create-input" placeholder="Collection name…" maxlength="40" autofocus />' +
    '<button class="collection-create-ok" title="Create" aria-label="Create collection">' +
      '<svg width="12" height="12" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="3" stroke-linecap="round" stroke-linejoin="round"><polyline points="20 6 9 17 4 12"></polyline></svg>' +
    '</button>' +
    '<button class="collection-create-cancel" title="Cancel" aria-label="Cancel">' +
      '<svg width="12" height="12" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><line x1="18" y1="6" x2="6" y2="18"></line><line x1="6" y1="6" x2="18" y2="18"></line></svg>' +
    '</button>';

  list.insertBefore(wrapper, list.firstChild);

  var input = wrapper.querySelector(".collection-create-input");
  var okBtn = wrapper.querySelector(".collection-create-ok");
  var cancelBtn = wrapper.querySelector(".collection-create-cancel");

  function doCreate() {
    var name = (input.value || "").trim();
    if (!name) { wrapper.remove(); return; }
    var collections = loadCollections();
    /* Prevent duplicate names */
    for (var i = 0; i < collections.length; i++) {
      if (collections[i].name.toLowerCase() === name.toLowerCase()) {
        showToast('Collection "' + name + '" already exists');
        input.focus();
        return;
      }
    }
    collections.push({ id: "col_" + Date.now(), name: name, items: [] });
    saveCollections(collections);
    renderCollectionsSidebar();
    showToast('Collection "' + name + '" created');
  }

  function doCancel() { wrapper.remove(); }

  okBtn.addEventListener("click", function(e) { e.stopPropagation(); doCreate(); });
  cancelBtn.addEventListener("click", function(e) { e.stopPropagation(); doCancel(); });
  input.addEventListener("keydown", function(e) {
    if (e.key === "Enter") doCreate();
    if (e.key === "Escape") doCancel();
  });
  input.focus();
}

function renderCollectionsSidebar() {
  var list = document.getElementById("collections-list");
  if (!list) return;
  var collections = loadCollections();

  /* Preserve any open create-input row */
  var createRow = list.querySelector(".collection-create-row");
  /* v77: preserve any open rename-input row */
  var renameRow = list.querySelector(".collection-rename-row");
  list.innerHTML = "";
  if (createRow) list.appendChild(createRow);

  if (collections.length === 0 && !createRow) {
    var hint = document.createElement("div");
    hint.className = "collection-hint";
    hint.textContent = "Create a collection, then drag mixes & playlists here";
    list.appendChild(hint);
    return;
  }

  for (var c = 0; c < collections.length; c++) {
    (function(col) {
      var colEl = document.createElement("div");
      colEl.className = "collection-folder";
      colEl.setAttribute("data-collection-id", col.id);

      /* v79: Use addEventListener instead of HTML attributes for reliable drag handling */
      (function(collectionId) {
        colEl.addEventListener("dragover", function(e) {
          handleCollectionDragOver(e, collectionId);
        });
        colEl.addEventListener("dragleave", function(e) {
          handleCollectionDragLeave(e, collectionId);
        });
        colEl.addEventListener("drop", function(e) {
          handleCollectionDrop(e, collectionId);
        });
      })(col.id);

      /* Header row */
      var header = document.createElement("div");
      header.className = "collection-header";
      header.innerHTML =
        '<span class="collection-icon">' +
          '<svg width="9" height="9" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><path d="M22 19a2 2 0 0 1-2 2H4a2 2 0 0 1-2-2V5a2 2 0 0 1 2-2h5l2 3h9a2 2 0 0 1 2 2z"></path></svg>' +
        '</span>' +
        '<span class="collection-name">' + esc(col.name) + '</span>' +
        '<span class="collection-count">(' + col.items.length + ')</span>' +
        /* v77: Restore button — puts collection items back into their playlist sections */
        '<span class="collection-restore" title="Restore items to their playlists">' +
          '<svg width="10" height="10" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><polyline points="1 4 1 10 7 10"></polyline><path d="M3.51 15a9 9 0 1 0 2.13-9.36L1 10"></path></svg>' +
        '</span>' +
        /* v77: Rename button */
        '<span class="collection-rename" title="Rename collection">' +
          '<svg width="10" height="10" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><path d="M11 4H4a2 2 0 0 0-2 2v14a2 2 0 0 0 2 2h14a2 2 0 0 0 2-2v-7"></path><path d="M18.5 2.5a2.121 2.121 0 0 1 3 3L12 15l-4 1 1-4 9.5-9.5z"></path></svg>' +
        '</span>' +
        '<span class="collection-delete" title="Delete collection">' +
          '<svg width="10" height="10" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><line x1="18" y1="6" x2="6" y2="18"></line><line x1="6" y1="6" x2="18" y2="18"></line></svg>' +
        '</span>';

      header.addEventListener("click", function(e) {
        if (e.target.closest(".collection-delete")) {
          e.stopPropagation();
          deleteCollection(col.id);
          return;
        }
        if (e.target.closest(".collection-rename")) {
          e.stopPropagation();
          startRenameCollection(col.id, col.name, header);
          return;
        }
        if (e.target.closest(".collection-restore")) {
          e.stopPropagation();
          restoreCollectionToPlaylists(col.id);
          return;
        }
        /* Toggle expand/collapse */
        colEl.classList.toggle("expanded");
      });

      colEl.appendChild(header);

      /* v77: If this collection has a pending rename, insert the rename input */
      if (renameRow && renameRow.getAttribute("data-collection-id") === col.id) {
        colEl.appendChild(renameRow);
        colEl.classList.add("expanded");
        /* Re-attach events and focus */
        var rInput = renameRow.querySelector(".collection-rename-input");
        if (rInput) setTimeout(function(){ rInput.focus(); rInput.select(); }, 0);
      }

      /* Items list (hidden by default, shown when expanded) */
      var itemsList = document.createElement("div");
      itemsList.className = "collection-items";

      for (var i = 0; i < col.items.length; i++) {
        (function(item, idx) {
          var itemEl = document.createElement("div");
          itemEl.className = "collection-item " + (item.type === "youtube" ? "item-yt" : "item-spotify");
          /* v78: Highlight the currently playing item in collections */
          var isActiveItem = false;
          if (N96.nowPlaying) {
            if (item.type === "youtube" && N96.nowPlaying.isYouTube && !N96.nowPlaying.isSpotify && N96.nowPlaying.videoId === item.id) {
              isActiveItem = true;
            } else if (item.type === "spotify" && spotifyState.activePlaylistId === item.id) {
              isActiveItem = true;
            }
          }
          if (isActiveItem) itemEl.classList.add("active");
          /* v77: make collection items draggable to other collections */
          itemEl.setAttribute("draggable", "true");
          itemEl.setAttribute("data-item-type", item.type);
          itemEl.setAttribute("data-item-id", item.id);
          itemEl.setAttribute("data-item-title", item.title || "");
          itemEl.setAttribute("data-source-collection", col.id);
          itemEl.setAttribute("data-item-idx", idx);

          var icon = item.type === "youtube"
            ? '<svg width="10" height="10" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><path d="M9 18V5l12-2v13"></path><circle cx="6" cy="18" r="3"></circle><circle cx="18" cy="16" r="3"></circle></svg>'
            : '<svg width="10" height="10" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><circle cx="12" cy="12" r="10"></circle><circle cx="8" cy="10" r="1" fill="currentColor"></circle><circle cx="12" cy="9" r="1" fill="currentColor"></circle><circle cx="16" cy="10" r="1" fill="currentColor"></circle></svg>';
          itemEl.innerHTML =
            '<span class="collection-item-icon">' + icon + '</span>' +
            '<span class="collection-item-name">' + esc(item.title || item.id) + '</span>' +
            '<span class="collection-item-remove" title="Remove from collection">' +
              '<svg width="10" height="10" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><line x1="18" y1="6" x2="6" y2="18"></line><line x1="6" y1="6" x2="18" y2="18"></line></svg>' +
            '</span>';

          /* v77: Drag start — for inter-collection drag */
          itemEl.addEventListener("dragstart", function(e) {
            var dragInfo = {
              source: "collection-item",
              sourceCollectionId: col.id,
              itemIdx: idx,
              type: item.type,
              id: item.id,
              title: item.title || ""
            };
            e.dataTransfer.setData("text/plain", JSON.stringify(dragInfo));
            e.dataTransfer.effectAllowed = "move";
            /* Highlight all OTHER collection drop zones */
            document.querySelectorAll(".collection-folder").forEach(function(el) {
              if (el.getAttribute("data-collection-id") !== col.id) {
                el.classList.add("collection-drag-active");
              }
            });
          });
          itemEl.addEventListener("dragend", function(e) {
            document.querySelectorAll(".collection-folder").forEach(function(el) {
              el.classList.remove("collection-drag-active");
              el.classList.remove("collection-drag-over");
            });
          });

          itemEl.addEventListener("click", function(e) {
            if (e.target.closest(".collection-item-remove")) {
              e.stopPropagation();
              removeFromCollection(col.id, idx);
              return;
            }
            playCollectionItem(item);
          });

          itemsList.appendChild(itemEl);
        })(col.items[i], i);
      }

      /* Drop zone hint (visible when dragging over) */
      var dropHint = document.createElement("div");
      dropHint.className = "collection-drop-hint";
      dropHint.textContent = "Drop here to add";
      itemsList.appendChild(dropHint);

      colEl.appendChild(itemsList);
      list.appendChild(colEl);
    })(collections[c]);
  }
}

function deleteCollection(colId) {
  var collections = loadCollections();
  var name = "";
  for (var i = 0; i < collections.length; i++) {
    if (collections[i].id === colId) { name = collections[i].name; collections.splice(i, 1); break; }
  }
  saveCollections(collections);
  renderCollectionsSidebar();
  if (name) showToast('Collection "' + name + '" deleted');
}

function removeFromCollection(colId, itemIdx) {
  var collections = loadCollections();
  for (var i = 0; i < collections.length; i++) {
    if (collections[i].id === colId) {
      var removed = collections[i].items.splice(itemIdx, 1);
      break;
    }
  }
  saveCollections(collections);
  renderCollectionsSidebar();
}

function playCollectionItem(item) {
  if (item.type === "youtube") {
    /* Look up the mix to get full metadata */
    var mixes = loadMixes();
    var mix = null;
    for (var i = 0; i < mixes.length; i++) {
      if (mixes[i].id === item.id) { mix = mixes[i]; break; }
    }
    if (mix) {
      playYouTube({ id: mix.id, title: mixDisplayName(mix), author: mix.author || "", duration: mix.duration || "" });
    } else {
      playYouTube({ id: item.id, title: item.title || "YouTube Mix", author: "", duration: "" });
    }
  } else if (item.type === "spotify") {
    /* Look up the Spotify playlist for full metadata */
    var playlists = loadSpotifyPlaylists();
    var pl = null;
    for (var i = 0; i < playlists.length; i++) {
      if (playlists[i].id === item.id) { pl = playlists[i]; break; }
    }
    if (pl) {
      playSpotifyPlaylist(pl);
    } else {
      showToast("Spotify playlist not found — it may have been removed");
    }
  }
}

/* ── Drag & Drop Handlers ── */

/* Called from ondragstart on mix-item and spotify-item elements */
function handleMixDragStart(e) {
  var type = "youtube";
  var id = "";
  var title = "";

  var mixItem = e.target.closest(".mix-item");
  var spItem = e.target.closest(".spotify-item");

  if (mixItem) {
    type = "youtube";
    id = mixItem.getAttribute("data-id") || "";
    title = mixItem.querySelector(".mix-name") ? mixItem.querySelector(".mix-name").textContent : "";
  } else if (spItem) {
    type = "spotify";
    id = spItem.getAttribute("data-id") || "";
    title = spItem.querySelector(".spotify-name") ? spItem.querySelector(".spotify-name").textContent : "";
  }

  if (!id) return;

  e.dataTransfer.setData("text/plain", JSON.stringify({ type: type, id: id, title: title }));
  e.dataTransfer.effectAllowed = "copy";

  /* Highlight all collection drop zones */
  document.querySelectorAll(".collection-folder").forEach(function(el) {
    el.classList.add("collection-drag-active");
  });
}

function handleMixDragEnd(e) {
  /* Remove all drag highlights */
  document.querySelectorAll(".collection-folder").forEach(function(el) {
    el.classList.remove("collection-drag-active");
    el.classList.remove("collection-drag-over");
  });
}

function handleCollectionDragOver(e, colId) {
  e.preventDefault();
  /* Determine the appropriate drop effect based on drag source */
  var raw = e.dataTransfer.types && e.dataTransfer.types.length > 0 ? "move" : "copy";
  e.dataTransfer.dropEffect = raw;
  /* Guard: e.target may be a text node during drag, which has no closest() */
  var folder = (e.target instanceof Element) ? e.target.closest(".collection-folder") : null;
  if (!folder) folder = document.querySelector('[data-collection-id="' + colId + '"]');
  if (folder) {
    folder.classList.add("collection-drag-over");
    /* Auto-expand on hover */
    if (!folder.classList.contains("expanded")) {
      folder.classList.add("expanded");
    }
  }
}

function handleCollectionDragLeave(e, colId) {
  /* Guard: e.target may be a text node during drag, which has no closest() */
  var folder = (e.target instanceof Element) ? e.target.closest(".collection-folder") : null;
  if (!folder) folder = document.querySelector('[data-collection-id="' + colId + '"]');
  if (folder) {
    /* Only remove if we're truly leaving the folder (not entering a child) */
    if (!e.relatedTarget || !folder.contains(e.relatedTarget)) {
      folder.classList.remove("collection-drag-over");
    }
  }
}

function handleCollectionDrop(e, colId) {
  e.preventDefault();
  /* Guard: e.target may be a text node during drag, which has no closest() */
  var folder = (e.target instanceof Element) ? e.target.closest(".collection-folder") : null;
  if (!folder) folder = document.querySelector('[data-collection-id="' + colId + '"]');
  if (folder) folder.classList.remove("collection-drag-over");
  document.querySelectorAll(".collection-folder").forEach(function(el) {
    el.classList.remove("collection-drag-active");
  });

  var raw = e.dataTransfer.getData("text/plain");
  if (!raw) return;

  try {
    var dragData = JSON.parse(raw);
  } catch(_) { return; }

  if (!dragData.type || !dragData.id) return;

  var collections = loadCollections();
  var col = null;
  for (var i = 0; i < collections.length; i++) {
    if (collections[i].id === colId) { col = collections[i]; break; }
  }
  if (!col) return;

  /* v77: Handle inter-collection drag (move from one collection to another) */
  if (dragData.source === "collection-item" && dragData.sourceCollectionId) {
    /* Don't drop on the same collection */
    if (dragData.sourceCollectionId === colId) return;

    /* Find source collection and remove the item */
    var sourceCol = null;
    for (var s = 0; s < collections.length; s++) {
      if (collections[s].id === dragData.sourceCollectionId) { sourceCol = collections[s]; break; }
    }
    if (sourceCol && typeof dragData.itemIdx === "number") {
      /* Remove from source */
      sourceCol.items.splice(dragData.itemIdx, 1);
    }

    /* Check for duplicate in target */
    for (var j = 0; j < col.items.length; j++) {
      if (col.items[j].type === dragData.type && col.items[j].id === dragData.id) {
        saveCollections(collections);
        renderCollectionsSidebar();
        showToast("Already in " + col.name + " — moved from " + (sourceCol ? sourceCol.name : "source"));
        return;
      }
    }

    col.items.push({ type: dragData.type, id: dragData.id, title: dragData.title || "" });
    saveCollections(collections);
    renderCollectionsSidebar();
    if (sourceCol) {
      showToast("Moved from " + sourceCol.name + " to " + col.name);
    } else {
      showToast("Added to " + col.name);
    }
    return;
  }

  /* Original: Drop from sidebar (YouTube Mix / Spotify playlist) */
  /* Check for duplicate */
  for (var j = 0; j < col.items.length; j++) {
    if (col.items[j].type === dragData.type && col.items[j].id === dragData.id) {
      showToast("Already in " + col.name);
      return;
    }
  }

  col.items.push({ type: dragData.type, id: dragData.id, title: dragData.title || "" });
  saveCollections(collections);
  renderCollectionsSidebar();
  showToast("Added to " + col.name);
}

/* ═══════════════════════════════════════════════════════════════
   v77: Collection Rename — inline edit input
   ═══════════════════════════════════════════════════════════════ */
function startRenameCollection(colId, currentName, headerEl) {
  /* Check if there's already a rename input open */
  var existing = document.querySelector(".collection-rename-row");
  if (existing) existing.remove();

  var colEl = headerEl.closest(".collection-folder");
  if (!colEl) return;

  var wrapper = document.createElement("div");
  wrapper.className = "collection-rename-row";
  wrapper.setAttribute("data-collection-id", colId);
  wrapper.innerHTML =
    '<input type="text" class="collection-rename-input" value="' + esc(currentName).replace(/"/g, '&quot;') + '" maxlength="40" />' +
    '<button class="collection-rename-ok" title="Save" aria-label="Save rename">' +
      '<svg width="12" height="12" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="3" stroke-linecap="round" stroke-linejoin="round"><polyline points="20 6 9 17 4 12"></polyline></svg>' +
    '</button>' +
    '<button class="collection-rename-cancel" title="Cancel" aria-label="Cancel rename">' +
      '<svg width="12" height="12" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><line x1="18" y1="6" x2="6" y2="18"></line><line x1="6" y1="6" x2="18" y2="18"></line></svg>' +
    '</button>';

  /* Insert after the header, before the items list */
  var itemsList = colEl.querySelector(".collection-items");
  if (itemsList) {
    colEl.insertBefore(wrapper, itemsList);
  } else {
    colEl.appendChild(wrapper);
  }

  var input = wrapper.querySelector(".collection-rename-input");
  var okBtn = wrapper.querySelector(".collection-rename-ok");
  var cancelBtn = wrapper.querySelector(".collection-rename-cancel");

  function doRename() {
    var newName = (input.value || "").trim();
    if (!newName || newName === currentName) {
      wrapper.remove();
      return;
    }
    /* Check for duplicate names */
    var collections = loadCollections();
    for (var i = 0; i < collections.length; i++) {
      if (collections[i].id !== colId && collections[i].name.toLowerCase() === newName.toLowerCase()) {
        showToast('Collection "' + newName + '" already exists');
        input.focus();
        input.select();
        return;
      }
    }
    /* Apply rename */
    for (var i = 0; i < collections.length; i++) {
      if (collections[i].id === colId) {
        collections[i].name = newName;
        break;
      }
    }
    saveCollections(collections);
    /* Remove the rename row BEFORE re-rendering, otherwise renderCollectionsSidebar
       preserves it and re-inserts it into the DOM */
    wrapper.remove();
    renderCollectionsSidebar();
    showToast('Renamed to "' + newName + '"');
  }

  function doCancel() { wrapper.remove(); }

  okBtn.addEventListener("click", function(e) { e.stopPropagation(); doRename(); });
  cancelBtn.addEventListener("click", function(e) { e.stopPropagation(); doCancel(); });
  input.addEventListener("keydown", function(e) {
    if (e.key === "Enter") doRename();
    if (e.key === "Escape") doCancel();
    e.stopPropagation();
  });
  /* Prevent header click from toggling expand while typing */
  input.addEventListener("click", function(e) { e.stopPropagation(); });

  input.focus();
  input.select();
}

/* ═══════════════════════════════════════════════════════════════
   v77: Restore Collection to Playlists
   Re-adds items from a collection back into their original
   playlist sections (YouTube Mixes / Spotify Playlists).
   Items that already exist in the target section are skipped.
   The collection itself is NOT deleted.
   ═══════════════════════════════════════════════════════════════ */
function restoreCollectionToPlaylists(colId) {
  var collections = loadCollections();
  var col = null;
  for (var i = 0; i < collections.length; i++) {
    if (collections[i].id === colId) { col = collections[i]; break; }
  }
  if (!col || col.items.length === 0) {
    showToast("Collection is empty — nothing to restore");
    return;
  }

  var ytRestored = 0;
  var ytSkipped = 0;
  var spRestored = 0;
  var spSkipped = 0;

  /* Restore YouTube items */
  var mixes = loadMixes();
  for (var i = 0; i < col.items.length; i++) {
    var item = col.items[i];
    if (item.type !== "youtube") continue;
    /* Check if already in mixes */
    var exists = false;
    for (var m = 0; m < mixes.length; m++) {
      if (mixes[m].id === item.id) { exists = true; break; }
    }
    if (exists) {
      ytSkipped++;
      continue;
    }
    /* Re-add the mix */
    mixes.push({
      id: item.id,
      name: "",
      title: item.title || "",
      author: "",
      thumbnail: "",
      duration: "",
      addedAt: Date.now() + i
    });
    ytRestored++;
  }
  if (ytRestored > 0) saveMixes(mixes);

  /* Restore Spotify items */
  var playlists = loadSpotifyPlaylists();
  for (var i = 0; i < col.items.length; i++) {
    var item = col.items[i];
    if (item.type !== "spotify") continue;
    /* Check if already in playlists */
    var exists = false;
    for (var p = 0; p < playlists.length; p++) {
      if (playlists[p].id === item.id) { exists = true; break; }
    }
    if (exists) {
      spSkipped++;
      continue;
    }
    /* Re-add the playlist */
    playlists.push({
      id: item.id,
      name: item.title || "",
      title: item.title || "",
      owner: "",
      image: "",
      total_tracks: 0,
      spotify_url: "https://open.spotify.com/playlist/" + item.id,
      addedAt: Date.now() + i
    });
    spRestored++;
  }
  if (spRestored > 0) {
    saveSpotifyPlaylists(playlists);
    /* Try to refresh metadata for newly restored playlists */
    for (var i = 0; i < col.items.length; i++) {
      var item = col.items[i];
      if (item.type === "spotify") {
        refreshSpotifyPlaylistMetadata(item.id);
      }
    }
  }

  /* Refresh YouTube metadata for restored mixes */
  if (ytRestored > 0) {
    refreshMissingMixMetadata();
  }

  /* Re-render sidebars */
  renderYtMixesSidebar();
  renderSpotifySidebar();

  /* Build summary toast */
  var parts = [];
  if (ytRestored > 0) parts.push(ytRestored + " YouTube mix" + (ytRestored > 1 ? "es" : ""));
  if (spRestored > 0) parts.push(spRestored + " Spotify playlist" + (spRestored > 1 ? "s" : ""));
  var skippedParts = [];
  if (ytSkipped > 0) skippedParts.push(ytSkipped + " YT already present");
  if (spSkipped > 0) skippedParts.push(spSkipped + " Spotify already present");

  var msg = "";
  if (parts.length > 0) {
    msg = "Restored " + parts.join(" & ");
    if (skippedParts.length > 0) msg += " (" + skippedParts.join(", ") + ")";
  } else {
    msg = "All items already in their playlists";
  }
  showToast(msg);
}

/* ── Make existing sidebar items draggable ── */
function makeSidebarItemsDraggable() {
  /* YouTube Mix items */
  document.querySelectorAll(".mix-item").forEach(function(el) {
    el.setAttribute("draggable", "true");
    el.addEventListener("dragstart", handleMixDragStart);
    el.addEventListener("dragend", handleMixDragEnd);
  });

  /* Spotify playlist items */
  document.querySelectorAll(".spotify-item").forEach(function(el) {
    el.setAttribute("draggable", "true");
    el.addEventListener("dragstart", handleMixDragStart);
    el.addEventListener("dragend", handleMixDragEnd);
  });
}



/* ═══════════════════════════════════════════════════════════════
   v75: Setup Wizard — guided configuration for new users
   Multi-step modal: Welcome → Music Dir → Spotify → yt-dlp → Save
   ═══════════════════════════════════════════════════════════════ */
var _wizardStep = 1;
var _wizardTotalSteps = 5;
var _wizardConfig = {};  // collected config data

/* ── First-run detection ── */
function checkFirstRun() {
  var setupComplete = localStorage.getItem('n96_setup_complete');
  if (setupComplete === 'true') return false;
  // Also check server-side — if MUSIC_DIR is the default or doesn't exist
  fetch('/api/config')
    .then(function(r) { return r.json(); })
    .then(function(data) {
      if (data.needsSetup) {
        console.log('[wizard] First run detected — showing Setup Wizard');
        setTimeout(function() { openSetupWizard(); }, 800);
      }
    })
    .catch(function() { /* silently ignore */ });
}

/* ── Open the Setup Wizard ── */
function openSetupWizard() {
  var modal = document.getElementById('setup-wizard-modal');
  if (!modal) return;
  modal.classList.remove('hidden');
  modal.classList.add('visible');
  _wizardStep = 1;
  _wizardConfig = {};
  updateWizardUI();
  // Load current config from server
  fetch('/api/config')
    .then(function(r) { return r.json(); })
    .then(function(data) {
      _wizardConfig._serverData = data;
      // Pre-fill fields
      var musicInput = document.getElementById('wizard-music-dir');
      if (musicInput && data.musicDir) musicInput.value = data.musicDir;
      var ytdlpInput = document.getElementById('wizard-ytdlp-path');
      if (ytdlpInput && data.ytdlpPath) ytdlpInput.value = data.ytdlpPath;
      // Show auto-detect hint
      if (data.autoDetectedMusicDir) {
        var autoEl = document.getElementById('wizard-music-auto');
        var autoPath = document.getElementById('wizard-music-auto-path');
        if (autoEl && autoPath) {
          autoPath.textContent = data.autoDetectedMusicDir;
          autoEl.style.display = 'flex';
        }
      }
      // Pre-check Spotify if already configured
      if (data.spotifyConfigured) {
        var spEnable = document.getElementById('wizard-spotify-enable');
        if (spEnable) spEnable.checked = true;
        wizardToggleSpotifyFields();
      }
      // Show yt-dlp status
      var ytdlpStatus = document.getElementById('wizard-ytdlp-status');
      if (ytdlpStatus) {
        ytdlpStatus.textContent = 'Currently using: ' + data.ytdlpPath;
        ytdlpStatus.classList.add('ok');
      }
    })
    .catch(function() { /* ignore */ });
}

/* ── Close the Setup Wizard ── */
function closeSetupWizard() {
  var modal = document.getElementById('setup-wizard-modal');
  if (!modal) return;
  modal.classList.remove('visible');
  setTimeout(function() { modal.classList.add('hidden'); }, 300);
}

/* ── Update wizard UI (progress bar, step visibility) ── */
function updateWizardUI() {
  // Show/hide steps
  for (var i = 1; i <= _wizardTotalSteps; i++) {
    var stepEl = document.getElementById('wizard-step-' + i);
    if (stepEl) {
      if (i === _wizardStep) stepEl.classList.remove('hidden');
      else stepEl.classList.add('hidden');
    }
  }
  // Update progress bar
  var progressBar = document.getElementById('wizard-progress-bar');
  if (progressBar) {
    progressBar.style.width = ((_wizardStep / _wizardTotalSteps) * 100) + '%';
  }
  // Update step dots
  var dots = document.querySelectorAll('.wizard-step-dot');
  for (var d = 0; d < dots.length; d++) {
    var stepNum = parseInt(dots[d].getAttribute('data-step'), 10);
    dots[d].classList.toggle('active', stepNum === _wizardStep);
    dots[d].classList.toggle('completed', stepNum < _wizardStep);
  }
  // Update summary on step 5
  if (_wizardStep === 5) {
    wizardUpdateSummary();
  }
}

/* ── Navigate to next step ── */
function wizardNext() {
  if (_wizardStep < _wizardTotalSteps) {
    _wizardStep++;
    updateWizardUI();
  }
}

/* ── Navigate to previous step ── */
function wizardBack() {
  if (_wizardStep > 1) {
    _wizardStep--;
    updateWizardUI();
  }
}

/* ── Skip current step (for optional steps) ── */
function wizardSkip() {
  wizardNext();
}

/* ── Validate Music Directory before proceeding ── */
function wizardValidateMusicDir() {
  var input = document.getElementById('wizard-music-dir');
  var errorEl = document.getElementById('wizard-music-dir-error');
  if (!input) return;

  var dir = (input.value || '').trim();
  if (!dir) {
    if (errorEl) { errorEl.textContent = 'Please enter a music folder path.'; errorEl.classList.add('visible'); }
    return;
  }
  if (errorEl) { errorEl.textContent = ''; errorEl.classList.remove('visible'); }

  // Validate via server
  fetch('/api/config', {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ musicDir: dir })
  })
    .then(function(r) { return r.json(); })
    .then(function(data) {
      if (data.success) {
        _wizardConfig.musicDir = dir;
        wizardNext();
      } else {
        var msg = 'Invalid path.';
        if (data.errors && data.errors.length > 0) {
          msg = data.errors[0].message;
        }
        if (errorEl) { errorEl.textContent = msg; errorEl.classList.add('visible'); }
      }
    })
    .catch(function(e) {
      if (errorEl) { errorEl.textContent = 'Validation failed: ' + e.message; errorEl.classList.add('visible'); }
    });
}

/* ── Use auto-detected music directory ── */
function wizardUseAutoMusicDir() {
  var autoPath = document.getElementById('wizard-music-auto-path');
  var musicInput = document.getElementById('wizard-music-dir');
  if (autoPath && musicInput) {
    musicInput.value = autoPath.textContent;
  }
}

/* ── Toggle Spotify fields visibility ── */
function wizardToggleSpotifyFields() {
  var checkbox = document.getElementById('wizard-spotify-enable');
  var fields = document.getElementById('wizard-spotify-fields');
  if (!checkbox || !fields) return;
  if (checkbox.checked) {
    fields.classList.remove('hidden');
  } else {
    fields.classList.add('hidden');
  }
}

/* ── Show Spotify credential guide ── */
function wizardShowSpotifyGuide() {
  var modal = document.getElementById('spotify-guide-modal');
  if (!modal) return;
  modal.classList.remove('hidden');
  modal.classList.add('visible');
}

/* ── Close Spotify guide ── */
function closeSpotifyGuide() {
  var modal = document.getElementById('spotify-guide-modal');
  if (!modal) return;
  modal.classList.remove('visible');
  setTimeout(function() { modal.classList.add('hidden'); }, 300);
}

/* ── Update summary on Step 5 ── */
function wizardUpdateSummary() {
  // Music dir
  var musicVal = document.getElementById('wizard-summary-music-val');
  var musicInput = document.getElementById('wizard-music-dir');
  if (musicVal && musicInput) {
    musicVal.textContent = musicInput.value || 'Not set';
  }

  // Spotify
  var spVal = document.getElementById('wizard-summary-spotify-val');
  var spIcon = document.getElementById('wizard-summary-spotify-icon');
  var spEnable = document.getElementById('wizard-spotify-enable');
  if (spVal && spEnable) {
    if (spEnable.checked) {
      spVal.textContent = 'Configured';
      if (spIcon) spIcon.innerHTML = '\u2713';
    } else {
      spVal.textContent = 'Not configured';
      if (spIcon) spIcon.innerHTML = '\u2014';
    }
  }

  // yt-dlp
  var ytVal = document.getElementById('wizard-summary-ytdlp-val');
  var ytInput = document.getElementById('wizard-ytdlp-path');
  if (ytVal && ytInput) {
    ytVal.textContent = ytInput.value || 'yt-dlp';
  }
}

/* ── Save configuration ── */
async function wizardSave() {
  var saveStatus = document.getElementById('wizard-save-status');
  var saveResult = document.getElementById('wizard-save-result');
  var saveBtn = document.getElementById('wizard-save-btn');
  var testBtn = document.getElementById('wizard-test-btn');

  // Build config object
  var config = {};
  var musicInput = document.getElementById('wizard-music-dir');
  if (musicInput) config.musicDir = musicInput.value.trim();

  var spEnable = document.getElementById('wizard-spotify-enable');
  if (spEnable && spEnable.checked) {
    var spId = document.getElementById('wizard-spotify-id');
    var spSecret = document.getElementById('wizard-spotify-secret');
    if (spId) config.spotifyClientId = spId.value.trim();
    if (spSecret) config.spotifyClientSecret = spSecret.value.trim();
  }

  var ytInput = document.getElementById('wizard-ytdlp-path');
  if (ytInput && ytInput.value.trim()) {
    config.ytDlpPath = ytInput.value.trim();
  }

  // Show saving state
  if (saveStatus) saveStatus.classList.remove('hidden');
  if (saveBtn) saveBtn.disabled = true;
  if (saveResult) saveResult.classList.add('hidden');

  try {
    var res = await fetch('/api/config', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify(config)
    });
    var data = await res.json();

    if (saveStatus) saveStatus.classList.add('hidden');
    if (saveBtn) saveBtn.disabled = false;

    if (data.success) {
      localStorage.setItem('n96_setup_complete', 'true');
      if (saveResult) {
        saveResult.innerHTML = '<div class="wizard-save-success">\u2713 Configuration saved!</div>' +
          '<p style="color:var(--text-secondary);font-size:12px;margin-top:8px;">Please restart the server for changes to take effect. ' +
          'After restarting, <a href="javascript:location.reload()" style="color:var(--accent);">refresh this page</a>.</p>';
        saveResult.classList.remove('hidden');
      }
      if (testBtn) testBtn.classList.remove('hidden');
      if (saveBtn) { saveBtn.textContent = 'Saved!'; saveBtn.disabled = true; }
    } else {
      var errorMsg = 'Save failed.';
      if (data.errors && data.errors.length > 0) {
        errorMsg = data.errors.map(function(e) { return e.message; }).join('; ');
      }
      if (saveResult) {
        saveResult.innerHTML = '<div class="wizard-save-error">' + esc(errorMsg) + '</div>';
        saveResult.classList.remove('hidden');
      }
    }

    // Show warnings if any
    if (data.warnings && data.warnings.length > 0) {
      var warningMsg = data.warnings.map(function(w) { return w.message; }).join(' ');
      showToast('Warning: ' + warningMsg, 'warning');
    }
  } catch (e) {
    if (saveStatus) saveStatus.classList.add('hidden');
    if (saveBtn) saveBtn.disabled = false;
    if (saveResult) {
      saveResult.innerHTML = '<div class="wizard-save-error">Network error: ' + esc(e.message) + '</div>';
      saveResult.classList.remove('hidden');
    }
  }
}

/* ── Test current configuration ── */
async function wizardTest() {
  var saveResult = document.getElementById('wizard-save-result');
  try {
    var res = await fetch('/api/config/test', { method: 'POST' });
    var data = await res.json();

    var html = '<div class="wizard-test-results">';
    html += '<div class="wizard-test-item ' + (data.musicDir ? 'ok' : 'fail') + '">Music Directory: ' + esc(data.details.musicDir || 'Unknown') + '</div>';
    html += '<div class="wizard-test-item ' + (data.spotify ? 'ok' : 'fail') + '">Spotify: ' + esc(data.details.spotify || 'Unknown') + '</div>';
    html += '<div class="wizard-test-item ' + (data.ytdlp ? 'ok' : 'fail') + '">yt-dlp: ' + esc(data.details.ytdlp || 'Unknown') + '</div>';
    html += '</div>';

    if (saveResult) {
      saveResult.innerHTML = html;
      saveResult.classList.remove('hidden');
    }
  } catch (e) {
    if (saveResult) {
      saveResult.innerHTML = '<div class="wizard-save-error">Test failed: ' + esc(e.message) + '</div>';
      saveResult.classList.remove('hidden');
    }
  }
}

/* Explicitly expose functions to global scope (for onclick handlers in HTML) */
window.togglePomodoroModal = togglePomodoroModal;
window.togglePomodoro = togglePomodoro;
window.applyPomodoroSettings = applyPomodoroSettings;
window.exportStats = exportStats;
window.openStatsPanel = openStatsPanel;
window.closeStatsPanel = closeStatsPanel;
window.resetToHome = resetToHome;
window.togglePerformanceMode = togglePerformanceMode;
window.toggleUltraMode = toggleUltraMode;
window.goBackView = goBackView;
window.openPlaylistModal = openPlaylistModal;
window.closePlaylistModal = closePlaylistModal;
window.fetchYouTubePlaylist = fetchYouTubePlaylist;
window.playYtPlaylist = playYtPlaylist;
window.openSetupWizard = openSetupWizard;
window.closeSetupWizard = closeSetupWizard;
window.wizardNext = wizardNext;
window.wizardBack = wizardBack;
window.wizardSkip = wizardSkip;
window.wizardValidateMusicDir = wizardValidateMusicDir;
window.wizardUseAutoMusicDir = wizardUseAutoMusicDir;
window.wizardToggleSpotifyFields = wizardToggleSpotifyFields;
window.wizardShowSpotifyGuide = wizardShowSpotifyGuide;
window.closeSpotifyGuide = closeSpotifyGuide;
window.wizardSave = wizardSave;
window.wizardTest = wizardTest;
window.createCollectionPrompt = createCollectionPrompt;
window.handleCollectionDragOver = handleCollectionDragOver;
window.handleCollectionDragLeave = handleCollectionDragLeave;
window.handleCollectionDrop = handleCollectionDrop;
window.startRenameCollection = startRenameCollection;
window.restoreCollectionToPlaylists = restoreCollectionToPlaylists;

