import { ArrowLeft } from 'lucide-react';
import { Sheet, SheetContent, SheetHeader, SheetTitle, SheetDescription } from './ui/sheet';
import { Button } from './ui/button';
import { ToolRow } from './tool-launcher';
import { useWorkspaceStore } from '../stores/workspace-store';

export function AiToolsSheet() {
  const { openSheet, setOpenSheet, workspace, getConnectedTools, getDisconnectedTools } =
    useWorkspaceStore();
  const open = openSheet === 'tools';

  if (!workspace) return null;

  const connected = getConnectedTools();
  const disconnected = getDisconnectedTools();

  return (
    <Sheet open={open} onOpenChange={(v) => setOpenSheet(v ? 'tools' : null)}>
      <SheetContent className="flex min-w-0 flex-col">
        <SheetHeader>
          <div className="flex items-center gap-2">
            <Button
              variant="ghost"
              size="icon"
              className="h-6 w-6"
              onClick={() => setOpenSheet(null)}
            >
              <ArrowLeft className="h-3.5 w-3.5" />
            </Button>
            <SheetTitle className="flex-1">AI Tools</SheetTitle>
          </div>
          <SheetDescription className="pl-8">
            Launch connected agents or sign in to more. All tools are built-in.
          </SheetDescription>
        </SheetHeader>

        <div className="flex-1 min-w-0 overflow-y-auto overflow-x-hidden">
          <div className="space-y-4 px-4 pb-4 [&>*:first-child]:mt-3">
            {connected.length > 0 && (
              <section className="space-y-1.5">
                <h4 className="text-[10px] font-semibold uppercase tracking-wider text-muted-foreground">
                  Connected ({connected.length})
                </h4>
                <div className="space-y-1">
                  {connected.map((t) => (
                    <ToolRow key={t.id} tool={t} />
                  ))}
                </div>
              </section>
            )}

            {disconnected.length > 0 && (
              <section className="space-y-1.5">
                <h4 className="text-[10px] font-semibold uppercase tracking-wider text-muted-foreground">
                  Available ({disconnected.length})
                </h4>
                <div className="space-y-1">
                  {disconnected.map((t) => (
                    <ToolRow key={t.id} tool={t} />
                  ))}
                </div>
              </section>
            )}
          </div>
        </div>
      </SheetContent>
    </Sheet>
  );
}
