// Note sources are declared by the client, not authenticated identities. Keep legacy human
// strings readable while retaining attribution on notes submitted by the agent client.
export function noteRecord(note) {
  return {
    text: typeof note === 'string' ? note : String(note?.text || ''),
    source: note?.source === 'agent' ? 'agent' : 'human',
  };
}

export function storedNote(note) {
  const record = noteRecord(note);
  return record.source === 'human' ? record.text : record;
}

export const noteAuthor = (note) => noteRecord(note).source === 'agent' ? 'Agent coordinator' : 'Human';
export const noteLabel = (note) => noteRecord(note).source === 'agent' ? 'Agent note' : 'You said';
