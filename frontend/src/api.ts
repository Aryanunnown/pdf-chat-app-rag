import { API_DEFAULTS } from './constants';
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

export type CompareMode = 'content' | 'methodology' | 'conclusions' | 'structure' | 'literal' | 'custom';

export type CompareTopicVerdict = 'same' | 'different' | 'onlyA' | 'onlyB' | 'unclear';

export type CompareStructured = {
  mode: CompareMode;
  task: string;
  topics: {
    topic: string;
    docA: string;
    docB: string;
    verdict: CompareTopicVerdict;
    notes?: string;
  }[];
  summary?: string;
};

export type CompareResponse = {
  answer: string;
  mode?: CompareMode;
  task?: string;
  structured?: CompareStructured | null;
  sourcesA: ChatSource[];
  sourcesB: ChatSource[];
};

const API_URL = API_DEFAULTS.BASE_URL;

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

export type UploadPdfOptions = {
  onProgress?: (percent: number) => void;
};

export async function uploadPdf(file: File, options?: UploadPdfOptions): Promise<DocumentSummary> {
  const form = new FormData();
  form.append('file', file);

  return await new Promise<DocumentSummary>((resolve, reject) => {
    const xhr = new XMLHttpRequest();
    xhr.open('POST', `${API_URL}/api/documents`);

    xhr.upload.onprogress = (evt) => {
      if (!evt.lengthComputable) return;
      const percent = Math.round((evt.loaded / evt.total) * 100);
      options?.onProgress?.(percent);
    };

    xhr.onerror = () => reject(new Error('Network error during upload'));

    xhr.onload = () => {
      try {
        const raw = xhr.responseText || '';
        if (xhr.status < 200 || xhr.status >= 300) {
          reject(new Error(raw || `Upload failed: ${xhr.status}`));
          return;
        }

        const data = (raw ? JSON.parse(raw) : {}) as { document?: DocumentSummary };
        if (!data.document) {
          reject(new Error('Upload failed: invalid response'));
          return;
        }
        resolve(data.document);
      } catch {
        reject(new Error('Upload failed: invalid JSON response'));
      }
    };

    xhr.send(form);
  });
}

export async function chat(docId: string, messages: { role: 'user' | 'assistant'; content: string }[], question: string) {
  return await http<{ answer: string; sources: ChatSource[] }>('/api/chat', {
    method: 'POST',
    body: JSON.stringify({ docId, messages, question }),
  });
}

export async function compare(docIdA: string, docIdB: string, prompt: string, mode?: CompareMode): Promise<CompareResponse> {
  return await http<CompareResponse>('/api/compare', {
    method: 'POST',
    body: JSON.stringify({ docIdA, docIdB, prompt, mode }),
  });
}
