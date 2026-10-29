/*---------------------------------------------------------------------------------------------
 *  OpenCursor. MIT License.
 *--------------------------------------------------------------------------------------------*/

import { useMemo, useState, type ReactElement } from 'react';
import { Icon } from '../common/icons';
import type {
	ConfigKey, ConfigValues, CustomModel, ModelRow, ProviderKey, ProviderRow, SettingsState,
} from '../../../src/settings/protocol';
import { Button, Empty, Group, ListEditor, NumberField, Page, Row, Segmented, Select, StatusDot, TextArea, TextField, Toggle } from './controls';

export type VerifyMap = Record<string, { status: 'running' | 'ok' | 'error'; message?: string } | undefined>;

export interface SectionProps {
	readonly state: SettingsState;
	readonly verify: VerifyMap;
	readonly set: <K extends ConfigKey>(key: K, value: ConfigValues[K]) => void;
	readonly send: (m: import('../../../src/settings/protocol').SettingsWebviewMessage) => void;
}

const MOD = typeof navigator !== 'undefined' && /Mac/.test(navigator.platform) ? '⌘' : 'Ctrl+';

export function General({ state, set, send }: SectionProps): ReactElement {
	const c = state.config;
	return (
		<Page title="General" lead="How the chat behaves and when the agent may act on its own.">
			<Group title="Chat">
				<Row label="Default mode" desc="Mode a new chat starts in.">
					<Select label="Default mode" value={c['chat.defaultMode']} onChange={v => set('chat.defaultMode', v)} options={[
						{ value: 'agent', label: 'Agent' }, { value: 'plan', label: 'Plan' }, { value: 'debug', label: 'Debug' }, { value: 'ask', label: 'Ask' },
					]} />
				</Row>
				<Row label={'Send with ' + MOD + 'Enter'} desc="Enter inserts a new line instead of sending.">
					<Toggle label="Send with modifier plus Enter" checked={c['chat.submitWithModEnter']} onChange={v => set('chat.submitWithModEnter', v)} />
				</Row>
				<Row label="Thinking effort" desc="How hard models think before answering. Auto thinks at high on API models and keeps the default of Claude Code and Codex. Also in the chat box, next to the model.">
					<Select label="Thinking effort" value={c['agent.effort']} onChange={v => set('agent.effort', v)} options={[
						{ value: 'auto', label: 'Auto' }, { value: 'off', label: 'Off' }, { value: 'low', label: 'Low' }, { value: 'medium', label: 'Medium' }, { value: 'high', label: 'High' }, { value: 'max', label: 'Max' },
					]} />
				</Row>
				<Row label="Show thinking" desc="Let thinking rows expand to show the model's reasoning.">
					<Toggle label="Show thinking" checked={c['chat.showThinking']} onChange={v => set('chat.showThinking', v)} />
				</Row>
				<Row label="Chat font size" desc="Pixels. Code blocks follow the editor font.">
					<NumberField label="Chat font size" value={c['chat.fontSize']} min={10} max={20} onCommit={v => set('chat.fontSize', v)} />
				</Row>
			</Group>
			<Group title="Terminal commands" hint="File edits never ask: they land as pending changes you can keep or undo. This only covers shell commands.">
				<Row label="Auto-run" desc="When the agent may run a command without asking you. Auto runs safe commands and asks before deleting, installing or going online. Full access never asks. Also in the chat box, next to the model.">
					<Segmented label="Auto-run policy" value={c['agent.autoRun']} onChange={v => set('agent.autoRun', v)} options={[
						{ value: 'ask', label: 'Ask every time' }, { value: 'allowlist', label: 'Allowlist' }, { value: 'auto', label: 'Auto' }, { value: 'always', label: 'Full access' },
					]} />
				</Row>
				<Row stacked label="Allowlist" desc={'Commands starting with these run without asking in Allowlist and Auto.'} disabled={c['agent.autoRun'] !== 'allowlist' && c['agent.autoRun'] !== 'auto'}>
					<ListEditor label="Command allowlist" items={c['agent.commandAllowlist']} onChange={v => set('agent.commandAllowlist', v)} placeholder="npm test" />
				</Row>
				<Row stacked label="Denylist" desc="Commands starting with these always ask, whatever the policy.">
					<ListEditor label="Command denylist" items={c['agent.commandDenylist']} onChange={v => set('agent.commandDenylist', v)} placeholder="git push" />
				</Row>
			</Group>
			<Group title="Updates">
				<Row label="Updates" desc="Automatic downloads new versions in the background; they install the next time OpenCursor quits.">
					<Select label="Updates" value={c['update.mode']} onChange={v => set('update.mode', v)} options={[
						{ value: 'auto', label: 'Automatic' }, { value: 'notify', label: 'Ask first' }, { value: 'off', label: 'Off' },
					]} />
				</Row>
			</Group>
			<Group title="Privacy" hint="OpenCursor has no account and no server between you and your models. API keys stay in the system keychain.">
				<Row label="Anonymous install count" desc="Once a day, send a random ID made on this computer, the version and the OS, so we know how many people use OpenCursor. Nothing about you, your code, chats or keys.">
					<Toggle label="Anonymous install count" checked={c['privacy.anonymousCount']} onChange={v => set('privacy.anonymousCount', v)} />
				</Row>
			</Group>
			<Group>
				<Row label="All settings" desc="Every OpenCursor option, in the standard settings editor.">
					<Button onClick={() => send({ type: 'openSettingsJson' })}>Open settings editor</Button>
				</Row>
			</Group>
		</Page>
	);
}

