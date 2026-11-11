/*---------------------------------------------------------------------------------------------
 *  OpenCursor. MIT License.
 *  A message from the project feed, as a card above the composer. It shows once; either button
 *  takes it away for good. The link itself stays on the host, which checks it.
 *--------------------------------------------------------------------------------------------*/

import type { ReactElement } from 'react';
import type { NoticeCard as Card } from '../../../src/shared/protocol';
import { Icon } from '../common/icons';
import { post } from './host';

export function NoticeCard({ n, onDone }: { n: Card; onDone: () => void }): ReactElement {
	const act = (open: boolean): void => {
		post({ type: 'noticeAction', id: n.id, open });
		onDone();
	};
	return (
		<section className="oc-feedcard" aria-label={n.title}>
			{n.brand || n.eyebrow ? (
				<header className="oc-feedcard-head">
					{n.brand?.icon ? <img className="oc-feedcard-icon" src={n.brand.icon} alt="" /> : null}
					<span className="oc-feedcard-who">
						{n.brand ? <b>{n.brand.name}</b> : null}
						{n.eyebrow ? <span>{n.eyebrow}</span> : null}
					</span>
					<button type="button" className="oc-iconbtn oc-feedcard-x" aria-label="Close" title="Close" onClick={() => act(false)}>
						<Icon name="x" size={13} />
					</button>
				</header>
			) : null}
			<h3 className="oc-feedcard-title">{n.title}</h3>
			{n.body ? <p className="oc-feedcard-body">{n.body}</p> : null}
			{n.points?.length ? (
				<ul className="oc-feedcard-points">
					{n.points.map(p => (
						<li key={p.title}>
							<i aria-hidden="true"><Icon name="check" size={10} /></i>
							<span><b>{p.title}</b> {p.text}</span>
						</li>
					))}
				</ul>
			) : null}
			{n.more ? <p className="oc-feedcard-more">{n.more}</p> : null}
			{n.action ? <button type="button" className="oc-feedcard-go" onClick={() => act(true)}>{n.action}</button> : null}
			{n.note ? <p className="oc-feedcard-note">{n.note}</p> : null}
			{!n.brand && !n.eyebrow ? (
				<button type="button" className="oc-iconbtn oc-feedcard-x is-float" aria-label="Close" title="Close" onClick={() => act(false)}>
					<Icon name="x" size={13} />
				</button>
			) : null}
		</section>
	);
}
