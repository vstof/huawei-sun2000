// -----------------------------------------------------------------------------
// Barrel of the dashboard widgets: one module per widget, shared helpers.
// The integration entry point (index.js) only needs registerWidgets.
// -----------------------------------------------------------------------------

export { WIDGET_KEYS } from './shared.js';
export { overviewWidget } from './overview.js';
export { productionWidget, handleProductionAction, resetProductionStateForTests, setProductionRefresh } from './production.js';
export { stringsWidget, handleStringsAction, resetStringsStateForTests, setStringsRefresh } from './lines.js';

import { WIDGET_KEYS } from './shared.js';
import { overviewWidget } from './overview.js';
import { productionWidget, handleProductionAction, resetProductionStateForTests, setProductionRefresh } from './production.js';
import { stringsWidget, handleStringsAction, resetStringsStateForTests, setStringsRefresh } from './lines.js';

export function resetNavStateForTests() {
  resetProductionStateForTests();
  resetStringsStateForTests();
}

export function registerWidgets(gladys) {
  gladys.onWidgetGet(WIDGET_KEYS.overview, (options) => overviewWidget(gladys, options ?? {}));
  gladys.onWidgetGet(WIDGET_KEYS.production, (options) => productionWidget(gladys, options ?? {}));
  gladys.onWidgetGet(WIDGET_KEYS.lines, (options) => stringsWidget(gladys, options ?? {}));
  setProductionRefresh(() => gladys.requestWidgetRefresh(WIDGET_KEYS.production));
  setStringsRefresh(() => gladys.requestWidgetRefresh(WIDGET_KEYS.lines));
  gladys.onWidgetAction(WIDGET_KEYS.production, (actionKey) => handleProductionAction(actionKey));
  gladys.onWidgetAction(WIDGET_KEYS.lines, (actionKey) => handleStringsAction(actionKey));
}