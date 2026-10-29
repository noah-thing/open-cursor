async function frameWith(page, sel, tries = 60) {
	for (let i = 0; i < tries; i++) { for (const f of page.frames()) { if (await f.$(sel).catch(() => null)) { return f; } } await new Promise(r => setTimeout(r, 500)); }
	throw new Error('frame not found: ' + sel);
}
export default async ({ page, sleep, shot }) => {
	const chat = await frameWith(page, '.oc-app .oc-composer');
	const tag = process.env.OC_TAG ?? 'dark';
	if (await chat.$('.oc-help-back')) { await chat.click('.oc-help-back'); await sleep(800); }
	await chat.locator('button[aria-label="New chat"], button:has-text("New chat")').first().click(); await sleep(900);
	for (const label of ['Agent', 'Plan', 'Debug', 'Ask']) {
		await chat.click('.oc-mode-chip'); await sleep(400);
		await chat.click(`.oc-mode-menu .oc-menu-item:has-text("${label}")`); await sleep(300);
		await chat.click('.oc-input'); await sleep(400);
		const ring = await chat.$eval('.oc-composer', el => getComputedStyle(el).boxShadow);
		console.log(tag, label, ring);
		await shot(`ring-${tag}-${label.toLowerCase()}`);
	}
};
