// Help flow: open from the title button, time an instant answer, leave with Esc.
async function chatFrame(page) {
	for (let i = 0; i < 60; i++) {
		for (const f of page.frames()) { if (await f.$('.oc-app .oc-composer').catch(() => null)) { return f; } }
		await new Promise(r => setTimeout(r, 500));
	}
	throw new Error('chat frame not found');
}
export default async ({ page, shot, sleep }) => {
	const f = await chatFrame(page);
	await shot('f0-before');
	// a profile that was left inside Help shows Leave Help in that spot: leave first
	const leave = page.locator('.monaco-action-bar .action-label[aria-label^="Leave Help"]').first();
	if (await leave.isVisible().catch(() => false)) { await leave.click(); await new Promise(r => setTimeout(r, 900)); }
	const btn = page.locator('.monaco-action-bar .action-label.codicon-question[aria-label^="Get Help"]').first();
	console.log('title button visible:', await btn.isVisible().catch(() => false));
	await btn.click();
	await sleep(140); await shot('f1-mid-transition');
	await sleep(700); await shot('f2-help');
	console.log('leave button in title:', await page.locator('.action-label.codicon-question[aria-label^="Leave Help"]').first().isVisible().catch(() => false));
	console.log('help bar:', await f.$eval('.oc-help-back', e => e.textContent).catch(() => 'none'));
	const t0 = Date.now();
	await f.fill('.oc-composer textarea', 'Where can I add APIs?');
	await f.press('.oc-composer textarea', 'Enter');
	for (let i = 0; i < 300; i++) {
		if (await f.evaluate(() => [...document.querySelectorAll('.oc-assistant')].pop()?.dataset.done === 'true')) { break; }
		await sleep(100);
	}
	console.log('answered in ms:', Date.now() - t0);
	console.log('answer:', await f.evaluate(() => [...document.querySelectorAll('.oc-assistant')].pop()?.textContent?.slice(0, 200)));
	await sleep(600); await shot('f3-answer');
	await f.click('.oc-composer textarea');
	await page.keyboard.press('Escape');
	await sleep(140); await shot('f4-leaving');
	await sleep(800); await shot('f5-left');
	console.log('still help after Esc:', await f.evaluate(() => document.querySelector('.oc-app')?.classList.contains('is-help')));
};
