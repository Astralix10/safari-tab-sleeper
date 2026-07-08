export const runtimeApi = globalThis.browser ?? globalThis.chrome;

export function sendRuntimeMessage(message) {
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
