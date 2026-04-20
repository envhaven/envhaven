import * as React from 'react';
import { cn } from '../../lib/utils';
import { Button } from './button';
import { Tooltip, TooltipContent, TooltipProvider, TooltipTrigger } from './tooltip';

export interface IconButtonProps extends React.ButtonHTMLAttributes<HTMLButtonElement> {
  tooltip: string;
  tooltipSide?: 'top' | 'right' | 'bottom' | 'left';
  size?: 'sm' | 'md';
}

const SIZE_CLASSES: Record<NonNullable<IconButtonProps['size']>, string> = {
  sm: 'h-5 w-5',
  md: 'h-7 w-7',
};

const IconButton = React.forwardRef<HTMLButtonElement, IconButtonProps>(
  ({ className, tooltip, tooltipSide, size = 'md', children, ...props }, ref) => (
    <TooltipProvider>
      <Tooltip>
        <TooltipTrigger asChild>
          <Button
            ref={ref}
            variant="ghost"
            size="icon"
            className={cn(SIZE_CLASSES[size], 'shrink-0', className)}
            {...props}
          >
            {children}
          </Button>
        </TooltipTrigger>
        <TooltipContent side={tooltipSide}>{tooltip}</TooltipContent>
      </Tooltip>
    </TooltipProvider>
  )
);
IconButton.displayName = 'IconButton';

export { IconButton };
