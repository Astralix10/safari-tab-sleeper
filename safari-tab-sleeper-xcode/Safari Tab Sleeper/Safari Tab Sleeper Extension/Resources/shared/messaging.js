export const runtimeApi = globalThis.browser ?? globalThis.chrome;

function deliverRuntimeMessage(message) {
  if (globalThis.browser?.runtime?.sendMessage) {
    return globalThis.browser.runtime.sendMessage(message);
  }

  return new Promise((resolve, reject) => {
    globalThis.chrome.runtime.sendMessage(message, (response) => {
      const error = globalThis.chrome.runtime.lastError;
      if (error) {
        reject(new Error(error.message));
        return;
      }

      resolve(response);
    });
  });
}

export async function sendRuntimeMessage(message) {
  let timer;
  const timeoutMs = /restore-all|sleep-all|free-memory|sleep-inactive/.test(message?.type) ? 60_000 : 15_000;
  try {
    return await Promise.race([
      deliverRuntimeMessage(message),
      new Promise((_, reject) => { timer = setTimeout(() => reject(new Error('Расширение не ответило вовремя.')), timeoutMs); }),
    ]);
  } finally {
    clearTimeout(timer);
  }
}
