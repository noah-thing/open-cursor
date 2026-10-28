export default async ({ page, sleep }) => {
	await sleep(2000);
	const items = await page.evaluate(() => [...document.querySelectorAll('.statusbar-item')].map(e => `${e.id} | ${e.getAttribute('aria-label')} | ${e.textContent}`));
	console.log(items.join('\n'));
};
