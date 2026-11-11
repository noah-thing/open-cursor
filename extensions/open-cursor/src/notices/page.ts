/*---------------------------------------------------------------------------------------------
 *  OpenCursor. MIT License.
 *  The page a 'tab' notice shows in an editor tab. Built from the notice's fields, every one escaped,
 *  in the editor's own theme colours so it reads as part of OpenCursor in light and dark.
 *--------------------------------------------------------------------------------------------*/

import { IMAGE_ORIGINS, type Notice } from './feed';

const esc = (s: string | undefined): string => (s ?? '').replace(/[&<>"']/g, c => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' })[c]!);

export function noticePage(n: Notice, cspSource: string, nonce: string): string {
	const csp = [
		'default-src \'none\'',
		`img-src ${cspSource} ${IMAGE_ORIGINS.join(' ')}`,
		`style-src 'nonce-${nonce}'`,
		`script-src 'nonce-${nonce}'`,
	].join('; ');
	const points = n.points?.length ? `
		<section class="why">${n.pointsTitle ? `<h2>${esc(n.pointsTitle)}</h2>` : ''}
			<div class="grid">${n.points.map(p => `<div class="f"><b>${esc(p.title)}</b><span>${esc(p.text)}</span></div>`).join('')}</div>
			${n.more ? `<p class="more">${esc(n.more)}</p>` : ''}
		</section>` : (n.more ? `<p class="more">${esc(n.more)}</p>` : '');
	const label = n.tag || n.eyebrow ? `<p class="tag">${n.tag ? `<span>${esc(n.tag)}</span>` : ''}${esc(n.eyebrow)}</p>` : '';
	return `<!DOCTYPE html><html lang="en"><head><meta charset="UTF-8">
<meta http-equiv="Content-Security-Policy" content="${csp}">
<meta name="viewport" content="width=device-width, initial-scale=1.0"><title>${esc(n.brand?.name ?? n.title)}</title>
<style nonce="${nonce}">
:root{--fg:var(--vscode-foreground);--dim:color-mix(in srgb,var(--fg) 64%,transparent);--faint:color-mix(in srgb,var(--fg) 42%,transparent);--line:color-mix(in srgb,var(--fg) 12%,transparent);--soft:color-mix(in srgb,var(--fg) 7%,transparent)}
*{box-sizing:border-box;margin:0}
body{background:var(--vscode-editor-background);color:var(--fg);font-family:var(--vscode-font-family);-webkit-font-smoothing:antialiased;padding:0}
.page{max-width:980px;margin:0 auto;padding:48px 48px 56px}
.hero{display:grid;grid-template-columns:minmax(0,1fr) minmax(0,.9fr);gap:40px;align-items:center}
.hero.solo{grid-template-columns:minmax(0,640px)}
.tag{display:inline-flex;align-items:center;gap:8px;height:24px;padding:0 9px 0 4px;border:1px solid var(--line);font:11px var(--vscode-editor-font-family),monospace;color:var(--dim)}
.tag span{background:var(--soft);color:var(--fg);padding:3px 6px}
h1{margin-top:16px;font-size:clamp(26px,3.4vw,34px);line-height:1.07;font-weight:650;letter-spacing:-.03em;text-wrap:balance}
.lede{margin-top:12px;color:var(--dim);font-size:14px;line-height:1.55;text-wrap:pretty}
.extra{margin-top:10px;font-size:14px;line-height:1.5;text-wrap:pretty}
.cta{display:flex;align-items:center;gap:16px;margin-top:22px;flex-wrap:wrap}
button.go{height:38px;padding:0 18px;border:0;border-radius:6px;background:var(--fg);color:var(--vscode-editor-background);font:600 13.5px var(--vscode-font-family);cursor:pointer;transition:opacity .15s}
button.go:hover{opacity:.88}
button.go:focus-visible{outline:2px solid var(--vscode-focusBorder);outline-offset:2px}
.note{font:11px/1.55 var(--vscode-editor-font-family),monospace;color:var(--faint);max-width:30ch}
figure{margin:0}
figure img{display:block;width:100%;border-radius:10px;box-shadow:0 0 0 1px var(--line),0 30px 60px -24px rgba(0,0,0,.55)}
figcaption{margin-top:9px;font:11px/1.5 var(--vscode-editor-font-family),monospace;color:var(--faint)}
.why{margin-top:44px}
.why h2{font:500 11px var(--vscode-editor-font-family),monospace;color:var(--faint);margin-bottom:12px}
.grid{display:grid;grid-template-columns:repeat(3,minmax(0,1fr));border-top:1px solid var(--line)}
.f{padding:16px 18px 18px 0;border-bottom:1px solid var(--line)}
.f:not(:nth-child(3n+1)){padding-left:18px;border-left:1px solid var(--line)}
.f b{display:block;font-size:14px;font-weight:600;margin-bottom:6px}
.f span{display:block;color:var(--dim);font-size:13px;line-height:1.5}
.more{margin-top:16px;color:var(--dim);font-size:13.5px}
.end{margin-top:28px;display:flex;justify-content:flex-end}
button.later{background:none;border:0;color:var(--faint);font:12.5px var(--vscode-font-family);cursor:pointer;padding:6px 2px}
button.later:hover{color:var(--fg)}
@media (max-width:760px){.page{padding:32px 24px 40px}.hero{grid-template-columns:1fr}.grid{grid-template-columns:1fr}.f:not(:nth-child(3n+1)){padding-left:0;border-left:0}}
</style></head><body><main class="page">
	<div class="hero${n.image ? '' : ' solo'}"><div>
		${label}
		<h1>${esc(n.title)}</h1>
		${n.body ? `<p class="lede">${esc(n.body)}</p>` : ''}
		${n.extra ? `<p class="extra">${esc(n.extra)}</p>` : ''}
		${n.action ? `<div class="cta"><button class="go" type="button" data-act="open">${esc(n.action.label)}</button>${n.note ? `<span class="note">${esc(n.note)}</span>` : ''}</div>` : ''}
	</div>${n.image ? `<figure><img src="${esc(n.image.url)}" alt="">${n.image.caption ? `<figcaption>${esc(n.image.caption)}</figcaption>` : ''}</figure>` : ''}</div>
	${points}
	<div class="end"><button class="later" type="button" data-act="close">Close</button></div>
</main>
<script nonce="${nonce}">
const vscode = acquireVsCodeApi();
for (const b of document.querySelectorAll('[data-act]')) b.addEventListener('click', () => vscode.postMessage({ type: b.dataset.act }));
</script></body></html>`;
}
