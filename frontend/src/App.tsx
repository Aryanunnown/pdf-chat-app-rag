import { useEffect, useMemo, useState } from 'react'
import ReactMarkdown from 'react-markdown'
import remarkGfm from 'remark-gfm'
import './App.css'
import {
  chat,
  compare,
  listDocuments,
  uploadPdf,
  type ChatSource,
  type CompareMode,
  type CompareStructured,
  type DocumentSummary,
} from './api'
import { FRONTEND_DEFAULTS } from './constants'

type ChatMessage = {
  role: 'user' | 'assistant'
  content: string
  sources?: ChatSource[]
}

function getErrorMessage(e: unknown): string {
  if (e instanceof Error) return e.message
  if (typeof e === 'string') return e
  try {
    return JSON.stringify(e)
  } catch {
    return ''
  }
}

function Sources({ sources }: { sources: ChatSource[] }) {
  if (!sources.length) return null
  return (
    <div className="sources">
      <div className="sourcesTitle">Sources</div>
      <ul className="sourcesList">
        {sources.map((s) => (
          <li key={s.chunkId} className="sourceItem">
            <div className="sourceMeta">
              <span className="mono">{s.chunkId}</span>
              <span>pages {s.pageStart}-{s.pageEnd}</span>
              <span className="muted">score {s.score.toFixed(3)}</span>
            </div>
            <div className="sourceExcerpt">{s.excerpt}…</div>
          </li>
        ))}
      </ul>
    </div>
  )
}

