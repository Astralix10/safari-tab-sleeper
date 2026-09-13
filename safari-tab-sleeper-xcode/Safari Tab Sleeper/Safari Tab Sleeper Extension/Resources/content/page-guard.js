(() => {
  const api = globalThis.browser ?? globalThis.chrome;
  let dirty = false;
  let youtubeVideoCount = 0;
  let youtubeLastVideoUrl = '';
  let lastHref = location.href;
  let lastSentState = '';
  const fieldSnapshots = new WeakMap();
  const editableSelector = 'input:not([type="hidden"]):not([type="button"]):not([type="submit"]):not([type="reset"]), textarea, select, [contenteditable="true"]';

  function isEditableElement(target) {
    if (!target) {
      return false;
    }

    const tagName = target.tagName?.toLowerCase();
    return target.isContentEditable || tagName === 'textarea' || tagName === 'select'
      || (tagName === 'input' && !['hidden', 'button', 'submit', 'reset'].includes(target.type));
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
    for (const field of root.querySelectorAll?.(editableSelector) ?? []) {
      if (!fieldSnapshots.has(field)) {
        fieldSnapshots.set(field, fieldValue(field));
      }
    }
  }

  function hasProgrammaticFieldChanges() {
    rememberFields();
    for (const field of document.querySelectorAll(editableSelector)) {
      if (fieldSnapshots.get(field) !== fieldValue(field)) {
        return true;
      }
    }
    return false;
  }

  function mediaIsPlaying() {
    return Array.from(document.querySelectorAll('audio, video'))
      .some((media) => !media.paused && !media.ended && media.readyState > 0);
  }

  function sendState() {
    try {
      const state = {
        type: 'tab-sleeper:page-state',
        pageUrl: location.href,
        pageTitle: document.title,
        dirty,
        mediaPlaying: mediaIsPlaying(),
        youtubeVideoCount,
        youtubeLastVideoUrl,
      };
      const signature = JSON.stringify(state);
      if (signature === lastSentState) return;
      lastSentState = signature;
      Promise.resolve(api.runtime.sendMessage(state)).catch(() => { lastSentState = ''; });
    } catch {
      lastSentState = '';
      // The background worker may be asleep or unavailable.
    }
  }

  function readPageState() {
    dirty ||= hasProgrammaticFieldChanges();
    return {
      canSleep: !dirty,
      dirty,
      mediaPlaying: mediaIsPlaying(),
      pageUrl: location.href,
      pageTitle: document.title,
      youtubeVideoCount,
      youtubeLastVideoUrl,
    };
  }

  // Available only in the extension's isolated world, including subframes.
  globalThis.__tabSleeperReadState = readPageState;

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

  for (const eventName of ['play', 'playing', 'pause', 'ended', 'emptied']) {
    document.addEventListener(eventName, sendState, true);
  }
  document.addEventListener('visibilitychange', sendState, true);

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

  api.runtime.onMessage.addListener((message, sender, sendResponse) => {
    if (message?.type === 'tab-sleeper:get-page-info') {
      sendResponse({
        pageUrl: location.href,
        pageTitle: document.title,
      });
      return false;
    }

    if (message?.type === 'tab-sleeper:can-sleep') {
      sendResponse(readPageState());
      return false;
    }

    if (message?.type === 'tab-sleeper:reset-youtube-counter') {
      youtubeVideoCount = 0;
      youtubeLastVideoUrl = youtubeVideoIdentity(location.href);
      sendState();
      sendResponse({ ok: true });
      return false;
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
