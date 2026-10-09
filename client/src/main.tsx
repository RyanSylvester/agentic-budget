import { StrictMode } from "react";
import { createRoot } from "react-dom/client";
import App from "./App";
import "./index.css";
import { applyTheme, savedTheme } from "./theme";

// Apply the saved theme before the first render so the app does not paint in
// the system theme and then flip.
applyTheme(savedTheme());

createRoot(document.getElementById("root")!).render(
  <StrictMode>
    <App />
  </StrictMode>
);

// Production builds only: the service worker caches the app shell so the
// installed app opens fast. Never in `vite dev`, where it would serve stale
// modules over hot reload.
if (import.meta.env.PROD && "serviceWorker" in navigator) {
  window.addEventListener("load", () => {
    navigator.serviceWorker.register("/sw.js").catch(() => {});
  });
}
