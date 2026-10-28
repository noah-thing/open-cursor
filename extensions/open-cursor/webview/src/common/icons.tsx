/*---------------------------------------------------------------------------------------------
 *  Open Cursor. MIT License.
 *--------------------------------------------------------------------------------------------*/

import type { CSSProperties, ReactElement } from 'react';

/** Hand drawn 16px icons, 1.5px stroke, currentColor. Paths are in a 16x16 box. */
const PATHS = {
	plus: 'M8 3.25v9.5M3.25 8h9.5',
	minus: 'M3.25 8h9.5',
	x: 'M4 4l8 8M12 4l-8 8',
	check: 'M3.5 8.5l3 3 6-7',
	chevronRight: 'M6 3.5L10.5 8 6 12.5',
	chevronDown: 'M3.5 6L8 10.5 12.5 6',
	chevronUp: 'M3.5 10L8 5.5 12.5 10',
	arrowUp: 'M8 13V3.5M4 7.25l4-4 4 4',
	arrowRight: 'M3 8h10M9 4l4 4-4 4',
	history: 'M2.75 8a5.25 5.25 0 1 0 1.6-3.75M2.75 2.75v2.5h2.5M8 5v3.25l2 1.25',
	more: 'M3.5 8h.01M8 8h.01M12.5 8h.01',
	gear: 'M8 5.6a2.4 2.4 0 1 0 0 4.8 2.4 2.4 0 0 0 0-4.8zM8 1.75l.8 1.7 1.8-.5.5 1.8 1.8.5-.5 1.8 1.4 1.3-1.4 1.3.5 1.8-1.8.5-.5 1.8-1.8-.5-.8 1.7-.8-1.7-1.8.5-.5-1.8-1.8-.5.5-1.8L1.6 8l1.4-1.3-.5-1.8 1.8-.5.5-1.8 1.8.5z',
	copy: 'M5.75 5.75V3.5a1 1 0 0 1 1-1h6a1 1 0 0 1 1 1v6a1 1 0 0 1-1 1h-2.25M3.25 5.75h6a1 1 0 0 1 1 1v6a1 1 0 0 1-1 1h-6a1 1 0 0 1-1-1v-6a1 1 0 0 1 1-1z',
	file: 'M4 2.5h5l3 3v8a.5.5 0 0 1-.5.5h-7.5a.5.5 0 0 1-.5-.5v-10.5a.5.5 0 0 1 .5-.5zM9 2.5v3h3',
	folder: 'M2.5 4.25a.75.75 0 0 1 .75-.75h3l1.25 1.5h5.25a.75.75 0 0 1 .75.75v6a.75.75 0 0 1-.75.75h-9.5a.75.75 0 0 1-.75-.75z',
	search: 'M7 11.5a4.5 4.5 0 1 0 0-9 4.5 4.5 0 0 0 0 9zM10.4 10.4l3.1 3.1',
	terminal: 'M2.5 3.5h11a1 1 0 0 1 1 1v7a1 1 0 0 1-1 1h-11a1 1 0 0 1-1-1v-7a1 1 0 0 1 1-1zM4.5 6.25l2 1.75-2 1.75M8 10h3',
	pencil: 'M10.5 3l2.5 2.5L5.5 13l-3 .5.5-3z M9 4.5l2.5 2.5',
	trash: 'M3 4.5h10M6.25 4.5V3h3.5v1.5M4.25 4.5l.5 8.5h6.5l.5-8.5M6.75 7v4M9.25 7v4',
	infinity: 'M4.6 5.2c-1.9 0-2.9 1.2-2.9 2.8s1 2.8 2.9 2.8c2.7 0 4.6-5.6 7.2-5.6 1.9 0 2.9 1.2 2.9 2.8s-1 2.8-2.9 2.8c-2.6 0-4.5-5.6-7.2-5.6z',
	todos: 'M3 4.5l1 1 1.75-2M3 10.5l1 1 1.75-2M8 4.5h5M8 10.5h5',
	bug: 'M5.5 5.5a2.5 2.5 0 0 1 5 0v.5h-5zM4.5 6h7v3.25a3.5 3.5 0 0 1-7 0zM8 6v7M2.5 8h2M11.5 8h2M3.25 4l1.5 1.25M12.75 4l-1.5 1.25M3.25 12.25l1.5-1.25M12.75 12.25l-1.5-1.25',
	chat: 'M2.5 4a1 1 0 0 1 1-1h9a1 1 0 0 1 1 1v6a1 1 0 0 1-1 1H7l-3 2.5V11h-.5a1 1 0 0 1-1-1z',
	at: 'M10.75 8a2.75 2.75 0 1 1-5.5 0 2.75 2.75 0 0 1 5.5 0zM10.75 8v.75a1.5 1.5 0 0 0 3 0V8a5.75 5.75 0 1 0-2.25 4.55',
	slash: 'M10.5 2.5l-5 11',
	image: 'M3 3h10a.5.5 0 0 1 .5.5v9a.5.5 0 0 1-.5.5H3a.5.5 0 0 1-.5-.5v-9A.5.5 0 0 1 3 3zM2.75 11l3-3 2.5 2.5 2-2 3 3M10.5 6.25h.01',
	undo: 'M3.25 6.5h6.25a3.25 3.25 0 0 1 0 6.5H6M3.25 6.5l2.75-2.75M3.25 6.5L6 9.25',
	restore: 'M2.75 8a5.25 5.25 0 1 0 1.6-3.75M2.75 2.75v2.5h2.5M8 5.5V8l1.75 1',
	brain: 'M6 2.75a2 2 0 0 0-2 2 2 2 0 0 0-1.25 3.5A2.25 2.25 0 0 0 5 11.5a2 2 0 0 0 3 1.25V3.5A1.75 1.75 0 0 0 6 2.75zM10 2.75a2 2 0 0 1 2 2 2 2 0 0 1 1.25 3.5A2.25 2.25 0 0 1 11 11.5a2 2 0 0 1-3 1.25',
	globe: 'M8 13.5a5.5 5.5 0 1 0 0-11 5.5 5.5 0 0 0 0 11zM2.5 8h11M8 2.5c1.7 1.6 2.4 3.4 2.4 5.5S9.7 11.9 8 13.5C6.3 11.9 5.6 10.1 5.6 8S6.3 4.1 8 2.5z',
	git: 'M4.5 3.25v5.5M4.5 11a1.5 1.5 0 1 0 0 3 1.5 1.5 0 0 0 0-3zM4.5 3.25a1.5 1.5 0 1 0 0-3 1.5 1.5 0 0 0 0 3zM11.5 5.25a1.5 1.5 0 1 0 0-3 1.5 1.5 0 0 0 0 3zM11.5 5.25c0 3-7 1.5-7 5.5',
	code: 'M5.5 4.5L2 8l3.5 3.5M10.5 4.5L14 8l-3.5 3.5M9.25 3l-2.5 10',
	play: 'M5 3.25l7 4.75-7 4.75z',
	stop: 'M4.5 4.5h7v7h-7z',
	warning: 'M8 2.5l6 10.5H2zM8 6.5v3M8 11.25h.01',
	list: 'M5.5 4h8M5.5 8h8M5.5 12h8M2.5 4h.01M2.5 8h.01M2.5 12h.01',
	plug: 'M6 2.5v3M10 2.5v3M4.5 5.5h7v2.25a3.5 3.5 0 0 1-7 0zM8 11.25v2.25',
	key: 'M5.25 10.75a3 3 0 1 1 2.6-1.5l5.15 5M10 11.5l1.5-1.5M11.5 13l1.25-1.25',
	refresh: 'M13 3.5v3h-3M3 12.5v-3h3M3.4 7A4.75 4.75 0 0 1 12.5 5.5L13 6.5M12.6 9A4.75 4.75 0 0 1 3.5 10.5L3 9.5',
	external: 'M9 3h4v4M13 3L7.5 8.5M11 9v3.5a.5.5 0 0 1-.5.5h-7a.5.5 0 0 1-.5-.5v-7a.5.5 0 0 1 .5-.5H7',
	link: 'M6.75 9.25a2.5 2.5 0 0 0 3.5 0l2.5-2.5a2.5 2.5 0 0 0-3.5-3.5l-.75.75M9.25 6.75a2.5 2.5 0 0 0-3.5 0l-2.5 2.5a2.5 2.5 0 0 0 3.5 3.5l.75-.75',
	rule: 'M3.5 2.5h9v11h-9zM5.75 5.5h4.5M5.75 8h4.5M5.75 10.5h2.5',
	sparkle: 'M8 2.5l1.3 3.7 3.7 1.3-3.7 1.3L8 12.5 6.7 8.8 3 7.5l3.7-1.3zM12.5 11.5l.5 1.25 1.25.5-1.25.5-.5 1.25-.5-1.25L10.75 13.25l1.25-.5z',
	database: 'M3 4.25C3 3.28 5.24 2.5 8 2.5s5 .78 5 1.75S10.76 6 8 6 3 5.22 3 4.25zM3 4.25v7.5C3 12.72 5.24 13.5 8 13.5s5-.78 5-1.75v-7.5M3 8c0 .97 2.24 1.75 5 1.75S13 8.97 13 8',
	user: 'M8 7.5a2.75 2.75 0 1 0 0-5.5 2.75 2.75 0 0 0 0 5.5zM2.75 14a5.25 5.25 0 0 1 10.5 0',
	circle: 'M8 13a5 5 0 1 0 0-10 5 5 0 0 0 0 10z',
	dot: 'M8 8h.01',
	filter: 'M2.5 3.5h11L9.25 8.5v4l-2.5 1v-5z',
	pin: 'M9.5 2.5l4 4-2 .5-2.5 2.5.25 3-1 1L5 10 2.5 12.5M5 10l-1-1 1-1 3 .25L10.5 5.75z',
	camera: 'M2.5 5h2.25L5.75 3.5h4.5L11.25 5h2.25a.5.5 0 0 1 .5.5v7a.5.5 0 0 1-.5.5h-11a.5.5 0 0 1-.5-.5v-7A.5.5 0 0 1 2.5 5zM8 10.75a2.25 2.25 0 1 0 0-4.5 2.25 2.25 0 0 0 0 4.5z',
	diff: 'M5 2.5v6M2 5.5h6M8 11.5h6M10.5 3.5h3.5v9',
	keyboard: 'M2.5 4.5h11a1 1 0 0 1 1 1v5a1 1 0 0 1-1 1h-11a1 1 0 0 1-1-1v-5a1 1 0 0 1 1-1zM4.5 7h.01M7 7h.01M9.5 7h.01M12 7h.01M5 9.5h6',
	home: 'M2.5 7.5L8 2.75l5.5 4.75M4 6.75v6.5h8v-6.5',
	tool: 'M9.9 3.1a3.25 3.25 0 0 0-3.8 4.1L2.5 10.8l2.7 2.7 3.6-3.6a3.25 3.25 0 0 0 4.1-3.8L10.8 8 8.7 5.9z',
	bolt: 'M9 2L3.5 9h4L7 14l5.5-7h-4z',
	cube: 'M8 2l5.5 3v6L8 14l-5.5-3V5zM8 8v6M2.5 5L8 8l5.5-3',
	book: 'M3 3h4a1 1 0 0 1 1 1v9.5a1.5 1.5 0 0 0-1.5-1.5H3zM13 3H9a1 1 0 0 0-1 1v9.5a1.5 1.5 0 0 1 1.5-1.5H13z',
} as const;

