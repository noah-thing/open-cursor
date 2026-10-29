/*---------------------------------------------------------------------------------------------
 *  OpenCursor. MIT License.
 *  The quiet "Made by" line on the start screens and in the settings nav.
 *--------------------------------------------------------------------------------------------*/

import type { MouseEvent, ReactElement } from 'react';
import avatar from './assets/fsconfig.jpg';
import './credit.css';

const X_URL = 'https://x.com/fsconfig';
const GITHUB_URL = 'https://github.com/noah-thing/open-cursor';

/** The rosette is blue; the check is a separate white shape because the outline path leaves it as a hole. */
function VerifiedBadge(): ReactElement {
	return (
		<svg className="oc-credit-badge" width="13" height="13" viewBox="0 0 22 22" aria-hidden="true" focusable="false">
			<path fill="#1D9BF0" d="M20.396 11c-.018-.646-.215-1.275-.57-1.816-.354-.54-.852-.972-1.438-1.246.223-.607.27-1.264.14-1.897-.131-.634-.437-1.218-.882-1.687-.47-.445-1.053-.75-1.687-.882-.633-.13-1.29-.083-1.897.14-.273-.587-.704-1.086-1.245-1.44S11.647 1.62 11 1.604c-.646.017-1.273.213-1.813.568s-.969.854-1.24 1.44c-.608-.223-1.267-.272-1.902-.14-.635.13-1.22.436-1.69.882-.445.47-.749 1.055-.878 1.688-.13.633-.08 1.29.144 1.896-.587.274-1.087.705-1.443 1.245-.356.54-.555 1.17-.574 1.817.02.647.218 1.276.574 1.817.356.54.856.972 1.443 1.245-.224.606-.274 1.263-.144 1.896.13.634.433 1.218.877 1.688.47.443 1.054.747 1.687.878.633.132 1.29.084 1.897-.136.274.586.705 1.084 1.246 1.439.54.354 1.17.551 1.816.569.647-.016 1.276-.213 1.817-.567s.972-.854 1.245-1.44c.604.239 1.266.296 1.903.164.636-.132 1.22-.447 1.68-.907.46-.46.776-1.044.908-1.681s.075-1.299-.165-1.903c.586-.274 1.084-.705 1.439-1.246.354-.54.551-1.17.569-1.816z" />
			<path fill="#fff" d="M9.662 14.85l-3.429-3.428 1.293-1.302 2.072 2.072 4.4-4.794 1.347 1.246z" />
		</svg>
	);
}

function GitHubMark(): ReactElement {
	return (
		<svg width="13" height="13" viewBox="0 0 16 16" fill="currentColor" aria-hidden="true" focusable="false">
			<path d="M8 0C3.58 0 0 3.58 0 8c0 3.54 2.29 6.53 5.47 7.59.4.07.55-.17.55-.38 0-.19-.01-.82-.01-1.49-2.01.37-2.53-.49-2.69-.94-.09-.23-.48-.94-.82-1.13-.28-.15-.68-.52-.01-.53.63-.01 1.08.58 1.23.82.72 1.21 1.87.87 2.33.66.07-.52.28-.87.51-1.07-1.78-.2-3.64-.89-3.64-3.95 0-.87.31-1.59.82-2.15-.08-.2-.36-1.02.08-2.12 0 0 .67-.21 2.2.82.64-.18 1.32-.27 2-.27.68 0 1.36.09 2 .27 1.53-1.04 2.2-.82 2.2-.82.44 1.1.16 1.92.08 2.12.51.56.82 1.27.82 2.15 0 3.07-1.87 3.75-3.65 3.95.29.25.54.73.54 1.48 0 1.07-.01 1.93-.01 2.2 0 .21.15.46.55.38A8.013 8.013 0 0016 8c0-4.42-3.58-8-8-8z" />
		</svg>
	);
}

/** `open` hands the URL to the host, which opens it in the browser. */
export function Credit({ open, className }: { readonly open: (url: string) => void; readonly className?: string }): ReactElement {
	const go = (url: string) => (e: MouseEvent): void => { e.preventDefault(); open(url); };
	return (
		<div className={'oc-credit' + (className ? ' ' + className : '')}>
			<a className="oc-credit-x" href={X_URL} title="Made by Noah, @fsconfig" aria-label="Noah on X, @fsconfig" onClick={go(X_URL)}>
				<img className="oc-credit-avatar" src={avatar} alt="" width="16" height="16" draggable={false} />
				<span className="oc-credit-text">
					<span>Made by </span><b>Noah</b>
					<VerifiedBadge />
					<span>@fsconfig</span>
				</span>
			</a>
			<a className="oc-credit-gh" href={GITHUB_URL} aria-label="OpenCursor on GitHub" onClick={go(GITHUB_URL)}>
				<GitHubMark />
				<span className="oc-credit-gh-label">GitHub</span>
			</a>
		</div>
	);
}
