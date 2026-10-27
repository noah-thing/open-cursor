/*---------------------------------------------------------------------------------------------
 *  Open Cursor. MIT License.
 *  Renders pending AI edits inside code editors: added lines get a green wash, removed lines are
 *  drawn as syntax highlighted view zones, and every hunk gets Undo / Keep buttons. The extension
 *  owns the edit state and pushes it here with `_openCursor.diff.set`; buttons call back into the
 *  extension's `openCursor.diff.*` commands.
 *--------------------------------------------------------------------------------------------*/

import './media/openCursor.css';
import { $, append, addDisposableListener, EventType, getTotalWidth } from '../../../../base/browser/dom.js';
import { Emitter, Event } from '../../../../base/common/event.js';
import { Disposable, DisposableStore } from '../../../../base/common/lifecycle.js';
import { ResourceMap } from '../../../../base/common/map.js';
import { URI } from '../../../../base/common/uri.js';
import { ICodeEditor, IOverlayWidget, IOverlayWidgetPosition, IViewZone } from '../../../../editor/browser/editorBrowser.js';
import { EditorContributionInstantiation, registerEditorContribution } from '../../../../editor/browser/editorExtensions.js';
import { LineSource, renderLines, RenderOptions } from '../../../../editor/browser/widget/diffEditor/components/diffEditorViewZones/renderLines.js';
import { EditorOption } from '../../../../editor/common/config/editorOptions.js';
import { IEditorContribution } from '../../../../editor/common/editorCommon.js';
import { ILanguageService } from '../../../../editor/common/languages/language.js';
import { IModelDeltaDecoration, OverviewRulerLane, MinimapPosition, TrackedRangeStickiness } from '../../../../editor/common/model.js';
import { ModelDecorationOptions } from '../../../../editor/common/model/textModel.js';
import { IModelService } from '../../../../editor/common/services/model.js';
import { Range } from '../../../../editor/common/core/range.js';
import { CommandsRegistry, ICommandService } from '../../../../platform/commands/common/commands.js';
import { InstantiationType, registerSingleton } from '../../../../platform/instantiation/common/extensions.js';
import { createDecorator } from '../../../../platform/instantiation/common/instantiation.js';
import { IKeybindingService } from '../../../../platform/keybinding/common/keybinding.js';
import { themeColorFromId } from '../../../../platform/theme/common/themeService.js';
import { overviewRulerAddedForeground, minimapGutterAddedBackground } from '../../scm/common/quickDiff.js';

export interface IPendingHunk {
	readonly id: string;
	/** 0-based line of the first added line in the current document. */
	readonly startLine: number;
	readonly addedCount: number;
	readonly removedLines: string[];
}

interface IFileDiffState {
	readonly hunks: readonly IPendingHunk[];
	readonly fileIndex: number;
	readonly fileCount: number;
}

export const IOpenCursorDiffService = createDecorator<IOpenCursorDiffService>('openCursorDiffService');

export interface IOpenCursorDiffService {
	readonly _serviceBrand: undefined;
	readonly onDidChange: Event<URI>;
	get(uri: URI): IFileDiffState | undefined;
	set(uri: URI, state: IFileDiffState): void;
	clear(uri: URI): void;
}

class OpenCursorDiffService implements IOpenCursorDiffService {
	declare readonly _serviceBrand: undefined;
	private readonly _states = new ResourceMap<IFileDiffState>();
	private readonly _onDidChange = new Emitter<URI>();
	readonly onDidChange = this._onDidChange.event;

	get(uri: URI) { return this._states.get(uri); }

	set(uri: URI, state: IFileDiffState) {
		if (!state.hunks.length) {
			this.clear(uri);
			return;
		}
		this._states.set(uri, state);
		this._onDidChange.fire(uri);
	}

	clear(uri: URI) {
		if (this._states.delete(uri)) {
			this._onDidChange.fire(uri);
		}
	}
}

registerSingleton(IOpenCursorDiffService, OpenCursorDiffService, InstantiationType.Delayed);

