import { render } from "solid-js/web";
import { App } from "./App.tsx";
import { initTheme } from "./theme.ts";
import "./styles.css";
import { installBugReporting } from "./bugreport/bugreport.ts";
import { installInstrumentation } from "./instrument.ts";
import { activateExtensions, emitStart } from "./extensions.ts";
import { runStartup } from "./host.ts";
import { restorePlugins } from "./plugins/settings.ts";
import { endSplash, startSplash } from "./splash.ts";

// Splash screen (animated logo from the HTML): server gold sponsors, removed once the application is ready.
startSplash();
// Captures and bug log hooked up before anything else: startup errors are included too.
installInstrumentation();
installBugReporting();
activateExtensions();
emitStart();
// Modules' startup work (activation codes, local license) before applying the theme and before the first render.
await runStartup();
initTheme();
render(() => <App />, document.getElementById("app")!);
endSplash();
// Catalog plugins reactivated as in the last session.
void restorePlugins();
