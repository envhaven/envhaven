import * as React from 'react';
import { cn } from '../../lib/utils';

interface FooterChipProps extends React.ButtonHTMLAttributes<HTMLButtonElement> {
  icon?: React.ReactNode;
  variant?: 'default' | 'warning';
}

const FooterChip = React.forwardRef<HTMLButtonElement, FooterChipProps>(
  ({ className, icon, variant = 'default', children, ...props }, ref) => (
    <button
      ref={ref}
      className={cn(
        'inline-flex h-6 items-center gap-1 rounded-full px-2 text-[10px] transition-colors',
        variant === 'default' &&
          'text-muted-foreground hover:bg-accent hover:text-foreground',
        variant === 'warning' &&
          'bg-amber-500/10 text-amber-600 hover:bg-amber-500/20 dark:text-amber-400',
        className
      )}
      {...props}
    >
      {icon && <span className="flex h-3 w-3 shrink-0 items-center justify-center">{icon}</span>}
      {children}
    </button>
  )
);
FooterChip.displayName = 'FooterChip';

export { FooterChip };
