/*---------------------------------------------------------------------------------------------
 *  Open Cursor. MIT License.
 *  Cmd+K: a prompt box that opens inside the editor above the selection. The extension does the
 *  model work (`openCursor.inline.submit`) and streams the result into the file as pending hunks,
 *  which openCursorDiff.ts draws. This file only owns the box, its states and its keys.
 *
 *  Cmd+K is also VS Code's chord prefix. While the box is empty, pressing a second Cmd+<key>
 *  closes it and runs the Cmd+K Cmd+<key> chord instead, so every chord keeps working.
 *--------------------------------------------------------------------------------------------*/

import { $, append, addDisposableListener, EventType } from '../../../../base/browser/dom.js';
import { StandardKeyboardEvent } from '../../../../base/browser/keyboardEvent.js';
import { KeyCode, KeyMod } from '../../../../base/common/keyCodes.js';
import { Disposable, DisposableStore } from '../../../../base/common/lifecycle.js';
import { isMacintosh } from '../../../../base/common/platform.js';
import { generateUuid } from '../../../../base/common/uuid.js';
import { ICodeEditor } from '../../../../editor/browser/editorBrowser.js';
import { EditorContributionInstantiation, registerEditorContribution } from '../../../../editor/browser/editorExtensions.js';
import { EditorOption } from '../../../../editor/common/config/editorOptions.js';
import { IEditorContribution } from '../../../../editor/common/editorCommon.js';
import { EditorContextKeys } from '../../../../editor/common/editorContextKeys.js';
import { ZoneWidget } from '../../../../editor/contrib/zoneWidget/browser/zoneWidget.js';
import { localize2 } from '../../../../nls.js';
import { Action2, registerAction2 } from '../../../../platform/actions/common/actions.js';
import { CommandsRegistry, ICommandService } from '../../../../platform/commands/common/commands.js';
import { ContextKeyExpr, IContextKey, IContextKeyService, RawContextKey } from '../../../../platform/contextkey/common/contextkey.js';
import { ServicesAccessor } from '../../../../platform/instantiation/common/instantiation.js';
import { IKeybindingService } from '../../../../platform/keybinding/common/keybinding.js';
import { KeybindingWeight } from '../../../../platform/keybinding/common/keybindingsRegistry.js';
import { IQuickInputService } from '../../../../platform/quickinput/common/quickInput.js';
import { ICodeEditorService } from '../../../../editor/browser/services/codeEditorService.js';

const CTX_INLINE_ACTIVE = new RawContextKey<boolean>('openCursor.inline.active', false);
const CTX_INLINE_STATE = new RawContextKey<string>('openCursor.inline.state', 'idle');

type InlineState = 'idle' | 'generating' | 'done' | 'error';

interface IModelOption { readonly id: string; readonly label: string; readonly hasKey?: boolean }

let lastModelId: string | undefined;

class InlineEditZone extends ZoneWidget {
	private readonly _store = new DisposableStore();
	private _input!: HTMLTextAreaElement;
	private _status!: HTMLElement;
	private _actions!: HTMLElement;
	private _modelButton!: HTMLButtonElement;

	constructor(editor: ICodeEditor, private readonly _ctrl: OpenCursorInlineEditController) {
		super(editor, { showFrame: false, showArrow: false, isResizeable: false, isAccessible: true, className: 'oc-inline-zone', keepEditorSelection: true });
		this.create();
	}

	protected override _fillContainer(container: HTMLElement): void {
		const box = append(container, $('.oc-inline-box'));
		this._input = append(box, $('textarea.oc-inline-input', { rows: '1', spellcheck: 'false' })) as HTMLTextAreaElement;
		const footer = append(box, $('.oc-inline-footer'));
		this._modelButton = append(footer, $('button.oc-inline-model', { title: 'Model' })) as HTMLButtonElement;
		this._status = append(footer, $('span.oc-inline-status'));
		this._actions = append(footer, $('.oc-inline-actions'));

		this._store.add(addDisposableListener(this._modelButton, EventType.CLICK, () => this._ctrl.pickModel()));
		this._store.add(addDisposableListener(this._input, EventType.INPUT, () => this.autoGrow()));
		this._store.add(addDisposableListener(this._input, EventType.KEY_DOWN, e => this._ctrl.onKeyDown(new StandardKeyboardEvent(e))));
	}

