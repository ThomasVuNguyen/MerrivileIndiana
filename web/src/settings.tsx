import { useEffect, useState } from 'react'
import type { ModelInfo, NewModel, Provider } from '../shared/protocol'
import { api } from './api'
import { SettingsTabs, TopBar } from './paper'
import { useSession } from './session'
import { Icon } from './ui'

const PROVIDERS: { id: Provider; name: string; models: string[]; hint: string }[] = [
  {
    id: 'anthropic',
    name: 'Anthropic',
    models: ['claude-opus-5-5', 'claude-sonnet-5-5', 'claude-haiku-5-5', 'claude-fable-5-1'],
    hint: 'API key from platform.claude.com → API keys.',
  },
  {
    id: 'workers-ai',
    name: 'Cloudflare Workers AI',
    models: [],
    hint: 'An API token with Workers AI read permission, and the account id from your Cloudflare dashboard. Pick a model that supports function calling.',
  },
  {
    id: 'openai',
    name: 'OpenAI-compatible',
    models: [],
    hint: 'Any /chat/completions endpoint with tool calling: OpenRouter, OpenAI, a local server.',
  },
]

export function Settings() {
  const [models, setModels] = useState<ModelInfo[] | null>(null)
  const [error, setError] = useState<string | null>(null)
  const [tests, setTests] = useState<Record<string, string>>({})
  const [adding, setAdding] = useState(false)
  const session = useSession()

  const load = () => api.models().then(setModels, (e: Error) => setError(e.message))
  useEffect(() => {
    load()
  }, [])

  const test = async (m: ModelInfo) => {
    setTests((t) => ({ ...t, [m.id]: 'Testing…' }))
    const r = await api.testModel(m.id).catch((e: Error) => ({ ok: false as const, error: e.message }))
    setTests((t) => ({ ...t, [m.id]: r.ok ? `Works · ${r.ms} ms` : r.error }))
  }

  return (
    <div className="projects settings">
      <TopBar active="settings" />
      <section className="settings-body">
        <a className="link settings-back" href="#/projects">
          ← Projects
        </a>
        <SettingsTabs active="models" />
        <h1>Models</h1>
        <p className="muted">
          The AI that writes your parts. Keys stay on the server; this page only ever shows their last four characters. The default model is used unless you
          pick another under the chat.
        </p>
        {error && <p className="auth-error">{error}</p>}
        {models && models.length === 0 && !adding && <p className="settings-empty">No models yet. Add one to start building.</p>}
        {models && models.length > 0 && (
          <ul className="model-list">
            {models.map((m) => (
              <li key={m.id} className="model-row">
                <label className="model-default" title="Default model">
                  <input
                    type="radio"
                    name="default"
                    checked={m.isDefault}
                    onChange={() => api.setDefault(m.id).then(load)}
                    aria-label={`Use ${m.label} by default`}
                  />
                </label>
                <div className="model-main">
                  <strong>{m.label}</strong>
                  <span>
                    {PROVIDERS.find((p) => p.id === m.provider)?.name} · {m.model} · key {m.keyHint}
                    {m.provider !== 'anthropic' && (m.vision ? ' · sees renders' : ' · text only')}
                  </span>
                  {tests[m.id] && <span className={`model-test${tests[m.id].startsWith('Works') ? ' is-ok' : tests[m.id] === 'Testing…' ? '' : ' is-bad'}`}>{tests[m.id]}</span>}
                </div>
                {m.isDefault && <span className="doc-kind">default</span>}
                <button className="link" onClick={() => test(m)}>
                  Test
                </button>
                <button
                  className="link"
                  onClick={() => {
                    if (confirm(`Remove ${m.label}? Its API key is deleted from the server.`)) api.removeModel(m.id).then(load)
                  }}
                >
                  Remove
                </button>
              </li>
            ))}
          </ul>
        )}
        {adding ? (
          <AddModel
            onCancel={() => setAdding(false)}
            onAdded={() => {
              setAdding(false)
              load()
            }}
          />
        ) : (
          <button className="btn btn--solid" onClick={() => setAdding(true)}>
            <Icon name="plus" size={14} /> Add model
          </button>
        )}
        <div className="settings-account">
          <span className="eyebrow">Account</span>
          <span>{session.user?.email}</span>
          <button className="link" onClick={session.signOut}>
            Sign out
          </button>
        </div>
      </section>
    </div>
  )
}

