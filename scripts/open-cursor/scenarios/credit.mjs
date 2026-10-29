async function frameWith(page, sel, tries = 60) {
	for (let i = 0; i < tries; i++) { for (const f of page.frames()) { if (await f.$(sel).catch(() => null)) { return f; } } await new Promise(r => setTimeout(r, 500)); }
	throw new Error('frame not found: ' + sel);
}
export default async ({ page, sleep, shot }) => {
	const chat = await frameWith(page, '.oc-app .oc-composer');
	if (await chat.$('.oc-help-back')) { await chat.click('.oc-help-back'); await sleep(800); }
	await chat.locator('button[aria-label="New chat"], button:has-text("New chat")').first().click(); await sleep(1200);
	console.log('home credit:', await chat.$eval('.oc-credit', e => e.innerText.replace(/\s+/g, ' ')).catch(() => 'none'));
	await chat.hover('.oc-credit-x'); await sleep(300);
	await shot('c1-home');
	await page.locator('.monaco-action-bar .action-label[aria-label^="Get Help"] >> visible=true').first().click(); await sleep(1500);
	console.log('help credit:', !!(await chat.$('.oc-help-bottom .oc-credit, .oc-credit')));
	await shot('c2-help');
	await page.keyboard.press('Meta+Shift+J'); await sleep(3000);
	const st = await frameWith(page, '.st-nav');
	console.log('settings credit:', await st.$eval('.oc-credit', e => e.innerText.replace(/\s+/g, ' ')).catch(() => 'none'));
	await shot('c3-settings');
	await page.setViewportSize({ width: 1440, height: 900 }).catch(() => {});
};