function ProviderKeyRow({ p, verify, send, extra }: {
	readonly p: ProviderRow;
	readonly verify: VerifyMap;
	readonly send: SectionProps['send'];
	readonly extra?: React.ReactNode;
}): ReactElement {
	const [draft, setDraft] = useState('');
	const v = verify[p.id];
	const needsKey = !p.keyless;
	return (
		<div className="st-row is-stacked st-provider">
			<div className="st-provider-head">
				<span className="st-row-label">{p.label}</span>
				{needsKey ? (
					<span className={'st-pill' + (p.hasKey ? ' is-ok' : '')}>{p.hasKey ? 'Key saved' : 'No key'}</span>
				) : <span className="st-pill is-ok">Local</span>}
				<span className="st-spacer" />
				{v?.status === 'running' ? <span className="st-verify is-running">Checking</span> : null}
				{v?.status === 'ok' ? <span className="st-verify is-ok"><Icon name="check" size={12} /> {v.message || 'Works'}</span> : null}
				{v?.status === 'error' ? <span className="st-verify is-error" title={v.message}>{v.message || 'Failed'}</span> : null}
				<Button small disabled={v?.status === 'running' || (needsKey && !p.hasKey && p.id !== 'custom')} onClick={() => send({ type: 'verify', provider: p.id })}>Verify</Button>
			</div>
			{needsKey ? (
				<div className="st-key-line">
					<input
						className="st-input is-mono"
						type="password"
						value={draft}
						placeholder={p.hasKey ? 'Enter a new key to replace the saved one' : 'Paste API key'}
						aria-label={p.label + ' API key'}
						autoComplete="off"
						spellCheck={false}
						onChange={e => setDraft(e.target.value)}
						onKeyDown={e => { if (e.key === 'Enter' && draft.trim()) { send({ type: 'setKey', provider: p.id, key: draft }); setDraft(''); } }}
					/>
					<Button small primary disabled={!draft.trim()} onClick={() => { send({ type: 'setKey', provider: p.id, key: draft }); setDraft(''); }}>Save</Button>
					{p.hasKey ? <Button small danger onClick={() => send({ type: 'clearKey', provider: p.id })}>Remove</Button> : null}
				</div>
			) : null}
			{extra}
		</div>
	);
}

function BaseUrl({ label, value, onCommit, placeholder }: { readonly label: string; readonly value: string; readonly onCommit: (v: string) => void; readonly placeholder: string }): ReactElement {
	return (
		<div className="st-sub">
			<span className="st-sub-label">{label}</span>
			<TextField label={label} value={value} onCommit={onCommit} placeholder={placeholder} mono width="100%" />
		</div>
	);
}