	get value(): string { return this._input.value; }
	set value(v: string) { this._input.value = v; this.autoGrow(); }

	setPlaceholder(text: string) { this._input.placeholder = text; }
	setModelLabel(text: string) { this._modelButton.textContent = `${text} ⌄`; }
	focusInput() { this._input.focus(); }

	render(state: InlineState, message: string | undefined, keys: { accept: string; reject: string }): void {
		this._actions.textContent = '';
		this.domNode.classList.toggle('oc-generating', state === 'generating');
		const button = (label: string, cls: string, run: () => void) => {
			const b = append(this._actions, $(`button.oc-inline-btn.${cls}`));
			b.textContent = label;
			this._store.add(addDisposableListener(b, EventType.CLICK, e => { e.preventDefault(); run(); }));
		};
		switch (state) {
			case 'idle':
				this._status.textContent = 'Esc to close';
				button('Submit ⏎', 'oc-primary', () => this._ctrl.submit());
				break;
			case 'generating':
				this._status.textContent = message ?? 'Generating…';
				button('Stop', 'oc-secondary', () => this._ctrl.cancel());
				break;
			case 'done':
				this._status.textContent = message ?? 'Type a follow-up, or';
				button(`Reject ${keys.reject}`, 'oc-secondary', () => this._ctrl.reject());
				button(`Accept ${keys.accept}`, 'oc-primary', () => this._ctrl.accept());
				break;
			case 'error':
				this._status.textContent = message ?? 'Something went wrong';
				this._status.classList.add('oc-error');
				button('Retry', 'oc-secondary', () => this._ctrl.submit());
				return;
		}
		this._status.classList.remove('oc-error');
	}

	autoGrow(): void {
		this._input.style.height = 'auto';
		this._input.style.height = `${Math.min(this._input.scrollHeight, 200)}px`;
		const lineHeight = this.editor.getOption(EditorOption.lineHeight);
		const px = this._input.offsetHeight + 46;
		this._relayout(Math.ceil(px / lineHeight));
	}

	showAt(afterLine: number): void {
		const lineHeight = this.editor.getOption(EditorOption.lineHeight);
		this.show({ lineNumber: afterLine, column: 1 }, Math.ceil(74 / lineHeight));
		this.autoGrow();
	}

	override dispose(): void {
		this._store.dispose();
		super.dispose();
	}
}

export class OpenCursorInlineEditController extends Disposable implements IEditorContribution {
	static readonly ID = 'editor.contrib.openCursorInlineEdit';
	private static readonly _bySession = new Map<string, OpenCursorInlineEditController>();

	static get(editor: ICodeEditor) {
		return editor.getContribution<OpenCursorInlineEditController>(OpenCursorInlineEditController.ID);
	}

	static forSession(sessionId: string) {
		return OpenCursorInlineEditController._bySession.get(sessionId);
	}

	private _zone: InlineEditZone | undefined;
	private _sessionId: string | undefined;
	private _state: InlineState = 'idle';
	private _selection: { startLine: number; startCol: number; endLine: number; endCol: number } | undefined;
	private readonly _active: IContextKey<boolean>;
	private readonly _stateKey: IContextKey<string>;

	constructor(
		private readonly _editor: ICodeEditor,
		@ICommandService private readonly _commandService: ICommandService,
		@IContextKeyService private readonly _contextKeyService: IContextKeyService,
		@IKeybindingService private readonly _keybindingService: IKeybindingService,
		@IQuickInputService private readonly _quickInputService: IQuickInputService,
	) {
		super();
		this._active = CTX_INLINE_ACTIVE.bindTo(_contextKeyService);
		this._stateKey = CTX_INLINE_STATE.bindTo(_contextKeyService);
		this._register(this._editor.onDidChangeModel(() => this.close()));
		this._register({ dispose: () => this.close() });
	}

