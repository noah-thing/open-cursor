// Checkpoint: agent edits a file, user keeps it, then restores the checkpoint; the file must revert.
import fs from 'node:fs';
import path from 'node:path';

async function chatFrame(page) {
	for (let i = 0; i < 40; i++) {
		for (const f of page.frames()) {
			if (await f.$('#root textarea').catch(() => null)) { return f; }
		}
		await new Promise(r => setTimeout(r, 500));
	}
	throw new Error('chat webview not found');
}

export default async ({ page, shot, sleep, workspace }) => {
	const file = path.join(workspace, 'src/math.ts');
	const before = fs.readFileSync(file, 'utf8');
	await page.keyboard.press('Meta+L');
	await sleep(1500);
	const frame = await chatFrame(page);
	const input = await frame.$('#root textarea');
	await input.click();
	await input.type('Add a function square(x: number) that returns x * x at the end of src/math.ts.');
	await page.keyboard.press('Enter');
	for (let i = 0; i < 60; i++) {
		await sleep(3000);
		if (i > 1 && !(await frame.$('button[aria-label="Stop"]'))) { break; }
	}
	await sleep(1000);
	const keep = await frame.$('text=Keep all');
	if (keep) { await keep.click(); await sleep(800); }
	const afterEdit = fs.readFileSync(file, 'utf8');
	console.log('edited:', afterEdit !== before);
	const bubble = await frame.$('.oc-user-text');
	await bubble.hover();
	await sleep(300);
	await (await frame.$('button[aria-label="Restore checkpoint"]')).click();
	await sleep(400);
	await shot('50-restore-confirm');
	await (await frame.$('.oc-confirm .oc-btn.is-primary')).click();
	await sleep(2000);
	await page.keyboard.press('Meta+S');
	await sleep(500);
	const restored = fs.readFileSync(file, 'utf8');
	console.log('restored to original:', restored === before);
	await shot('51-restored');
};
