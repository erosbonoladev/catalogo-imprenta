import { hasPermission, useAuth } from "../auth";
import { PERMISOS_BACKUPS } from "../types";
import { useTheme } from "../theme";
import UpdateChecker from "./UpdateChecker";
import barraLateralIcon from "../../Assets/barra-lateral.svg";
import usuarioIcon from "../../Assets/usuario.svg";
import estrellasIcon from "../../Assets/estrellas.svg";
import cierreSesionIcon from "../../Assets/cierre-de-sesion-de-usuario.svg";
import configuracionIcon from "../../Assets/configuracion.svg";

interface Props {
  open: boolean;
  onToggle: () => void;
  onConfiguraciones: () => void;
}

export default function Sidebar({ open, onToggle, onConfiguraciones }: Props) {
  const { user, logout } = useAuth();
  const { theme, toggleTheme } = useTheme();
  const isDark = theme === "dark";
  const showConfiguraciones =
    hasPermission(user, "configuraciones") || PERMISOS_BACKUPS.some((p) => hasPermission(user, p));

  return (
    <>
      <button
        type="button"
        className="sidebar-toggle"
        onClick={onToggle}
        title={open ? "Ocultar barra lateral" : "Mostrar barra lateral"}
        aria-label={open ? "Ocultar barra lateral" : "Mostrar barra lateral"}
        aria-expanded={open}
      >
        <img src={barraLateralIcon} alt="" aria-hidden="true" />
      </button>

      <aside className={`sidebar${open ? " sidebar-open" : ""}`} aria-hidden={!open}>
        <div className="sidebar-inner">
          <div className="sidebar-user">
            <div className="icon-badge sidebar-user-icon">
              <img src={usuarioIcon} alt="" aria-hidden="true" />
            </div>
            <span className="sidebar-user-name">{user?.username}</span>
          </div>

          <button
            type="button"
            className={`sidebar-item sidebar-theme-toggle${isDark ? " sidebar-theme-active" : ""}`}
            onClick={toggleTheme}
            aria-pressed={isDark}
          >
            <img src={estrellasIcon} alt="" aria-hidden="true" className="sidebar-item-icon" />
            <span>{isDark ? "Modo oscuro" : "Modo claro"}</span>
          </button>

          {/* Espacio reservado para futuras funcionalidades por usuario. */}
          <div className="sidebar-spacer" />

          <button type="button" className="sidebar-item sidebar-logout" onClick={logout}>
            <img
              src={cierreSesionIcon}
              alt=""
              aria-hidden="true"
              className="sidebar-item-icon"
            />
            <span>Cerrar sesión</span>
          </button>

          <div className="sidebar-bottom-group">
            {showConfiguraciones && (
              <button
                type="button"
                className="icon-btn sidebar-icon-btn"
                onClick={onConfiguraciones}
                title="Configuraciones"
                aria-label="Configuraciones"
              >
                <img src={configuracionIcon} alt="" aria-hidden="true" />
              </button>
            )}
            <UpdateChecker />
          </div>
        </div>
      </aside>

      {open && <div className="sidebar-backdrop" onClick={onToggle} />}
    </>
  );
}
