/*---------------------------------------------------------------------------------------------
 *  OpenCursor. MIT License.
 *  The message feed: news from the project shown inside OpenCursor without a new release. The feed
 *  is one signed JSON file on opencursor.org. A feed that does not verify against the key below is
 *  ignored, so whoever controls the hosting still cannot put words in the editor. Pure, so the rules
 *  for what shows and to whom can be tested without VS Code.
 *--------------------------------------------------------------------------------------------*/

import { createPublicKey, verify } from 'crypto';
import { isNewer } from '../update/plan';

export const FEED_URL = 'https://opencursor.org/notices.json';

// The matching private key never leaves the maintainer's machine (scripts/notice.mjs signs with it).
const KEY = createPublicKey('-----BEGIN PUBLIC KEY-----\nMCowBQYDK2VwAyEA5MFeVAB/Sel1GgQINk+puZbC340rqN9OnpLJPnYxaK0=\n-----END PUBLIC KEY-----\n');

/** A full page in an editor tab, a card above the chat composer, or a small native notification. */
export type NoticeKind = 'tab' | 'card' | 'toast';

export interface NoticePoint {
	readonly title: string;
	readonly text: string;
}

export interface Notice {
	readonly id: string;
	readonly kind: NoticeKind;
	readonly title: string;
	/** The main paragraph: the lede on a tab, the text of a card or a toast. */
	readonly body?: string;
	/** A second, stronger paragraph under the body (tab). */
	readonly extra?: string;
	/** Who it comes from, shown in the header of a card and as the label of a tab. */
	readonly brand?: { readonly name: string; readonly icon?: string };
	/** A short line under the brand: "From the maker of OpenCursor". */
	readonly eyebrow?: string;
	/** A one word badge before the eyebrow on a tab: "Free". */
	readonly tag?: string;
	/** Selling points: a grid on a tab, a checked list on a card. */
	readonly points?: readonly NoticePoint[];
	readonly pointsTitle?: string;
	/** A closing line after the points, such as "+ a lot more". */
	readonly more?: string;
	readonly image?: { readonly url: string; readonly caption?: string };
	readonly action?: { readonly label: string; readonly url: string };
	/** Small print beside or under the button. */
	readonly note?: string;
	/** Versions this notice is for, inclusive. */
	readonly from?: string;
	readonly to?: string;
	readonly platforms?: readonly NodeJS.Platform[];
	/** ISO times between which it may show. */
	readonly after?: string;
	readonly until?: string;
}

export interface Feed {
	readonly notices: readonly Notice[];
	readonly issued: number;
}

// A leaked key could only point people at these sites, never anywhere else.
const LINK_HOSTS: ReadonlySet<string> = new Set(['opencursor.org', 'mylunchbox.dev', 'github.com', 'x.com']);
const IMAGE_HOSTS: ReadonlySet<string> = new Set(['opencursor.org', 'mylunchbox.dev', 'raw.githubusercontent.com']);
export const IMAGE_ORIGINS = [...IMAGE_HOSTS].map(h => `https://${h}`);

function onHosts(url: unknown, hosts: ReadonlySet<string>): boolean {
	if (typeof url !== 'string') { return false; }
	try {
		const u = new URL(url);
		return u.protocol === 'https:' && hosts.has(u.hostname.replace(/^www\./, '')) && !u.username && !u.password;
	} catch {
		return false;
	}
}

export const safeLink = (url: unknown): boolean => onHosts(url, LINK_HOSTS);
export const safeImage = (url: unknown): boolean => onHosts(url, IMAGE_HOSTS);

/**
 * The notices in a feed, or undefined when it is not signed by the project. The signature covers the
 * notices and the time they were issued, so an older feed served again cannot bring back a message
 * that was taken down, and one dated more than an hour ahead is refused.
 */
export function verifyFeed(body: unknown, lastIssued = 0, now = Date.now(), key = KEY): Feed | undefined {
	const feed = body as { notices?: unknown; issued?: unknown; sig?: unknown };
	if (!feed || !Array.isArray(feed.notices) || typeof feed.sig !== 'string' || typeof feed.issued !== 'number') { return undefined; }
	if (feed.issued < lastIssued || feed.issued > now + 3600e3) { return undefined; }
	try {
		const signed = Buffer.from(JSON.stringify({ notices: feed.notices, issued: feed.issued }));
		return verify(null, signed, key, Buffer.from(feed.sig, 'base64')) ? { notices: feed.notices as Notice[], issued: feed.issued } : undefined;
	} catch {
		return undefined;
	}
}

const KINDS: ReadonlySet<string> = new Set(['tab', 'card', 'toast']);
const str = (v: unknown, max: number): boolean => v === undefined || (typeof v === 'string' && v.length <= max);

/** Well formed, with every link and image on an allowed site. A notice that is not is dropped whole. */
export function wellFormed(n: Notice): boolean {
	if (!n || typeof n.id !== 'string' || !n.id || n.id.length > 80 || !KINDS.has(n.kind)) { return false; }
	if (typeof n.title !== 'string' || !n.title || n.title.length > 140) { return false; }
	if (![n.body, n.extra, n.more, n.note].every(v => str(v, 600)) || !str(n.eyebrow, 80) || !str(n.tag, 24) || !str(n.pointsTitle, 60)) { return false; }
	if (n.points !== undefined && (!Array.isArray(n.points) || n.points.length > 9 || !n.points.every(p => p && str(p.title, 60) && str(p.text, 200) && typeof p.title === 'string'))) { return false; }
	if (n.brand !== undefined && (typeof n.brand.name !== 'string' || !str(n.brand.name, 40) || (n.brand.icon !== undefined && !safeImage(n.brand.icon)))) { return false; }
	if (n.image !== undefined && (!safeImage(n.image.url) || !str(n.image.caption, 160))) { return false; }
	if (n.action !== undefined && (typeof n.action.label !== 'string' || !str(n.action.label, 40) || !safeLink(n.action.url))) { return false; }
	return true;
}

/** The notices meant for this copy right now, in feed order, leaving out the ones already seen. */
export function visible(list: readonly Notice[], version: string, platform: NodeJS.Platform, seen: readonly string[], now = Date.now()): Notice[] {
	return list.filter(n =>
		wellFormed(n) && !seen.includes(n.id) &&
		(!n.from || !isNewer(n.from, version)) && (!n.to || !isNewer(version, n.to)) &&
		(!n.platforms || n.platforms.includes(platform)) &&
		(!n.after || Date.parse(n.after) <= now) && (!n.until || Date.parse(n.until) > now),
	);
}

/** Seen ids, kept short: ids that have left the feed are dropped once there are many. */
export function remember(seen: readonly string[], id: string, feed: readonly Notice[]): string[] {
	if (seen.includes(id)) { return [...seen]; }
	const live = seen.length > 150 ? seen.filter(s => feed.some(n => n.id === s)) : [...seen];
	return [...live, id].slice(-200);
}
