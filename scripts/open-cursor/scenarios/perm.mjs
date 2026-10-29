import * as fs from 'fs';
import * as path from 'path';
async function frameWith(page, sel, tries = 60) {
	for (let i = 0; i < tries; i++) { for (const f of page.frames()) { if (await f.$(sel).catch(() => null)) { return f; } } await new Promise(r => setTimeout(r, 500)); }
	throw new Error('frame not found: ' + sel);
}
export default async ({ page, sleep, shot, workspace }) => {
	const chat = await frameWith(page, '.oc-app .oc-composer');
	if (await chat.$('.oc-help-back')) { await chat.click('.oc-help-back'); await sleep(800); }
	await chat.locator('button[aria-label="New chat"], button:has-text("New chat")').first().click(); await sleep(900);
	await shot('perm-1-chip');
	await chat.click('.oc-perm-chip'); await sleep(500);
	await shot('perm-2-menu');
	await chat.click('.oc-perm-menu .oc-menu-item.is-auto'); await sleep(900);
	console.log('chip after Auto:', await chat.$eval('.oc-perm-chip', e => e.textContent));
	await chat.click('.oc-perm-chip'); await sleep(300);
	await chat.click('.oc-perm-menu .oc-menu-item.is-always'); await sleep(700);
	console.log('chip after Full:', await chat.$eval('.oc-perm-chip', e => e.textContent));
	await shot('perm-3-full');
	// Ask mode hides it
	await chat.click('.oc-mode-chip'); await sleep(300);
	await chat.click('.oc-mode-menu .oc-menu-item.is-ask'); await sleep(400);
	console.log('chip in Ask mode:', !!(await chat.$('.oc-perm-chip')));
	await chat.click('.oc-mode-chip'); await sleep(300);
	await chat.click('.oc-mode-menu .oc-menu-item.is-agent'); await sleep(400);
	// back to Auto and run a real turn: touch should run on its own, rm should wait
	await chat.click('.oc-perm-chip'); await sleep(300);
	await chat.click('.oc-perm-menu .oc-menu-item.is-auto'); await sleep(700);
	const root = workspace ?? process.env.OC_WS;
	if (root) { fs.writeFileSync(path.join(root, 'oc-probe.txt'), 'keep\n'); try { fs.unlinkSync(path.join(root, 'oc-made.txt')); } catch { } }
	await chat.fill('.oc-input', 'Use run_terminal_cmd for each, one call at a time: first `touch oc-made.txt`, then `rm oc-probe.txt`. Set requires_approval honestly for each.');
	await chat.press('.oc-input', 'Enter');
	for (let i = 0; i < 120; i++) { await sleep(1000); if (await chat.$('.oc-approval')) { break; } }
	const card = await chat.$('.oc-approval-cmd');
	console.log('approval card:', card ? await card.textContent() : 'none');
	if (root) { console.log('made exists:', fs.existsSync(path.join(root, 'oc-made.txt')), 'probe exists:', fs.existsSync(path.join(root, 'oc-probe.txt'))); }
	await shot('perm-4-approval');
	const skip = await chat.$('.oc-approval button:has-text("Skip")'); if (skip) { await skip.click(); await sleep(1500); }
};
