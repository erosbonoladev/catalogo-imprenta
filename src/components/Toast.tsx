import { useEffect } from "react";

interface Props {
  message: string;
  show: boolean;
  onHide: () => void;
}

export default function Toast({ message, show, onHide }: Props) {
  useEffect(() => {
    if (!show) return;
    const timer = setTimeout(onHide, 2500);
    return () => clearTimeout(timer);
  }, [show, onHide]);

  if (!show) return null;

  return (
    <div className="toast" role="status">
      {message}
    </div>
  );
}
