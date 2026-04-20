import { cva, type VariantProps } from 'class-variance-authority';
import { cn } from '../../lib/utils';

const statusDotVariants = cva('inline-block h-2 w-2 shrink-0 rounded-full', {
  variants: {
    variant: {
      success: 'bg-success',
      warn: 'bg-amber-500',
      error: 'bg-destructive',
      idle: 'bg-muted-foreground/40',
    },
  },
  defaultVariants: {
    variant: 'idle',
  },
});

export interface StatusDotProps
  extends React.HTMLAttributes<HTMLSpanElement>,
    VariantProps<typeof statusDotVariants> {}

function StatusDot({ className, variant, ...props }: StatusDotProps) {
  return <span className={cn(statusDotVariants({ variant }), className)} {...props} />;
}

export { StatusDot };