export type IconName = keyof typeof PATHS;

const FILLED = new Set<IconName>(['play', 'stop', 'dot']);

export interface IconProps {
	readonly name: IconName;
	readonly size?: number;
	readonly className?: string;
	readonly style?: CSSProperties;
}

export function Icon({ name, size = 16, className, style }: IconProps): ReactElement {
	const filled = FILLED.has(name);
	return (
		<svg
			className={'oc-icon' + (className ? ' ' + className : '')}
			width={size}
			height={size}
			viewBox="0 0 16 16"
			fill={filled ? 'currentColor' : 'none'}
			stroke={name === 'dot' ? 'currentColor' : filled ? 'none' : 'currentColor'}
			strokeWidth={name === 'dot' ? 3 : 1.5}
			strokeLinecap="round"
			strokeLinejoin="round"
			aria-hidden="true"
			style={style}
		>
			<path d={PATHS[name]} />
		</svg>
	);
}

export function Spinner({ size = 14 }: { readonly size?: number }): ReactElement {
	return (
		<svg className="oc-spinner" width={size} height={size} viewBox="0 0 16 16" fill="none" aria-hidden="true">
			<circle cx="8" cy="8" r="6" stroke="currentColor" strokeOpacity="0.25" strokeWidth="1.75" />
			<path d="M14 8a6 6 0 0 0-6-6" stroke="currentColor" strokeWidth="1.75" strokeLinecap="round" />
		</svg>
	);
}