function App() {
  const [documents, setDocuments] = useState<DocumentSummary[]>([])
  const [activeDocId, setActiveDocId] = useState<string>('')
  const [mode, setMode] = useState<'chat' | 'compare'>('chat')

  const [busy, setBusy] = useState(false)
  const [thinkingChat, setThinkingChat] = useState(false)
  const [thinkingCompare, setThinkingCompare] = useState(false)
  const [error, setError] = useState<string>('')

  const [uploadPercent, setUploadPercent] = useState<number | null>(null)
  const [uploadPhase, setUploadPhase] = useState<'idle' | 'uploading' | 'processing'>('idle')

  const activeDoc = useMemo(() => documents.find((d) => d.id === activeDocId), [documents, activeDocId])

  const [messages, setMessages] = useState<ChatMessage[]>([])
  const [question, setQuestion] = useState('')

  const [docA, setDocA] = useState('')
  const [docB, setDocB] = useState('')
  const [compareMode, setCompareMode] = useState<CompareMode>('content')
  const [comparePrompt, setComparePrompt] = useState('Compare the documents: key similarities and key differences.')
  const [compareAnswer, setCompareAnswer] = useState<string>('')
  const [compareStructured, setCompareStructured] = useState<CompareStructured | null>(null)
  const [compareSourcesA, setCompareSourcesA] = useState<ChatSource[]>([])
  const [compareSourcesB, setCompareSourcesB] = useState<ChatSource[]>([])

  function defaultComparePromptForMode(m: CompareMode) {
    switch (m) {
      case 'methodology':
        return 'Compare the methodology: data, experimental setup, evaluation, and limitations.'
      case 'conclusions':
        return 'Compare the main conclusions, results, and key takeaways.'
      case 'structure':
        return 'Compare the document structure: sections, organization, and coverage.'
      case 'literal':
        return 'Compare literal wording differences: definitions, requirements, numbers, and constraints.'
      case 'custom':
        return 'Compare the documents: key similarities and key differences.'
      case 'content':
      default:
        return 'Compare the documents: key similarities and key differences.'
    }
  }

  async function refreshDocs(selectId?: string) {
    const docs = await listDocuments()
    setDocuments(docs)

    const nextSelected = selectId || activeDocId
    if (nextSelected && docs.some((d) => d.id === nextSelected)) {
      setActiveDocId(nextSelected)
      return
    }

    if (docs.length) {
      setActiveDocId(docs[0].id)
    } else {
      setActiveDocId('')
    }
  }

  useEffect(() => {
    refreshDocs().catch((e) => setError(e.message))
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [])

  function validateUploadFile(file: File) {
    const isPdf = file.type === FRONTEND_DEFAULTS.PDF_MIME || file.name.toLowerCase().endsWith('.pdf')
    if (!isPdf) throw new Error('Only PDF files are supported.')
    if (file.size > FRONTEND_DEFAULTS.MAX_PDF_BYTES) throw new Error(`PDF must be ${FRONTEND_DEFAULTS.MAX_PDF_LABEL} or smaller.`)
  }

  async function onUpload(file: File) {
    setError('')
    setUploadPercent(0)
    setUploadPhase('uploading')
    setBusy(true)
    try {
      validateUploadFile(file)
      const doc = await uploadPdf(file, {
        onProgress: (pct) => {
          setUploadPercent(pct)
          if (pct >= 100) setUploadPhase('processing')
        },
      })
      await refreshDocs(doc.id)
      setMessages([])
      setCompareAnswer('')
      setCompareStructured(null)
      setCompareSourcesA([])
      setCompareSourcesB([])
    } catch (e: unknown) {
      setError(getErrorMessage(e) || 'Upload failed')
    } finally {
      setBusy(false)
      setUploadPhase('idle')
      setUploadPercent(null)
    }
  }

  async function onAsk() {
    if (!activeDocId) {
      setError('Upload and select a document first.')
      return
    }
    if (!question.trim()) return

    setError('')
    const q = question.trim()
    setQuestion('')

    const nextMessages: ChatMessage[] = [...messages, { role: 'user', content: q }]
    setMessages(nextMessages)

    setBusy(true)
    setThinkingChat(true)
    try {
      const history = nextMessages
        .filter((m) => m.role === 'user' || m.role === 'assistant')
        .map((m) => ({ role: m.role, content: m.content }))

      const resp = await chat(activeDocId, history.slice(0, -1), q)
      setMessages((prev) => [...prev, { role: 'assistant', content: resp.answer, sources: resp.sources }])
    } catch (e: unknown) {
      setError(getErrorMessage(e) || 'Chat failed')
    } finally {
      setThinkingChat(false)
      setBusy(false)
    }
  }

  async function onCompare() {
    if (!docA || !docB || docA === docB) {
      setError('Select two different documents to compare.')
      return
    }
    setError('')
    setBusy(true)
    setThinkingCompare(true)
    try {
      const resp = await compare(docA, docB, comparePrompt, compareMode)
      setCompareAnswer(resp.answer)
      setCompareStructured(resp.structured || null)
      setCompareSourcesA(resp.sourcesA)
      setCompareSourcesB(resp.sourcesB)
    } catch (e: unknown) {
      setError(getErrorMessage(e) || 'Compare failed')
    } finally {
      setThinkingCompare(false)
      setBusy(false)
    }
  }

  return (
    <div className="shell">
      <header className="header">
        <div className="title">PDF Chat App</div>
        <div className="subtitle">Upload PDFs, ask questions, and get cited answers.</div>
      </header>

      <div className="layout">
        <aside className="sidebar">
          <div className="panel">
            <div className="panelTitle">Upload</div>
            <input
              type="file"
              accept="application/pdf"
              disabled={busy}
              onChange={(e) => {
                const f = e.target.files?.[0]
                if (f) void onUpload(f)
                // Allow re-selecting the same file after upload.
                e.target.value = ''
              }}
            />
            {uploadPercent !== null ? (
              <div className="uploadProgress">
                <div className="uploadProgressRow">
                  <div className="muted">
                    {uploadPhase === 'uploading'
                      ? `Uploading… ${uploadPercent}%`
                      : uploadPhase === 'processing'
                        ? 'Processing…'
                        : ''}
                  </div>
                </div>
                <div className="progressTrack" role="progressbar" aria-valuenow={uploadPercent} aria-valuemin={0} aria-valuemax={100}>
                  <div className="progressFill" style={{ width: `${uploadPercent}%` }} />
                </div>
              </div>
            ) : (
              <div className="muted">Max size: {FRONTEND_DEFAULTS.MAX_PDF_LABEL}</div>
            )}
          </div>

          <div className="panel">
            <div className="panelTitle">Documents</div>
            {documents.length === 0 ? (
              <div className="muted">No documents yet.</div>
            ) : (
              <select value={activeDocId} disabled={busy} onChange={(e) => setActiveDocId(e.target.value)}>
                {documents.map((d) => (
                  <option key={d.id} value={d.id}>
                    {d.name}
                  </option>
                ))}
              </select>
            )}
            {activeDoc ? (
              <div className="docMeta">
                <div className="muted">pages: {activeDoc.numPages}</div>
                <div className="muted">chunks: {activeDoc.numChunks}</div>
                {typeof activeDoc.totalExtractedChars === 'number' ? (
                  <div className="muted">extracted chars: {activeDoc.totalExtractedChars}</div>
                ) : null}
                {typeof activeDoc.nonEmptyPages === 'number' ? (
                  <div className="muted">non-empty pages: {activeDoc.nonEmptyPages}</div>
                ) : null}
                {activeDoc.scannedLikely ? <div className="warn">Likely scanned PDF (text extraction may fail)</div> : null}
              </div>
            ) : null}
          </div>

          <div className="panel">
            <div className="panelTitle">Mode</div>
            <div className="modeRow">
              <button className={mode === 'chat' ? 'btn active' : 'btn'} onClick={() => setMode('chat')} disabled={busy}>
                Chat
              </button>
              <button className={mode === 'compare' ? 'btn active' : 'btn'} onClick={() => setMode('compare')} disabled={busy}>
                Compare
              </button>
            </div>
          </div>
        </aside>

        <main className="main">
          {error ? <div className="error">{error}</div> : null}

          {mode === 'chat' ? (
            <div className="panel">
              <div className="panelTitle">Chat</div>
              <div className="chat">
                {messages.length === 0 ? (
                  <div className="muted">Ask a question about the selected PDF.</div>
                ) : (
                  messages.map((m, idx) => (
                    <div key={idx} className={m.role === 'user' ? 'msg user' : 'msg assistant'}>
                      <div className="msgRole">{m.role}</div>
                      {m.role === 'assistant' ? (
                        <div className="msgContent markdown">
                          <ReactMarkdown remarkPlugins={[remarkGfm]}>{m.content}</ReactMarkdown>
                        </div>
                      ) : (
                        <div className="msgContent">{m.content}</div>
                      )}
                      {m.role === 'assistant' && m.sources ? <Sources sources={m.sources} /> : null}
                    </div>
                  ))
                )}

                {thinkingChat ? (
                  <div className="msg assistant thinking">
                    <div className="msgRole">assistant</div>
                    <div className="msgContent muted">Thinking…</div>
                  </div>
                ) : null}
              </div>

              <div className="composer">
                <input
                  value={question}
                  disabled={busy}
                  placeholder="Ask a question about the PDF…"
                  onChange={(e) => setQuestion(e.target.value)}
                  onKeyDown={(e) => {
                    if (e.key === 'Enter') void onAsk()
                  }}
                />
                <button className="btn" onClick={() => void onAsk()} disabled={busy || !question.trim()}>
                  Ask
                </button>
              </div>
            </div>
          ) : (
            <div className="panel">
              <div className="panelTitle">Compare Documents</div>

              <div className="compareGrid">
                <div>
                  <div className="muted">Document A</div>
                  <select value={docA} disabled={busy} onChange={(e) => setDocA(e.target.value)}>
                    <option value="">Select…</option>
                    {documents.map((d) => (
                      <option key={d.id} value={d.id}>
                        {d.name}
                      </option>
                    ))}
                  </select>
                </div>
                <div>
                  <div className="muted">Document B</div>
                  <select value={docB} disabled={busy} onChange={(e) => setDocB(e.target.value)}>
                    <option value="">Select…</option>
                    {documents.map((d) => (
                      <option key={d.id} value={d.id}>
                        {d.name}
                      </option>
                    ))}
                  </select>
                </div>
              </div>

              <textarea
                value={comparePrompt}
                disabled={busy}
                onChange={(e) => setComparePrompt(e.target.value)}
                rows={3}
              />

              <div className="compareModeRow">
                <div className="muted">Comparison mode</div>
                <select
                  value={compareMode}
                  disabled={busy}
                  onChange={(e) => {
                    const next = e.target.value as CompareMode
                    const prevDefault = defaultComparePromptForMode(compareMode)
                    const nextDefault = defaultComparePromptForMode(next)
                    setCompareMode(next)
                    // If user hasn't customized the prompt, keep it in sync with mode.
                    if (comparePrompt.trim() === prevDefault.trim()) setComparePrompt(nextDefault)
                  }}
                >
                  <option value="content">Content</option>
                  <option value="methodology">Methodology</option>
                  <option value="conclusions">Conclusions</option>
                  <option value="structure">Structure</option>
                  <option value="literal">Literal wording</option>
                  <option value="custom">Custom</option>
                </select>
              </div>

              <div className="modeRow">
                <button className="btn" onClick={() => void onCompare()} disabled={busy}>
                  Compare
                </button>
              </div>

              {compareAnswer ? (
                <div className="compareResult">
                  {compareStructured && Array.isArray(compareStructured.topics) && compareStructured.topics.length ? (
                    <div className="compareStructured">
                      <div className="sourcesTitle">Comparison Table</div>
                      {compareStructured.summary ? <div className="muted">{compareStructured.summary}</div> : null}
                      <div className="compareTableWrap">
                        <table className="compareTable">
                          <thead>
                            <tr>
                              <th>Topic</th>
                              <th>Doc A</th>
                              <th>Doc B</th>
                              <th>Verdict</th>
                            </tr>
                          </thead>
                          <tbody>
                            {compareStructured.topics.map((t, idx) => (
                              <tr key={idx}>
                                <td className="compareTopic">{t.topic}</td>
                                <td>{t.docA}</td>
                                <td>{t.docB}</td>
                                <td className="compareVerdict">{t.verdict}</td>
                              </tr>
                            ))}
                          </tbody>
                        </table>
                      </div>
                    </div>
                  ) : null}

                  <div className="msg assistant">
                    <div className="msgRole">assistant</div>
                    <div className="msgContent markdown">
                      <ReactMarkdown remarkPlugins={[remarkGfm]}>{compareAnswer}</ReactMarkdown>
                    </div>
                  </div>

                  <div className="compareSources">
                    <div>
                      <div className="sourcesTitle">Sources A</div>
                      <Sources sources={compareSourcesA} />
                    </div>
                    <div>
                      <div className="sourcesTitle">Sources B</div>
                      <Sources sources={compareSourcesB} />
                    </div>
                  </div>
                </div>
              ) : thinkingCompare ? (
                <div className="msg assistant thinking">
                  <div className="msgRole">assistant</div>
                  <div className="msgContent muted">Thinking…</div>
                </div>
              ) : null}
            </div>
          )}
        </main>
      </div>
    </div>
  )
}

export default App
