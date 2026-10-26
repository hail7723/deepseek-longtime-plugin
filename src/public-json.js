// Do not use stringify/parse here: it silently coerces NaN and exotic objects.
// Undefined entries are omitted recursively; all other unsupported values fail
// closed before the Agent runtime snapshots the canonical tool value.
export function publicJson(value, ancestors = new Set()) {
  if (value === null || ['string', 'boolean'].includes(typeof value)) return value;
  if (typeof value === 'number' && Number.isFinite(value) && !Object.is(value, -0)) return value;
  if (typeof value !== 'object' || ancestors.has(value)) throw invalidOutput();
  const array = Array.isArray(value);
  const prototype = Object.getPrototypeOf(value);
  if (array ? prototype !== Array.prototype : prototype !== Object.prototype && prototype !== null) throw invalidOutput();
  ancestors.add(value);
  try {
    const result = array ? [] : {};
    for (const key of Reflect.ownKeys(value)) {
      if (array && key === 'length') continue;
      const descriptor = Object.getOwnPropertyDescriptor(value, key);
      if (typeof key !== 'string' || !descriptor.enumerable || !Object.hasOwn(descriptor, 'value')) throw invalidOutput();
      if (array && (!/^(0|[1-9]\d*)$/.test(key) || Number(key) >= value.length)) throw invalidOutput();
      if (descriptor.value === undefined) continue;
      const item = publicJson(descriptor.value, ancestors);
      if (array) result.push(item);
      else Object.defineProperty(result, key, { value: item, enumerable: true, writable: true, configurable: true });
    }
    return result;
  } finally { ancestors.delete(value); }
}

function invalidOutput() {
  const error = new Error('Project memory tool returned a non-JSON value');
  error.code = 'INVALID_TOOL_OUTPUT';
  return error;
}

export function publicCommitResult(result) {
  if (!result.ok || !result.synced) return result;
  const { ok, synced, projectId, taskId, taskVersion, contractVersion, flushed, needsReview } = result;
  const { id, eventSeq, createdAt } = result.checkpoint;
  return { ok, synced, projectId, taskId, taskVersion, contractVersion,
    checkpoint: { id, eventSeq, createdAt }, flushed, needsReview };
}

export function publicCompleteResult(result) {
  if (!result.ok) return result;
  const { projectId, taskId, state, taskVersion, contractVersion, leaseReleased } = result;
  const { id, eventSeq, createdAt } = result.checkpoint;
  const value = { ok: true, synced: true, projectId, taskId, state, taskVersion, contractVersion,
    checkpoint: { id, eventSeq, createdAt }, leaseReleased };
  if (Buffer.byteLength(JSON.stringify(value, null, 2)) > 2048) {
    const error = new Error('Completion receipt exceeds its response budget'); error.code = 'PARTICIPANT_RESPONSE_TOO_LARGE'; throw error;
  }
  return value;
}
