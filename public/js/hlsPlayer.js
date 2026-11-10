/**
 * Plays a video with adaptive quality.
 *
 *   const player = VideoCmsPlayer.attach(videoEl, { hlsUrl, mp4Url }, { qualitySelect, infoEl });
 *   ...
 *   player.destroy();
 *
 * - hlsUrl set + hls.js supported (Chrome/Edge/Firefox/Android): "Auto" picks the
 *   quality from the viewer's measured bandwidth; the menu can lock 1080p/720p/480p/360p.
 *   The viewer's choice is remembered in localStorage.
 * - Safari / iPhone: native HLS, automatic quality only (Apple has no manual switch API).
 * - No hlsUrl (videos uploaded before HLS): falls back to the MP4.
 *
 * Needs hls.js loaded first: <script src="https://cdn.jsdelivr.net/npm/hls.js@1"></script>
 */
(function () {
  const PREF_KEY = 'videoCms.preferredQuality';

  function shortSide(level) {
    return Math.min(level.width || Infinity, level.height || Infinity) || level.height;
  }

  function attach(video, { hlsUrl, mp4Url }, { qualitySelect, infoEl } = {}) {
    let hls = null;
    const setInfo = (t) => { if (infoEl) infoEl.textContent = t; };
    const resetSelect = (enabled) => {
      if (!qualitySelect) return;
      qualitySelect.innerHTML = '<option value="-1">Auto</option>';
      qualitySelect.disabled = !enabled;
      qualitySelect.onchange = null;
    };

    if (hlsUrl && window.Hls && window.Hls.isSupported()) {
      hls = new window.Hls({ capLevelToPlayerSize: true }); // don't fetch 1080p into a small player
      hls.loadSource(hlsUrl);
      hls.attachMedia(video);
      resetSelect(true);

      hls.on(window.Hls.Events.MANIFEST_PARSED, (_, data) => {
        if (!qualitySelect) return;
        data.levels
          .map((l, i) => ({ p: shortSide(l), i }))
          .sort((a, b) => b.p - a.p)
          .forEach(({ p, i }) => qualitySelect.add(new Option(`${p}p`, String(i))));

        // Re-apply the viewer's last manual choice (by label, since level order can differ per video).
        let saved = null;
        try { saved = localStorage.getItem(PREF_KEY); } catch (_) { /* private mode */ }
        const match = [...qualitySelect.options].find((o) => o.text === saved);
        if (match && match.value !== '-1') {
          qualitySelect.value = match.value;
          hls.currentLevel = Number(match.value);
        }

        qualitySelect.onchange = () => {
          // -1 = Auto. nextLevel switches at the next segment without a stall.
          hls.nextLevel = Number(qualitySelect.value);
          const label = qualitySelect.selectedOptions[0].text;
          try { localStorage.setItem(PREF_KEY, label.startsWith('Auto') ? 'Auto' : label); } catch (_) {}
        };
      });

      hls.on(window.Hls.Events.LEVEL_SWITCHED, (_, d) => {
        const level = hls.levels[d.level];
        if (!level) return;
        const p = shortSide(level);
        const auto = hls.autoLevelEnabled;
        if (qualitySelect) qualitySelect.options[0].text = auto ? `Auto (${p}p)` : 'Auto';
        const mbps = (hls.bandwidthEstimate / 1e6).toFixed(1);
        setInfo(`${p}p · ~${mbps} Mbps${auto ? '' : ' · manual'}`);
      });

      hls.on(window.Hls.Events.ERROR, (_, d) => {
        if (!d.fatal) return;
        if (d.type === window.Hls.ErrorTypes.NETWORK_ERROR) hls.startLoad();
        else if (d.type === window.Hls.ErrorTypes.MEDIA_ERROR) hls.recoverMediaError();
        else if (mp4Url) { hls.destroy(); hls = null; video.src = mp4Url; setInfo('MP4 fallback'); resetSelect(false); }
        else { setInfo('Playback error'); }
      });
    } else if (hlsUrl && video.canPlayType('application/vnd.apple.mpegurl')) {
      video.src = hlsUrl; // Safari / iOS: switches quality by bandwidth natively
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
