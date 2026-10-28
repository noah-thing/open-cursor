// Start screen, the glide into a conversation, and the working state.
const chatFrame = async (page, sleep) => {
	for (let i = 0; i < 60; i++) {
		for (const f of page.frames()) {
			try { if (await f.$(".oc-app")) { return f; } } catch { /* detached */ }
		}
		await sleep(250);
	}
	throw new Error("chat frame not found");
};
export default async ({ page, shot, sleep }) => {
	await sleep(3000);
	const f = await chatFrame(page, sleep);
	await f.click("button[aria-label=\"New chat\"]");
	await sleep(1200);
	await shot("h1-home");
	if (process.env.OC_PROMPT === "none") { return; }
	await f.click(".oc-input");
	await page.keyboard.type(process.env.OC_PROMPT ?? "In src/math.ts add a function cube(n) that returns n * n * n. Keep it short.");
	await sleep(300);
	await shot("h2-typed");
	await page.keyboard.press("Enter");
	await sleep(120); await shot("h3-t120");
	await sleep(200); await shot("h4-t320");
	await sleep(400); await shot("h5-t720");
	await sleep(3000); await shot("h6-working");
	await sleep(6000); await shot("h7-working");
	for (let i = 0; i < 90; i++) { if (!(await f.$(".oc-working"))) { break; } await sleep(2000); }
	await sleep(800);
	await shot("h8-done");
};
