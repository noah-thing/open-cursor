// Free models: open from the model menu, a wrong key, one click OpenCode install, use a free model, the menu's Free section.
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
	await shot('m1-model-menu');
	console.log('menu sections:', JSON.stringify(await chat.$$eval('.oc-menu-section-title', e => e.map(x => x.textContent))));
	console.log('get row:', await chat.$eval('.oc-menu-item.is-connect .oc-menu-label', e => e.textContent).catch(() => 'none'));
	await chat.click('.oc-menu-footer.is-free');
	const fm = await frameWith(page, 'main.fm');
	await sleep(1200);
	await shot('m2-free-page');
	console.log('cards:', JSON.stringify(await fm.$$eval('.fm-card-name', e => e.map(x => x.textContent))));

	// a wrong Groq key, typed
	const groq = fm.locator('.fm-card', { hasText: 'Groq' }).first();
	await groq.locator('.fm-card-head').click();
	await sleep(500);
	await groq.locator('text=or type it').click();
	await groq.locator('input').fill('gsk_' + 'x'.repeat(48));
	await groq.locator('button[type=submit]').click();
	for (let i = 0; i < 40; i++) { if (await groq.locator('.fm-result').count()) { break; } await sleep(250); }
	console.log('wrong key says:', await groq.locator('.fm-result').textContent().catch(() => 'nothing'));
	await shot('m3-wrong-key');

	// one click OpenCode
	const t0 = Date.now();
	const get = fm.locator('.fm-hero button', { hasText: 'Get OpenCode' });
	if (await get.count()) {
		await get.click();
		await sleep(1500); await shot('m4-installing');
		for (let i = 0; i < 360; i++) { if (await fm.locator('.fm-hero .fm-status.is-on').count()) { break; } await sleep(500); }
		console.log('install took s:', Math.round((Date.now() - t0) / 1000), 'error:', await fm.locator('.fm-hero .fm-result').textContent().catch(() => 'none'));
	}
	await sleep(1500);
	await shot('m5-opencode-ready');
	const models = await fm.$$eval('.fm-model-name', e => e.map(x => x.textContent));
	console.log('opencode models:', JSON.stringify(models));
	if (models.length) {
		await fm.locator('.fm-model').first().click();
		await sleep(2500);
		await chat.fill('.oc-composer textarea', 'Reply with exactly three words: free model works');
		await chat.press('.oc-composer textarea', 'Enter');
		const t1 = Date.now();
		for (let i = 0; i < 240; i++) {
			if (await chat.evaluate(() => [...document.querySelectorAll('.oc-assistant')].pop()?.dataset.done === 'true')) { break; }
			await sleep(500);
		}
		console.log('answer in s:', Math.round((Date.now() - t1) / 1000), JSON.stringify(await chat.evaluate(() => [...document.querySelectorAll('.oc-assistant')].pop()?.textContent?.slice(0, 200))));
		console.log('chip:', await chat.$eval('.oc-model-chip', e => e.textContent));
		await shot('m6-answer');
		await chat.click('.oc-model-chip');
		await sleep(500);
		console.log('menu sections after:', JSON.stringify(await chat.$$eval('.oc-menu-section-title', e => e.map(x => x.textContent))));
		console.log('free tags:', await chat.$$eval('.oc-tag.is-free', e => e.length));
		await shot('m7-menu-free');
	}
};
