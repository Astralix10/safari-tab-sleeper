import { COMPANION_MUTATION_TOKEN } from './companion-token.js';

export const COMPANION_MUTATION_HEADER = 'x-safari-tab-sleeper-token';

export function companionMutationHeaders(contentType = 'text/plain;charset=UTF-8') {
  return {
    'content-type': contentType,
    [COMPANION_MUTATION_HEADER]: COMPANION_MUTATION_TOKEN,
  };
}
