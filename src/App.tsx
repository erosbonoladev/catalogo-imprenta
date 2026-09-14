import { useEffect, useState } from "react";
import "./App.css";
import SearchScreen from "./components/SearchScreen";
import ProductDetail from "./components/ProductDetail";
import ProductForm from "./components/ProductForm";
import PlasticosSection from "./components/PlasticosSection";
import PiezasGeneralSection from "./components/PiezasGeneralSection";
import PiezaDetalleScreen from "./components/PiezaDetalleScreen";
import ImprentaSection from "./components/ImprentaSection";
import MaderasSection from "./components/MaderasSection";
import Configuraciones from "./components/Configuraciones";
import LoginScreen from "./components/LoginScreen";
import Sidebar from "./components/Sidebar";
import NavigationBar from "./components/NavigationBar";
import RemisionesSection from "./components/RemisionesSection";
import SkuMasterSection from "./components/SkuMasterSection";
import DailyBackupPrompt from "./components/DailyBackupPrompt";
import { useAuth } from "./auth";
import type { SearchFilter } from "./types";

type View =
  | { name: "search" }
  | { name: "detail"; productId: number }
  | { name: "form"; productId?: number }
  | { name: "plasticos"; productId: number }
  | { name: "piezasGeneral" }
  | { name: "piezaDetalle"; plasticProductId: number }
  | { name: "imprenta"; productId: number }
  | { name: "maderas"; productId: number }
  | { name: "configuraciones" }
  | { name: "remisiones" }
  | { name: "skuMaster" };

interface SearchState {
  query: string;
  filter: SearchFilter;
  page: number;
}

const HOME_VIEW: View = { name: "search" };
const BLANK_SEARCH: SearchState = { query: "", filter: "todo", page: 1 };

function viewNoun(v: View): string {
  switch (v.name) {
    case "search":
      return "el catálogo";
    case "detail":
      return "la ficha técnica";
    case "form":
      return "el formulario";
    case "plasticos":
      return "las piezas";
    case "piezasGeneral":
      return "Piezas General";
    case "piezaDetalle":
      return "la pieza";
    case "imprenta":
      return "Imprenta";
    case "maderas":
      return "Maderas";
    case "configuraciones":
      return "Configuraciones";
    case "remisiones":
      return "Remisiones";
    case "skuMaster":
      return "SKU Master";
  }
}

