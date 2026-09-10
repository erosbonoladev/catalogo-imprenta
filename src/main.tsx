import React from "react";
import ReactDOM from "react-dom/client";
import App from "./App";
import { AuthProvider } from "./auth";
import { ThemeProvider } from "./theme";
import { UpdateProvider } from "./updateContext";

ReactDOM.createRoot(document.getElementById("root") as HTMLElement).render(
  <React.StrictMode>
    <ThemeProvider>
      <UpdateProvider>
        <AuthProvider>
          <App />
        </AuthProvider>
      </UpdateProvider>
    </ThemeProvider>
  </React.StrictMode>,
);
