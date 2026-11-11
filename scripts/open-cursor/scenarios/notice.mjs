// Notice feed: wait for the feed read, capture whatever it shows.
export default async ({ page, shot, sleep }) => {
	await sleep(16000);
	await shot(process.env.OC_SHOT_NAME || '90-notice');
	const frames = [];
	for (const f of page.frames()) {
		const t = await f.evaluate(() => [document.title, document.querySelector('h1')?.textContent ?? '', document.querySelector('.oc-feedcard-title')?.textContent ?? ''].join(' | ')).catch(() => '');
		if (t.replace(/[ |]/g, '')) frames.push(t);
	}
	console.log('FRAMES ' + JSON.stringify(frames));
};
