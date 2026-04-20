import * as React from 'react';
import { cn } from '../../lib/utils';

const Section = React.forwardRef<HTMLDivElement, React.HTMLAttributes<HTMLDivElement>>(
  ({ className, ...props }, ref) => (
    <section ref={ref} className={cn('space-y-2', className)} {...props} />
  )
);
Section.displayName = 'Section';

interface SectionHeaderProps extends React.HTMLAttributes<HTMLDivElement> {
  title: string;
  action?: React.ReactNode;
}

const SectionHeader = React.forwardRef<HTMLDivElement, SectionHeaderProps>(
  ({ className, title, action, ...props }, ref) => (
    <div
      ref={ref}
      className={cn('flex h-6 items-center justify-between', className)}
      {...props}
    >
      <h3 className="text-[11px] font-semibold uppercase tracking-wide text-section-header">
        {title}
      </h3>
      {action && <div className="flex items-center gap-1">{action}</div>}
    </div>
  )
);
SectionHeader.displayName = 'SectionHeader';

interface SectionBodyProps extends React.HTMLAttributes<HTMLDivElement> {
  maxHeight?: string;
}

const SectionBody = React.forwardRef<HTMLDivElement, SectionBodyProps>(
  ({ className, maxHeight, style, ...props }, ref) => (
    <div
      ref={ref}
      className={cn('space-y-1', maxHeight && 'overflow-y-auto', className)}
      style={maxHeight ? { maxHeight, ...style } : style}
      {...props}
    />
  )
);
SectionBody.displayName = 'SectionBody';

export { Section, SectionHeader, SectionBody };
