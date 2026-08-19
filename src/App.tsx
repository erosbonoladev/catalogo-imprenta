import { useState } from "react";
import "./App.css";
import SearchScreen from "./components/SearchScreen";
import ProductDetail from "./components/ProductDetail";
import ProductForm from "./components/ProductForm";

type View =
  | { name: "search" }
  | { name: "detail"; productId: number }
  | { name: "form"; productId?: number };

function App() {
  const [view, setView] = useState<View>({ name: "search" });

  return (
    <main className="app">
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
    </main>
  );
}

export default App;