	open(): void {
		const model = this._editor.getModel();
		const selection = this._editor.getSelection();
		if (!model || !selection) {
			return;
		}
		if (this._zone) {
			this._zone.focusInput();
			return;
		}
		this._sessionId = generateUuid();
		OpenCursorInlineEditController._bySession.set(this._sessionId, this);
		this._selection = {
			startLine: selection.startLineNumber - 1,
			startCol: selection.startColumn - 1,
			endLine: selection.endLineNumber - 1,
			endCol: selection.endColumn - 1,
		};
		this._zone = new InlineEditZone(this._editor, this);
		this._zone.setPlaceholder(selection.isEmpty() ? 'Generate code… (@ to mention, ⏎ to submit)' : 'Edit selected code… (⏎ to submit)');
		this._zone.showAt(selection.startLineNumber - 1);
		this._setState('idle');
		this._active.set(true);
		void this._refreshModelLabel();
		this._zone.focusInput();
	}

	close(): void {
		if (this._sessionId) {
			OpenCursorInlineEditController._bySession.delete(this._sessionId);
		}
		this._sessionId = undefined;
		this._zone?.dispose();
		this._zone = undefined;
		this._active.set(false);
		this._stateKey.set('idle');
		this._state = 'idle';
	}

	private _setState(state: InlineState, message?: string): void {
		this._state = state;
		this._stateKey.set(state);
		this._zone?.render(state, message, isMacintosh ? { accept: '⌘⏎', reject: '⌘⌫' } : { accept: 'Ctrl+Enter', reject: 'Ctrl+Backspace' });
	}

	setStatus(state: InlineState, message?: string): void {
		this._setState(state, message);
		if (state === 'done' && this._zone) {
			this._zone.value = '';
			this._zone.setPlaceholder('Follow-up instructions… (⏎ to refine)');
			this._zone.focusInput();
		}
	}

	async submit(): Promise<void> {
		const model = this._editor.getModel();
		if (!this._zone || !model || !this._sessionId || !this._selection) {
			return;
		}
		const prompt = this._zone.value.trim();
		if (!prompt) {
			return;
		}
		this._setState('generating');
		try {
			await this._commandService.executeCommand('openCursor.inline.submit', {
				sessionId: this._sessionId,
				uri: model.uri.toString(),
				selection: this._selection,
				prompt,
				modelId: lastModelId,
			});
			if (this._state === 'generating') {
				this.setStatus('done');
			}
		} catch (err) {
			this._setState('error', err instanceof Error ? err.message : String(err));
		}
	}

	cancel(): void {
		if (this._sessionId) {
			this._commandService.executeCommand('openCursor.inline.cancel', this._sessionId);
		}
		this._setState('idle');
	}

	accept(): void {
		if (this._sessionId) {
			this._commandService.executeCommand('openCursor.inline.accept', this._sessionId);
		}
		this.close();
		this._editor.focus();
	}

	reject(): void {
		if (this._sessionId) {
			this._commandService.executeCommand('openCursor.inline.reject', this._sessionId);
		}
		this.close();
		this._editor.focus();
	}

	async pickModel(): Promise<void> {
		const models = await this._commandService.executeCommand<IModelOption[]>('openCursor.models.list') ?? [];
		const pick = await this._quickInputService.pick(models.map(m => ({ id: m.id, label: m.label, description: m.hasKey === false ? 'no key' : undefined })), { placeHolder: isMacintosh ? 'Model for Cmd+K' : 'Model for Ctrl+K' });
		if (pick) {
			lastModelId = pick.id;
			this._zone?.setModelLabel(pick.label);
		}
		this._zone?.focusInput();
	}