CommandsRegistry.registerCommand('_openCursor.diff.set', (accessor, uri: string, hunks: IPendingHunk[], meta?: { fileIndex: number; fileCount: number }) => {
	accessor.get(IOpenCursorDiffService).set(URI.parse(uri), { hunks: hunks ?? [], fileIndex: meta?.fileIndex ?? 0, fileCount: meta?.fileCount ?? 1 });
});
CommandsRegistry.registerCommand('_openCursor.diff.clear', (accessor, uri: string) => {
	accessor.get(IOpenCursorDiffService).clear(URI.parse(uri));
});

const addedLineDecoration = ModelDecorationOptions.register({
	description: 'open-cursor-diff-added',
	className: 'oc-diff-added-line',
	isWholeLine: true,
	stickiness: TrackedRangeStickiness.NeverGrowsWhenTypingAtEdges,
	overviewRuler: { color: themeColorFromId(overviewRulerAddedForeground), position: OverviewRulerLane.Full },
	minimap: { color: themeColorFromId(minimapGutterAddedBackground), position: MinimapPosition.Gutter },
});

const removedMarkerDecoration = ModelDecorationOptions.register({
	description: 'open-cursor-diff-removed-marker',
	isWholeLine: true,
	overviewRuler: { color: 'rgba(255, 90, 90, 0.8)', position: OverviewRulerLane.Full },
});

/** Small button group anchored to the top right of a hunk. */
class HunkWidget implements IOverlayWidget {
	private static _ids = 0;
	private readonly _id = `oc-hunk-widget-${HunkWidget._ids++}`;
	private readonly _domNode: HTMLElement;
	private readonly _store = new DisposableStore();
	private _position: IOverlayWidgetPosition | null = null;

	constructor(
		private readonly _editor: ICodeEditor,
		private readonly _uri: URI,
		private readonly _hunkId: string,
		commandService: ICommandService,
		keybindingService: IKeybindingService,
	) {
		this._domNode = $('.oc-hunk-widget');
		const undo = append(this._domNode, $('button.oc-hunk-btn.oc-undo'));
		undo.textContent = labelWithKey('Undo', keybindingService, 'openCursor.diff.rejectHunk');
		const keep = append(this._domNode, $('button.oc-hunk-btn.oc-keep'));
		keep.textContent = labelWithKey('Keep', keybindingService, 'openCursor.diff.acceptHunk');
		this._store.add(addDisposableListener(undo, EventType.CLICK, e => {
			e.preventDefault();
			commandService.executeCommand('openCursor.diff.rejectHunk', this._uri.toString(), this._hunkId);
		}));
		this._store.add(addDisposableListener(keep, EventType.CLICK, e => {
			e.preventDefault();
			commandService.executeCommand('openCursor.diff.acceptHunk', this._uri.toString(), this._hunkId);
		}));
		this._editor.addOverlayWidget(this);
	}

	layout(afterLineNumber: number, removedHeightPx: number): void {
		const { contentLeft, contentWidth, verticalScrollbarWidth } = this._editor.getLayoutInfo();
		const lineHeight = this._editor.getOption(EditorOption.lineHeight);
		// Sit on the first line of the hunk (removed zone if any, else the first added line).
		const top = (afterLineNumber === 0 ? 0 : this._editor.getTopForLineNumber(afterLineNumber) + lineHeight) - removedHeightPx - this._editor.getScrollTop();
		this._position = {
			preference: {
				top: Math.max(0, top - 22),
				left: contentLeft + contentWidth - (2 * verticalScrollbarWidth + getTotalWidth(this._domNode)),
			},
			stackOrdinal: 2,
		};
		this._editor.layoutOverlayWidget(this);
	}

	getId() { return this._id; }
	getDomNode() { return this._domNode; }
	getPosition() { return this._position; }

	dispose(): void {
		this._store.dispose();
		this._editor.removeOverlayWidget(this);
	}
}

