// Settings: open the OpenCursor settings page and capture a few sections.
async function settingsFrame(page) {
	for (let i = 0; i < 40; i++) {
		for (const f of page.frames()) {
			const t = await f.evaluate(() => document.title).catch(() => '');
			if (await f.$('#root nav, #root [role="navigation"], #root .oc-settings-nav').catch(() => null)) { return f; }
		}
		await new Promise(r => setTimeout(r, 500));
	}
	return undefined;
}
export default async ({ page, shot, sleep }) => {
	await page.keyboard.press('Meta+Shift+J');
	await sleep(3000);
	await shot('40-settings');
	const f = await settingsFrame(page);
	if (!f) { console.log('settings frame not found'); return; }
	for (const name of ['Models', 'Subscriptions', 'MCP']) {
		const btn = await f.$(`text=${name}`);
		if (btn) { await btn.click(); await sleep(1500); await shot(`41-settings-${name.toLowerCase()}`); }
	}
};
