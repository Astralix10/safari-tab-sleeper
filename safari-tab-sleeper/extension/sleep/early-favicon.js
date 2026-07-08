(function () {
  const placeholder = "data:image/svg+xml,%3Csvg xmlns='http://www.w3.org/2000/svg' viewBox='0 0 32 32'%3E%3Crect width='32' height='32' rx='8' fill='%23f2f5f4'/%3E%3Cpath d='M10 11h12l-9 10h9' fill='none' stroke='%2364706d' stroke-width='2.6' stroke-linecap='round' stroke-linejoin='round'/%3E%3C/svg%3E";
  const favicon = document.querySelector('#favicon');
  if (!favicon) {
    return;
  }

  favicon.href = pickIconUrl() || placeholder;

  function pickIconUrl() {
    const entry = decodeFallbackEntry(location.hash);
    if (!entry) {
      return '';
    }

    if (isHttpUrl(entry.favIconUrl)) {
      return entry.favIconUrl;
    }

    try {
      const parsed = new URL(entry.url);
      if (parsed.protocol === 'http:' || parsed.protocol === 'https:') {
        return `${parsed.origin}/favicon.ico`;
      }
    } catch {
      return '';
    }

    return '';
  }

  function decodeFallbackEntry(hash) {
    try {
      const params = new URLSearchParams(String(hash || '').replace(/^#/, ''));
      const encoded = params.get('fallback');
      if (!encoded) {
        return null;
      }

      return JSON.parse(base64UrlDecode(encoded));
    } catch {
      return null;
    }
  }

  function base64UrlDecode(value) {
    const padded = value.replace(/-/g, '+').replace(/_/g, '/').padEnd(Math.ceil(value.length / 4) * 4, '=');
    const binary = atob(padded);
    const bytes = Uint8Array.from(binary, (char) => char.charCodeAt(0));
    return new TextDecoder().decode(bytes);
  }

  function isHttpUrl(value) {
    try {
      const parsed = new URL(value);
      return parsed.protocol === 'http:' || parsed.protocol === 'https:';
    } catch {
      return false;
    }
  }
})();
