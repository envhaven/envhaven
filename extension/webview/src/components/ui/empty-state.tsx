import * as React from 'react';
import { cn } from '../../lib/utils';

interface EmptyStateProps extends React.HTMLAttributes<HTMLDivElement> {
  icon?: React.ReactNode;
  title?: string;
  description?: string;
  action?: React.ReactNode;
  compact?: boolean;
}

const EmptyState = React.forwardRef<HTMLDivElement, EmptyStateProps>(
  ({ className, icon, title, description, action, compact, ...props }, ref) => {
    if (compact) {
      return (
        <div
          ref={ref}
          className={cn('text-xs text-muted-foreground', className)}
          {...props}
        >
          {title ?? description}
        </div>
      );
    }
    return (
      <div
        ref={ref}
        className={cn(
          'flex flex-col items-center gap-2 rounded-md border border-dashed border-border/50 px-4 py-6 text-center',
          className
        )}
        {...props}
      >
        {icon && <div className="text-muted-foreground">{icon}</div>}
        {title && (
          <p className="text-[11px] font-medium text-foreground">{title}</p>
        )}
        {description && (
          <p className="text-[11px] text-muted-foreground">{description}</p>
        )}
        {action && <div className="pt-1">{action}</div>}
      </div>
    );
  }
);
EmptyState.displayName = 'EmptyState';

export { EmptyState };
