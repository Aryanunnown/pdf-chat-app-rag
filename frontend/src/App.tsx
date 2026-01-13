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
  type DocumentSummary,
} from './api'

type ChatMessage = {
  role: 'user' | 'assistant'
  content: string
  sources?: ChatSource[]
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

  const activeDoc = useMemo(() => documents.find((d) => d.id === activeDocId), [documents, activeDocId])

  const [messages, setMessages] = useState<ChatMessage[]>([])
  const [question, setQuestion] = useState('')

  const [docA, setDocA] = useState('')
  const [docB, setDocB] = useState('')
  const [comparePrompt, setComparePrompt] = useState('Compare the documents: key similarities and key differences.')
  const [compareAnswer, setCompareAnswer] = useState<string>('')
  const [compareSourcesA, setCompareSourcesA] = useState<ChatSource[]>([])
  const [compareSourcesB, setCompareSourcesB] = useState<ChatSource[]>([])

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

  async function onUpload(file: File) {
    setError('')
    setBusy(true)
    try {
      const doc = await uploadPdf(file)
      await refreshDocs(doc.id)
      setMessages([])
      setCompareAnswer('')
      setCompareSourcesA([])
      setCompareSourcesB([])
    } catch (e: any) {
      setError(e.message || 'Upload failed')
    } finally {
      setBusy(false)
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
    } catch (e: any) {
      setError(e.message || 'Chat failed')
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
      const resp = await compare(docA, docB, comparePrompt)
      setCompareAnswer(resp.answer)
      setCompareSourcesA(resp.sourcesA)
      setCompareSourcesB(resp.sourcesB)
    } catch (e: any) {
      setError(e.message || 'Compare failed')
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
              }}
            />
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

              <div className="modeRow">
                <button className="btn" onClick={() => void onCompare()} disabled={busy}>
                  Compare
                </button>
              </div>

              {compareAnswer ? (
                <div className="compareResult">
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
