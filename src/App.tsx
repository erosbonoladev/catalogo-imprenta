import { useEffect, useState } from "react";
import "./App.css";
import SearchScreen from "./components/SearchScreen";
import ProductDetail from "./components/ProductDetail";
import ProductForm from "./components/ProductForm";
import PlasticosSection from "./components/PlasticosSection";
import ImprentaSection from "./components/ImprentaSection";
import Configuraciones from "./components/Configuraciones";
import LoginScreen from "./components/LoginScreen";
import Sidebar from "./components/Sidebar";
import { useAuth } from "./auth";

type View =
  | { name: "search" }
  | { name: "detail"; productId: number }
  | { name: "form"; productId?: number }
  | { name: "plasticos"; productId: number }
  | { name: "imprenta"; productId: number }
  | { name: "configuraciones" };

function App() {
  const { user, loading } = useAuth();
  const [view, setView] = useState<View>({ name: "search" });
  const [sidebarOpen, setSidebarOpen] = useState(true);

  useEffect(() => {
    setView({ name: "search" });
  }, [user?.id]);

  if (loading) {
    return (
      <main className="app">
        <p className="hint">Cargando…</p>
      </main>
    );
  }

  if (!user) {
    return (
      <main className="app app-login">
        <LoginScreen />
      </main>
    );
  }

  return (
    <div className="app-shell">
      <Sidebar
        open={sidebarOpen}
        onToggle={() => setSidebarOpen((o) => !o)}
        onConfiguraciones={() => setView({ name: "configuraciones" })}
      />

      <main className="app app-content">
        {view.name === "search" && (
          <SearchScreen
            onSelect={(id) => setView({ name: "detail", productId: id })}
            onNew={() => setView({ name: "form" })}
          />
        )}

        {view.name === "detail" && (
          <ProductDetail
            productId={view.productId}
            onBack={() => setView({ name: "search" })}
            onEdit={(id) => setView({ name: "form", productId: id })}
            onDeleted={() => setView({ name: "search" })}
            onOpenPlasticos={(id) => setView({ name: "plasticos", productId: id })}
            onOpenImprenta={(id) => setView({ name: "imprenta", productId: id })}
          />
        )}

        {view.name === "form" && (
          <ProductForm
            productId={view.productId}
            onDone={(id) => setView({ name: "detail", productId: id })}
            onCancel={() =>
              setView(
                view.productId
                  ? { name: "detail", productId: view.productId }
                  : { name: "search" },
              )
            }
          />
        )}

        {view.name === "plasticos" && (
          <PlasticosSection
            productId={view.productId}
            onBack={() => setView({ name: "detail", productId: view.productId })}
          />
        )}

        {view.name === "imprenta" && (
          <ImprentaSection
            productId={view.productId}
            onBack={() => setView({ name: "detail", productId: view.productId })}
          />
        )}

        {view.name === "configuraciones" && (
          <Configuraciones onBack={() => setView({ name: "search" })} />
        )}
      </main>
    </div>
  );
}

export default App;
