import { isRemoteJsonValue } from '@deepseek-ai/dsh-typert-protocol';

const STATUSES = new Set(['pending', 'passed', 'failed', 'blocked', 'observed']);

export function validateAcceptanceUpdates(updates) {
  if (updates === undefined) return;
  if (!Array.isArray(updates)) throw new TypeError('acceptance_updates must be an array');
  for (const item of updates) {
    if (!item || typeof item !== 'object' || Array.isArray(item)
      || typeof item.criterion !== 'string' || item.criterion.trim().length === 0
      || !STATUSES.has(item.status)
      || (Object.hasOwn(item, 'evidence_refs') && (!Array.isArray(item.evidence_refs) || !item.evidence_refs.every(ref => typeof ref === 'string')))
      || (Object.hasOwn(item, 'note') && typeof item.note !== 'string')
      || !isRemoteJsonValue(item)) {
      throw new TypeError('acceptance_updates require a non-empty criterion, a valid status, optional string[] evidence_refs and string note');
    }
  }
}

// Updates replace the observation for their criterion. Empty updates are a
// no-op, so the append-only deferred path can never clear confirmed state.
export function mergeAcceptanceUpdates(current, updates) {
  const merged = new Map((current ?? []).map(item => [item.criterion, item]));
  for (const item of updates) merged.set(item.criterion, item);
  return [...merged.values()];
}
