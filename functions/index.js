// Cloud Functions entry point (Firebase Functions v2, ESM). The only server
// component of the app: the admin "Reset training data" callable. All logic
// and every authorization check live in ./src/resetCore.js (unit-tested);
// this file only wires it to firebase-functions + firebase-admin.
import { onCall, HttpsError } from 'firebase-functions/v2/https';
import { initializeApp } from 'firebase-admin/app';
import { getFirestore, FieldValue } from 'firebase-admin/firestore';
import { createResetHandler, ResetError } from './src/resetCore.js';

initializeApp();
const handler = createResetHandler({ db: getFirestore(), serverTimestamp: () => FieldValue.serverTimestamp() });

export const adminResetUserFitness = onCall({ timeoutSeconds: 300, memory: '256MiB' }, async (request) => {
  try {
    return await handler(request);
  } catch (err) {
    if (err instanceof ResetError) throw new HttpsError(err.code, err.message);
    console.error('adminResetUserFitness failed', err);
    throw new HttpsError('internal', 'The reset did not complete. You can safely run it again.');
  }
});
