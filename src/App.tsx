import { useState } from "react";
import "./App.css";
import SearchScreen from "./components/SearchScreen";
import ProductDetail from "./components/ProductDetail";
import ProductForm from "./components/ProductForm";
import PasswordGate from "./components/PasswordGate";
import PlasticosSection from "./components/PlasticosSection";
import ImprentaSection from "./components/ImprentaSection";
import AdminSettings from "./components/AdminSettings";
import { SECCION_ADMIN, SECCION_IMPRENTA, SECCION_PLASTICOS } from "./types";

type PrivadoDestino = "plasticos" | "imprenta";

type View =
  | { name: "search" }
  | { name: "detail"; productId: number }
  | { name: "form"; productId?: number }
  | { name: "gate"; productId: number; destino: PrivadoDestino }
  | { name: "plasticos"; productId: number }
  | { name: "imprenta"; productId: number }
  | { name: "admin-gate" }
  | { name: "admin" };

function App() {
  const [view, setView] = useState<View>({ name: "search" });

  return (
    <main className="app">
      {view.name === "search" && (
        <SearchScreen
          onSelect={(id) => setView({ name: "detail", productId: id })}
          onNew={() => setView({ name: "form" })}
          onAdmin={() => setView({ name: "admin-gate" })}
        />
      )}

      {view.name === "detail" && (
        <ProductDetail
          productId={view.productId}
          onBack={() => setView({ name: "search" })}
          onEdit={(id) => setView({ name: "form", productId: id })}
          onDeleted={() => setView({ name: "search" })}
          onOpenPlasticos={(id) =>
            setView({ name: "gate", productId: id, destino: "plasticos" })
          }
          onOpenImprenta={(id) =>
            setView({ name: "gate", productId: id, destino: "imprenta" })
          }
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

      {view.name === "gate" && (
        <PasswordGate
          section={view.destino === "plasticos" ? SECCION_PLASTICOS : SECCION_IMPRENTA}
          onUnlock={() => {
            if (view.destino === "plasticos") {
              setView({ name: "plasticos", productId: view.productId });
            } else {
              setView({ name: "imprenta", productId: view.productId });
            }
          }}
          onCancel={() => setView({ name: "detail", productId: view.productId })}
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

      {view.name === "admin-gate" && (
        <PasswordGate
          section={SECCION_ADMIN}
          onUnlock={() => setView({ name: "admin" })}
          onCancel={() => setView({ name: "search" })}
        />
      )}

      {view.name === "admin" && (
        <AdminSettings onBack={() => setView({ name: "search" })} />
      )}
    </main>
  );
}

export default App;
