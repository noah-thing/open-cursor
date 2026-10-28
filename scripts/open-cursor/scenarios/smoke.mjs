// Smoke: chat panel renders, a file opens, Cmd+K box opens.
export default async ({ page, shot, sleep }) => {
	await sleep(3000);
	await shot('01-startup');
	await page.keyboard.press('Meta+P');
	await sleep(500);
	await page.keyboard.type('math.ts');
	await sleep(600);
	await page.keyboard.press('Enter');
	await sleep(1500);
	await page.keyboard.press('Meta+A');
	await page.keyboard.press('Meta+K');
	await sleep(1200);
	await shot('02-cmdk');
	await page.keyboard.press('Escape');
	await sleep(500);
	await page.keyboard.press('Meta+L');
	await sleep(1500);
	await shot('03-chat-with-selection');
};
