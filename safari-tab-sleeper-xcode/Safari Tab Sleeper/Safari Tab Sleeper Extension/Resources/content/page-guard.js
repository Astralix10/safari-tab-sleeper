(() => {
  const api = globalThis.browser ?? globalThis.chrome;
  let dirty = false;
  let youtubeVideoCount = 0;
  let youtubeLastVideoUrl = '';
  let lastHref = location.href;
  const fieldSnapshots = new WeakMap();

  function isEditableElement(target) {
    if (!target) {
      return false;
    }

    const tagName = target.tagName?.toLowerCase();
    return target.isContentEditable || tagName === 'textarea' || tagName === 'select' || tagName === 'input';
  }

  function youtubeVideoIdentity(url) {
    try {
      const parsed = new URL(url);
      const host = parsed.hostname.toLowerCase();
      if (host === 'youtu.be') {
        return parsed.pathname.split('/').filter(Boolean)[0] || '';
      }
      if (host !== 'youtube.com' && !host.endsWith('.youtube.com')) {
        return '';
      }
      if (parsed.pathname === '/watch') {
        return parsed.searchParams.get('v') || '';
      }
      const shortMatch = parsed.pathname.match(/^\/(?:shorts|live)\/([^/]+)/);
      return shortMatch?.[1] || '';
    } catch {
      return '';
    }
  }

  function fieldValue(field) {
    if (field instanceof HTMLInputElement && (field.type === 'checkbox' || field.type === 'radio')) {
      return `${field.checked}`;
    }
    if (field instanceof HTMLSelectElement) {
      return Array.from(field.selectedOptions, (option) => option.value).join('\u0000');
    }
    return String(field.value ?? field.textContent ?? '');
  }

  function rememberFields(root = document) {
    for (const field of root.querySelectorAll?.('input, textarea, select, [contenteditable="true"]') ?? []) {
      if (!fieldSnapshots.has(field)) {
        fieldSnapshots.set(field, fieldValue(field));
      }
    }
  }

  function hasProgrammaticFieldChanges() {
    rememberFields();
    for (const field of document.querySelectorAll('input, textarea, select, [contenteditable="true"]')) {
      if (fieldSnapshots.get(field) !== fieldValue(field)) {
        return true;
      }
    }
    return false;
  }

  function sendState() {
    try {
      Promise.resolve(api.runtime.sendMessage({
        type: 'tab-sleeper:page-state',
        pageUrl: location.href,
        pageTitle: document.title,
        dirty,
        youtubeVideoCount,
        youtubeLastVideoUrl,
      })).catch(() => undefined);
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
    const videoIdentity = youtubeVideoIdentity(href);
    if (videoIdentity && videoIdentity !== youtubeLastVideoUrl) {
      youtubeVideoCount += 1;
      youtubeLastVideoUrl = videoIdentity;
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
    dirty = true;
    sendState();
  }, true);

  window.addEventListener('pageshow', () => {
    rememberFields();
    sendState();
  });
  window.addEventListener('popstate', () => setTimeout(handleNavigationChange, 0));
  window.addEventListener('hashchange', handleNavigationChange);
  document.addEventListener('yt-navigate-finish', handleNavigationChange);

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
      dirty ||= hasProgrammaticFieldChanges();
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
      youtubeLastVideoUrl = youtubeVideoIdentity(location.href);
      sendState();
      return Promise.resolve({ ok: true });
    }

    return false;
  });

  rememberFields();
  if (youtubeVideoIdentity(location.href)) {
    youtubeVideoCount = 1;
    youtubeLastVideoUrl = youtubeVideoIdentity(location.href);
  }
  sendState();
})();
