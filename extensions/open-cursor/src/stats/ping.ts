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