const PROVIDER_ORDER: ProviderKey[] = ['anthropic', 'openai', 'google', 'openrouter', 'deepseek', 'xai', 'mistral', 'groq', 'ollama', 'lmstudio', 'custom'];

function providerName(state: SettingsState, id: string): string {
	return state.providers.find(p => p.id === id)?.label ?? id;
}

function AddCustomModel({ state, set }: { readonly state: SettingsState; readonly set: SectionProps['set'] }): ReactElement {
	const [provider, setProvider] = useState<ProviderKey>('ollama');
	const [model, setModel] = useState('');
	const [label, setLabel] = useState('');
	const [ctx, setCtx] = useState('');
	const [baseUrl, setBaseUrl] = useState('');
	const list = state.config['models.custom'];
	const add = (): void => {
		const id = model.trim();
		if (!id) { return; }
		const entry: CustomModel = { provider, model: id };
		if (label.trim()) { entry.label = label.trim(); }
		const n = Number(ctx);
		if (Number.isFinite(n) && n > 0) { entry.contextWindow = n; }
		if (baseUrl.trim()) { entry.baseUrl = baseUrl.trim(); }
		set('models.custom', [...list, entry]);
		setModel(''); setLabel(''); setCtx(''); setBaseUrl('');
	};
	return (
		<>
			{list.map((m, i) => (
				<div key={m.provider + m.model + i} className="st-row">
					<div className="st-row-text">
						<div className="st-row-label">{m.label || m.model}</div>
						<div className="st-row-desc"><code>{m.provider}/{m.model}</code>{m.contextWindow ? ' · ' + m.contextWindow.toLocaleString() + ' tokens' : ''}{m.baseUrl ? ' · ' + m.baseUrl : ''}</div>
					</div>
					<div className="st-row-control"><Button small danger onClick={() => set('models.custom', list.filter((_, j) => j !== i))}>Remove</Button></div>
				</div>
			))}
			<div className="st-row is-stacked">
				<div className="st-row-text">
					<div className="st-row-label">Add a model</div>
					<div className="st-row-desc">Any model id the provider's API accepts, for example one you pulled into Ollama.</div>
				</div>
				<div className="st-form">
					<Select label="Provider" value={provider} onChange={setProvider} options={PROVIDER_ORDER.map(p => ({ value: p, label: providerName(state, p) }))} />
					<input className="st-input is-mono" placeholder="Model id" aria-label="Model id" value={model} onChange={e => setModel(e.target.value)} onKeyDown={e => { if (e.key === 'Enter') { add(); } }} />
					<input className="st-input" placeholder="Label (optional)" aria-label="Label" value={label} onChange={e => setLabel(e.target.value)} />
					<input className="st-input" placeholder="Context window" aria-label="Context window" inputMode="numeric" value={ctx} onChange={e => setCtx(e.target.value.replace(/[^\d]/g, ''))} />
					<input className="st-input is-mono st-form-wide" placeholder="Base URL override (optional)" aria-label="Base URL" value={baseUrl} onChange={e => setBaseUrl(e.target.value)} />
					<Button primary disabled={!model.trim()} onClick={add}>Add model</Button>
				</div>
			</div>
		</>
	);
}

