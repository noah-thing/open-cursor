/*---------------------------------------------------------------------------------------------
 *  OpenCursor. MIT License.
 *  Core side of OpenCursor: inline diff review, the Cmd+K box, and workbench defaults that give
 *  the editor its AI-first layout. Everything else lives in extensions/open-cursor.
 *--------------------------------------------------------------------------------------------*/

import './openCursorDiff.js';
import './openCursorInlineEdit.js';
import { Registry } from '../../../../platform/registry/common/platform.js';
import { Extensions as ConfigurationExtensions, IConfigurationRegistry } from '../../../../platform/configuration/common/configurationRegistry.js';

Registry.as<IConfigurationRegistry>(ConfigurationExtensions.Configuration).registerDefaultConfigurations([{
	overrides: {
		// The built-in Copilot chat stack is replaced by OpenCursor's own agent.
		'chat.disableAIFeatures': true,
		'workbench.activityBar.location': 'top',
		// The chat is the only thing in the secondary side bar, so its one-icon tab strip goes away.
		'workbench.activityBar.autoHide': true,
		// Motion everywhere the workbench offers it: lists, the terminal and the caret glide instead of jumping.
		'workbench.list.smoothScrolling': true,
		'terminal.integrated.smoothScrolling': true,
		'editor.cursorBlinking': 'smooth',
		// Flat, edge to edge panels instead of floating cards.
		'window.density.layout': 'compact',
		'workbench.secondarySideBar.defaultVisibility': 'visible',
		'workbench.startupEditor': 'none',
		'workbench.tips.enabled': false,
		'window.commandCenter': true,
		'editor.inlineSuggest.enabled': true,
		'editor.inlineSuggest.edits.showCollapsed': false,
		'editor.minimap.enabled': false,
		'editor.fontSize': 13,
		'editor.lineHeight': 1.6,
		'editor.cursorSmoothCaretAnimation': 'on',
		'editor.smoothScrolling': true,
		'terminal.integrated.fontSize': 12,
		'telemetry.telemetryLevel': 'off',
		'extensions.ignoreRecommendations': false,
	}
}]);
