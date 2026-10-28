// Composer: @ mention popup, slash popup, mode menu, model menu.
async function chatFrame(page) {
	for (let i = 0; i < 40; i++) {
		for (const f of page.frames()) {
			if (await f.$('#root textarea').catch(() => null)) { return f; }
		}
		await new Promise(r => setTimeout(r, 500));
	}
	throw new Error('chat webview not found');
}
export default async ({ page, shot, sleep }) => {
	await page.keyboard.press('Meta+L');
	await sleep(1500);
	const frame = await chatFrame(page);
	const input = await frame.$('#root textarea');
	await input.click();
	await input.type('explain @mat');
	await sleep(1200);
	await shot('60-mention');
	await page.keyboard.press('Enter');
	await sleep(500);
	await shot('61-mention-picked');
	await input.fill('');
	await input.type('/');
	await sleep(1000);
	await shot('62-slash');
	await page.keyboard.press('Escape');
	await input.fill('');
	await page.keyboard.press('Meta+.');
	await sleep(600);
	await shot('63-mode-menu');
	await page.keyboard.press('Escape');
	const model = await frame.$('.oc-model-btn, button[aria-label*="Model"], button[title*="Model"]');
	if (model) { await model.click(); await sleep(700); await shot('64-model-menu'); }
};