export function Models({ state, verify, set, send }: SectionProps): ReactElement {
	const c = state.config;
	const [filter, setFilter] = useState('');
	const enabledModels = state.models.filter(m => m.enabled);
	const options = useMemo(() => [
		{ value: '', label: 'Automatic', group: '' },
		...enabledModels.map(m => ({ value: m.id, label: m.label, group: providerName(state, m.provider) })),
	], [enabledModels, state]);
	const tabOptions = useMemo(() => [
		{ value: '', label: 'Automatic', group: '' },
		...enabledModels.filter(m => m.supportsFim).map(m => ({ value: m.id, label: m.label + ' (FIM)', group: providerName(state, m.provider) })),
		...enabledModels.filter(m => !m.supportsFim).map(m => ({ value: m.id, label: m.label, group: providerName(state, m.provider) })),
	], [enabledModels, state]);
	const providers = PROVIDER_ORDER.map(id => state.providers.find(p => p.id === id)).filter((p): p is ProviderRow => !!p);

	const grouped = useMemo(() => {
		const q = filter.trim().toLowerCase();
		const map = new Map<string, ModelRow[]>();
		for (const m of state.models) {
			if (q && !(m.label.toLowerCase().includes(q) || m.id.toLowerCase().includes(q))) { continue; }
			const list = map.get(m.provider) ?? [];
			list.push(m);
			map.set(m.provider, list);
		}
		return [...map.entries()];
	}, [state.models, filter]);

	return (
		<Page title="Models" lead="Bring your own keys, local servers, or the agent CLIs you already pay for. Keys live in your system keychain and never leave this machine except to call the provider.">
			<Group title="Defaults">
				<Row label="Chat and agent" desc="Used for new chats."><Select label="Default chat model" width={260} value={c['models.default']} onChange={v => set('models.default', v)} options={options} /></Row>
				<Row label={'Inline edit (' + MOD + 'K)'} desc="Pick a fast model."><Select label="Inline edit model" width={260} value={c['models.inline']} onChange={v => set('models.inline', v)} options={options} /></Row>
				<Row label="Tab completion" desc="Fill-in-the-middle models work best."><Select label="Tab model" width={260} value={c['models.tab']} onChange={v => set('models.tab', v)} options={tabOptions} /></Row>
			</Group>

			<Group title="Providers" hint="Add a key to unlock that provider's models.">
				{providers.map(p => {
					let extra: React.ReactNode;
					if (p.id === 'ollama') {
						extra = (
							<>
								<BaseUrl label="Server URL" value={c['providers.ollama.baseUrl']} onCommit={v => set('providers.ollama.baseUrl', v)} placeholder="http://localhost:11434" />
								<div className="st-sub">
									<span className="st-sub-label">Context length</span>
									<NumberField label="Ollama context length" value={c['providers.ollama.numCtx']} min={0} step={1024} width={110} onCommit={v => set('providers.ollama.numCtx', v)} />
									<span className="st-sub-note">Ollama's own default is tiny. 0 leaves it to the server.</span>
								</div>
							</>
						);
					} else if (p.id === 'lmstudio') {
						extra = <BaseUrl label="Server URL" value={c['providers.lmstudio.baseUrl']} onCommit={v => set('providers.lmstudio.baseUrl', v)} placeholder="http://localhost:1234/v1" />;
					} else if (p.id === 'custom') {
						extra = <BaseUrl label="Base URL" value={c['providers.custom.baseUrl']} onCommit={v => set('providers.custom.baseUrl', v)} placeholder="http://localhost:8000/v1" />;
					} else if (p.id === 'openai') {
						extra = <BaseUrl label="Base URL override (Azure or a proxy)" value={c['providers.openai.baseUrl']} onCommit={v => set('providers.openai.baseUrl', v)} placeholder="https://api.openai.com/v1" />;
					}
					return <ProviderKeyRow key={p.id} p={p} verify={verify} send={send} extra={extra} />;
				})}
			</Group>

			<Group
				title="Available models"
				hint="Turn off the ones you do not want in the picker."
				actions={<Button small onClick={() => send({ type: 'refreshModels' })}><Icon name="refresh" size={12} /> Refresh</Button>}
			>
				<div className="st-row st-search-row">
					<div className="st-search"><Icon name="search" size={13} /><input value={filter} onChange={e => setFilter(e.target.value)} placeholder="Filter models" aria-label="Filter models" spellCheck={false} /></div>
				</div>
				{grouped.length === 0 ? <Empty>{state.models.length ? 'No models match.' : 'No models yet. Add a key or start a local server, then refresh.'}</Empty> : null}
				{grouped.map(([prov, list]) => (
					<div key={prov} className="st-model-group">
						<div className="st-model-group-label">{providerName(state, prov)}</div>
						{list.map(m => (
							<div key={m.id} className="st-row is-compact">
								<div className="st-row-text">
									<div className="st-row-label">{m.label}{m.custom ? <span className="st-pill">custom</span> : null}</div>
									<div className="st-row-desc"><code>{m.id}</code> · {m.contextWindow >= 1000 ? Math.round(m.contextWindow / 1000) + 'k' : m.contextWindow} context</div>
								</div>
								<div className="st-row-control"><Toggle label={'Show ' + m.label} checked={m.enabled} onChange={v => send({ type: 'setModelEnabled', id: m.id, enabled: v })} /></div>
							</div>
						))}
					</div>
				))}
			</Group>

			<Group title="Custom models"><AddCustomModel state={state} set={set} /></Group>
		</Page>
	);
}

