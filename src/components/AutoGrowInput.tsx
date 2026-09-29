import { useEffect, useRef } from "react";
import type { KeyboardEvent } from "react";

interface Props {
  value: string;
  onChange: (value: string) => void;
  placeholder?: string;
  className?: string;
  multiline?: boolean;
  required?: boolean;
  // Se disparan antes del manejo interno (auto-alto, Enter) — usados por
  // PiezaNombreField para navegar el dropdown de coincidencias con el
  // teclado sin duplicar este componente.
  onKeyDown?: (e: KeyboardEvent<HTMLTextAreaElement>) => void;
  onFocus?: () => void;
  onBlur?: () => void;
}

export default function AutoGrowInput({
  value,
  onChange,
  placeholder,
  className,
  multiline = false,
  required,
  onKeyDown,
  onFocus,
  onBlur,
}: Props) {
  const ref = useRef<HTMLTextAreaElement>(null);

  useEffect(() => {
    const el = ref.current;
    if (!el) return;
    el.style.height = "auto";
    el.style.height = `${el.scrollHeight}px`;
  }, [value]);

  function handleKeyDown(e: KeyboardEvent<HTMLTextAreaElement>) {
    onKeyDown?.(e);
    if (!multiline && e.key === "Enter") {
      e.preventDefault();
    }
  }

  return (
    <textarea
      ref={ref}
      rows={1}
      className={className}
      value={value}
      placeholder={placeholder}
      required={required}
      onChange={(e) => onChange(e.target.value)}
      onKeyDown={handleKeyDown}
      onFocus={onFocus}
      onBlur={onBlur}
    />
  );
}
