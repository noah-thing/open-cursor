/*---------------------------------------------------------------------------------------------
 *  Open Cursor. MIT License.
 *--------------------------------------------------------------------------------------------*/

export interface VsCodeApi<M, S = unknown> {
	postMessage(message: M): void;
	getState(): S | undefined;
	setState(state: S): void;
}

declare function acquireVsCodeApi(): VsCodeApi<unknown>;

let cached: VsCodeApi<unknown> | undefined;

/** acquireVsCodeApi may only be called once per webview, so everything shares this handle. */
export function getVsCode<M, S = unknown>(): VsCodeApi<M, S> {
	cached ??= acquireVsCodeApi();
	return cached as VsCodeApi<M, S>;
}
