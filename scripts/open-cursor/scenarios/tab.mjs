// Tab: type the start of a function and wait for a ghost-text suggestion, then accept it.
export default async ({ page, shot, sleep }) => {
	await page.keyboard.press('Meta+P');
	await sleep(400);
	await page.keyboard.type('math.ts');
	await sleep(500);
	await page.keyboard.press('Enter');
	await sleep(1500);
	await page.keyboard.press('Meta+ArrowDown');
	await page.keyboard.press('Enter');
	await page.keyboard.type('export function divide(a: number, b: number) {', { delay: 30 });
	await page.keyboard.press('Enter');
	let ghost = null;
	for (let i = 0; i < 20 && !ghost; i++) {
		await sleep(500);
		ghost = await page.$('.ghost-text-decoration, .ghost-text');
	}
	await shot('30-tab-ghost');
	console.log('ghost text visible:', !!ghost);
	await page.keyboard.press('Tab');
	await sleep(500);
	await shot('31-tab-accepted');
	const text = await page.evaluate(() => [...document.querySelectorAll('.view-lines .view-line')].map(l => l.textContent).join('\n'));
	console.log(text);
};
