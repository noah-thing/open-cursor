// Import first: lets modules that `import * as vscode from 'vscode'` load in plain node (nothing is ever called).
import Module from 'module';

const stub: unknown = new Proxy(function () { /* stub */ }, { get: (_t, k) => (k === '__esModule' ? false : stub), apply: () => stub, construct: () => ({}) });
const m = Module as unknown as { _load: (request: string, ...rest: unknown[]) => unknown };
const original = m._load;
m._load = function (request: string, ...rest: unknown[]) {
	return request === 'vscode' ? stub : original.call(this, request, ...rest);
};
