/**
 * The network a rate limit counts against. IPv4 stays as is. An IPv6 address is cut to its /64, because one
 * subscriber usually owns a whole /64 and could otherwise rotate through it to dodge the limit.
 */
export function ipBucket(ip: string): string {
	let a = ip.trim().toLowerCase().replace(/%.*$/, '');
	const mapped = /^(?:0{0,4}:){0,5}:?ffff:(\d{1,3}(?:\.\d{1,3}){3})$/.exec(a);
	if (mapped) { return mapped[1]; }
	if (!a.includes(':')) { return a; }
	// a trailing dotted IPv4 takes the place of the last two groups
	const v4 = /^(.*:)(\d{1,3})\.(\d{1,3})\.(\d{1,3})\.(\d{1,3})$/.exec(a);
	if (v4) { a = v4[1] + ((+v4[2] << 8) | +v4[3]).toString(16) + ':' + ((+v4[4] << 8) | +v4[5]).toString(16); }
	const [head, tail] = a.split('::');
	const h = head ? head.split(':') : [];
	const t = tail === undefined ? [] : tail ? tail.split(':') : [];
	const groups = tail === undefined ? h : [...h, ...Array<string>(Math.max(0, 8 - h.length - t.length)).fill('0'), ...t];
	if (groups.length !== 8 || groups.some(g => !/^[0-9a-f]{1,4}$/.test(g))) { return ip; }
	return groups.slice(0, 4).map(g => g.replace(/^0+(?=.)/, '')).join(':') + '::/64';
}