export function Subscriptions({ state, set, send }: SectionProps): ReactElement {
	const on = state.config['cli.enabled'];
	return (
		<Page title="Subscriptions" lead="Run an agent CLI you already pay for as the backend of a chat. OpenCursor keeps the editing, review and checkpoints; the CLI does the thinking and tool use.">
			<Group>
				<Row label="Offer agent CLIs in the model picker" desc="They appear as their own group, next to your API keys.">
					<Toggle label="Enable CLI agents" checked={on} onChange={v => set('cli.enabled', v)} />
				</Row>
			</Group>
			<Group title="Detected" actions={<Button small onClick={() => send({ type: 'refreshCli' })}><Icon name="refresh" size={12} /> Detect again</Button>}>
				{state.cli.length === 0 ? <Empty>Looking for agent CLIs on your PATH.</Empty> : null}
				{state.cli.map(a => (
					<div key={a.id} className={'st-row is-stacked st-cli' + (on ? '' : ' is-disabled')}>
						<div className="st-provider-head">
							<StatusDot kind={!a.installed ? 'idle' : a.loggedIn === false ? 'warn' : 'ok'} label={a.installed ? 'Installed' : 'Not installed'} />
							<span className="st-row-label">{a.label}</span>
							{a.installed && a.version ? <span className="st-pill">{a.version}</span> : null}
							{a.installed ? (
								<span className={'st-pill' + (a.loggedIn ? ' is-ok' : a.loggedIn === false ? ' is-warn' : '')}>{a.loggedIn ? 'Signed in' : a.loggedIn === false ? 'Not signed in' : 'Sign-in unknown'}</span>
							) : <span className="st-pill">Not found</span>}
						</div>
						{a.installed ? (
							<div className="st-row-desc">{a.binaryPath}{a.loggedIn === false ? <><br />{a.loginHint}</> : null}</div>
						) : (
							<div className="st-howto">
								<div className="st-row-desc">Install it, then sign in. Detection runs again when you come back to this page.</div>
								<code className="st-code">{a.installHint}</code>
								<div className="st-row-desc">{a.loginHint}</div>
							</div>
						)}
					</div>
				))}
				<Row stacked label="Not found where you expect it?" desc={<>Set <code>openCursor.cli.paths</code> in settings to point at the binary.</>}>
					<Button small onClick={() => send({ type: 'openSettingsJson' })}>Open settings</Button>
				</Row>
			</Group>
		</Page>
	);
}

export function TabSection({ state, set }: SectionProps): ReactElement {
	const c = state.config;
	const fim = state.models.filter(m => m.enabled && m.supportsFim);
	const rest = state.models.filter(m => m.enabled && !m.supportsFim);
	return (
		<Page title="Tab" lead="Multi-line completions as you type. Press Tab to accept.">
			<Group>
				<Row label="Enable Tab" desc="Turn completions off to save tokens.">
					<Toggle label="Enable Tab" checked={c['tab.enabled']} onChange={v => set('tab.enabled', v)} />
				</Row>
				<Row label="Model" desc="Fill-in-the-middle models like Codestral, DeepSeek or a local Qwen coder are fastest." disabled={!c['tab.enabled']}>
					<Select label="Tab model" width={260} value={c['models.tab']} onChange={v => set('models.tab', v)} options={[
						{ value: '', label: 'Automatic', group: '' },
						...fim.map(m => ({ value: m.id, label: m.label, group: 'Fill-in-the-middle' })),
						...rest.map(m => ({ value: m.id, label: m.label, group: 'Other models' })),
					]} />
				</Row>
				<Row label="Delay" desc="Milliseconds to wait after you stop typing before asking." disabled={!c['tab.enabled']}>
					<NumberField label="Debounce in milliseconds" value={c['tab.debounceMs']} min={0} max={2000} step={20} onCommit={v => set('tab.debounceMs', v)} />
				</Row>
			</Group>
		</Page>
	);
}