/** "1 of 3  ‹ ›   Undo File  Keep File" bar floating at the bottom of the editor. */
class ReviewBarWidget implements IOverlayWidget {
	private readonly _domNode: HTMLElement;
	private readonly _counter: HTMLElement;
	private readonly _hunks: HTMLElement;
	private readonly _store = new DisposableStore();

	constructor(
		private readonly _editor: ICodeEditor,
		private readonly _uri: URI,
		commandService: ICommandService,
		keybindingService: IKeybindingService,
	) {
		this._domNode = $('.oc-review-bar');
		const nav = append(this._domNode, $('.oc-review-nav'));
		const prev = append(nav, $('button.oc-review-icon', { title: 'Previous file' }));
		prev.textContent = '‹';
		this._counter = append(nav, $('span.oc-review-counter'));
		const next = append(nav, $('button.oc-review-icon', { title: 'Next file' }));
		next.textContent = '›';
		this._hunks = append(this._domNode, $('span.oc-review-hunks'));
		const undo = append(this._domNode, $('button.oc-review-btn.oc-undo'));
		undo.textContent = labelWithKey('Undo File', keybindingService, 'openCursor.diff.rejectFile');
		const keep = append(this._domNode, $('button.oc-review-btn.oc-keep'));
		keep.textContent = labelWithKey('Keep File', keybindingService, 'openCursor.diff.acceptFile');
		const run = (id: string, ...args: unknown[]) => (e: MouseEvent) => {
			e.preventDefault();
			commandService.executeCommand(id, ...args);
		};
		this._store.add(addDisposableListener(prev, EventType.CLICK, run('openCursor.diff.prevFile')));
		this._store.add(addDisposableListener(next, EventType.CLICK, run('openCursor.diff.nextFile')));
		this._store.add(addDisposableListener(undo, EventType.CLICK, run('openCursor.diff.rejectFile', this._uri.toString())));
		this._store.add(addDisposableListener(keep, EventType.CLICK, run('openCursor.diff.acceptFile', this._uri.toString())));
		this._editor.addOverlayWidget(this);
	}

	update(state: IFileDiffState): void {
		this._counter.textContent = `${state.fileIndex + 1} / ${state.fileCount}`;
		this._hunks.textContent = state.hunks.length === 1 ? '1 change' : `${state.hunks.length} changes`;
		this._editor.layoutOverlayWidget(this);
	}

	getId() { return 'oc-review-bar'; }
	getDomNode() { return this._domNode; }
	getPosition(): IOverlayWidgetPosition | null {
		const { width, height } = this._editor.getLayoutInfo();
		const w = this._domNode.offsetWidth || 360;
		return { preference: { top: height - 52, left: Math.max(8, (width - w) / 2) }, stackOrdinal: 3 };
	}

	dispose(): void {
		this._store.dispose();
		this._editor.removeOverlayWidget(this);
	}
}

function labelWithKey(label: string, keybindingService: IKeybindingService, commandId: string): string {
	const kb = keybindingService.lookupKeybinding(commandId)?.getLabel();
	return kb ? `${label} ${kb}` : label;
}

export class OpenCursorDiffContribution extends Disposable implements IEditorContribution {
	static readonly ID = 'editor.contrib.openCursorDiff';

	private readonly _renderStore = this._register(new DisposableStore());
	private readonly _decorations = this._editor.createDecorationsCollection();
	private _zoneIds: string[] = [];

	constructor(
		private readonly _editor: ICodeEditor,
		@IOpenCursorDiffService private readonly _diffService: IOpenCursorDiffService,
		@ICommandService private readonly _commandService: ICommandService,
		@IKeybindingService private readonly _keybindingService: IKeybindingService,
		@IModelService private readonly _modelService: IModelService,
		@ILanguageService private readonly _languageService: ILanguageService,
	) {
		super();
		this._register(this._diffService.onDidChange(uri => {
			if (this._editor.getModel()?.uri.toString() === uri.toString()) {
				this._render();
			}
		}));
		this._register(this._editor.onDidChangeModel(() => this._render()));
		this._register(this._editor.onDidChangeConfiguration(e => {
			if (e.hasChanged(EditorOption.fontInfo) || e.hasChanged(EditorOption.lineHeight)) {
				this._render();
			}
		}));
		this._register({ dispose: () => this._clear() });
		this._render();
	}

