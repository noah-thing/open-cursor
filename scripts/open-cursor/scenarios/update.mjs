// Update: with a local feed that offers 0.1.1, Check for Updates, Update, Restart now. run-update.sh checks the result.
export default async ({ page, sleep, shot }) => {
	await sleep(4000);
	await page.keyboard.press("F1"); await sleep(500);
	await page.keyboard.type("Check for Updates"); await sleep(600);
	await page.keyboard.press("Enter");
	const update = page.locator(".notification-toast .monaco-button", { hasText: /^Update$/ }).first();
	await update.waitFor({ timeout: 30000 });
	console.log("notice:", (await page.locator(".notification-toast .notification-list-item-message").first().textContent())?.trim());
	await shot("u1-notice");
	await update.click();
	const restart = page.locator(".notification-toast .monaco-button", { hasText: /^Restart now$/ }).first();
	await restart.waitFor({ timeout: 180000 });
	console.log("ready:", (await page.locator(".notification-toast .notification-list-item-message").first().textContent())?.trim());
	console.log("status bar:", await page.locator(".statusbar-item", { hasText: "Restart to update" }).count());
	await shot("u2-ready");
	await restart.click();
	await sleep(3000);
};
