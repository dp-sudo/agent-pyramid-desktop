import { lazy, Suspense, type ReactElement } from "react";
import { useWorkbench } from "./store/WorkbenchContext";

const Workbench = lazy(() =>
  import("./Workbench").then((module) => ({ default: module.Workbench })),
);

const SettingsView = lazy(() =>
  import("./SettingsView").then((module) => ({ default: module.SettingsView })),
);

function RouteFallback(): ReactElement {
  return <div className="ds-route-fallback" />;
}

export function AppShell(): ReactElement {
  const { state } = useWorkbench();

  return (
    <div className="ds-workbench-shell">
      <Suspense fallback={<RouteFallback />}>
        {state.route === "code" || state.route === "write" ? <Workbench /> : null}
        {state.route === "settings" ? <SettingsView /> : null}
      </Suspense>
    </div>
  );
}
