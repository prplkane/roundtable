// Note sources are declared by the client, not authenticated identities. Keep legacy human
// strings readable while retaining attribution on notes submitted by the agent client:
// 'agent' is the assistant's own note, 'relayed' the user's answers as the assistant reported them.
export const SOURCES = ['human', 'agent', 'relayed'];
export function noteRecord(note) {
  return {
    text: typeof note === 'string' ? note : String(note?.text || ''),
    source: SOURCES.includes(note?.source) ? note.source : 'human',
  };
}

export function storedNote(note) {
  const record = noteRecord(note);
  return record.source === 'human' ? record.text : record;
}

const AUTHORS = { human: 'Human', agent: 'Agent coordinator', relayed: 'Human (relayed by the assistant)' };
const LABELS = { human: 'You said', agent: 'Agent note', relayed: 'You said, via your assistant' };
export const noteAuthor = (note) => AUTHORS[noteRecord(note).source];
export const noteLabel = (note) => LABELS[noteRecord(note).source];
