import { useState, useEffect } from 'react';
import { Pencil } from 'lucide-react';
import { Input } from './ui/input';
import { Tooltip, TooltipContent, TooltipProvider, TooltipTrigger } from './ui/tooltip';
import { Section, SectionHeader } from './ui/section';
import { cn } from '../lib/utils';
import { useWorkspaceStore } from '../stores/workspace-store';
import { vscode } from '../lib/vscode';

// Scaled iframe preview. The iframe renders the app at ~3× the banner's pixel
// size and is transform-scaled down so the preview reads like a desktop view
// shrunk into the sidebar. `pointer-events-none` keeps clicks flowing to the
// wrapping anchor; the anchor opens the URL full-size in a new tab.
// If the site blocks embedding (X-Frame-Options / frame-ancestors CSP), the
// iframe renders blank — the LIVE overlay still shows, and clicking still works.
const PREVIEW_SCALE = 0.3;
const PREVIEW_INVERSE_PCT = `${100 / PREVIEW_SCALE}%`;

function PreviewSection({ url, isOnline }: { url: string; isOnline: boolean }) {
  const { workspace, optimisticSetPort, portUpdateStatus } = useWorkspaceStore();
  const [isEditing, setIsEditing] = useState(false);
  const [editValue, setEditValue] = useState('');
  const [showSuccess, setShowSuccess] = useState(false);

  const currentPort = workspace?.exposedPort || 3000;

  useEffect(() => {
    if (portUpdateStatus === 'success') {
      setShowSuccess(true);
      const timer = setTimeout(() => setShowSuccess(false), 1500);
      return () => clearTimeout(timer);
    }
  }, [portUpdateStatus]);

  const handleEditClick = () => {
    setEditValue(currentPort.toString());
    setIsEditing(true);
    setShowSuccess(false);
  };

  const handlePortSave = () => {
    const port = parseInt(editValue, 10);
    if (!isNaN(port) && port >= 1024 && port <= 65535 && port !== currentPort) {
      optimisticSetPort(port);
      vscode.postMessage({ command: 'updatePreviewPort', port });
    }
    setIsEditing(false);
  };

  const handleKeyDown = (e: React.KeyboardEvent) => {
    if (e.key === 'Enter') handlePortSave();
    if (e.key === 'Escape') setIsEditing(false);
  };

  // Diagonal-stripe fallback shown when the app is offline.
  const stripesBg: React.CSSProperties = {
    backgroundImage:
      'repeating-linear-gradient(45deg, rgba(255,255,255,0.02) 0 10px, rgba(255,255,255,0.06) 10px 20px)',
  };

  // Halo so LIVE reads against any iframe content. text-shadow is per-glyph
  // and avoids the stacking-context weirdness that filter-based drop-shadows
  // can introduce when a subject sits over an iframe.
  const liveTextShadow =
    '0 0 3px rgba(0,0,0,0.95), 0 0 7px rgba(0,0,0,0.7), 0 1px 3px rgba(0,0,0,0.6)';
  const liveDotShadow = '0 0 5px 1px rgba(0,0,0,0.85)';

  return (
    <div className="overflow-hidden rounded-md border border-border">
      {/* Banner: entire area is the link. Live iframe preview when online,
          diagonal stripes otherwise. LIVE badge fades out on hover. */}
      {isOnline ? (
        <a
          href={url}
          target="_blank"
          rel="noopener noreferrer"
          className="group relative block aspect-[5/2] cursor-pointer overflow-hidden bg-muted"
        >
          <iframe
            src={url}
            title="App preview"
            scrolling="no"
            tabIndex={-1}
            aria-hidden="true"
            className="pointer-events-none absolute left-0 top-0 border-0"
            style={{
              width: PREVIEW_INVERSE_PCT,
              height: PREVIEW_INVERSE_PCT,
              transform: `scale(${PREVIEW_SCALE})`,
              transformOrigin: 'top left',
            }}
          />
          <div className="pointer-events-none absolute inset-0 bg-black/25 transition-opacity duration-200 group-hover:opacity-0" />
          <div className="pointer-events-none relative flex h-full items-center justify-center transition-opacity duration-200 group-hover:opacity-0">
            <div className="flex items-center gap-1.5">
              <span className="relative flex h-2 w-2">
                <span className="absolute inline-flex h-full w-full animate-ping rounded-full bg-success opacity-75" />
                <span
                  className="relative inline-flex h-2 w-2 rounded-full bg-success"
                  style={{ boxShadow: liveDotShadow }}
                />
              </span>
              <span
                className="text-xs font-bold tracking-widest text-success"
                style={{ textShadow: liveTextShadow }}
              >
                LIVE
              </span>
            </div>
          </div>
        </a>
      ) : (
        <div
          className="relative aspect-[5/2] overflow-hidden bg-muted"
          style={stripesBg}
        >
          <div className="relative flex h-full items-center justify-center">
            <span className="text-[11px] font-medium tracking-wider text-muted-foreground">
              Offline
            </span>
          </div>
        </div>
      )}

      {/* Body: URL + port editor. */}
      <div className="space-y-2 border-t border-border px-3 py-3">
        <a
          href={url}
          target="_blank"
          rel="noopener noreferrer"
          className="block truncate font-mono text-sm text-link hover:underline underline-offset-4"
        >
          {url.replace('https://', '')}
        </a>

        <div className="flex items-center gap-2 text-xs">
          <span className="text-muted-foreground">Port</span>
          {isEditing ? (
            <Input
              autoFocus
              value={editValue}
              onChange={(e) => setEditValue(e.target.value)}
              onBlur={handlePortSave}
              onKeyDown={handleKeyDown}
              className="h-6 w-[64px] rounded-sm px-1.5 py-0 text-center font-mono text-xs shadow-sm focus-visible:ring-1 focus-visible:ring-primary focus-visible:ring-offset-0"
            />
          ) : (
            <TooltipProvider>
              <Tooltip delayDuration={200}>
                <TooltipTrigger asChild>
                  <button
                    onClick={handleEditClick}
                    className={cn(
                      'inline-flex h-6 items-center rounded-sm border border-border bg-muted px-2 font-mono text-xs font-medium transition-colors hover:bg-accent',
                      showSuccess && 'bg-success/20 text-success border-success/30'
                    )}
                  >
                    {currentPort}
                  </button>
                </TooltipTrigger>
                <TooltipContent side="top" className="text-xs">
                  Change exposed port
                </TooltipContent>
              </Tooltip>
            </TooltipProvider>
          )}
          {!isEditing && (
            <button
              onClick={handleEditClick}
              className="text-muted-foreground hover:text-foreground"
              aria-label="Edit port"
            >
              <Pencil className="h-3 w-3" />
            </button>
          )}
        </div>
      </div>
    </div>
  );
}

export function WorkspaceInfo() {
  const { workspace } = useWorkspaceStore();
  if (!workspace?.isManaged || !workspace.previewUrl) return null;

  return (
    <Section>
      <SectionHeader title="Live URL" />
      <PreviewSection url={workspace.previewUrl} isOnline={workspace.previewPortOpen} />
    </Section>
  );
}
