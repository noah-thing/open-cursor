// Start screen subscriptions block and the model menu opened from the middle of the window.
const chatFrame = async (page, sleep) => {
	for (let i = 0; i < 60; i++) { for (const f of page.frames()) { try { if (await f.$(".oc-app")) { return f; } } catch { /* detached */ } } await sleep(250); }
	throw new Error("chat frame not found");
};
export default async ({ page, shot, sleep }) => {
	await sleep(3500);
	const f = await chatFrame(page, sleep);
	const nc = await f.$("button[aria-label=\"New chat\"]") ?? await f.$(".oc-rail-new");
	await nc.click();
	await sleep(1500);
	await shot("c1-home");
	await f.click(".oc-model-chip");
	await sleep(500);
	await shot("c2-model-menu");
	const box = await f.evaluate(() => { const r = document.querySelector(".oc-model-menu").getBoundingClientRect(); return { top: Math.round(r.top), bottom: Math.round(r.bottom), h: innerHeight }; });
	console.log("menu box", JSON.stringify(box));
	await page.keyboard.press("Escape");
};