function App() {
  const { user, loading } = useAuth();
  const [history, setHistory] = useState<{ stack: View[]; index: number }>({
    stack: [HOME_VIEW],
    index: 0,
  });
  const [dirty, setDirty] = useState(false);
  const [searchState, setSearchState] = useState<SearchState>(BLANK_SEARCH);
  const [sidebarOpen, setSidebarOpen] = useState(true);

  const view = history.stack[history.index];
  const prevView = history.index > 0 ? history.stack[history.index - 1] : null;
  const nextView = history.index < history.stack.length - 1 ? history.stack[history.index + 1] : null;

  useEffect(() => {
    setHistory({ stack: [HOME_VIEW], index: 0 });
    setDirty(false);
    setSearchState(BLANK_SEARCH);
  }, [user?.id]);

  function confirmLeave(): boolean {
    return !dirty || confirm("Hay cambios sin guardar. ¿Salir de todas formas?");
  }

  function navigate(next: View) {
    if (!confirmLeave()) return;
    setDirty(false);
    setHistory((h) => {
      const stack = h.stack.slice(0, h.index + 1).concat(next);
      return { stack, index: stack.length - 1 };
    });
  }

  function goBack() {
    if (history.index <= 0 || !confirmLeave()) return;
    setDirty(false);
    setHistory((h) => ({ ...h, index: h.index - 1 }));
  }

  function goForward() {
    if (history.index >= history.stack.length - 1 || !confirmLeave()) return;
    setDirty(false);
    setHistory((h) => ({ ...h, index: h.index + 1 }));
  }

  function goToCatalogo() {
    if (!confirmLeave()) return;
    setDirty(false);
    setSearchState(BLANK_SEARCH);
    setHistory((h) => {
      if (h.stack[h.index].name === "search") return h;
      const stack = h.stack.slice(0, h.index + 1).concat(HOME_VIEW);
      return { stack, index: stack.length - 1 };
    });
  }

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

  const backTitle = prevView
    ? view.name === "form"
      ? "Cancelar"
      : `Volver a ${viewNoun(prevView)}`
    : null;
  const forwardTitle = nextView ? `Ir a ${viewNoun(nextView)}` : null;

  return (
    <div className="app-shell">
      <DailyBackupPrompt />
      <Sidebar
        open={sidebarOpen}
        onToggle={() => setSidebarOpen((o) => !o)}
        onCatalogo={goToCatalogo}
        onConfiguraciones={() => navigate({ name: "configuraciones" })}
        onRemisiones={() => navigate({ name: "remisiones" })}
        onPiezasGeneral={() => navigate({ name: "piezasGeneral" })}
        onSkuMaster={() => navigate({ name: "skuMaster" })}
      />
      <NavigationBar
        canGoBack={history.index > 0}
        canGoForward={history.index < history.stack.length - 1}
        backTitle={backTitle}
        forwardTitle={forwardTitle}
        onBack={goBack}
        onForward={goForward}
      />

      <main className="app app-content">
        {view.name === "search" && (
          <SearchScreen
            query={searchState.query}
            filter={searchState.filter}
            page={searchState.page}
            onQueryChange={(query) => setSearchState((s) => ({ ...s, query }))}
            onFilterChange={(filter) => setSearchState((s) => ({ ...s, filter, page: 1 }))}
            onPageChange={(page) => setSearchState((s) => ({ ...s, page }))}
            onSelect={(id) => navigate({ name: "detail", productId: id })}
            onNew={() => navigate({ name: "form" })}
          />
        )}

        {view.name === "detail" && (
          <ProductDetail
            productId={view.productId}
            onEdit={(id) => navigate({ name: "form", productId: id })}
            onDeleted={() => navigate({ name: "search" })}
            onOpenPlasticos={(id) => navigate({ name: "plasticos", productId: id })}
            onOpenImprenta={(id) => navigate({ name: "imprenta", productId: id })}
            onOpenMaderas={(id) => navigate({ name: "maderas", productId: id })}
          />
        )}

        {view.name === "form" && (
          <ProductForm
            productId={view.productId}
            onDone={(id) => navigate({ name: "detail", productId: id })}
            onCancel={goBack}
            onDirtyChange={setDirty}
          />
        )}

        {view.name === "plasticos" && (
          <PlasticosSection productId={view.productId} onDirtyChange={setDirty} />
        )}

        {view.name === "piezasGeneral" && (
          <PiezasGeneralSection
            onVerPieza={(id) => navigate({ name: "piezaDetalle", plasticProductId: id })}
          />
        )}

        {view.name === "piezaDetalle" && (
          <PiezaDetalleScreen
            plasticProductId={view.plasticProductId}
            onBack={goBack}
            onOpenProduct={(productId) => navigate({ name: "detail", productId })}
          />
        )}

        {view.name === "imprenta" && (
          <ImprentaSection productId={view.productId} onDirtyChange={setDirty} />
        )}

        {view.name === "maderas" && (
          <MaderasSection
            productId={view.productId}
            onDirtyChange={setDirty}
            onOpenPiezas={() => navigate({ name: "plasticos", productId: view.productId })}
          />
        )}

        {view.name === "configuraciones" && <Configuraciones />}

        {view.name === "remisiones" && <RemisionesSection />}

        {view.name === "skuMaster" && (
          <SkuMasterSection
            onOpenProduct={(id) => navigate({ name: "detail", productId: id })}
            onOpenPieza={(id) => navigate({ name: "piezaDetalle", plasticProductId: id })}
          />
        )}
      </main>
    </div>
  );
}

export default App;
