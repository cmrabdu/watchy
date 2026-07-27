import { useCallback, useState, type DragEvent } from "react";
import { formatBytes, uploadFile } from "./api";
import { useI18n } from "./i18n";

type Props = {
  onUploaded: () => void;
};

export function UploadDropzone({ onUploaded }: Props) {
  const { t } = useI18n();
  const [dragging, setDragging] = useState(false);
  const [busy, setBusy] = useState(false);
  const [progress, setProgress] = useState(0);
  const [current, setCurrent] = useState<string | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [done, setDone] = useState<string | null>(null);

  const handleFiles = useCallback(
    async (files: FileList | File[]) => {
      const list = [...files];
      if (!list.length) return;
      setBusy(true);
      setError(null);
      setDone(null);
      try {
        for (const file of list) {
          setCurrent(file.name);
          setProgress(0);
          await uploadFile(file, setProgress);
        }
        setDone(
          list.length === 1
            ? t("uploadAdded", { name: list[0].name })
            : t("uploadAddedMany", { n: list.length }),
        );
        onUploaded();
      } catch (err) {
        setError(err instanceof Error ? err.message : t("uploadFailed"));
      } finally {
        setBusy(false);
        setCurrent(null);
        setProgress(0);
      }
    },
    [onUploaded, t],
  );

  const onDrop = (e: DragEvent) => {
    e.preventDefault();
    setDragging(false);
    if (e.dataTransfer.files?.length) void handleFiles(e.dataTransfer.files);
  };

  return (
    <div
      className={`dropzone ${dragging ? "is-dragging" : ""} ${busy ? "is-busy" : ""}`}
      onDragEnter={(e) => {
        e.preventDefault();
        setDragging(true);
      }}
      onDragOver={(e) => {
        e.preventDefault();
        setDragging(true);
      }}
      onDragLeave={(e) => {
        e.preventDefault();
        setDragging(false);
      }}
      onDrop={onDrop}
    >
      <div className="dropzone-copy">
        <strong>{t("dropTitle")}</strong>
        <p>{t("dropHint")}</p>
        {busy && current && (
          <div className="upload-progress">
            <span>
              {current} — {progress}%
            </span>
            <div className="upload-bar">
              <i style={{ width: `${progress}%` }} />
            </div>
          </div>
        )}
        {error && <p className="error">{error}</p>}
        {done && <p className="ok-msg">{done}</p>}
      </div>
      <label className="ghost-btn dropzone-btn">
        {t("chooseFiles")}
        <input
          type="file"
          multiple
          accept=".mp4,.webm,.mkv,.m4v,.vtt,.srt,video/*,text/vtt"
          hidden
          disabled={busy}
          onChange={(e) => {
            if (e.target.files) void handleFiles(e.target.files);
            e.target.value = "";
          }}
        />
      </label>
      <p className="dropzone-hint">{t("maxUpload", { size: formatBytes(20 * 1024 ** 3) })}</p>
    </div>
  );
}
