/*---------------------------------------------------------------------------------------------
 *  OpenCursor. MIT License.
 *  Settings webview entry.
 *--------------------------------------------------------------------------------------------*/

import { createRoot } from 'react-dom/client';
import '../common/base.css';
import './settings.css';
import { App } from './App';

const root = document.getElementById('root');
if (root) {
	createRoot(root).render(<App />);
}
