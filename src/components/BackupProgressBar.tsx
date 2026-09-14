import type { BackupProgress } from "../db";

interface Props {
  progress: BackupProgress | null;
}

export default function BackupProgressBar({ progress }: Props) {
  if (!progress) return null;
  return (
    <div className="import-progress">
      <p className="hint" style={{ margin: 0 }}>
        {progress.detail}
      </p>
      <div className="progress-bar">
        <div className="progress-bar-fill" style={{ width: `${progress.percent}%` }} />
      </div>
    </div>
  );
}