export function Rules({ state, set, send }: SectionProps): ReactElement {
	const scopes: { scope: 'workspace' | 'user' | 'legacy'; title: string }[] = [
		{ scope: 'workspace', title: 'Project rules' },
		{ scope: 'legacy', title: 'Compatible files' },
		{ scope: 'user', title: 'User rule files' },
	];
	return (
		<Page title="Rules" lead="Standing instructions the agent reads on every turn. Rules from .cursor/rules, AGENTS.md, CLAUDE.md and .cursorrules work as they are.">
			<Group title="User rules" hint="Free text, applied to every chat in every workspace.">
				<div className="st-row is-stacked">
					<TextArea label="User rules" rows={7} value={state.config['rules.user']} onCommit={v => set('rules.user', v)} placeholder={'Reply briefly. Prefer TypeScript. Never touch generated files.'} />
				</div>
			</Group>
			{scopes.map(s => {
				const list = state.rules.filter(r => r.scope === s.scope);
				if (s.scope === 'legacy' && list.length === 0) { return null; }
				return (
					<Group
						key={s.scope}
						title={s.title}
						actions={s.scope !== 'legacy' ? (
							<Button small disabled={s.scope === 'workspace' && !state.hasWorkspace} onClick={() => send({ type: 'newRule', scope: s.scope as 'workspace' | 'user' })}>
								<Icon name="plus" size={12} /> New rule
							</Button>
						) : undefined}
					>
						{list.length === 0 ? <Empty>{s.scope === 'workspace' ? (state.hasWorkspace ? 'No rules in .open-cursor/rules or .cursor/rules yet.' : 'Open a folder to add project rules.') : 'No files in ~/.open-cursor/rules.'}</Empty> : null}
						{list.map(r => (
							<div key={r.uri} className="st-row is-compact">
								<div className="st-row-text">
									<div className="st-row-label">{r.name}</div>
									<div className="st-row-desc">{r.description ? r.description + ' · ' : ''}<code>{r.source}</code></div>
								</div>
								<div className="st-row-control"><Button small onClick={() => send({ type: 'openRule', uri: r.uri })}>Open</Button></div>
							</div>
						))}
					</Group>
				);
			})}
		</Page>
	);
}

export function Commands({ state, send }: SectionProps): ReactElement {
	return (
		<Page title="Commands" lead="Type / in the chat to run one. Each command is a markdown file whose text becomes the prompt.">
			<Group
				title="Slash commands"
				actions={
					<>
						<Button small disabled={!state.hasWorkspace} onClick={() => send({ type: 'newCommand', scope: 'workspace' })}><Icon name="plus" size={12} /> Project command</Button>
						<Button small onClick={() => send({ type: 'newCommand', scope: 'user' })}><Icon name="plus" size={12} /> User command</Button>
					</>
				}
			>
				{state.commands.length === 0 ? <Empty>No commands yet. Add a markdown file to <code>.open-cursor/commands</code> or <code>~/.open-cursor/commands</code>.</Empty> : null}
				{state.commands.map(c => (
					<div key={c.name + c.source} className="st-row is-compact">
						<div className="st-row-text">
							<div className="st-row-label"><code className="st-slash">/{c.name}</code></div>
							<div className="st-row-desc">{c.description ? c.description + ' · ' : ''}<code>{c.source}</code></div>
						</div>
						<div className="st-row-control"><Button small onClick={() => send({ type: 'openCommand', source: c.source })}>Open</Button></div>
					</div>
				))}
			</Group>
		</Page>
	);
}

