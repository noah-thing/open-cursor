// Cmd+K: select greet(), ask for a change, wait for the diff, screenshot, accept.
export default async ({ page, shot, sleep }) => {
	await page.keyboard.press('Meta+P');
	await sleep(400);
	await page.keyboard.type('math.ts');
	await sleep(500);
	await page.keyboard.press('Enter');
	await sleep(1200);
	// Select lines 5-7 (greet) via Go to Line, then shift-select.
	await page.keyboard.press('Control+G');
	await sleep(300);
	await page.keyboard.type('5');
	await page.keyboard.press('Enter');
	await sleep(300);
	await page.keyboard.press('Home');
	for (let i = 0; i < 3; i++) { await page.keyboard.press('Shift+ArrowDown'); }
	await page.keyboard.press('Meta+K');
	await sleep(800);
	await page.keyboard.type('use a template literal and return the greeting string instead of logging it');
	await shot('20-cmdk-typed');
	await page.keyboard.press('Enter');
	for (let i = 0; i < 24; i++) {
		await sleep(2500);
		const done = await page.$('.oc-inline-zone:not(.oc-generating) .oc-inline-btn.oc-primary');
		if (done && i > 0) { break; }
	}
	await sleep(800);
	await shot('21-cmdk-diff');
	await page.keyboard.press('Meta+Enter');
	await sleep(1000);
	await shot('22-cmdk-accepted');
};
