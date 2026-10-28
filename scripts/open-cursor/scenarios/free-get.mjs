// Model menu "Get" on OpenCode: one click opens Free models and installs it.
async function frameWith(page, sel, tries = 60) {
	for (let i = 0; i < tries; i++) {
		for (const f of page.frames()) { if (await f.$(sel).catch(() => null)) { return f; } }
		await new Promise(r => setTimeout(r, 500));
	}
	throw new Error('frame not found: ' + sel);
}
export default async ({ page, shot, sleep }) => {
	const chat = await frameWith(page, '.oc-app .oc-composer');
	await chat.click('.oc-model-chip');
	await sleep(500);
	console.log('not connected rows:', JSON.stringify(await chat.$$eval('.oc-menu-item.is-connect .oc-menu-label', e => e.map(x => x.textContent))));
	await shot('g1-menu');
	await chat.locator('.oc-menu-item.is-connect', { hasText: 'OpenCode' }).click();
	const t0 = Date.now();
	const fm = await frameWith(page, 'main.fm');
	await sleep(800); await shot('g2-installing');
	console.log('installing shown:', await fm.locator('.fm-hero button', { hasText: 'Installing' }).count());
	for (let i = 0; i < 360; i++) { if (await fm.locator('.fm-hero .fm-status.is-on').count()) { break; } await sleep(500); }
	console.log('ready after s:', Math.round((Date.now() - t0) / 1000), 'models:', await fm.locator('.fm-model').count());
	await shot('g3-ready');
};
