// Agent turn: ask the chat to change a file, wait for the run to finish, screenshot the review.
const PROMPT = process.env.OC_PROMPT ?? 'In src/math.ts add a function `multiply(a: number, b: number)` below add, with a one line JSDoc comment. Keep the rest unchanged.';

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
	await page.keyboard.press('Meta+P');
	await sleep(400);
	await page.keyboard.type('math.ts');
	await sleep(500);
	await page.keyboard.press('Enter');
	await sleep(1200);
	await page.keyboard.press('Meta+L');
	await sleep(1500);
	const frame = await chatFrame(page);
	const input = await frame.$('#root textarea');
	await input.click();
	await input.type(PROMPT);
	await shot('10-agent-typed');
	await page.keyboard.press('Enter');
	const deadline = Date.now() + Number(process.env.OC_TIMEOUT ?? 240000);
	let n = 0;
	while (Date.now() < deadline) {
		await sleep(5000);
		if (n++ % 4 === 0) { await shot(`11-agent-progress-${n}`); }
		const running = await frame.$('[data-running="true"], .is-running, button[aria-label="Stop"], button[title^="Stop"]').catch(() => null);
		if (!running && n > 1) { break; }
	}
	await sleep(1500);
	await shot('12-agent-done');
	const text = await frame.evaluate(() => document.querySelector('#root')?.innerText ?? '');
	console.log('--- chat text ---\n' + text.slice(-3000));
};
