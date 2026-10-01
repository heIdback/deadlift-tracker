// Training-state GENERATION — the marker that stops a stale client from
// resurrecting data an admin reset removed. Pure constants/helpers only;
// the live state and Firestore access are in services/trainingGenerationService.js.
//
// Model (see README "Admin → Reset training data" → "Stale devices"):
//   - users/{uid}.trainingGeneration: a random token, changed by EVERY
//     successful admin reset (absent → the 'initial' generation);
//   - users/{uid}/progressionSuggestions/__training-generation-<token>: the
//     generation's SENTINEL document. The reset (applied by the user's own
//     app — services/trainingResetService.js) deletes the old sentinel and
//     creates the new one in the same transaction that changes the token;
//   - every client write of training state is a batch that also
//     `update()`s its generation's sentinel. `update` requires the document
//     to exist, so once a reset has removed that sentinel the SERVER rejects
//     the whole batch atomically — including writes queued offline before
//     the reset and replayed afterwards. No security-rules change is needed.
//
export const INITIAL_GENERATION = 'initial';
export const GENERATION_SENTINEL_COLLECTION = 'progressionSuggestions';
export const GENERATION_SENTINEL_PREFIX = '__training-generation-';
const TOKEN = /^[A-Za-z0-9_-]{1,64}$/;

export const generationSentinelId = (generation) => `${GENERATION_SENTINEL_PREFIX}${generation}`;

export const isGenerationSentinelId = (id) => typeof id === 'string' && id.startsWith(GENERATION_SENTINEL_PREFIX);

/** The generation a profile document belongs to ('initial' if it was never reset). */
export function generationOf(profile) {
  const g = profile?.trainingGeneration;
  return typeof g === 'string' && TOKEN.test(g) ? g : INITIAL_GENERATION;
}
