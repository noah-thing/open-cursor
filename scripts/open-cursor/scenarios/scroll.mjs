// Scroll audit: in a small window, every page whose content runs past the view must scroll with the wheel.
async function frameWith(page, sel, tries = 60) {
	for (let i = 0; i < tries; i++) {
		for (const f of page.frames()) { if (await f.$(sel).catch(() => null)) { return f; } }
		await new Promise(r => setTimeout(r, 500));
	}
	throw new Error('frame not found: ' + sel);
}
const probe = f => f.evaluate(() => {
	const els = [document.documentElement, ...document.querySelectorAll('*')];
	const tops = els.map(e => e.scrollTop);
	let bottom = 0;
	for (const e of document.querySelectorAll('body *')) { const r = e.getBoundingClientRect(); if (r.height && getComputedStyle(e).visibility !== 'hidden') { bottom = Math.max(bottom, r.bottom); } }
	return { sum: tops.reduce((a, b) => a + b, 0), overflow: Math.round(bottom - innerHeight), h: innerHeight };
});
let failures = 0;
async function check(page, f, name, at) {
	const before = await probe(f);
	const box = await f.evaluate(sel => { const e = sel ? document.querySelector(sel) : document.body; const r = e.getBoundingClientRect(); return { x: r.left + r.width / 2, y: r.top + Math.min(r.height / 2, 200) }; }, at ?? null);
	const fr = await (await f.frameElement()).boundingBox();
	await page.mouse.move(fr.x + box.x, fr.y + box.y);
	await page.mouse.wheel(0, 700);
	await new Promise(r => setTimeout(r, 500));
	const after = await probe(f);
	const needs = before.overflow > 8;
	const moved = after.sum > before.sum;
	const ok = !needs || moved;
	if (!ok) { failures++; }
	console.log(`${ok ? 'ok  ' : 'FAIL'} ${name}: content past view ${before.overflow}px, wheel scrolled ${moved}`);
	// back to the top for the next check
	await f.evaluate(() => { for (const e of [document.documentElement, ...document.querySelectorAll('*')]) { if (e.scrollTop) { e.scrollTop = 0; } } });
}
export default async ({ app, page, sleep }) => {
	await app.evaluate(({ BrowserWindow }) => { const w = BrowserWindow.getAllWindows()[0]; w.setSize(1000, 560); });
	await sleep(1500);
	const chat = await frameWith(page, '.oc-app .oc-composer');
	await check(page, chat, 'chat start screen', '.oc-stage');
	await chat.click('.oc-model-chip'); await sleep(400);
	await check(page, chat, 'model menu', '.oc-menu-list');
	await page.keyboard.press('Escape'); await sleep(300);
	// Help home, then a long Help conversation
	await page.locator('.monaco-action-bar .action-label.codicon-question[aria-label^="Get Help"]').first().click();
	await sleep(1200);
	await check(page, chat, 'help start screen', '.oc-stage');
	for (const q of ['Where do I add an API key?', 'How do I get free models?', 'What do the four modes do?', 'How do I undo what the agent changed?', 'keyboard shortcuts', 'how do I add an MCP server']) {
		await chat.fill('.oc-composer textarea', q); await chat.press('.oc-composer textarea', 'Enter'); await sleep(700);
	}
	await page.keyboard.press('Escape'); await sleep(200);
	const help = await frameWith(page, '.oc-app .oc-composer');
	await help.evaluate(() => { const s = document.querySelector('.oc-scroll'); if (s) { s.scrollTop = 0; } });
	await check(page, help, 'long conversation', '.oc-scroll');
	// past chats list
	await page.keyboard.press('Meta+Alt+Quote').catch(() => {});
	await sleep(600);
	if (await chat.$('.oc-hist-scroll')) { await check(page, chat, 'past chats', '.oc-hist-scroll'); }
	// Free models with every card open
	await page.keyboard.press('Escape');
	await page.keyboard.press('Meta+Shift+P'); await sleep(400);
	await page.keyboard.type('Get Free Models'); await sleep(500); await page.keyboard.press('Enter');
	const fm = await frameWith(page, 'main.fm');
	await sleep(1000);
	for (const h of await fm.$$('.fm-card-head')) { await h.click(); await sleep(150); }
	await sleep(500);
	await check(page, fm, 'free models page', 'main.fm');
	// every settings section
	await page.keyboard.press('Meta+Shift+J');
	const st = await frameWith(page, '.st-nav');
	await sleep(800);
	const names = await st.$$eval('.st-nav-item', e => e.map(x => x.textContent.trim()));
	for (const n of names) {
		await st.locator('.st-nav-item', { hasText: n }).first().click(); await sleep(500);
		await check(page, st, 'settings: ' + n, '.st-main');
	}
	console.log('failures:', failures);
};
