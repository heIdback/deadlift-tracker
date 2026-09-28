/** Strip HTML tags and collapse whitespace from any free-text field before storing. */
export function sanitizeText(input, maxLength = 500) {
  if (input == null) return '';
  const stripped = String(input).replace(/<[^>]*>/g, '').trim();
  return stripped.slice(0, maxLength);
}

export function isValidWeight(kg) {
  return typeof kg === 'number' && Number.isFinite(kg) && kg >= 0 && kg <= 500;
}

export function isValidReps(reps) {
  return Number.isInteger(reps) && reps >= 0 && reps <= 100;
}

export function isValidRpe(rpe) {
  if (rpe == null || rpe === '') return true; // optional field
  const n = Number(rpe);
  return Number.isFinite(n) && n >= 1 && n <= 10;
}

/** Validate a single logged set before it is written to Firestore. */
export function validateSet({ kg, reps, rpe, note }) {
  const errors = [];
  if (!isValidWeight(kg)) errors.push('Weight must be between 0 and 500 kg.');
  if (!isValidReps(reps)) errors.push('Reps must be a whole number between 0 and 100.');
  if (!isValidRpe(rpe)) errors.push('RPE must be between 1 and 10.');
  if (note && note.length > 300) errors.push('Note is too long (max 300 characters).');
  return { valid: errors.length === 0, errors };
}
