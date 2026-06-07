import React from "react";
import { createRoot } from "react-dom/client";
import { AppShell } from "./ui/AppShell";
import { WorkbenchProvider } from "./ui/store/WorkbenchContext";
import { i18n, initTheme } from "./i18n";
import "./ui/styles/tokens.css";
import "./ui/styles/shell.css";

// Apply theme synchronously to avoid FOUC.
initTheme();

const rootElement = document.getElementById("root");

if (!rootElement) {
  throw new Error("Root element was not found.");
}

createRoot(rootElement).render(
  <React.StrictMode>
    <WorkbenchProvider>
      <AppShell />
    </WorkbenchProvider>
  </React.StrictMode>,
);

void i18n;
