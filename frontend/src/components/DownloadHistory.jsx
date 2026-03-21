import {
  Play,
  Download,
  Trash2,
  Clock,
  Video,
  Music,
  ExternalLink,
  FileAudio,
  FileVideo,
  RefreshCw,
} from "lucide-react";

function DownloadHistory({ downloads, apiUrl, onDelete, onPlay }) {
  const formatFileSize = (bytes) => {
    if (!bytes) return "Unknown";
    const sizes = ["B", "KB", "MB", "GB"];
    const i = Math.floor(Math.log(bytes) / Math.log(1024));
    return `${(bytes / Math.pow(1024, i)).toFixed(2)} ${sizes[i]}`;
  };

  const formatDate = (dateString) => {
    return new Date(dateString).toLocaleDateString();
  };

  const getTimeRemaining = (createdAt) => {
    const created = new Date(createdAt);
    const expires = new Date(created.getTime() + 24 * 60 * 60 * 1000);
    const now = new Date();
    const hoursLeft = Math.max(
      0,
      Math.floor((expires - now) / (1000 * 60 * 60)),
    );
    return hoursLeft;
  };

  const getFileType = (download) => {
    // Check explicit type first, then fall back to filename extension
    if (download.type === "audio") return "audio";
    if (download.type === "video" || download.type === "combined")
      return "video";

    // Fallback to filename extension check
    const isAudioFile = download.filename.match(
      /\.(mp3|m4a|ogg|opus|wav|flac)$/i,
    );
    return isAudioFile ? "audio" : "video";
  };

  if (downloads.length === 0) {
    return (
      <div className="history-section">
        <h2>Download History</h2>
        <div className="empty-history">
          No downloads yet. Start by entering a video URL above!
        </div>
      </div>
    );
  }

  return (
    <div className="history-section">
      <h2>Download History ({downloads.length})</h2>
      <div className="history-list">
        {downloads.map((download) => {
          const hoursLeft = getTimeRemaining(download.createdAt);
          const isExpired = hoursLeft === 0;
          const fileType = getFileType(download);
          const isAudio = fileType === "audio";
          const downloadUrl = `${apiUrl}/api/files/${download.downloadId}/${encodeURIComponent(download.filename)}?action=download`;

  const handleRedownload = (download) => {
    // Navigate to main download page with the URL pre-filled
    if (download.url) {
      // Store the URL in localStorage so the main component can pick it up
      localStorage.setItem('redownloadUrl', download.url);
      // Refresh the page to trigger a new download flow
      window.location.reload();
    }
  };

  return (
            <div
              key={download.downloadId}
              className={`history-item ${isExpired ? "expired" : ""}`}
            >
              {download.thumbnail ? (
                <div style={{ position: "relative" }}>
                  <img
                    src={download.thumbnail}
                    alt={download.title}
                    className="history-thumb"
                  />
                  {/* File type badge */}
                  <div
                    style={{
                      position: "absolute",
                      bottom: 4,
                      right: 4,
                      background: isAudio ? "#f59e0b" : "#3b82f6",
                      color: "white",
                      padding: "2px 6px",
                      borderRadius: 4,
                      fontSize: "0.7rem",
                      fontWeight: 600,
                      display: "flex",
                      alignItems: "center",
                      gap: 2,
                    }}
                  >
                    {isAudio ? (
                      <FileAudio size={10} />
                    ) : (
                      <FileVideo size={10} />
                    )}
                    {isAudio ? "AUDIO" : "VIDEO"}
                  </div>
                </div>
              ) : (
                <div
                  className="history-thumb"
                  style={{
                    background: "#f0f0f0",
                    display: "flex",
                    alignItems: "center",
                    justifyContent: "center",
                    position: "relative",
                  }}
                >
                  {isAudio ? (
                    <Music size={24} color="#999" />
                  ) : (
                    <Video size={24} color="#999" />
                  )}
                  {/* File type badge */}
                  <div
                    style={{
                      position: "absolute",
                      bottom: 4,
                      right: 4,
                      background: isAudio ? "#f59e0b" : "#3b82f6",
                      color: "white",
                      padding: "2px 6px",
                      borderRadius: 4,
                      fontSize: "0.7rem",
                      fontWeight: 600,
                      display: "flex",
                      alignItems: "center",
                      gap: 2,
                    }}
                  >
                    {isAudio ? "AUDIO" : "VIDEO"}
                  </div>
                </div>
              )}

              <div className="history-info">
                <h3 title={download.title}>{download.title}</h3>
                <p>
                  {formatFileSize(download.size)} •{" "}
                  {formatDate(download.createdAt)}
                </p>
                {/* File type indicator */}
                <p
                  style={{
                    color: isAudio ? "#f59e0b" : "#3b82f6",
                    fontSize: "0.8rem",
                    marginTop: 2,
                    display: "flex",
                    alignItems: "center",
                    gap: 4,
                  }}
                >
                  {isAudio ? <FileAudio size={12} /> : <FileVideo size={12} />}
                  {isAudio ? "Audio Only" : "Video"}
                </p>
                <p
                  style={{
                    color: isExpired ? "#dc2626" : hoursLeft < 4 ? "#f59e0b" : "#667eea",
                    fontSize: "0.8rem",
                    marginTop: 2,
                    display: "flex",
                    alignItems: "center",
                    gap: 4,
                  }}
                >
                  <Clock size={12} />
                  {isExpired ? "File expired - server cleaned up" : `${hoursLeft}h remaining`}
                </p>
                {/* Original URL link - always visible */}
                {download.url && (
                  <a
                    href={download.url}
                    target="_blank"
                    rel="noopener noreferrer"
                    style={{
                      color: "#667eea",
                      fontSize: "0.8rem",
                      marginTop: 4,
                      display: "inline-flex",
                      alignItems: "center",
                      gap: 4,
                      textDecoration: "none",
                    }}
                    onClick={(e) => e.stopPropagation()}
                  >
                    <ExternalLink size={12} />
                    Original Video
                  </a>
                )}
              </div>

              <div className="history-actions">
                {!isExpired ? (
                  <>
                    <button
                      onClick={() => onPlay(download)}
                      className="action-btn primary"
                      title="Play"
                    >
                      <Play size={14} />
                    </button>

                    <a
                      href={downloadUrl}
                      download={download.filename}
                      className="action-btn secondary"
                      title="Download"
                    >
                      <Download size={14} />
                    </a>
                  </>
                ) : (
                  <>
                    <button
                      onClick={() => handleRedownload(download)}
                      className="action-btn primary"
                      title="Re-download"
                      disabled={!download.url}
                    >
                      <RefreshCw size={14} />
                    </button>
                  </>
                )}

                {download.url && (
                  <a
                    href={download.url}
                    target="_blank"
                    rel="noopener noreferrer"
                    className="action-btn secondary"
                    title="Open Original"
                    onClick={(e) => e.stopPropagation()}
                  >
                    <ExternalLink size={14} />
                  </a>
                )}

                <button
                  onClick={() => onDelete(download.downloadId)}
                  className="action-btn danger"
                  title="Delete"
                >
                  <Trash2 size={14} />
                </button>
              </div>
            </div>
          );
        })}
      </div>
    </div>
  );
}

export default DownloadHistory;
