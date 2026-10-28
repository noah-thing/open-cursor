// Help: open it from the chat header, check the start screen, ask a question, and see the page it opens.
async function chatFrame(page) {
	for (let i = 0; i < 60; i++) {
		for (const f of page.frames()) {
			if (await f.$('.oc-app .oc-help-btn').catch(() => null)) { return f; }
		}
		await new Promise(r => setTimeout(r, 500));
	}
	throw new Error('chat frame not found');
}
const tabs = page => page.$$eval('.tabs-container .tab .label-name, .tabs-container .tab .monaco-icon-label', els => els.map(e => e.textContent.trim()).filter(Boolean));

export default async ({ page, shot, sleep }) => {
	const f = await chatFrame(page);
	await f.click('.oc-help-btn >> visible=true');
	await sleep(1200);
	await shot('h1-help-home');
	const state = await f.evaluate(() => ({
		isHelp: document.querySelector('.oc-app')?.classList.contains('is-help'),
		chip: document.querySelector('.oc-help-chip')?.textContent,
		questions: [...document.querySelectorAll('.oc-help-q')].length,
		jumps: [...document.querySelectorAll('.oc-help-jump')].map(b => b.textContent),
		placeholder: document.querySelector('.oc-composer textarea')?.getAttribute('placeholder'),
	}));
	console.log('home', JSON.stringify(state));

	// A jump needs no model.
	if (await f.$('.oc-help-jump')) { await f.click('.oc-help-jump >> nth=1'); }
	await sleep(2000);
	console.log('after jump, tabs:', JSON.stringify(await tabs(page)));
	await shot('h2-jump-models');

	const question = process.env.OC_PROMPT || 'Where do I add an API key?';
	await f.fill('.oc-composer textarea', question);
	await f.press('.oc-composer textarea', 'Enter');
	await sleep(1500);
	await shot('h3-working');
	for (let i = 0; i < 180; i++) {
		const done = await f.evaluate(() => { const a = [...document.querySelectorAll('.oc-assistant')].pop(); return a?.dataset.done === 'true'; });
		if (done) { break; }
		await sleep(1000);
	}
	await sleep(800);
	const answer = await f.evaluate(() => {
		const a = [...document.querySelectorAll('.oc-assistant')].pop();
		return {
			text: a?.querySelector('.oc-md')?.textContent?.slice(0, 600),
			jumped: [...(a?.querySelectorAll('.oc-help-jumped-title') ?? [])].map(e => e.textContent),
			links: [...(a?.querySelectorAll('.oc-go') ?? [])].map(e => e.getAttribute('data-help') + ' ' + e.textContent),
			tools: [...(a?.querySelectorAll('.oc-tool .oc-row-title') ?? [])].map(e => e.textContent),
			error: a?.querySelector('.oc-error')?.textContent,
		};
	});
	console.log('answer', JSON.stringify(answer, null, 1));
	console.log('tabs now:', JSON.stringify(await tabs(page)));
	await shot('h4-answer');
	await page.keyboard.press('Escape'); await sleep(400);
	const go = await f.$('.oc-go');
	if (go) { await go.click(); await sleep(1500); console.log('after link, tabs:', JSON.stringify(await tabs(page))); await shot('h5-link'); }
	await f.hover('.oc-help-chip');
	await shot('h6-chip-hover');
};