	private _clear(): void {
		this._renderStore.clear();
		this._decorations.clear();
		if (this._zoneIds.length) {
			const ids = this._zoneIds;
			this._zoneIds = [];
			this._editor.changeViewZones(accessor => ids.forEach(id => accessor.removeZone(id)));
		}
	}

	private _render(): void {
		this._clear();
		const model = this._editor.getModel();
		if (!model || this._editor.isSimpleWidget) {
			return;
		}
		const state = this._diffService.get(model.uri);
		if (!state) {
			return;
		}

		const lineCount = model.getLineCount();
		const decorations: IModelDeltaDecoration[] = [];
		const renderOptions = RenderOptions.fromEditor(this._editor);
		const languageId = model.getLanguageId();
		const placed: { hunk: IPendingHunk; afterLine: number; removedPx: number; widget: HunkWidget }[] = [];

		this._editor.changeViewZones(accessor => {
			for (const hunk of state.hunks) {
				const start = Math.min(hunk.startLine + 1, lineCount + 1);
				if (hunk.addedCount > 0) {
					const end = Math.min(start + hunk.addedCount - 1, lineCount);
					decorations.push({ range: new Range(start, 1, end, 1), options: addedLineDecoration });
				} else {
					const line = Math.max(1, Math.min(start, lineCount));
					decorations.push({ range: new Range(line, 1, line, 1), options: removedMarkerDecoration });
				}

				let removedPx = 0;
				const afterLine = start - 1;
				if (hunk.removedLines.length) {
					const domNode = $('.oc-diff-removed-zone.view-lines.line-delete.monaco-mouse-cursor-text');
					const heightInLines = this._renderRemoved(hunk.removedLines, languageId, renderOptions, domNode);
					removedPx = heightInLines * this._editor.getOption(EditorOption.lineHeight);
					const zone: IViewZone = { afterLineNumber: afterLine, heightInLines, domNode, ordinal: 50001 };
					this._zoneIds.push(accessor.addZone(zone));
				}

				const widget = new HunkWidget(this._editor, model.uri, hunk.id, this._commandService, this._keybindingService);
				this._renderStore.add(widget);
				placed.push({ hunk, afterLine, removedPx, widget });
			}
		});
		this._decorations.set(decorations);

		const layoutWidgets = () => placed.forEach(p => p.widget.layout(p.afterLine, p.removedPx));
		layoutWidgets();
		this._renderStore.add(this._editor.onDidScrollChange(layoutWidgets));
		this._renderStore.add(this._editor.onDidLayoutChange(layoutWidgets));

		const bar = new ReviewBarWidget(this._editor, model.uri, this._commandService, this._keybindingService);
		bar.update(state);
		this._renderStore.add(bar);
	}

	/** Renders original lines with real syntax colours through a throwaway text model. */
	private _renderRemoved(lines: string[], languageId: string, options: RenderOptions, domNode: HTMLElement): number {
		const temp = this._modelService.createModel(lines.join('\n'), this._languageService.createById(languageId), undefined, false);
		try {
			temp.tokenization.forceTokenization(temp.getLineCount());
			const tokens = [];
			for (let i = 1; i <= temp.getLineCount(); i++) {
				tokens.push(temp.tokenization.getLineTokens(i));
			}
			const source = new LineSource(tokens, [], temp.mightContainNonBasicASCII(), temp.mightContainRTL());
			return renderLines(source, options, [], domNode).heightInLines;
		} finally {
			temp.dispose();
		}
	}
}

registerEditorContribution(OpenCursorDiffContribution.ID, OpenCursorDiffContribution, EditorContributionInstantiation.AfterFirstRender);
