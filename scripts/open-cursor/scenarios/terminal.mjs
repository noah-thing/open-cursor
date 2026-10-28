// Terminal Cmd+K: describe a command, it lands in the prompt unexecuted.
export default async ({ page, shot, sleep }) => {
	await page.keyboard.press('Meta+Shift+P');
	await sleep(500);
	await page.keyboard.type('Terminal: Create New Terminal');
	await sleep(600);
	await page.keyboard.press('Enter');
	await sleep(3000);
	await page.click('.terminal-wrapper.active .xterm, .terminal .xterm');
	await sleep(500);
	await page.keyboard.press('Meta+K');
	await sleep(800);
	await page.keyboard.type('list all typescript files under src');
	await page.keyboard.press('Enter');
	await sleep(20000);
	await shot('70-terminal-cmdk');
	const text = await page.evaluate(() => document.querySelector('.terminal .xterm-rows, .xterm-accessibility-tree')?.textContent ?? '');
	console.log('terminal:', text.replace(/\s+/g, ' ').slice(-200));
};
