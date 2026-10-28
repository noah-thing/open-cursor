/*---------------------------------------------------------------------------------------------
 *  Open Cursor. MIT License.
 *  Chat webview entry.
 *--------------------------------------------------------------------------------------------*/

import { createRoot } from 'react-dom/client';
import '../common/base.css';
import './chat.css';
import { App } from './App';

const root = document.getElementById('root');
if (root) {
	createRoot(root).render(<App />);
}
