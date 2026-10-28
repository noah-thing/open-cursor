/*---------------------------------------------------------------------------------------------
 *  OpenCursor. MIT License.
 *  Free models page entry.
 *--------------------------------------------------------------------------------------------*/

import { createRoot } from 'react-dom/client';
import '../common/base.css';
import './free.css';
import { App } from './App';

const root = document.getElementById('root');
if (root) {
	createRoot(root).render(<App />);
}
