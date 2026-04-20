import * as React from 'react';
import { cn } from '../../lib/utils';

interface RowProps extends Omit<React.HTMLAttributes<HTMLDivElement>, 'children'> {
  leading?: React.ReactNode;
  label: React.ReactNode;
  trailing?: React.ReactNode;
  bordered?: boolean;
  interactive?: boolean;
}

const Row = React.forwardRef<HTMLDivElement, RowProps>(
  ({ className, leading, label, trailing, bordered, interactive = true, ...props }, ref) => (
    <div
      ref={ref}
      className={cn(
        'group flex h-8 items-center gap-2 rounded-md px-2',
        interactive && 'cursor-pointer hover:bg-accent',
        bordered && 'border border-border bg-muted/30',
        className
      )}
      {...props}
    >
      {leading && <div className="flex shrink-0 items-center">{leading}</div>}
      <div className="flex-1 min-w-0 truncate text-sm">{label}</div>
      {trailing && <div className="flex shrink-0 items-center gap-1">{trailing}</div>}
    </div>
  )
);
Row.displayName = 'Row';

export { Row };
