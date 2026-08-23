import { useCallback, useRef, useState, type DragEvent } from "react";
import {
  abortUpload,
  formatBytes,
  uploadResumable,
  type UploadHandle,
  type UploadProgress,
} from "./api";
import { useI18n } from "./i18n";

type Props = {
  onUploaded: () => void;
  /** Sans droits admin, seuls les sous-titres passent (regle du serveur). */
  subtitlesOnly?: boolean;
};

const VIDEO_EXT = /\.(mp4|webm|mkv|m4v)$/i;

export function UploadDropzone({ onUploaded, subtitlesOnly = false }: Props) {
  const { t, lang } = useI18n();
  const [dragging, setDragging] = useState(false);
  const [busy, setBusy] = useState(false);
  const [progress, setProgress] = useState<UploadProgress | null>(null);
  const [current, setCurrent] = useState<string | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [done, setDone] = useState<string | null>(null);
  const [failedQueue, setFailedQueue] = useState<File[] | null>(null);
  const handleRef = useRef<UploadHandle | null>(null);

  const handleFiles = useCallback(
    async (files: FileList | File[]) => {
      const list = [...files].filter(
        (f) => !subtitlesOnly || !VIDEO_EXT.test(f.name),
      );
      if (!list.length) {
        if (subtitlesOnly) setError(t("uploadVideoAdminOnly"));
        return;
      }
      setBusy(true);
      setError(null);
      setDone(null);
      setFailedQueue(null);
      const remaining = [...list];
      try {
        while (remaining.length) {
          const file = remaining[0];
          setCurrent(file.name);
          setProgress(null);
          const handle = uploadResumable(file, setProgress);
          handleRef.current = handle;
          await handle.promise;
          remaining.shift();
        }
        setDone(
          list.length === 1
            ? t("uploadAdded", { name: list[0].name })
            : t("uploadAddedMany", { n: list.length }),
        );
        onUploaded();
      } catch (err) {
        const msg = err instanceof Error ? err.message : t("uploadFailed");
        if (msg === "aborted") {
          setError(t("uploadCancelled"));
        } else {
          setError(msg);
          // La reprise repart de l'offset connu du serveur : rien n'est perdu.
          setFailedQueue(remaining);
        }
      } finally {
        handleRef.current = null;
        setBusy(false);
        setCurrent(null);
      }
    },
    [onUploaded, subtitlesOnly, t],
  );

  const onDrop = (e: DragEvent) => {
    e.preventDefault();
    setDragging(false);
    if (e.dataTransfer.files?.length) void handleFiles(e.dataTransfer.files);
  };

  const cancel = () => {
    handleRef.current?.abort();
    const name = current;
    if (name) void abortUpload(name).catch(() => undefined);
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
        <strong>{subtitlesOnly ? t("dropTitleSubs") : t("dropTitle")}</strong>
        <p>{subtitlesOnly ? t("dropHintSubs") : t("dropHint")}</p>
        {busy && current && (
          <div className="upload-progress">
            <span>
              {current} — {progress?.pct ?? 0}%
              {progress && progress.sent > 0 && (
                <span className="upload-detail">
                  {" "}
                  · {formatBytes(progress.sent)} / {formatBytes(progress.total)}
                  {progress.rate > 0 && ` · ${formatBytes(progress.rate)}/s`}
                  {progress.etaSeconds != null &&
                    ` · ${humanEta(progress.etaSeconds, lang)}`}
                </span>
              )}
            </span>
            <div className="upload-bar">
              <i style={{ width: `${progress?.pct ?? 0}%` }} />
            </div>
            <button type="button" className="ghost-btn" onClick={cancel}>
              {t("uploadCancel")}
            </button>
          </div>
        )}
        {error && <p className="error">{error}</p>}
        {failedQueue && failedQueue.length > 0 && (
          <button
            type="button"
            className="primary-btn"
            onClick={() => void handleFiles(failedQueue)}
          >
            {t("uploadResume")}
          </button>
        )}
        {done && <p className="ok-msg">{done}</p>}
      </div>
      <label className="ghost-btn dropzone-btn">
        {t("chooseFiles")}
        <input
          type="file"
          multiple
          accept={
            subtitlesOnly
              ? ".vtt,.srt,.ass,.ssa,text/vtt"
              : ".mp4,.webm,.mkv,.m4v,.vtt,.srt,.ass,.ssa,video/*,text/vtt"
          }
          hidden
          disabled={busy}
          onChange={(e) => {
            if (e.target.files) void handleFiles(e.target.files);
            e.target.value = "";
          }}
        />
      </label>
      {!subtitlesOnly && (
        <p className="dropzone-hint">
          {t("maxUpload", { size: formatBytes(20 * 1024 ** 3) })}
        </p>
      )}
    </div>
  );
}

function humanEta(seconds: number, lang: string): string {
  if (seconds < 60) return lang === "fr" ? `${seconds} s restantes` : `${seconds}s left`;
  const m = Math.round(seconds / 60);
  if (m < 60) return lang === "fr" ? `${m} min restantes` : `${m} min left`;
  const h = Math.floor(m / 60);
  const r = m % 60;
  return lang === "fr" ? `${h} h ${r} restantes` : `${h}h ${r}m left`;
}