	private async _refreshModelLabel(): Promise<void> {
		const models = await this._commandService.executeCommand<IModelOption[]>('openCursor.models.list') ?? [];
		const id = lastModelId ?? await this._commandService.executeCommand<string>('openCursor.models.getDefault', 'inline');
		const label = models.find(m => m.id === id)?.label ?? id ?? 'No model';
		this._zone?.setModelLabel(label);
	}

	onKeyDown(e: StandardKeyboardEvent): void {
		const value = this._zone?.value ?? '';
		if (e.keyCode === KeyCode.Escape) {
			e.preventDefault();
			if (this._state === 'generating') {
				this.cancel();
			}
			this.close();
			this._editor.focus();
			return;
		}
		if (e.keyCode === KeyCode.Enter && (e.metaKey || e.ctrlKey) && this._state === 'done' && !value.trim()) {
			e.preventDefault();
			this.accept();
			return;
		}
		if (e.keyCode === KeyCode.Backspace && (e.metaKey || e.ctrlKey) && this._state === 'done' && !value) {
			e.preventDefault();
			this.reject();
			return;
		}
		if (e.keyCode === KeyCode.Enter && !e.shiftKey && !e.altKey) {
			e.preventDefault();
			this.submit();
			return;
		}
		if (!value && this._state === 'idle' && (e.metaKey || e.ctrlKey) && !isModifierOnly(e.keyCode)) {
			if (this._runChord(e)) {
				e.preventDefault();
				e.stopPropagation();
			}
		}
	}

	/** Runs the `Cmd+K <key>` chord bound to the pressed key, if any. */
	private _runChord(e: StandardKeyboardEvent): boolean {
		const first = this._keybindingService.lookupKeybinding('openCursor.inline.open')?.getDispatchChords()[0];
		const second = this._keybindingService.resolveKeyboardEvent(e).getDispatchChords()[0];
		if (!first || !second) {
			return false;
		}
		this.close();
		this._editor.focus();
		const candidates = this._keybindingService.getKeybindings().filter(k =>
			k.chords.length === 2 && k.chords[0] === first && k.chords[1] === second && k.command &&
			(!k.when || this._contextKeyService.contextMatchesRules(k.when)));
		const match = candidates[candidates.length - 1];
		if (match?.command) {
			this._commandService.executeCommand(match.command, match.commandArgs);
			return true;
		}
		return true;
	}
}

function isModifierOnly(keyCode: KeyCode): boolean {
	return keyCode === KeyCode.Meta || keyCode === KeyCode.Ctrl || keyCode === KeyCode.Shift || keyCode === KeyCode.Alt;
}

registerEditorContribution(OpenCursorInlineEditController.ID, OpenCursorInlineEditController, EditorContributionInstantiation.Lazy);

registerAction2(class extends Action2 {
	constructor() {
		super({
			id: 'openCursor.inline.open',
			title: isMacintosh ? localize2('openCursor.inline.open', "Edit Inline (Cmd+K)") : localize2('openCursor.inline.openCtrl', "Edit Inline (Ctrl+K)"),
			category: localize2('openCursor', "Open Cursor"),
			f1: true,
			precondition: EditorContextKeys.writable,
			keybinding: {
				primary: KeyMod.CtrlCmd | KeyCode.KeyK,
				when: ContextKeyExpr.and(EditorContextKeys.editorTextFocus, EditorContextKeys.writable),
				// Above every Cmd+K chord, so the box opens; chords are replayed from inside the box.
				weight: KeybindingWeight.ExternalExtension + 100,
			},
		});
	}
	run(accessor: ServicesAccessor): void {
		const editor = accessor.get(ICodeEditorService).getFocusedCodeEditor() ?? accessor.get(ICodeEditorService).getActiveCodeEditor();
		if (editor) {
			OpenCursorInlineEditController.get(editor)?.open();
		}
	}
});

CommandsRegistry.registerCommand('_openCursor.inline.status', (_accessor, sessionId: string, state: InlineState, message?: string) => {
	OpenCursorInlineEditController.forSession(sessionId)?.setStatus(state, message);
});