export function Mcp({ state, send }: SectionProps): ReactElement {
	return (
		<Page title="Tools and MCP" lead="Model Context Protocol servers add tools to the agent. Configs from ~/.cursor/mcp.json and .cursor/mcp.json are picked up too.">
			<Group
				title="Servers"
				actions={
					<>
						<Button small onClick={() => send({ type: 'mcpReload' })}><Icon name="refresh" size={12} /> Reload</Button>
						<Button small onClick={() => send({ type: 'mcpOpenConfig', scope: 'user' })}>User config</Button>
						<Button small disabled={!state.hasWorkspace} onClick={() => send({ type: 'mcpOpenConfig', scope: 'workspace' })}>Project config</Button>
					</>
				}
			>
				{state.mcp.length === 0 ? <Empty>No MCP servers configured.</Empty> : null}
				{state.mcp.map(s => (
					<div key={s.name + s.source} className="st-row">
						<div className="st-row-text">
							<div className="st-row-label">
								<StatusDot kind={s.status === 'ready' ? 'ok' : s.status === 'error' ? 'error' : s.status === 'starting' ? 'busy' : 'idle'} label={s.status} />
								{s.name}
								<span className="st-pill">{s.transport}</span>
								{s.status === 'ready' ? <span className="st-pill">{s.toolCount} {s.toolCount === 1 ? 'tool' : 'tools'}</span> : null}
								{s.status === 'starting' ? <span className="st-pill">starting</span> : null}
							</div>
							<div className={'st-row-desc' + (s.error ? ' is-error' : '')}>{s.error ? s.error : <code>{s.source}</code>}</div>
						</div>
						<div className="st-row-control"><Toggle label={'Enable ' + s.name} checked={s.status !== 'disabled'} onChange={v => send({ type: 'mcpSetEnabled', name: s.name, enabled: v })} /></div>
					</div>
				))}
			</Group>
		</Page>
	);
}

export function Indexing({ state, set, send }: SectionProps): ReactElement {
	const i = state.index;
	const c = state.config;
	const label = { disabled: 'Off', idle: 'Idle', indexing: 'Indexing', ready: 'Ready', error: 'Error' }[i.state];
	return (
		<Page title="Indexing" lead="A semantic index of the workspace for codebase search. Without an embedding model it falls back to keyword search.">
			<Group>
				<Row label="Index this workspace" desc="Chunks are embedded with the model below and stored locally.">
					<Toggle label="Enable indexing" checked={c['index.enabled']} onChange={v => set('index.enabled', v)} />
				</Row>
				<Row label="Embedding model" desc={<><code>auto</code> picks an OpenAI key, then Gemini, then a local Ollama model. Or write <code>provider/model</code>. Changing it rebuilds the index.</>}>
					<TextField label="Embedding model" mono width={260} value={c['index.embeddingModel']} onCommit={v => set('index.embeddingModel', v || 'auto')} placeholder="auto" list="oc-embed-models" />
					<datalist id="oc-embed-models">
						<option value="auto" /><option value="openai/text-embedding-3-small" /><option value="openai/text-embedding-3-large" />
						<option value="google/gemini-embedding-001" /><option value="ollama/nomic-embed-text" />
					</datalist>
				</Row>
			</Group>
			<Group title="Status" actions={
				<>
					<Button small disabled={!c['index.enabled'] || i.state === 'indexing'} onClick={() => send({ type: 'indexRebuild' })}><Icon name="refresh" size={12} /> Rebuild</Button>
					<Button small danger disabled={i.files === 0 && i.state !== 'error'} onClick={() => send({ type: 'indexClear' })}>Clear</Button>
				</>
			}>
				<div className="st-row is-stacked">
					<div className="st-provider-head">
						<StatusDot kind={i.state === 'ready' ? 'ok' : i.state === 'error' ? 'error' : i.state === 'indexing' ? 'busy' : 'idle'} />
						<span className="st-row-label">{label}</span>
						<span className="st-spacer" />
						<span className="st-stat"><b>{i.files.toLocaleString()}</b> files</span>
						<span className="st-stat"><b>{i.chunks.toLocaleString()}</b> chunks</span>
					</div>
					{i.state === 'indexing' ? (
						<div className="st-progress" role="progressbar" aria-valuemin={0} aria-valuemax={100} aria-valuenow={Math.round((i.progress ?? 0) * 100)}>
							<div style={{ width: Math.round((i.progress ?? 0) * 100) + '%' }} />
						</div>
					) : null}
					{i.error ? <div className="st-row-desc is-error">{i.error}</div> : null}
				</div>
			</Group>
		</Page>
	);
}
