/*---------------------------------------------------------------------------------------------
 *  OpenCursor. MIT License.
 *--------------------------------------------------------------------------------------------*/

import type { CSSProperties, ReactElement } from 'react';
import { PEARL, PEARL_MASK, PEARL_RATIO } from './pearl';

/**
 * Shown while a view gets its first data. Pearl floats, a pearl sheen passes over it and a line of
 * light runs underneath. It waits a moment before appearing, so fast loads never flash it.
 */
export function Loader({ size = 60 }: { readonly size?: number }): ReactElement {
	const style = { ['--oc-pearl-w' as string]: Math.round(size * PEARL_RATIO) + 'px', ['--oc-pearl-h' as string]: size + 'px', ['--oc-pearl-mask' as string]: `url(${PEARL_MASK})` } as CSSProperties;
	return (
		<div className="oc-loader" role="status" aria-label="Loading" style={style}>
			<div className="oc-loader-mark">
				<img src={PEARL} alt="" draggable={false} />
				<span className="oc-loader-sheen" aria-hidden="true" />
			</div>
			<span className="oc-loader-shadow" aria-hidden="true" />
			<span className="oc-loader-line" aria-hidden="true" />
		</div>
	);
}