function AddModel({ onAdded, onCancel }: { onAdded: () => void; onCancel: () => void }) {
  const [provider, setProvider] = useState<Provider>('anthropic')
  const [label, setLabel] = useState('')
  const [model, setModel] = useState('claude-opus-5-5')
  const [apiKey, setApiKey] = useState('')
  const [accountId, setAccountId] = useState('')
  const [baseUrl, setBaseUrl] = useState('')
  const [vision, setVision] = useState(false)
  const [busy, setBusy] = useState(false)
  const [error, setError] = useState<string | null>(null)
  const meta = PROVIDERS.find((p) => p.id === provider)!

  const pick = (p: Provider) => {
    setProvider(p)
    setModel(PROVIDERS.find((x) => x.id === p)!.models[0] ?? '')
    setError(null)
  }

  const submit = async (e: React.FormEvent) => {
    e.preventDefault()
    setBusy(true)
    setError(null)
    const m: NewModel = {
      provider,
      label: label.trim() || model.trim(),
      model: model.trim(),
      apiKey: apiKey.trim(),
      ...(provider === 'workers-ai' && { accountId: accountId.trim() }),
      ...(provider === 'openai' && { baseUrl: baseUrl.trim() }),
      ...(provider !== 'anthropic' && { vision }),
    }
    try {
      await api.addModel(m)
      onAdded()
    } catch (err) {
      setError((err as Error).message)
    } finally {
      setBusy(false)
    }
  }

  return (
    <form className="paper-card add-model" onSubmit={submit}>
      <div className="seg" role="radiogroup" aria-label="Provider">
        {PROVIDERS.map((p) => (
          <button key={p.id} type="button" role="radio" aria-checked={provider === p.id} onClick={() => pick(p.id)}>
            {p.name}
          </button>
        ))}
      </div>
      <p className="muted small">{meta.hint}</p>
      <label>
        Model id
        <input value={model} onChange={(e) => setModel(e.target.value)} list={`models-${provider}`} placeholder={provider === 'workers-ai' ? '@cf/…' : 'model name'} required />
        <datalist id={`models-${provider}`}>
          {meta.models.map((m) => (
            <option key={m} value={m} />
          ))}
        </datalist>
      </label>
      {provider === 'workers-ai' && (
        <label>
          Account id
          <input value={accountId} onChange={(e) => setAccountId(e.target.value)} placeholder="32 hex characters" required />
        </label>
      )}
      {provider === 'openai' && (
        <label>
          Base URL
          <input value={baseUrl} onChange={(e) => setBaseUrl(e.target.value)} placeholder="https://openrouter.ai/api/v1" type="url" required />
        </label>
      )}
      <label>
        {provider === 'anthropic' ? 'API key' : 'API token'}
        <input value={apiKey} onChange={(e) => setApiKey(e.target.value)} type="password" autoComplete="off" required />
      </label>
      <label>
        Name <span className="faint">(optional)</span>
        <input value={label} onChange={(e) => setLabel(e.target.value)} placeholder={model || 'e.g. Opus for hard parts'} />
      </label>
      {provider !== 'anthropic' && (
        <label className="check">
          <input type="checkbox" checked={vision} onChange={(e) => setVision(e.target.checked)} />
          Model accepts images (it sees renders of its parts)
        </label>
      )}
      {error && (
        <p className="auth-error" role="alert">
          {error}
        </p>
      )}
      <div className="add-model-actions">
        <button className="btn btn--solid" disabled={busy}>
          {busy ? 'Checking…' : 'Test and add'}
        </button>
        <button type="button" className="link" onClick={onCancel}>
          Cancel
        </button>
      </div>
    </form>
  )
}
