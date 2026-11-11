/**
 * Plays a video with adaptive quality.
 *
 *   const player = VideoCmsPlayer.attach(videoEl, { hlsUrl, mp4Url }, { qualitySelect, infoEl });
 *   ...
 *   player.destroy();
 *
 * - Starts initial playback with 360p for instant, buffer-free start.
 * - Auto mode: adapts resolution (360p, 480p, 720p, 1080p) dynamically according
 *   to network bandwidth.
 * - Manual mode: user can lock to a specific resolution (e.g. 1080p, 720p).
 *   Selecting "Auto" immediately resumes automatic bandwidth adaptation.
 */
(function () {
  const PREF_KEY = 'videoCms.preferredQuality';

  function shortSide(level) {
    return Math.min(level.width || Infinity, level.height || Infinity) || level.height;
  }

  function attach(video, { hlsUrl, mp4Url }, { qualitySelect, infoEl } = {}) {
    let hls = null;
    let timer = null;

    const setInfo = (t) => { if (infoEl) infoEl.textContent = t; };
    const resetSelect = (enabled) => {
      if (!qualitySelect) return;
      qualitySelect.innerHTML = '<option value="-1">Auto</option>';
      qualitySelect.disabled = !enabled;
      qualitySelect.onchange = null;
    };

    if (hlsUrl && window.Hls && window.Hls.isSupported()) {
      hls = new window.Hls({
        maxBufferLength: 12,          // Keep buffer tight so bandwidth changes reflect quickly
        capLevelToPlayerSize: false,  // Allow 1080p/720p even in smaller player dimensions
        // Initial estimate at 1 Mbps seeds playback at 360p, then adapts upward
        abrEwmaDefaultEstimate: 1000000,
      });
      hls.loadSource(hlsUrl);
      hls.attachMedia(video);
      resetSelect(true);

      hls.on(window.Hls.Events.MANIFEST_PARSED, (_, data) => {
        if (!qualitySelect) return;

        // Build resolution list: Auto first, then descending (1080p, 720p, etc.)
        qualitySelect.innerHTML = '<option value="-1">Auto</option>';
        data.levels
          .map((l, i) => ({ p: shortSide(l), i }))
          .sort((a, b) => b.p - a.p)
          .forEach(({ p, i }) => qualitySelect.add(new Option(`${p}p`, String(i))));

        // Check if user previously locked to a manual resolution
        let saved = null;
        try { saved = localStorage.getItem(PREF_KEY); } catch (_) { }
        const match = [...qualitySelect.options].find((o) => o.text === saved);

        if (match && match.value !== '-1') {
          // Manual preference preserved
          qualitySelect.value = match.value;
          hls.nextLevel = Number(match.value);
        } else {
          // Default: Auto quality (adapts by bandwidth)
          qualitySelect.value = '-1';
          hls.nextLevel = -1;
        }

        // User changes dropdown
        qualitySelect.onchange = () => {
          const val = Number(qualitySelect.value);
          hls.nextLevel = val; // -1 = Auto (ABR); >= 0 = manual level
          if (val === -1) {
            try { localStorage.setItem(PREF_KEY, 'Auto'); } catch (_) { }
          } else {
            const label = qualitySelect.selectedOptions[0].text;
            try { localStorage.setItem(PREF_KEY, label); } catch (_) { }
          }
        };
      });

      hls.on(window.Hls.Events.LEVEL_SWITCHED, (_, d) => {
        const level = hls.levels[d.level];
        if (!level) return;
        const p = shortSide(level);
        const isAuto = hls.autoLevelEnabled;
        if (qualitySelect) {
          qualitySelect.options[0].text = isAuto ? `Auto (${p}p)` : 'Auto';
        }
        const mbps = (hls.bandwidthEstimate / 1e6).toFixed(1);
        setInfo(`${p}p · ~${mbps} Mbps ${isAuto ? '(Auto)' : '(Manual)'}`);
      });

      // Keep status line and dropdown label updated in real-time
      timer = setInterval(() => {
        if (!hls) return;
        const lvl = hls.levels[hls.currentLevel];
        if (!lvl) return;
        const p = shortSide(lvl);
        const isAuto = hls.autoLevelEnabled;
        if (qualitySelect) {
          qualitySelect.options[0].text = isAuto ? `Auto (${p}p)` : 'Auto';
        }
        const mbps = (hls.bandwidthEstimate / 1e6).toFixed(1);
        setInfo(`${p}p · ~${mbps} Mbps ${isAuto ? '(Auto)' : '(Manual)'}`);
      }, 500);

      hls.on(window.Hls.Events.ERROR, (_, d) => {
        if (!d.fatal) return;
        if (d.type === window.Hls.ErrorTypes.NETWORK_ERROR) {
          hls.startLoad();
        } else if (d.type === window.Hls.ErrorTypes.MEDIA_ERROR) {
          hls.recoverMediaError();
        } else if (mp4Url) {
          hls.destroy();
          hls = null;
          video.src = mp4Url;
          setInfo('MP4 fallback');
          resetSelect(false);
        } else {
          setInfo('Playback error');
        }
      });
    } else if (hlsUrl && video.canPlayType('application/vnd.apple.mpegurl')) {
      video.src = hlsUrl;
      resetSelect(false);
      setInfo('Auto quality');
    } else if (mp4Url) {
      video.src = mp4Url;
      resetSelect(false);
      setInfo(hlsUrl ? 'MP4 (HLS not supported here)' : 'Single quality (uploaded before HLS)');
    } else {
      resetSelect(false);
      setInfo('No playable source');
    }

    return {
      destroy() {
        if (timer) { clearInterval(timer); timer = null; }
        if (hls) { hls.destroy(); hls = null; }
        video.pause();
        video.removeAttribute('src');
        video.load();
        resetSelect(false);
        setInfo('');
      },
    };
  }

  window.VideoCmsPlayer = { attach };
})();
