// Claude Usage website — progressive enhancement only; the page works without it.
// 1. Download buttons (.js-download) point at the visitor's OS file, taken from the download section's links
//    (filled in at build time from the latest release), and that OS's card is marked "Your system".
// 2. Command boxes (pre.cmd) get a Copy button.
// No requests, no storage, nothing sent anywhere.
(() => {
  'use strict';

  /** OS → the download that suits most people on it, and the button text. */
  const PRIMARY = {
    windows: { asset: 'winSetup', label: 'Download for Windows' },
    mac: { asset: 'macArm', label: 'Download for macOS' },
    linux: { asset: 'appImage', label: 'Download for Linux' },
  };

  /** The visitor's desktop OS, or null on phones, tablets and anything unknown (they get the download section). */
  function detectOs() {
    const ua = navigator.userAgent || '';
    const platform = (navigator.userAgentData && navigator.userAgentData.platform) || navigator.platform || '';
    if (/android|iphone|ipad|ipod|mobile|cros/i.test(ua)) return null;
    if (/mac/i.test(platform) && navigator.maxTouchPoints > 1) return null; // iPadOS asks for the desktop site
    if (/win/i.test(platform) || /windows nt/i.test(ua)) return 'windows';
    if (/mac/i.test(platform) || /mac os x/i.test(ua)) return 'mac';
    if (/linux|x11/i.test(platform) || /linux|x11/i.test(ua)) return 'linux';
    return null;
  }

  function setUpDownloads() {
    const os = detectOs();
    if (!os) return;
    const card = document.querySelector(`.platform[data-os="${os}"]`);
    const link = card && card.querySelector(`.dl[data-asset="${PRIMARY[os].asset}"]`);
    if (!link) return;
    card.classList.add('is-yours');

    const size = (link.querySelector('.dl-size') || {}).textContent || '';
    for (const button of document.querySelectorAll('.js-download')) {
      const meta = [`v${button.dataset.version}`, link.dataset.kind, size].filter(Boolean).join(' · ');
      button.href = link.href;
      button.querySelector('.js-download-label').textContent = PRIMARY[os].label;
      button.querySelector('.js-download-meta').textContent = meta;
    }
  }

  function setUpCopyButtons() {
    if (!navigator.clipboard) return;
    for (const pre of document.querySelectorAll('pre.cmd')) {
      const button = document.createElement('button');
      button.type = 'button';
      button.className = 'copy';
      button.textContent = 'Copy';
      button.setAttribute('aria-label', 'Copy command');
      let timer;
      button.addEventListener('click', () => {
        navigator.clipboard.writeText(pre.querySelector('code').textContent.trim()).then(
          () => {
            button.textContent = 'Copied';
            clearTimeout(timer);
            timer = setTimeout(() => (button.textContent = 'Copy'), 1600);
          },
          () => {
            button.textContent = 'Press Ctrl+C';
          },
        );
      });
      pre.append(button);
    }
  }

  setUpDownloads();
  setUpCopyButtons();
})();
