export type DocumentSummary = {
  id: string;
  name: string;
  createdAt: string;
  numPages: number;
  numChunks: number;
  scannedLikely: boolean;
  totalExtractedChars?: number;
  nonEmptyPages?: number;
};

export type ChatSource = {
  chunkId: string;
  pageStart: number;
  pageEnd: number;
  score: number;
  excerpt: string;
};

const API_URL = import.meta.env.VITE_API_URL || 'http://localhost:8080';

async function http<T>(path: string, init?: RequestInit): Promise<T> {
  const res = await fetch(`${API_URL}${path}`, {
    ...init,
    headers: {
      'Content-Type': 'application/json',
      ...(init?.headers || {}),
    },
  });

  if (!res.ok) {
    const text = await res.text();
    throw new Error(text || `Request failed: ${res.status}`);
  }
  return (await res.json()) as T;
}

export async function listDocuments(): Promise<DocumentSummary[]> {
  const data = await http<{ documents: DocumentSummary[] }>('/api/documents');
  return data.documents;
}

export async function uploadPdf(file: File): Promise<DocumentSummary> {
  const form = new FormData();
  form.append('file', file);

  const res = await fetch(`${API_URL}/api/documents`, { method: 'POST', body: form });
  if (!res.ok) {
    const text = await res.text();
    throw new Error(text || `Upload failed: ${res.status}`);
  }

  const data = (await res.json()) as { document: DocumentSummary };
  return data.document;
}

export async function chat(docId: string, messages: { role: 'user' | 'assistant'; content: string }[], question: string) {
  return await http<{ answer: string; sources: ChatSource[] }>('/api/chat', {
    method: 'POST',
    body: JSON.stringify({ docId, messages, question }),
  });
}

export async function compare(docIdA: string, docIdB: string, prompt: string) {
  return await http<{ answer: string; sourcesA: ChatSource[]; sourcesB: ChatSource[] }>('/api/compare', {
    method: 'POST',
    body: JSON.stringify({ docIdA, docIdB, prompt }),
  });
}
