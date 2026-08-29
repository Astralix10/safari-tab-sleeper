(() => {
  const api = globalThis.browser ?? globalThis.chrome;
  let dirty = false;
  let youtubeVideoCount = 0;
  let youtubeLastVideoUrl = '';
  let lastHref = location.href;

  function isEditableElement(target) {
    if (!target) {
      return false;
    }

    const tagName = target.tagName?.toLowerCase();
    return target.isContentEditable || tagName === 'textarea' || tagName === 'select' || tagName === 'input';
  }

  function isYouTubeWatchUrl(url) {
    try {
      const parsed = new URL(url);
      const host = parsed.hostname.toLowerCase();
      return (host === 'youtube.com' || host.endsWith('.youtube.com')) && parsed.pathname === '/watch' && parsed.searchParams.has('v');
    } catch {
      return false;
    }
  }

  function sendState() {
    try {
      api.runtime.sendMessage({
        type: 'tab-sleeper:page-state',
        pageUrl: location.href,
        pageTitle: document.title,
        dirty,
        youtubeVideoCount,
        youtubeLastVideoUrl,
      });
    } catch {
      // The background worker may be asleep or unavailable.
    }
  }

  function handleNavigationChange() {
    const href = location.href;
    if (href === lastHref) {
      return;
    }

    lastHref = href;
    dirty = false;
    if (isYouTubeWatchUrl(href) && href !== youtubeLastVideoUrl) {
      youtubeVideoCount += 1;
      youtubeLastVideoUrl = href;
    }
    sendState();
  }

  document.addEventListener('input', (event) => {
    if (isEditableElement(event.target)) {
      dirty = true;
      sendState();
    }
  }, true);

  document.addEventListener('change', (event) => {
    if (isEditableElement(event.target)) {
      dirty = true;
      sendState();
    }
  }, true);

  document.addEventListener('submit', () => {
    dirty = false;
    sendState();
  }, true);

  window.addEventListener('pageshow', sendState);
  window.addEventListener('popstate', () => setTimeout(handleNavigationChange, 0));
  window.setInterval(handleNavigationChange, 1000);

  for (const method of ['pushState', 'replaceState']) {
    const original = history[method];
    history[method] = function tabSleeperHistoryWrapper(...args) {
      const result = original.apply(this, args);
      setTimeout(handleNavigationChange, 0);
      return result;
    };
  }

  api.runtime.onMessage.addListener((message) => {
    if (message?.type === 'tab-sleeper:get-page-info') {
      return Promise.resolve({
        pageUrl: location.href,
        pageTitle: document.title,
      });
    }

    if (message?.type === 'tab-sleeper:can-sleep') {
      return Promise.resolve({
        canSleep: !dirty,
        dirty,
        pageUrl: location.href,
        pageTitle: document.title,
        youtubeVideoCount,
        youtubeLastVideoUrl,
      });
    }

    if (message?.type === 'tab-sleeper:reset-youtube-counter') {
      youtubeVideoCount = 0;
      youtubeLastVideoUrl = isYouTubeWatchUrl(location.href) ? location.href : '';
      sendState();
      return Promise.resolve({ ok: true });
    }

    return false;
  });

  if (isYouTubeWatchUrl(location.href)) {
    youtubeVideoCount = 1;
    youtubeLastVideoUrl = location.href;
  }
  sendState();
})();
