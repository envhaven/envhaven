import * as React from 'react';
import {
  AI_TOOL_ICONS,
  type ToolIconData,
  type ToolIconPrimitive,
  type ToolId,
} from '../../../../platform-tool-catalog.generated';
import { cn } from '../lib/utils';

interface IconProps {
  className?: string;
}

function paint(value: string | undefined, gradientId: string): string | undefined {
  return value === '$gradient' ? `url(#${gradientId})` : value;
}

function renderPrimitive(
  primitive: ToolIconPrimitive,
  key: React.Key,
  gradientId: string,
): React.ReactNode {
  switch (primitive.type) {
    case 'path':
      return (
        <path
          key={key}
          d={primitive.d}
          fill={paint(primitive.fill, gradientId)}
          fillRule={primitive.fillRule}
          clipRule={primitive.clipRule}
          stroke={paint(primitive.stroke, gradientId)}
          strokeWidth={primitive.strokeWidth}
          strokeLinecap={primitive.strokeLinecap}
          strokeLinejoin={primitive.strokeLinejoin}
          transform={primitive.transform}
        />
      );
    case 'rect':
      return (
        <rect
          key={key}
          x={primitive.x}
          y={primitive.y}
          width={primitive.width}
          height={primitive.height}
          rx={primitive.rx}
          fill={paint(primitive.fill, gradientId)}
          stroke={paint(primitive.stroke, gradientId)}
          strokeWidth={primitive.strokeWidth}
          transform={primitive.transform}
        />
      );
    case 'circle':
      return (
        <circle
          key={key}
          cx={primitive.cx}
          cy={primitive.cy}
          r={primitive.r}
          fill={paint(primitive.fill, gradientId)}
          stroke={paint(primitive.stroke, gradientId)}
          strokeWidth={primitive.strokeWidth}
          transform={primitive.transform}
        />
      );
    case 'group':
      return (
        <g key={key} transform={primitive.transform}>
          {primitive.children.map((child, index) => renderPrimitive(child, index, gradientId))}
        </g>
      );
  }
}

const CatalogIcon: React.FC<IconProps & { id: ToolId }> = ({ id, className }) => {
  const gradientId = React.useId();
  const icon: ToolIconData = AI_TOOL_ICONS[id];
  return (
    <svg
      viewBox={icon.viewBox}
      fill={icon.fill}
      fillRule={icon.fillRule}
      className={className}
      aria-hidden="true"
      focusable="false"
    >
      {icon.gradient && (
        <defs>
          <linearGradient
            id={gradientId}
            x1={icon.gradient.x1}
            y1={icon.gradient.y1}
            x2={icon.gradient.x2}
            y2={icon.gradient.y2}
            gradientUnits={icon.gradient.gradientUnits}
          >
            {icon.gradient.stops.map((stop, index) => (
              <stop
                key={index}
                offset={stop.offset}
                stopColor={stop.stopColor}
                stopOpacity={stop.stopOpacity}
              />
            ))}
          </linearGradient>
        </defs>
      )}
      {icon.primitives.map((primitive, index) => renderPrimitive(primitive, index, gradientId))}
    </svg>
  );
};

function iconComponent(id: ToolId): React.FC<IconProps> {
  return function Icon(props) {
    return <CatalogIcon id={id} {...props} />;
  };
}

export const iconMap = Object.fromEntries(
  (Object.keys(AI_TOOL_ICONS) as ToolId[]).map((id) => [id, iconComponent(id)]),
) as Record<ToolId, React.FC<IconProps>>;

const FallbackIcon: React.FC<IconProps & { label: string }> = ({ className, label }) => (
  <div
    aria-hidden="true"
    className={cn(
      'flex items-center justify-center rounded bg-muted text-[10px] font-bold text-muted-foreground',
      className,
    )}
  >
    {label}
  </div>
);

export const ToolIcon: React.FC<{ id: string; className?: string }> = ({
  id,
  className = 'h-4 w-4',
}) => {
  const Icon = Object.prototype.hasOwnProperty.call(iconMap, id) ? iconMap[id as ToolId] : undefined;
  return Icon
    ? <Icon className={className} />
    : <FallbackIcon className={className} label={id.slice(0, 2).toUpperCase()} />;
};
