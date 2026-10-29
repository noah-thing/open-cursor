/*---------------------------------------------------------------------------------------------
 *  OpenCursor. MIT License.
 *  What one install count ping contains. Pure, so it is easy to check that nothing else leaves.
 *--------------------------------------------------------------------------------------------*/

export interface PingBody {
	readonly id: string;
	readonly version: string;
	readonly os: 'darwin' | 'win32' | 'linux';
	readonly arch: 'arm64' | 'x64';
}

/** Undefined on a platform the counter does not track. */
export function pingBody(id: string, version: string, platform: NodeJS.Platform, arch: string): PingBody | undefined {
	if (platform !== 'darwin' && platform !== 'win32' && platform !== 'linux') { return undefined; }
	if (arch !== 'arm64' && arch !== 'x64') { return undefined; }
	return { id, version, os: platform, arch };
}

/** The user's own telemetry choice. Not vscode.env.isTelemetryEnabled: built Code-OSS reports telemetry
 *  as unsupported (only Microsoft's product enables it), so that flag is always false in a release. */
export function telemetryOff(level: unknown, legacy: unknown): boolean {
	return level === 'off' || legacy === false;
}

/** The value a person set themselves, ignoring defaults. OpenCursor ships telemetry.telemetryLevel
 *  defaulting to off so Microsoft's telemetry never runs, and that default must not read as a choice. */
export function chosen<T>(i: { globalValue?: T; workspaceValue?: T; workspaceFolderValue?: T } | undefined): T | undefined {
	return i?.workspaceFolderValue ?? i?.workspaceValue ?? i?.globalValue;
}
